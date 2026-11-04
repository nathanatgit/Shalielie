// iOS 27 Texture/Grain (质感/颗粒). Direct port of add_texture_items / add_texture_bytes in
// photographic_style_port.py (v0.5.0), with the same Apple bytes from iPhone 18 Pro IMG_0309.
//
// Photos offers the controls only when a style photo carries BOTH the texture_styles item
// AND iOS 27's twelve 2026 semantic mattes; the item without the mattes removes the whole
// style palette. For a scene with no people every matte is the same empty 768x576 frame.

import { topBox, metaChildren, findChild, be, concat, box, bytesEqual } from "./box.js?v=0.6.0-web";
import {
  discoverHeic, parseIloc, parseIinf, parseIpcoIpma, extractItem, propertyForItem,
  auxUriForItem, findItemsByType, appendIpcoProperty, addItems, auxcBox,
  MATTE_URIS, setItemPropertyAssociations, dimensionsForItem, propertyBoxBytes,
} from "./heif.js?v=0.6.0-web";
import { parseBplist, buildBplist } from "./bplist.js?v=0.6.0-web";

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
const utf8 = (s) => new TextEncoder().encode(s);

export const URI_TEXTURE_STYLES = "tag:apple.com,2026:photo:metadata:texture_styles";
export const URI_PERSON_INSTANCES = "tag:apple.com,2026:photo:aux:semanticpersoninstances";

// Binary plist: Preset Standard, CaptureType LF, CaptureMode Still, PortType PortTypeBack,
// HardwareModel iPhone19,7 (matching the native iPhone 18 Pro reference set),
// TextureStylePeopleDataVersion 3, FilmGrainSeed 92.
export const TEXTURE_STYLES_BLOB = b64(
  "YnBsaXN0MDDXAQIDBAUGBwgJCgsMDQ5WUHJlc2V0W0NhcHR1cmVUeXBlW0NhcHR1cmVNb2RlWFBv"
  + "cnRUeXBlXUhhcmR3YXJlTW9kZWxfEB1UZXh0dXJlU3R5bGVQZW9wbGVEYXRhVmVyc2lvbl1GaWxt"
  + "R3JhaW5TZWVkWFN0YW5kYXJkUkxGVVN0aWxsXFBvcnRUeXBlQmFja1ppUGhvbmUxOSw3EAMQXAgX"
  + "Hio2P01te4SHjZqlpwAAAAAAAAEBAAAAAAAAAA8AAAAAAAAAAAAAAAAAAACp");

export const MATTE_2026_URIS = [
  "semanticnosematte", "semanticskinmattev2", "semanticnonfaceskinmatte",
  "semanticlipsmatte", "semanticteethmattev2", "semanticpersonmatte",
  "semanticglassesmattev2", "semanticeyebrowsmatte", "semantictattoomatte",
  "semantichandsmatte", "semanticearsmatte", "semanticfaceskinmatte",
].map((n) => `tag:apple.com,2026:photo:aux:${n}`);
const MATTE_ISPE = hex("0000001469737065000000000000030000000240");
const MATTE_PIXI = hex("0000000e70697869000000000108");
const MATTE_HVCC = hex(
  "0000006f68766343010408000000bfc8000000005af000fcfcf8f800000b03a00001001740010c01ffff04"
  + "0800000300bfc800000300005a170240a100010021420101040800000300bfc800000300005ac018080241"
  + "6205e49165537020202008a2000100094401c061d2421014c9");
const MATTE_EMPTY = b64(
  "AAAAmCgBrxJdSi5rFrhWizr/aWc5IydgU/X8AAADAAADAAADAAADARsKDFgAAAMAAAMAAAMAAAMAAAacAAAD"
  + "AAADAAADAAADAAADADygAAADAAADAAADAAADAANSAAADAAADAAADAAADAyoAAAMAAAMAAAMAAHTAAAADAAAD"
  + "AAADAAP8AAADAAADAAADAA6oAAADAAADAAADACgg");
