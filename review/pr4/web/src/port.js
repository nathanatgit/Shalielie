// The patch pipeline, ported from cmd_patch in photographic_style_port.py.
//
// The app supplies an independently encoded 8-bit linear thumbnail. Library callers
// may still reuse the source thumbnail. The generic graph path may receive
// a locally encoded replacement thumbnail/HDR pair from the caller,
// but this container module itself remains codec-independent. Decoding is only needed
// for optional target scene statistics and c/d light maps and is supplied as a callback.

import { topBox, boxes, be, concat, slice, u } from "./box.js?v=0.6.0-web";
import {
  discoverHeic, parseIloc, parseIinf, parseIref, parseIpcoIpma, extractItem, extractItemData, replaceIdatItem,
  propertyForItem, propertyBoxBytes, dimensionsForItem, auxUriForItem,
  irotAngleForItem, imirAxisForItem, displayDimensions, findItemsByType,
  replaceIpcoProperty, replaceItemPropertyWithSource, appendIpcoProperty,
  repointItemProperty, associateItemProperty, setItemPropertyAssociations, removeItems, setItemReference, addItems,
  ispeBox, IROT_IDENTITY,
  MATTE_URIS, MATTE_URI_SET, DEPTH_URI,
} from "./heif.js?v=0.6.0-web";
import { injectAppleMakerNoteTag } from "./exif.js?v=0.6.0-web";
import {installPortraitMatte} from './portrait-matte.js?v=0.6.0-web';
import { addTextureItems, hasTexture, upgradeStylesV16, preferNativeSkin } from "./texture.js?v=0.6.0-web";
import {
  applySceneStatistics, applyLightMaps, setPersonMasksValid, applyPersonMetadata, buildLightMaps,
  linearLumaFromRgb, LIGHTMAP_N,
} from "./styles.js?v=0.6.0-web";

export const VERSION = "0.6.0-web";

function gridDescriptor(meta, iid) {
  const iloc = parseIloc(meta, topBox(meta, "meta"));
  const item = iloc.items.get(iid);
  if (!item || item.constructionMethod !== 1 || item.extents.length !== 1)
    throw new Error(`Grid item ${iid} is not stored in idat`);
  const idat = boxes(meta, topBox(meta, "meta").off + topBox(meta, "meta").hdr + 4,
    topBox(meta, "meta").off + topBox(meta, "meta").size).find((b) => b.type === "idat");
  if (!idat) throw new Error("Profile has no idat box");
  const extent = item.extents[0];
  const off = idat.off + idat.hdr + item.baseOffset + extent.offset;
  return slice(meta, off, extent.length);
}

function replaceGridDescriptor(meta, iid, descriptor) {
  const iloc = parseIloc(meta, topBox(meta, "meta"));
  const item = iloc.items.get(iid);
  if (!item || item.constructionMethod !== 1 || item.extents.length !== 1)
    throw new Error(`Grid item ${iid} is not stored in idat`);
  const m = topBox(meta, "meta");
  const idat = boxes(meta, m.off + m.hdr + 4, m.off + m.size).find((b) => b.type === "idat");
  const extent = item.extents[0];
  if (!idat || descriptor.length !== extent.length)
    throw new Error(`Grid item ${iid} has an incompatible descriptor`);
  const out = meta.slice();
  out.set(descriptor, idat.off + idat.hdr + item.baseOffset + extent.offset);
  return out;
}

function gridDescriptorV0(width, height, columns, rows) {
  if (width > 0xffff || height > 0xffff || columns < 1 || rows < 1)
    throw new Error("Generic grid dimensions are out of range");
  return concat([
    new Uint8Array([0, 0, rows - 1, columns - 1]), be(width, 2), be(height, 2),
  ]);
}