const MATTE_XMP = utf8(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">\n'
  + '   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
  + '      <rdf:Description rdf:about=""\n'
  + '            xmlns:fsincMattes="http://ns.apple.com/fsinc/1.0/">\n'
  + "         <fsincMattes:FSINCMatteVersion>0</fsincMattes:FSINCMatteVersion>\n"
  + "      </rdf:Description>\n"
  + "   </rdf:RDF>\n"
  + "</x:xmpmeta>\n");
const LEGACY_SKIN_XMP = utf8(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description rdf:about="" xmlns:semanticSegmentationMatte="http://ns.apple.com/semanticSegmentationMatte/1.0/">'
  + '<semanticSegmentationMatte:SemanticSegmentationMatteVersion>65536</semanticSegmentationMatte:SemanticSegmentationMatteVersion>'
  + '</rdf:Description></rdf:RDF></x:xmpmeta>');
const instanceXmp = (referenceKey) => utf8(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">\n'
  + '   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
  + '      <rdf:Description rdf:about=""\n'
  + '            xmlns:fsincMattes="http://ns.apple.com/fsinc/1.0/">\n'
  + `         <fsincMattes:InstanceMaskReferenceKey>${referenceKey}</fsincMattes:InstanceMaskReferenceKey>\n`
  + "         <fsincMattes:FSINCMatteVersion>0</fsincMattes:FSINCMatteVersion>\n"
  + "      </rdf:Description>\n"
  + "   </rdf:RDF>\n"
  + "</x:xmpmeta>\n");

export function textureStylesWithPeople(peopleData) {
  if (!peopleData?.length) return TEXTURE_STYLES_BLOB;
  const plist = parseBplist(TEXTURE_STYLES_BLOB);
  plist.set("TextureStylePostProcessedPeopleData", peopleData);
  return buildBplist(plist);
}

export function identityToneCurve() {
  const curve = new Uint8Array(516);
  curve.set([1, 1, 0, 0]);
  const view = new DataView(curve.buffer);
  for (let i = 0; i < 256; i++) view.setUint16(4 + i * 2, Math.round(i * 65535 / 255), true);
  return curve;
}

/** Upgrade an older native Photographic Style plist to the schema iOS 27 uses with Texture. */
export function upgradeStylesV16(stylesBlob) {
  const source = parseBplist(stylesBlob);
  const toneCurve = source.get("3");
  if (source.get("0") === 16 && source.get("5") === 0
      && toneCurve instanceof Uint8Array && toneCurve.length === 516
      && source.has("k") && source.has("l")) return [stylesBlob, false];

  const values = new Map(source);
  values.set("3", identityToneCurve());
  values.set("0", 16);
  values.set("5", 0);
  values.set("k", false);
  values.set("l", false);
  // Native iPhone 18 ordering. Binary-plist dictionary order is not semantic, but matching it
  // makes diagnostics and byte comparisons much less surprising.
  const order = ["2", "h", "3", "i", "4", "j", "c", "5", "k", "d", "6", "l",
    "e", "7", "0", "f", "1", "g"];
  const upgraded = new Map();
  for (const key of order) if (values.has(key)) upgraded.set(key, values.get(key));
  for (const [key, value] of values) if (!upgraded.has(key)) upgraded.set(key, value);
  return [buildBplist(upgraded), true];
}

export function hasTexture(infos) {
  return [...infos.values()].some((i) => i.uri === URI_TEXTURE_STYLES);
}

// Replaced payloads are appended to the new mdat and already receive a fresh offset.
// Only untouched payloads that remain after meta need to move by meta's growth.
export function shouldShiftOriginalPayload(iid, external, replacements) {
  return external.has(iid) && !replacements.has(iid);
}

/** Prefer the source photo's skin masks; derive missing v2 directly from native legacy skin. */
export function preferNativeSkin(data, discovery, generated = new Map()) {
  const overrides = new Map(generated);
  const read = (uri) => {
    const iid = [...discovery.infos.keys()].find((id) => auxUriForItem(discovery.props, id) === uri);
    if (iid === undefined) return null;
    const [width, height] = dimensionsForItem(discovery.props, iid);
    const nativeProperties = (discovery.props.associations.get(iid) || []).map((a) => {
      const p = discovery.props.properties[a.index - 1];
      return { type: p.type, essential: a.essential,
        bytes: data.slice(p.box.off, p.box.off + p.box.size) };
    });
    return { payload: extractItem(data, discovery.iloc, iid), width, height, nativeProperties,
      hvcc: propertyBoxBytes(data, discovery.props, iid, "hvcC"),
      pixi: propertyBoxBytes(data, discovery.props, iid, "pixi") };
  };
  const legacy = read(MATTE_URIS.semanticskinmatte);
  const v2 = read(MATTE_2026_URIS[1]);
  if (legacy) overrides.set(MATTE_URIS.semanticskinmatte, legacy);
  if (v2 || legacy) overrides.set(MATTE_2026_URIS[1], v2 || legacy);
  return overrides;
}

/**
 * Add missing mattes and texture_styles, with source-native skin taking precedence.
 * Returns [meta, Map(itemId -> payload), summary].
 */