function even(value) { return Math.max(16, Math.round(value / 2) * 2); }
function equalBytes(a, b) {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// Donor items sometimes share one ipco property index even when a grafted source
// needs different values. Appending and repointing prevents an HDR tile update from
// silently changing the primary tiles that happened to share the donor property.
function isolateItemProperty(meta, itemIds, type, sourceBox) {
  if (!sourceBox) throw new Error(`Source item has no ${type} property`);
  const props = parseIpcoIpma(meta, topBox(meta, "meta"));
  const oldIndexes = itemIds.map((iid) => {
    const property = propertyForItem(props, iid, type);
    if (!property) throw new Error(`Donor item ${iid} has no ${type} property`);
    return property.index;
  });
  let newIndex;
  [meta, newIndex] = appendIpcoProperty(meta, sourceBox);
  itemIds.forEach((iid, index) => {
    meta = repointItemProperty(meta, iid, oldIndexes[index], newIndex);
  });
  return meta;
}

// Copy the complete ordered collection: an item may have both ICC and nclx colr.
// Clear absent source properties as well, so donor HDR descriptors cannot leak in.
function copyRenderingProperties(meta, outputId, sourceData, sourceProps, sourceId, types = new Set(["colr", "clli", "mdcv", "hvcC", "ispe", "pixi", "clap", "pasp", "irot", "imir"])) {
  const copied = [];
  for (const association of sourceProps.associations.get(sourceId) || []) {
    const property = sourceProps.properties[association.index - 1];
    if (!types.has(property?.type)) continue;
    const bytes = sourceData.slice(property.box.off, property.box.off + property.box.size);
    const current = parseIpcoIpma(meta, topBox(meta, "meta"));
    let index = current.properties.find((candidate) => candidate.type === property.type &&
      equalBytes(meta.slice(candidate.box.off, candidate.box.off + candidate.box.size), bytes))?.index;
    if (index === undefined) [meta, index] = appendIpcoProperty(meta, bytes);
    copied.push({ index, essential: association.essential });
  }
  const current = parseIpcoIpma(meta, topBox(meta, "meta"));
  const retained = (current.associations.get(outputId) || []).filter((association) =>
    !types.has(current.properties[association.index - 1]?.type));
  // Keep the source's relative association order, including duplicate colr.
  return setItemPropertyAssociations(meta, outputId, [...copied, ...retained]
    .map(({ index, essential }) => [index, essential]));
}

export function selectProfile(index, primaryTiles, hdrTiles, directHdr = false) {
  if (!index) throw new Error("Profile index unavailable");
  const match = Object.entries(index).filter(([, v]) =>
    v.primary_tiles === primaryTiles && (directHdr || v.hdr_tiles === hdrTiles));
  if (match.length === 1) return match[0][0];
  throw new Error(`Unsupported tile layout: ${primaryTiles}/${hdrTiles} HDR`);
}

/**
 * @param targetData  Uint8Array of the source HEIC
 * @param profile     from loadProfile()
 * @param opts.decode async (targetData, {width,height,angle,mirror}) -> Uint8Array RGB,
 *                    or null to skip target-derived statistics and light maps
 * @param opts.texture false to leave out the iOS 27 Texture/Grain set (v0.4.4 output)
 */
export async function patch(targetData, profile, opts = {}) {
  const td = discoverHeic(targetData);
  opts = { ...opts, matteOverrides: preferNativeSkin(targetData, td, opts.matteOverrides) };
  const directHdr = td.hdrGrid !== null && td.hdrTiles.length === 0
    && td.infos.get(td.hdrGrid)?.type === "hvc1";
  const generic = opts.generic === true;
  if (generic && td.hdrGrid !== null && !directHdr
      && td.hdrTiles.length !== profile.manifest.donor_hdr_tiles.length)
    throw new Error("Generic graft does not support an unmatched tiled HDR graph");
  if (!generic && (td.hdrGrid === null || (!td.hdrTiles.length && !directHdr)))
    throw new Error("Missing HDR gain-map image");
  if (!generic && td.thumbnail === null) throw new Error("Missing embedded thumbnail");
  if (generic && td.thumbnail === null && !opts.syntheticThumbnail)
    throw new Error("Generic graft needs a generated thumbnail");
  if (generic && td.hdrGrid === null && !opts.syntheticHdr)
    throw new Error("Generic graft needs a generated HDR gain map");
  if (td.exifItem === null) throw new Error("Missing Exif item");

  const { manifest } = profile;
  let meta = profile.meta.slice();
  const report = { version: VERSION, warnings: [] };

  if (!generic && (td.primaryTiles.length !== manifest.primary_tile_count
      || (!directHdr && td.hdrTiles.length !== manifest.hdr_tile_count)))
    throw new Error(`Tile count mismatch: ${td.primaryTiles.length}/${td.hdrTiles.length} HDR`);
  if (generic && (td.primaryTiles.length < 1
      || td.primaryTiles.length > manifest.donor_primary_tiles.length))
    throw new Error(`Generic graft cannot host ${td.primaryTiles.length} primary tiles`);

  const payloads = new Map(profile.retained);
  const targetIloc = td.iloc;

  const primarySlots = manifest.donor_primary_tiles.map(Number);
  const usedPrimarySlots = primarySlots.slice(0, td.primaryTiles.length);
  usedPrimarySlots.forEach((donorIid, i) => {
    payloads.set(donorIid, extractItem(targetData, targetIloc, td.primaryTiles[i]));
  });
  if (generic) {
    const unused = primarySlots.slice(td.primaryTiles.length);
    if (unused.length) {
      meta = removeItems(meta, unused);
      unused.forEach((iid) => payloads.delete(iid));
    }
    const donorPrimary = Number(manifest.donor_primary_item);
    meta = setItemReference(meta, "dimg", donorPrimary, usedPrimarySlots);
    meta = replaceGridDescriptor(meta, donorPrimary,
      gridDescriptor(targetData.slice(), td.primary));
    meta = replaceItemPropertyWithSource(meta, donorPrimary, "ispe",
      propertyBoxBytes(targetData, td.props, td.primary, "ispe"));
    report.generic = {
      sourceLayout: `${td.primaryTiles.length}/${td.hdrTiles.length}`,
      primaryPayloadsPreserved: td.primaryTiles.length,
    };
  }
  const primaryOutput = Number(manifest.donor_primary_item);
  meta = replaceGridDescriptor(meta, primaryOutput, gridDescriptor(targetData, td.primary));
  meta = replaceItemPropertyWithSource(meta, primaryOutput, "ispe", propertyBoxBytes(targetData, td.props, td.primary, "ispe"));
  let portHdrItem = Number(manifest.donor_hdr_grid_item);
  if (!directHdr && td.hdrGrid !== null) {
    manifest.donor_hdr_tiles.forEach((donorIid, i) => {
      payloads.set(Number(donorIid), extractItem(targetData, targetIloc, td.hdrTiles[i]));
    });
    {
      const donorHdr = Number(manifest.donor_hdr_grid_item);
      meta = replaceGridDescriptor(meta, donorHdr,
        gridDescriptor(targetData.slice(), td.hdrGrid));
      for (const type of ["ispe", "pixi", "colr", "auxC"])
        meta = replaceItemPropertyWithSource(meta, donorHdr, type,
          propertyBoxBytes(targetData, td.props, td.hdrGrid, type));
      report.hdr = {
        mode: "tiled-preserved",
        sourceItem: td.hdrGrid,
        outputItem: donorHdr,
        payloadsPreserved: td.hdrTiles.length,
      };
    }
  } else if (directHdr || generic) {
    const removed = new Set([
      Number(manifest.donor_hdr_grid_item),
      ...manifest.donor_hdr_tiles.map(Number),
    ]);
    const donorHdrSidecars = [];
    // A donor XMP item describing the removed grid must not survive as an orphan.
    const beforeHdrInfos = parseIinf(meta, topBox(meta, "meta"));
    for (const ref of parseIref(meta, topBox(meta, "meta"))) {
      if (ref.type !== "cdsc" || !ref.to.some((iid) => removed.has(iid))) continue;
      if (payloads.has(ref.from)) donorHdrSidecars.push({
        contentType: beforeHdrInfos.get(ref.from)?.contentType || "application/rdf+xml",
        payload: payloads.get(ref.from),
      });
      removed.add(ref.from);
    }
    meta = removeItems(meta, removed);
    for (const iid of removed) payloads.delete(iid);
    const sourceHdr = directHdr ? td.hdrGrid : null;
    const hdrBoxes = directHdr
      ? ["ispe", "pixi", "colr", "hvcC", "irot", "imir"]
        .map((type) => propertyBoxBytes(targetData, td.props, sourceHdr, type)).filter(Boolean)
      : [ispeBox(opts.syntheticHdr.width, opts.syntheticHdr.height), opts.syntheticHdr.hvcc,
        ...(opts.syntheticHdr.colr ? [opts.syntheticHdr.colr] : [])];
    const currentProps = parseIpcoIpma(meta, topBox(meta, "meta"));
    const primaryAssoc = currentProps.associations.get(Number(manifest.donor_primary_item)) || [];
    const hdrReuse = directHdr ? [] : primaryAssoc.filter((a) => {
      const type = currentProps.properties[a.index - 1]?.type;
      return type === "pixi" || (type === "colr" && !opts.syntheticHdr.colr)
        || type === "irot" || type === "imir";
    }).map((a) => [a.index, a.essential]);
    const [directMeta, assignedHdr] = addItems(meta, [{
      key: "directHdr", itemType: directHdr ? td.infos.get(sourceHdr).type : "hvc1",
      boxes: hdrBoxes, reuse: hdrReuse,
      uri: directHdr ? null : "urn:com:apple:photo:2020:aux:hdrgainmap",
      auxc: directHdr ? propertyBoxBytes(targetData, td.props, sourceHdr, "auxC") : null,
      refType: "auxl", refTo: [Number(manifest.donor_primary_item)],
    }]);
    meta = directMeta;
    portHdrItem = assignedHdr.get("directHdr");
    payloads.set(portHdrItem, directHdr
      ? extractItem(targetData, targetIloc, sourceHdr) : opts.syntheticHdr.payload);
    if (!directHdr && donorHdrSidecars.length) {
      const specs = donorHdrSidecars.map((sidecar, index) => ({
        key: `synthetic-hdr-xmp-${index}`, itemType: "mime",
        contentType: sidecar.contentType, refType: "cdsc", refTo: [portHdrItem],
        _payload: sidecar.payload,
      }));
      let sidecarIds;
      [meta, sidecarIds] = addItems(meta, specs);
      for (const spec of specs) payloads.set(sidecarIds.get(spec.key), spec._payload);
    }
    const tmap = findItemsByType(parseIinf(meta, topBox(meta, "meta")), "tmap")[0];
    if (tmap !== undefined)
      meta = setItemReference(meta, "dimg", tmap,
        [Number(manifest.donor_primary_item), portHdrItem]);
    report.hdr = {
      mode: directHdr ? "direct" : "synthetic-direct", sourceItem: sourceHdr,
      outputItem: portHdrItem,
      tmapDependency: tmap === undefined ? null : [Number(manifest.donor_primary_item), portHdrItem],
    };
  }
  payloads.set(Number(manifest.donor_thumbnail_item), td.thumbnail !== null
    ? extractItem(targetData, targetIloc, td.thumbnail) : opts.syntheticThumbnail.payload);

  const targetExif = extractItem(targetData, targetIloc, td.exifItem);
  payloads.set(Number(manifest.donor_exif_item), injectAppleMakerNoteTag(
    targetExif, profile.mn54, 0x54, Number(manifest.smartstyle_makernote_type ?? 7)));

  // Compressed payloads must travel with their own codec/colour configuration.
  const donorPrimary0 = Number(manifest.donor_primary_tiles[0]);
  const targetPrimary0 = td.primaryTiles[0];
  meta = replaceItemPropertyWithSource(meta, donorPrimary0, "hvcC",
    propertyBoxBytes(targetData, td.props, targetPrimary0, "hvcC"));
  meta = replaceItemPropertyWithSource(meta, donorPrimary0, "colr",
    propertyBoxBytes(targetData, td.props, targetPrimary0, "colr"));
  if (generic) {
    for (const type of ["ispe", "pixi"])
      meta = replaceItemPropertyWithSource(meta, donorPrimary0, type,
        propertyBoxBytes(targetData, td.props, targetPrimary0, type));
  }
  const donorThumb = Number(manifest.donor_thumbnail_item);
  meta = replaceItemPropertyWithSource(meta, donorThumb, "hvcC", td.thumbnail !== null
    ? propertyBoxBytes(targetData, td.props, td.thumbnail, "hvcC")
    : opts.syntheticThumbnail.hvcc);
  meta = replaceItemPropertyWithSource(meta, donorThumb, "ispe", td.thumbnail !== null
    ? propertyBoxBytes(targetData, td.props, td.thumbnail, "ispe")
    : ispeBox(opts.syntheticThumbnail.width, opts.syntheticThumbnail.height));
  if (td.thumbnail !== null) {
    meta = replaceItemPropertyWithSource(meta, donorThumb, "pixi",
      propertyBoxBytes(targetData, td.props, td.thumbnail, "pixi"));
    meta = replaceItemPropertyWithSource(meta, donorThumb, "colr",
      propertyBoxBytes(targetData, td.props, td.thumbnail, "colr"));
  } else if (opts.syntheticThumbnail.colr) {
    meta = isolateItemProperty(meta, [donorThumb], "colr", opts.syntheticThumbnail.colr);
  }
  if (!directHdr && td.hdrGrid !== null) {
    const donorHdr0 = Number(manifest.donor_hdr_tiles[0]);
    if (generic) {
      const donorHdrTiles = manifest.donor_hdr_tiles.map(Number);
      for (const type of ["hvcC", "ispe"])
        meta = isolateItemProperty(meta, donorHdrTiles, type,
          propertyBoxBytes(targetData, td.props, td.hdrTiles[0], type));
    } else {
      meta = replaceItemPropertyWithSource(meta, donorHdr0, "hvcC",
        propertyBoxBytes(targetData, td.props, td.hdrTiles[0], "hvcC"));
    }
  }

  // Orientation: the donor's shared irot drives the whole item graph.
  const donorPrimary = Number(manifest.donor_primary_item);
  const targetAngle = irotAngleForItem(targetData, td.props, td.primary);
  const targetMirror = imirAxisForItem(targetData, td.props, td.primary);
  const donorAngle = irotAngleForItem(meta, parseIpcoIpma(meta, topBox(meta, "meta")), donorPrimary);
  const sourceImir = propertyBoxBytes(targetData, td.props, td.primary, "imir");
  meta = replaceItemPropertyWithSource(meta, donorPrimary, "irot",
    propertyBoxBytes(targetData, td.props, td.primary, "irot") || IROT_IDENTITY);
  if (targetMirror !== null) {
    const now = parseIpcoIpma(meta, topBox(meta, "meta"));
    const existingImir = propertyForItem(now, donorPrimary, "imir");
    if (existingImir) {
      meta = replaceItemPropertyWithSource(meta, donorPrimary, "imir",
        sourceImir);
    } else {
      const primaryIrot = propertyForItem(now, donorPrimary, "irot");
      const followsPrimaryOrientation = primaryIrot
        ? [...now.associations].filter(([, assoc]) =>
          assoc.some((entry) => entry.index === primaryIrot.index)).map(([iid]) => iid)
        : [donorPrimary];
      let imirIndex;
      [meta, imirIndex] = appendIpcoProperty(meta, sourceImir);
      for (const iid of followsPrimaryOrientation)
        meta = associateItemProperty(meta, iid, imirIndex, true);
      report.warnings.push(`profile had no imir slot; added property ${imirIndex} to ${
        followsPrimaryOrientation.length} orientation-linked items`);
    }
  }
  report.orientation = { donor: donorAngle, target: targetAngle, mirror: targetMirror };

  // The neutral StyleDeltaMap is layout-independent at the tile-payload level. For an
  // arbitrary aspect ratio, retain only the number of 512px tiles needed by a 2880px
  // long-edge map and rewrite its grid descriptor instead of stretching the 4:3 donor.
  {
    const deltaGrid = Number(manifest.donor_delta_grid_item);
    const deltaSlots = manifest.donor_delta_tiles.map(Number);
    const [pw, ph] = dimensionsForItem(td.props, td.primary);
    const landscape = pw >= ph;
    const scale = Math.min((landscape ? 2880 : 2160) / pw,
      (landscape ? 2160 : 2880) / ph);
    const dw = even(pw * scale), dh = even(ph * scale);
    const columns = Math.ceil(dw / 512), rows = Math.ceil(dh / 512);
    const needed = columns * rows;
    if (needed > deltaSlots.length)
      throw new Error(`Generic delta grid needs ${needed} tiles; profile has ${deltaSlots.length}`);
    const used = deltaSlots.slice(0, needed), unused = deltaSlots.slice(needed);
    if (unused.length) {
      meta = removeItems(meta, unused);
      unused.forEach((iid) => payloads.delete(iid));
    }
    meta = setItemReference(meta, "dimg", deltaGrid, used);
    meta = replaceGridDescriptor(meta, deltaGrid,
      gridDescriptorV0(dw, dh, columns, rows));
    const deltaProps = parseIpcoIpma(meta, topBox(meta, "meta"));
    const deltaIspe = propertyForItem(deltaProps, deltaGrid, "ispe");
    meta = replaceIpcoProperty(meta, deltaIspe.index, ispeBox(dw, dh), "ispe");
    report.delta = { mode: "neutral-placeholder", width: dw, height: dh, columns, rows, tiles: needed,
      originalRecovered: false };
    if (report.generic) report.generic.delta = report.delta;
  }

  // tmap declares display geometry and carries its own irot, so it must follow the target.
  const donorTmaps = findItemsByType(parseIinf(meta, topBox(meta, "meta")), "tmap");
  const targetTmaps = findItemsByType(td.infos, "tmap");
  if (donorTmaps.length) {
    const donorTmap = donorTmaps[0];
    let srcIspe, srcIrot;
    if (targetTmaps.length) {
      srcIspe = propertyBoxBytes(targetData, td.props, targetTmaps[0], "ispe");
      srcIrot = propertyBoxBytes(targetData, td.props, targetTmaps[0], "irot");
      // Gain map pixels and their reconstruction parameters are one pair.
      // Keeping the donor tmap here changes HDR even when every HEVC tile is preserved.
      const paired = td.hdrGrid !== null && td.refs.some((ref) => ref.type === "dimg" &&
        ref.from === targetTmaps[0] && ref.to.length === 2 &&
        ref.to[0] === td.primary && ref.to[1] === td.hdrGrid);
      if (paired) {
        meta = replaceIdatItem(meta, donorTmap, extractItemData(targetData, td, targetTmaps[0]));
        for (const type of ["colr", "pixi"]) {
          const source = propertyBoxBytes(targetData, td.props, targetTmaps[0], type);
          if (source) meta = isolateItemProperty(meta, [donorTmap], type, source);
        }
        meta = setItemReference(meta, "dimg", donorTmap, [Number(manifest.donor_primary_item), portHdrItem]);
        report.tmapMetadata = "target-preserved";
      }
    } else {
      const [pw, ph] = dimensionsForItem(td.props, td.primary);
      const [dw, dh] = displayDimensions(pw, ph, targetAngle);
      srcIspe = ispeBox(dw, dh);
      srcIrot = IROT_IDENTITY;
    }
    meta = replaceItemPropertyWithSource(meta, donorTmap, "ispe", srcIspe);
    meta = replaceItemPropertyWithSource(meta, donorTmap, "irot", srcIrot || IROT_IDENTITY);
    report.tmap = dimensionsForItem(parseIpcoIpma(meta, topBox(meta, "meta")), donorTmap);
  }

  // A source gain map must not retain another photo's reconstruction sidecars.
  if (td.hdrGrid !== null) {
    const infos = parseIinf(meta, topBox(meta, "meta")), related = new Set([portHdrItem, ...donorTmaps]);
    const stale = parseIref(meta, topBox(meta, "meta")).filter(ref => ref.type === "cdsc" &&
      infos.get(ref.from)?.type === "mime" && ref.to.some(id => related.has(id))).map(ref => ref.from);
    if (stale.length) { meta = removeItems(meta, stale); stale.forEach(id => payloads.delete(id)); }
    report.hdrSidecars = "source-only";
  }

  // Semantic mattes and depth.
  const donorProps = parseIpcoIpma(meta, topBox(meta, "meta"));
  const donorInfos = parseIinf(meta, topBox(meta, "meta"));
  const donorSlots = new Map(), targetSlots = new Map();
  for (const iid of donorInfos.keys()) {
    const uri = auxUriForItem(donorProps, iid);
    if (uri && MATTE_URI_SET.has(uri)) donorSlots.set(uri, iid);
  }
  for (const iid of td.infos.keys()) {
    const uri = auxUriForItem(td.props, iid);
    if (uri && MATTE_URI_SET.has(uri)) targetSlots.set(uri, iid);
  }
  report.mattes = { transplanted: [], added: [], neutralized: [] };
  let assigned = new Map();
  if (donorSlots.size) {
    const templateIid = donorSlots.values().next().value;
    const templateRefs = parseIref(meta, topBox(meta, "meta"))
      .filter((r) => r.type === "auxl" && r.from === templateIid).map((r) => r.to);
    const toIds = templateRefs.length ? templateRefs[0] : [td.primary];
    const specs = [];

    if (targetSlots.size) {
      const shared = [...targetSlots.keys()].filter((k) => donorSlots.has(k));
      const extra = [...targetSlots.keys()].filter((k) => !donorSlots.has(k));
      const spare = [...donorSlots.keys()].filter((k) => !targetSlots.has(k));
      const anyTarget = targetSlots.values().next().value;
      const [m2, newHvcc] = appendIpcoProperty(meta,
        propertyBoxBytes(targetData, td.props, anyTarget, "hvcC"));
      meta = m2;
      const oldHvcc = propertyForItem(donorProps, donorSlots.get(shared[0]), "hvcC").index;
      for (const uri of shared) {
        meta = repointItemProperty(meta, donorSlots.get(uri), oldHvcc, newHvcc);
        meta = replaceItemPropertyWithSource(meta, donorSlots.get(uri), "auxC",
          propertyBoxBytes(targetData, td.props, targetSlots.get(uri), "auxC"));
        payloads.set(donorSlots.get(uri),
          extractItem(targetData, targetIloc, targetSlots.get(uri)));
        report.mattes.transplanted.push(uri.split(":").pop());
      }
      const neutralSrc = donorSlots.get(MATTE_URIS.portraiteffectsmatte);
      for (const uri of spare) {
        if (neutralSrc !== undefined && payloads.has(donorSlots.get(uri))) {
          payloads.set(donorSlots.get(uri), profile.retained.get(neutralSrc));
          report.mattes.neutralized.push(uri.split(":").pop());
        }
      }
      const nowProps = parseIpcoIpma(meta, topBox(meta, "meta"));
      const templateAssoc = nowProps.associations.get(templateIid);
      const templateAuxc = propertyForItem(nowProps, templateIid, "auxC");
      const matteReuse = templateAssoc.filter((a) => a.index !== templateAuxc.index)
        .map((a) => [a.index, a.essential]);
      for (const uri of extra)
        specs.push({
          key: uri, uri, reuse: matteReuse, boxes: [],
          auxc: propertyBoxBytes(targetData, td.props, targetSlots.get(uri), "auxC"),
        });
    }

    // Depth is independent of the mattes: a Portrait photo of a non-person subject
    // carries depth with no mattes at all.
    const depthIds = [...td.infos.keys()].filter((i) => auxUriForItem(td.props, i) === DEPTH_URI);
    const donorDepth = [...donorInfos.keys()].filter((i) => auxUriForItem(donorProps, i) === DEPTH_URI);
    if (depthIds.length && !donorDepth.length) {
      const di = depthIds[0];
      const orientationProps = parseIpcoIpma(meta, topBox(meta, "meta"));
      const irotProp = propertyForItem(orientationProps, templateIid, "irot");
      const imirProp = propertyForItem(orientationProps, templateIid, "imir");
      const boxesForDepth = ["ispe", "pixi", "colr", "hvcC"]
        .map((t) => propertyBoxBytes(targetData, td.props, di, t)).filter(Boolean);
      specs.push({
        key: DEPTH_URI, uri: DEPTH_URI,
        reuse: [irotProp, imirProp].filter(Boolean).map((prop) => [prop.index, true]),
        boxes: boxesForDepth,
        auxc: propertyBoxBytes(targetData, td.props, di, "auxC"),
      });
      targetSlots.set(DEPTH_URI, di);
    }

    for (const s of specs) { s.refType = "auxl"; s.refTo = toIds; }
    if (specs.length) {
      const [m3, a] = addItems(meta, specs);
      meta = m3; assigned = a;
      for (const [uri, newIid] of assigned) {
        payloads.set(newIid, extractItem(targetData, targetIloc, targetSlots.get(uri)));
        report.mattes.added.push(`${uri === DEPTH_URI ? "depth" : uri.split(":").pop()}#${newIid}`);
      }
    }

    // XMP sidecars: every auxiliary is interpreted through a mime item pointed at it
    // by cdsc. The depth sidecar carries the Portrait blur parameters.
    const portInfos = parseIinf(meta, topBox(meta, "meta"));
    const portRefs = parseIref(meta, topBox(meta, "meta"));
    const idMap = new Map([[td.primary, Number(manifest.donor_primary_item)]]);
    if (td.hdrGrid !== null) idMap.set(td.hdrGrid, portHdrItem);
    const portTmaps = findItemsByType(portInfos, "tmap");
    targetTmaps.forEach((t, i) => { if (portTmaps[i] !== undefined) idMap.set(t, portTmaps[i]); });
    for (const [uri, tiid] of targetSlots) {
      if (donorSlots.has(uri)) idMap.set(tiid, donorSlots.get(uri));
      else if (assigned.has(uri)) idMap.set(tiid, assigned.get(uri));
    }
    const portCdsc = new Map(portRefs.filter((r) => r.type === "cdsc").map((r) => [r.from, r.to]));
    const described = new Map();
    for (const [iid, info] of portInfos)
      if (info.type === "mime" && portCdsc.has(iid))
        described.set(portCdsc.get(iid).join(","), iid);
    const targetCdsc = new Map(td.refs.filter((r) => r.type === "cdsc").map((r) => [r.from, r.to]));
    const sidecarSpecs = [];
    for (const [tiid, info] of [...td.infos.entries()].sort((a, b) => a[0] - b[0])) {
      if (info.type !== "mime" || !targetCdsc.has(tiid)) continue;
      const tgts = targetCdsc.get(tiid);
      if (!tgts.every((t) => idMap.has(t))) continue;
      const mapped = tgts.map((t) => idMap.get(t));
      const payload = extractItem(targetData, targetIloc, tiid);
      const key = mapped.join(",");
      if (described.has(key)) payloads.set(described.get(key), payload);
      else sidecarSpecs.push({
        key: `mime${tiid}`, itemType: "mime",
        contentType: info.contentType || "application/rdf+xml",
        refType: "cdsc", refTo: mapped, _payload: payload,
      });
    }
    if (sidecarSpecs.length) {
      const [m4, sc] = addItems(meta, sidecarSpecs);
      meta = m4;
      for (const s of sidecarSpecs) payloads.set(sc.get(s.key), s._payload);
      report.sidecarsAdded = sidecarSpecs.length;
    }
  }

  // iOS 27 Texture/Grain set (2026 mattes + texture_styles). Appending keeps every existing
  // property index, so the manifest's linearthumbnail hvcC index below still holds.
  report.texture = "off";
  if (opts.texture !== false) {
    const portInfos = parseIinf(meta, topBox(meta, "meta"));
    if (hasTexture(portInfos)) report.texture = "from profile";
    else {
      const [m6, texPayloads, summary] = addTextureItems(
        meta, Number(manifest.donor_primary_item), {
          matteOverrides: opts.matteOverrides,
          texturePeopleData: opts.texturePeopleData,
        });
      meta = m6;
      for (const [iid, blob] of texPayloads) payloads.set(iid, blob);
      report.texture = summary;
    }
  }

  const portraitResult=installPortraitMatte(meta,payloads,targetData,td,opts.matteOverrides?.get(MATTE_URIS.portraiteffectsmatte),Number(manifest.donor_primary_item));
  meta=portraitResult.meta;report.portraitMatte=portraitResult.report;

  // Linearthumbnail: reuse the target's own thumbnail, no encoder needed.
  const donorLt = Number(manifest.donor_linear_thumb_item);
  if (td.thumbnail === null && opts.syntheticThumbnail.colr) {
    let colorIndex;
    [meta, colorIndex] = appendIpcoProperty(meta, opts.syntheticThumbnail.colr);
    const oldColor = propertyForItem(parseIpcoIpma(meta, topBox(meta, "meta")), donorLt, "colr");
    meta = oldColor ? repointItemProperty(meta, donorLt, oldColor.index, colorIndex)
      : associateItemProperty(meta, donorLt, colorIndex, false);
  }
  const thumbHvcc = td.thumbnail !== null
    ? propertyBoxBytes(targetData, td.props, td.thumbnail, "hvcC")
    : opts.syntheticThumbnail.hvcc;
  payloads.set(donorLt, td.thumbnail !== null
    ? extractItem(targetData, targetIloc, td.thumbnail) : opts.syntheticThumbnail.payload);
  meta = replaceIpcoProperty(meta, Number(manifest.linear_thumb_hvcc_property_index),
    thumbHvcc, "hvcC");
  meta = replaceItemPropertyWithSource(meta, donorLt, "ispe", td.thumbnail !== null
    ? propertyBoxBytes(targetData, td.props, td.thumbnail, "ispe")
    : ispeBox(opts.syntheticThumbnail.width, opts.syntheticThumbnail.height));
  const srcPixi = td.thumbnail !== null
    ? propertyBoxBytes(targetData, td.props, td.thumbnail, "pixi")
    : propertyBoxBytes(meta, parseIpcoIpma(meta, topBox(meta, "meta")), donorThumb, "pixi");
  const curPixi = propertyForItem(parseIpcoIpma(meta, topBox(meta, "meta")), donorLt, "pixi");
  if (srcPixi && curPixi) {
    const oldPixi = propertyBoxBytes(meta, parseIpcoIpma(meta, topBox(meta, "meta")), donorLt, "pixi");
    if (!oldPixi || oldPixi.length !== srcPixi.length
        || oldPixi.some((v, i) => v !== srcPixi[i])) {
      // pixi is shared with the delta grid and tmap, so append rather than overwrite.
      const [m5, idx] = appendIpcoProperty(meta, srcPixi);
      meta = repointItemProperty(m5, donorLt, curPixi.index, idx);
    }
  }
  report.linearThumb = dimensionsForItem(parseIpcoIpma(meta, topBox(meta, "meta")), donorLt);
  if (opts.linearThumbnail) {
    const lt = opts.linearThumbnail;
    payloads.set(donorLt, lt.payload);
    for (const [type, value] of [["hvcC", lt.hvcc], ["pixi", lt.pixi],
      ["ispe", ispeBox(lt.width, lt.height)], ["colr", lt.colr]]) {
      if (propertyForItem(parseIpcoIpma(meta, topBox(meta, "meta")), donorLt, type))
        meta = isolateItemProperty(meta, [donorLt], type, value);
      else {
        let index;
        [meta, index] = appendIpcoProperty(meta, value);
        meta = associateItemProperty(meta, donorLt, index, type === "hvcC");
      }
    }
    report.linearThumb = [lt.width, lt.height];
    report.linearThumbMode = lt.mode;
    report.linearThumbSourcePixels = lt.sourcePixels;
  } else report.linearThumbMode = "reuse-thumbnail";

  // A neutral delta's encoding describes the neutral payload, never the source primary.
  const neutralProps = parseIpcoIpma(profile.meta, topBox(profile.meta, "meta"));
  const neutralTypes = new Set(["hvcC", "pixi", "colr", "clli", "mdcv"]);
  for (const id of [Number(manifest.donor_delta_grid_item), ...manifest.donor_delta_tiles.map(Number)]) {
    if (parseIinf(meta, topBox(meta, "meta")).has(id))
      meta = copyRenderingProperties(meta, id, profile.meta, neutralProps, id, neutralTypes);
  }
  if (opts.linearThumbnail) {
    const props = parseIpcoIpma(meta, topBox(meta, "meta"));
    const kept = (props.associations.get(donorLt) || []).filter(a => !["colr", "clli", "mdcv"].includes(props.properties[a.index - 1]?.type));
    let index;
    [meta, index] = appendIpcoProperty(meta, opts.linearThumbnail.colr);
    meta = setItemPropertyAssociations(meta, donorLt, [...kept.map(a => [a.index, a.essential]), [index, false]]);
  }

  // Preserve rendering descriptors after all shared donor-property mutations.
  // Reusing HEVC bytes alone does not preserve how an HDR-aware viewer renders them.
  meta = copyRenderingProperties(meta, donorPrimary, targetData, td.props, td.primary);
  for (let index = 0; index < td.primaryTiles.length; index++)
    meta = copyRenderingProperties(meta, usedPrimarySlots[index], targetData, td.props, td.primaryTiles[index]);
  if (td.hdrGrid !== null) {
    const outputHdr = portHdrItem;
    // auxC must be copied together with the rendering properties. Retaining it
    // separately used to append it at the end and reorder the source HDR grid.
    const hdrTypes = new Set(["colr", "clli", "mdcv", "hvcC", "ispe", "pixi", "clap", "pasp", "irot", "imir", "auxC"]);
    meta = copyRenderingProperties(meta, outputHdr, targetData, td.props, td.hdrGrid, hdrTypes);
    if (!directHdr) {
      const slots = manifest.donor_hdr_tiles.map(Number);
      for (let index = 0; index < td.hdrTiles.length; index++)
        meta = copyRenderingProperties(meta, slots[index], targetData, td.props, td.hdrTiles[index], hdrTypes);
    }
  }
  if (td.thumbnail !== null)
    meta = copyRenderingProperties(meta, donorThumb, targetData, td.props, td.thumbnail);
  if (!opts.linearThumbnail && td.thumbnail !== null)
    meta = copyRenderingProperties(meta, donorLt, targetData, td.props, td.thumbnail);
  if (report.tmapMetadata === "target-preserved")
    meta = copyRenderingProperties(meta, donorTmaps[0], targetData, td.props, targetTmaps[0]);
  report.renderingProperties = "source-preserved-per-item";
  report.auxiliarySources = { hdr: td.hdrGrid !== null ? "source-preserved" : "synthetic-neutral",
    linearThumbnail: opts.linearThumbnail?.sourceImage || (opts.linearThumbnail ? "caller-supplied" : "source-thumbnail-reuse"),
    styleDeltaMap: "neutral-placeholder" };

  // Styles plist edits.
  const donorStyles = Number(manifest.donor_styles_item);
  if (payloads.has(donorStyles)) {
    let blob = payloads.get(donorStyles);
    // Measuring the photo is an enhancement, never a requirement. A decoder that is
    // missing, blocked or simply broken must cost quality, not the whole port - so
    // failures here fall back to the donor values rather than propagating.
    // A decoder that returns the wrong number of samples is worse than one that
    // throws: the statistics would come out silently wrong. Check the size.
    const measure = async (req) => {
      const rgb = await opts.decode(targetData, req);
      const need = req.width * req.height * 3;
      if (!rgb || rgb.length !== need)
        throw new Error(`decoder returned ${rgb ? rgb.length : 0} bytes, expected ${need}`);
      return rgb;
    };

    let sorted = null;
    report.decoded = false;
    if (opts.decode && opts.sceneStats !== "donor") {
      try {
        const rgb = await measure({ width: 256, height: 192 });
        sorted = Array.from(linearLumaFromRgb(rgb)).sort((a, b) => a - b);
        report.decoded = true;
      } catch (e) {
        sorted = null;
        report.decodeError = (e && e.message) || String(e);
      }
    }
    const [b1, sr] = applySceneStatistics(blob, sorted ? (opts.sceneStats || "target") : "donor", sorted);
    blob = b1;
    report.sceneStats = sr;
    if (opts.decode && opts.lightMaps === "target" && report.decoded) {
      try {
        const grid = await measure({
          width: LIGHTMAP_N, height: LIGHTMAP_N, angle: targetAngle, mirror: targetMirror,
        });
        const [c, dmap] = buildLightMaps(linearLumaFromRgb(grid));
        const [b2, mr] = applyLightMaps(blob, c, dmap);
        blob = b2;
        report.lightMaps = mr;
      } catch (e) {
        report.decodeError = (e && e.message) || String(e);
      }
    }
    if (report.mattes.transplanted.length || opts.matteOverrides?.size) {
      const [b3, before] = setPersonMasksValid(blob);
      blob = b3;
      report.personMasksValidHint = `${before} -> 1.0`;
    }
    if (opts.personMetadata) {
      let fields;
      [blob, fields] = applyPersonMetadata(blob, opts.personMetadata);
      report.personMetadata = fields;
    }
    if (opts.texture !== false) {
      let upgraded;
      [blob, upgraded] = upgradeStylesV16(blob);
      report.stylesV16 = upgraded;
    }
    payloads.set(donorStyles, blob);
  }

  // Rebuild one clean mdat and rewrite every external extent.
  const profileIloc = parseIloc(meta, topBox(meta, "meta"));
  const externalIds = [...profileIloc.items.entries()]
    .filter(([, it]) => it.constructionMethod === 0 && it.extents.length)
    .map(([iid]) => iid).sort((a, b) => a - b);
  const missing = externalIds.filter((i) => !payloads.has(i));
  if (missing.length) throw new Error(`Profile is missing payload(s): ${missing}`);

  const mdatStart = profile.ftyp.length + meta.length;
  let cursor = mdatStart + 8;
  const chunks = [];
  const layout = new Map();
  for (const iid of externalIds) {
    const blob = payloads.get(iid);
    layout.set(iid, [cursor, blob.length]);
    chunks.push(blob);
    cursor += blob.length;
  }
  const metaOut = meta.slice();
  const iloc2 = parseIloc(metaOut, topBox(metaOut, "meta"));
  for (const [iid, [off, len]] of layout) {
    const e = iloc2.items.get(iid).extents[0];
    metaOut.set(be(off, iloc2.offsetSize), e.offsetPos);
    metaOut.set(be(len, iloc2.lengthSize), e.lengthPos);
  }
  const mdatPayload = concat(chunks);
  const result = concat([
    profile.ftyp, metaOut, be(8 + mdatPayload.length, 4),
    new Uint8Array([0x6d, 0x64, 0x61, 0x74]), mdatPayload,
  ]);
  {
    const out = discoverHeic(result);
    const types = new Set(["colr", "clli", "mdcv", "hvcC", "ispe", "pixi", "clap", "pasp", "irot", "imir"]);
    const descriptors = (bytes, props, id) => (props.associations.get(id) || []).filter(a => types.has(props.properties[a.index - 1]?.type))
      .map(a => { const p = props.properties[a.index - 1]; return { type: p.type, essential: a.essential, bytes: bytes.slice(p.box.off, p.box.off + p.box.size) }; });
    const verifyItem = (sourceId, outputId) => {
      if (!equalBytes(extractItemData(targetData, td, sourceId), extractItemData(result, out, outputId)))
        throw new Error(`self-check failed: source image payload ${sourceId} changed`);
      const before = descriptors(targetData, td.props, sourceId), after = descriptors(result, out.props, outputId);
      if (before.length !== after.length || before.some((p, i) => p.type !== after[i].type || p.essential !== after[i].essential || !equalBytes(p.bytes, after[i].bytes)))
        throw new Error(`self-check failed: source image descriptors ${sourceId} changed`);
    };
    verifyItem(td.primary, out.primary);
    td.primaryTiles.forEach((id, i) => verifyItem(id, out.primaryTiles[i]));
    if (td.thumbnail !== null) verifyItem(td.thumbnail, out.thumbnail);
    if (td.hdrGrid !== null) {
      types.add("auxC");
      verifyItem(td.hdrGrid, out.hdrGrid);
      td.hdrTiles.forEach((id, i) => verifyItem(id, out.hdrTiles[i]));
      types.delete("auxC");
    }
    if (report.tmapMetadata === "target-preserved") verifyItem(targetTmaps[0], findItemsByType(out.infos, "tmap")[0]);
    if(report.portraitMatte.mode==='native-preserved'){types.add('auxC');verifyItem(report.portraitMatte.sourceItemId,report.portraitMatte.itemId);types.delete('auxC');}
    if (out.refs.some(ref => !out.infos.has(ref.from) || ref.to.some(id => !out.infos.has(id))))
      throw new Error("self-check failed: dangling image reference");
    if ([...out.props.associations.keys()].some(id => !out.infos.has(id)))
      throw new Error("self-check failed: properties assigned to a removed item");
    report.sourceConsistency = { checked: true, primaryTiles: td.primaryTiles.length, hdrTiles: td.hdrTiles.length,
      hdrItem: out.hdrGrid, colorCodecGeometryPreserved: true, hdrPropertyOrderPreserved: td.hdrGrid !== null };
  }
  return { data: result, report };
}