export function addTextureItems(meta, primary, {
  matteOverrides = new Map(), texturePeopleData = null,
} = {}) {
  const props0 = parseIpcoIpma(meta, topBox(meta, "meta"));
  if (props0.flags & 1) throw new Error("Wide ipma is not supported for adding Texture/Grain items");
  const infos = parseIinf(meta, topBox(meta, "meta"));
  const present = new Set([...infos.keys()].map((i) => auxUriForItem(props0, i)));
  const requests = MATTE_2026_URIS.filter((uri) => !present.has(uri))
    .map((uri) => ({ key: uri, uri, replacement: matteOverrides.get(uri) }));
  // Source-native legacy skin wins; generated skin is the fallback when it is absent.
  const skinV2 = matteOverrides.get(MATTE_2026_URIS[1]);
  const legacySkin = matteOverrides.get(MATTE_URIS.semanticskinmatte) || skinV2;
  if (legacySkin) {
    const uri = MATTE_URIS.semanticskinmatte;
    const existing = [...infos.keys()].filter((iid) => auxUriForItem(props0, iid) === uri);
    if (existing.length) {
      for (const iid of existing) requests.push({ key: `${uri}#${iid}`, uri, replacement: legacySkin, iid });
    } else requests.push({ key: uri, uri, replacement: legacySkin });
  }
  for (const [uri, replacement] of matteOverrides) {
    if (MATTE_2026_URIS.includes(uri) || present.has(uri)
        || (legacySkin && uri === MATTE_URIS.semanticskinmatte)) continue;
    if (Array.isArray(replacement.instances)) {
      replacement.instances.forEach((instance, i) => requests.push({
        key: `${uri}#${i}`, uri, replacement: instance,
      }));
    } else requests.push({ key: uri, uri, replacement });
  }
  const targets = [primary, ...findItemsByType(infos, "tmap").slice(0, 1)];
  const irot = propertyForItem(props0, primary, "irot");
  const imir = propertyForItem(props0, primary, "imir");
  const payloads = new Map();

  if (requests.length) {
    // auxC (descriptive) must precede irot (transformative), so associate in native order.
    let ispeI, pixiI, hvccI;
    [meta, ispeI] = appendIpcoProperty(meta, MATTE_ISPE);
    [meta, pixiI] = appendIpcoProperty(meta, MATTE_PIXI);
    [meta, hvccI] = appendIpcoProperty(meta, MATTE_HVCC);
    const specs = [];
    for (const request of requests) {
      const { key, uri, replacement } = request;
      let auxcI;
      [meta, auxcI] = appendIpcoProperty(meta, auxcBox(uri));
      let itemIspeI = ispeI, itemPixiI = pixiI, itemHvccI = hvccI;
      if (replacement && !replacement.nativeProperties) {
        if (replacement.width !== undefined || replacement.height !== undefined) {
          const { width, height } = replacement;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
            throw new Error("Invalid generated matte dimensions");
          [meta, itemIspeI] = appendIpcoProperty(meta,
            box("ispe", concat([be(0, 4), be(width, 4), be(height, 4)])));
        }
        [meta, itemPixiI] = appendIpcoProperty(meta, replacement.pixi || MATTE_PIXI);
        [meta, itemHvccI] = appendIpcoProperty(meta, replacement.hvcc);
      }
      const reuse = [[itemIspeI, false], [itemPixiI, false], [auxcI, true], [itemHvccI, true]];
      if (replacement?.nativeProperties) {
        reuse.length = 0;
        for (const property of replacement.nativeProperties) {
          let index = auxcI;
          if (property.type !== "auxC") {
            const current = parseIpcoIpma(meta, topBox(meta, "meta"));
            const match = current.properties.find((p) => bytesEqual(property.bytes,
              meta.subarray(p.box.off, p.box.off + p.box.size)));
            if (match) index = match.index;
            else [meta, index] = appendIpcoProperty(meta, property.bytes);
          }
          reuse.push([index, property.essential]);
        }
      } else {
        if (irot) reuse.push([irot.index, true]);
        if (imir) reuse.push([imir.index, true]);
      }
      if (request.iid !== undefined) {
        // Discard stale donor dimensions, colour and transforms on this item only.
        meta = setItemPropertyAssociations(meta, request.iid, reuse);
        payloads.set(request.iid, replacement.payload);
      } else specs.push({ key, reuse, refType: "auxl", refTo: targets });
    }
    const additions = requests.filter((request) => request.iid === undefined);
    let mattes, sidecars;
    [meta, mattes] = addItems(meta, specs);
    for (const request of additions)
      payloads.set(mattes.get(request.key), request.replacement?.payload || MATTE_EMPTY);
    [meta, sidecars] = addItems(meta, additions.map((request) => ({
      key: `xmp:${request.key}`, itemType: "mime", contentType: "application/rdf+xml",
      refType: "cdsc", refTo: [mattes.get(request.key)],
    })));
    for (const request of additions) {
      const iid = sidecars.get(`xmp:${request.key}`);
      payloads.set(iid, request.replacement?.referenceKey
        ? instanceXmp(request.replacement.referenceKey)
        : request.uri === MATTE_URIS.semanticskinmatte ? LEGACY_SKIN_XMP : MATTE_XMP);
    }
  }

  let tex;
  [meta, tex] = addItems(meta, [{
    key: "texture", itemType: "uri ", itemName: "metadata",
    contentType: URI_TEXTURE_STYLES, refType: "cdsc", refTo: targets,
  }]);
  payloads.set(tex.get("texture"), textureStylesWithPeople(texturePeopleData));
  const generated = requests.filter((request) => request.replacement && !request.replacement.nativeProperties).length;
  const reused = requests.filter((request) => request.replacement?.nativeProperties).length;
  const legacyUpdated = requests.filter((request) => request.iid !== undefined).length;
  return [meta, payloads, `added #${tex.get("texture")} -> [${targets}], ${requests.length - legacyUpdated} mattes, ${generated} generated, ${reused} source skin reused, ${legacyUpdated} legacy skin updated`];
}

/**
 * Native iPhone 16/17 style photo -> the same photo plus Texture/Grain. Existing image
 * payloads stay byte-identical, including source-native legacy skin; an older
 * styles plist is upgraded to the v16 schema required
 * by iOS 27's Glow/Film renderer, and new payloads go into one mdat appended at the end.
 */
export function addTexture(data, {
  matteOverrides = new Map(), personMetadata = null, texturePeopleData = null,
} = {}) {
  const d = discoverHeic(data);
  if (d.stylesItem === null) throw new Error("no native Photographic Style");
  if (hasTexture(d.infos)) throw new Error("already has texture_styles");
  const iloc = d.iloc;
  if (iloc.version !== 1 || iloc.offsetSize !== 4 || iloc.lengthSize !== 4
      || iloc.baseOffsetSize !== 0 || iloc.indexSize !== 0)
    throw new Error("unsupported iloc layout");
  const iref = findChild(metaChildren(data, d.meta), "iref");
  if (data[iref.off + iref.hdr] !== 0) throw new Error("unsupported iref version");
  const { off: mo, size: ms } = d.meta;
  const external = new Map([...iloc.items].filter(([, it]) =>
    it.constructionMethod === 0 && it.extents.length));
  for (const it of external.values())
    for (const e of it.extents)
      if (e.offset < mo + ms) throw new Error("payload before end of meta");

  const [newMeta, newPayloads, summary] = addTextureItems(
    data.slice(mo, mo + ms), d.primary,
    { matteOverrides: preferNativeSkin(data, d, matteOverrides), texturePeopleData });
  // Preserve every native scene/person statistic, but supply the v16 schema and identity tone
  // curve required when the iOS 27 Texture set activates Glow/Film rendering. IMG_4245 showed
  // that merely appending the v18 item set to a v14 plist makes both styles nearly black.
  const originalStyles = extractItem(data, iloc, d.stylesItem);
  const [styles, stylesUpgraded] = upgradeStylesV16(originalStyles);
  if (stylesUpgraded) newPayloads.set(d.stylesItem, styles);
  // Generated face statistics never replace the phone's native 2023 statistics here; they
  // belong in texture_styles; generated skin also updates the legacy skin auxiliary.
  void personMetadata;
  const delta = newMeta.length - ms;
  const metaOut = newMeta.slice();
  const niloc = parseIloc(metaOut, topBox(metaOut, "meta"));
  const tail = data.subarray(mo + ms);
  const cursor = mo + newMeta.length + tail.length + 8;
  const extra = [];
  let extraLen = 0;
  for (const iid of [...newPayloads.keys()].sort((a, b) => a - b)) {
    const e = niloc.items.get(iid).extents[0];
    metaOut.set(be(cursor + extraLen, 4), e.offsetPos);
    metaOut.set(be(newPayloads.get(iid).length, 4), e.lengthPos);
    extra.push(newPayloads.get(iid));
    extraLen += newPayloads.get(iid).length;
  }
  if (cursor + extraLen >= 2 ** 32) throw new Error("file too large for 32-bit offsets");
  for (const [iid, it] of niloc.items)
    if (shouldShiftOriginalPayload(iid, external, newPayloads))
      for (const e of it.extents) metaOut.set(be(e.offset + delta, 4), e.offsetPos);
  const result = concat([
    data.subarray(0, mo), metaOut, tail,
    be(8 + extraLen, 4), new Uint8Array([0x6d, 0x64, 0x61, 0x74]), ...extra,
  ]);

  // Self-check: every original payload byte-identical, every new one readable.
  const check = discoverHeic(result);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const iid of external.keys()) {
    if (!newPayloads.has(iid)
        && !same(extractItem(result, check.iloc, iid), extractItem(data, iloc, iid)))
      throw new Error(`self-check failed: item ${iid} changed`);
  }
  for (const [iid, blob] of newPayloads)
    if (!same(extractItem(result, check.iloc, iid), blob))
      throw new Error(`self-check failed: new item ${iid} unreadable`);
  return { data: result, report: {
    mode: "add-texture", texture: summary, metaGrowth: delta,
    generatedMattes: matteOverrides.size, personMasksValidHint: null, stylesUpgraded,
  } };
}
