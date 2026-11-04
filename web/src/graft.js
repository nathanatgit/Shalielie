// v0.6.2: the style items go into the photo's OWN item graph. Port of graft_style_graph /
// patch_with_photo_graph in photographic_style_port.py (see the comments there); every step
// runs in the same order with the same bytes, so both builds write identical files.

import { topBox, be, concat, slice, box, boxes, metaChildren, findChild } from "./box.js";
import {
  parseIloc, parseIpcoIpma, extractItem, propertyForItem, propertyBoxBytes, dimensionsForItem,
  auxUriForItem, irotAngleForItem, imirAxisForItem, findItemsByType, appendIpcoProperty,
  addItems, auxcBox, ispeBox, refBox, discoverHeic, URI_STYLE_DELTA, URI_LINEAR_THUMB,
  URI_STYLES, MATTE_URI_SET, DEPTH_URI,
} from "./heif.js";
import { injectAppleMakerNoteTag } from "./exif.js";
import { addTextureItems, softSkinPeople, filmGrainSeed } from "./texture.js";
import {
  applySceneStatistics, applyLightMaps, setPersonMasksValid, buildLightMaps,
  linearLumaFromRgb, LIGHTMAP_N,
} from "./styles.js";

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));

// V11-tested neutral 512x512 Main10 StyleDeltaMap tile and its hvcC.
const NEUTRAL_DELTA_SAMPLE = hex(
  "000000632801af1d1058ad4a4a11f7015bd6bec7001fd1329415a22692009480a"
  + "971ca05188127800000cf80930d94200000030000a280870000030000030000fa80"
  + "000003000003000039e000000300000300025a000003000003000a680000030000"
  + "03001e10");
const NEUTRAL_DELTA_HVCC = hex(
  "00000076687663430102200000009000000000005af000fcfdfafa00000f03a000"
  + "01001840010c01ffff02200000030090000003000003005a959809a10001002942"
  + "010102200000030090000003000003005aa0040200804d96566924cae680800000"
  + "03008000000c84a2000100074401c172b46240");
const STYLE_PIXI_10BIT = hex("000000107069786900000000030a0a0a");
const STYLE_DELTA_COLR = b64(
  "AAACPGNvbHJwcm9mAAACMGFwcGwEAAAAbW50clJHQiBYWVogB+MAAQABAAAAAAAAYWNzcEFQUEwAAAAAQVBQ"
  + "TAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1hcHBsX7/VQcvuTpXllWLEtDLoDwAAAAAAAAAAAAAAAAAA"
  + "AAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA+Y3BydAAAAUgAAABQd3RwdAAAAZgAAAAUclhZWgAAAawA"
  + "AAAUZ1hZWgAAAcAAAAAUYlhZWgAAAdQAAAAUclRSQwAAAegAAAAQY2hhZAAAAfgAAAAsY2ljcAAAAiQAAAAM"
  + "YlRSQwAAAegAAAAQZ1RSQwAAAegAAAAQbWx1YwAAAAAAAAABAAAADGVuVVMAAAAiAAAAHABEAGkAcwBwAGwA"
  + "YQB5ACAAUAAzACAATABpAG4AZQBhAHIAAG1sdWMAAAAAAAAAAQAAAAxlblVTAAAANAAAABwAQwBvAHAAeQBy"
  + "AGkAZwBoAHQAIABBAHAAcABsAGUAIABJAG4AYwAuACwAIAAyADAAMQA5WFlaIAAAAAAAAPbWAAEAAAAA0y1Y"
  + "WVogAAAAAAAAg98AAD2/////u1hZWiAAAAAAAABKvwAAsTcAAAq5WFlaIAAAAAAAACg4AAARCwAAyLlwYXJh"
  + "AAAAAAAAAAAAAQAAc2YzMgAAAAAAAQxCAAAF3v//8yYAAAeTAAD9kP//+6L///2jAAAD3AAAwG5jaWNwAAAA"
  + "AAwIAAE=");
const STYLE_BRANDS = ["MiHA", "heix"];
// 48 MP natives tile their 5760x4320 map 640x896; 512x512 tiles trimmed by the grid cover it
// equally, and reuse the one neutral tile.
const STYLE_DELTA_SIZES = [[4032, 3024, 2880, 2160], [5712, 4284, 4096, 3072], [3088, 2316, 2240, 1680],
                           [8064, 6048, 5760, 4320]];
const STYLE_LINEAR_THUMB = [1024, 768];

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** StyleDeltaMap size for a primary of this stored size, or null when none is known. */
/**
 * StyleDeltaMap size for a primary of any size (Any Image): the native 2880x2160 map (2160x2880
 * upright) scaled to the photo's aspect ratio, never larger than the photo, as PR #4's import
 * does. Native files of other sizes have not been seen, so this is a guess. See
 * generic_style_delta_size in photographic_style_port.py.
 */
/** Python's round(): halves go to the even neighbour, so both builds pick the same size. */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function genericStyleDeltaSize(width, height) {
  const [bw, bh] = width >= height ? [2880, 2160] : [2160, 2880];
  const scale = Math.min(bw / width, bh / height, 1);
  const even = (n) => Math.max(2, roundHalfEven(n * scale / 2) * 2);
  return [even(width), even(height)];
}

export function styleDeltaSize(width, height) {
  for (const [w, h, dw, dh] of STYLE_DELTA_SIZES) {
    if (w === width && h === height) return [dw, dh];
    if (h === width && w === height) return [dh, dw];
  }
  return null;
}

function ftypWithStyleBrands(ftyp) {
  const brands = [];
  for (let i = 16; i < ftyp.length; i += 4) brands.push(String.fromCharCode(...ftyp.subarray(i, i + 4)));
  const missing = STYLE_BRANDS.filter((b) => !brands.includes(b));
  if (!missing.length) return ftyp;
  const at = brands.includes("MiHB") ? brands.indexOf("MiHB") + 1 : brands.length;
  const out = [...brands.slice(0, at), ...missing, ...brands.slice(at)];
  return box("ftyp", concat([ftyp.subarray(8, 16), ...out.map(ascii)]));
}

function appendIref(meta, refBoxBytes) {
  const mb = topBox(meta, "meta");
  const ir = findChild(metaChildren(meta, mb), "iref");
  const newIref = box("iref", concat([slice(meta, ir.off + ir.hdr, ir.size - ir.hdr), refBoxBytes]));
  const rebuilt = [slice(meta, mb.off + mb.hdr, 4)];
  for (const b of boxes(meta, mb.off + mb.hdr + 4, mb.off + mb.size))
    rebuilt.push(b.type === "iref" ? newIref : slice(meta, b.off, b.size));
  return box("meta", concat(rebuilt));
}

function moveItemToIdat(meta, iid, payload) {
  const mb = topBox(meta, "meta");
  const iloc = parseIloc(meta, mb);
  if (iloc.version !== 1 || iloc.baseOffsetSize !== 0 || iloc.indexSize !== 0)
    throw new Error("Unsupported iloc layout for an idat item");
  const e = iloc.items.get(iid).extents[0];
  const idat = findChild(metaChildren(meta, mb), "idat");
  if (idat.hdr !== 8 || mb.hdr !== 8) throw new Error("64-bit meta/idat box sizes are not supported");
  const m = meta.slice();
  const cmPos = e.offsetPos - 6;
  m[cmPos + 1] = (m[cmPos + 1] & 0xf0) | 1;
  m.set(be(idat.size - idat.hdr, iloc.offsetSize), e.offsetPos);
  m.set(be(payload.length, iloc.lengthSize), e.lengthPos);
  const end = idat.off + idat.size;
  const out = concat([m.subarray(0, end), payload, m.subarray(end)]);
  out.set(be(idat.size + payload.length, 4), idat.off);
  out.set(be(mb.size + payload.length, 4), mb.off);
  return out;
}

function rebuildHeic(data, d, ftyp, meta, payloads) {
  const ft = topBox(data, "ftyp");
  const mo = d.meta.off, ms = d.meta.size;
  if (ft.off !== 0 || mo < ft.size) throw new Error("Expected ftyp first and meta after it");
  const old = d.iloc.items;
  for (const it of old.values())
    if (it.constructionMethod === 0)
      for (const e of it.extents)
        if (e.offset < mo + ms) throw new Error("payload before end of meta");
  const shift = (ftyp.length - ft.size) + (meta.length - ms);
  const head = concat([ftyp, data.subarray(ft.size, mo)]);
  const tail = data.subarray(mo + ms);
  const m = meta.slice();
  const niloc = parseIloc(m, topBox(m, "meta"));
  if (niloc.offsetSize !== 4 || niloc.lengthSize !== 4) throw new Error("unsupported iloc layout");
  const cursor = head.length + m.length + tail.length + 8;
  const extra = [];
  let extraLen = 0;
  for (const iid of [...niloc.items.keys()].sort((a, b) => a - b)) {
    const it = niloc.items.get(iid);
    if (it.constructionMethod !== 0 || !it.extents.length) continue;
    if (payloads.has(iid)) {
      const e = it.extents[0];
      m.set(be(cursor + extraLen, 4), e.offsetPos);
      m.set(be(payloads.get(iid).length, 4), e.lengthPos);
      extra.push(payloads.get(iid));
      extraLen += payloads.get(iid).length;
    } else if (old.has(iid)) {
      it.extents.forEach((e, k) => m.set(be(old.get(iid).extents[k].offset + shift, 4), e.offsetPos));
    }
  }
  if (cursor + extraLen >= 2 ** 32) throw new Error("file too large for 32-bit offsets");
  const parts = [head, m, tail];
  if (extraLen) parts.push(be(8 + extraLen, 4), ascii("mdat"), ...extra);
  const result = concat(parts);

  const check = discoverHeic(result);
  for (const [iid, it] of old)
    if (it.constructionMethod === 0 && !payloads.has(iid)
        && !same(extractItem(result, check.iloc, iid), extractItem(data, d.iloc, iid)))
      throw new Error(`self-check failed: item ${iid} changed`);
  for (const [iid, blob] of payloads)
    if (!same(extractItem(result, check.iloc, iid), blob))
      throw new Error(`self-check failed: item ${iid} unreadable`);
  return result;
}

/** graft_style_graph: returns [bytes, report]. */
export function graftStyleGraph(targetData, td, stylesBlob, mn54, mn54Type, linearThumb, texture = true,
  extra = {}) {
  const props = td.props;
  const primary = td.primary;
  const [pw, ph] = dimensionsForItem(props, primary);
  const size = extra.generic ? genericStyleDeltaSize(pw, ph) : styleDeltaSize(pw, ph);
  if (!size) throw new Error(`No StyleDeltaMap size known for a ${pw}x${ph} primary`);
  const [dw, dh] = size;
  const cols = Math.ceil(dw / 512), rows = Math.ceil(dh / 512);
  const irot = propertyForItem(props, primary, "irot");
  const rot = irot ? [[irot.index, true]] : [];
  const targets = [primary, ...findItemsByType(td.infos, "tmap").slice(0, 1)];
  let meta = targetData.slice(td.meta.off, td.meta.off + td.meta.size);
  if (parseIpcoIpma(meta, topBox(meta, "meta")).flags & 1) throw new Error("Wide ipma is not supported");

  let colrI, pixiI, dIspe, dAuxc, tIspe, tHvcc, lIspe, lPixi, lAuxc, lHvcc;
  [meta, colrI] = appendIpcoProperty(meta, STYLE_DELTA_COLR);
  [meta, pixiI] = appendIpcoProperty(meta, STYLE_PIXI_10BIT);
  [meta, dIspe] = appendIpcoProperty(meta, ispeBox(dw, dh));
  [meta, dAuxc] = appendIpcoProperty(meta, auxcBox(URI_STYLE_DELTA));
  [meta, tIspe] = appendIpcoProperty(meta, ispeBox(512, 512));
  [meta, tHvcc] = appendIpcoProperty(meta, NEUTRAL_DELTA_HVCC);
  [meta, lIspe] = appendIpcoProperty(meta, linearThumb.ispe);
  lPixi = pixiI;
  if (!same(linearThumb.pixi, STYLE_PIXI_10BIT)) [meta, lPixi] = appendIpcoProperty(meta, linearThumb.pixi);
  [meta, lAuxc] = appendIpcoProperty(meta, auxcBox(URI_LINEAR_THUMB));
  [meta, lHvcc] = appendIpcoProperty(meta, linearThumb.hvcC);

  let lt, tiles, grid, st;
  [meta, lt] = addItems(meta, [{ key: "lt", refType: "auxl", refTo: targets,
    reuse: [[lIspe, false], ...rot, [lPixi, false], [lAuxc, true], [lHvcc, true]] }]);
  [meta, tiles] = addItems(meta, Array.from({ length: rows * cols }, (_, n) => ({
    key: `t${n}`, reuse: [[tIspe, true], [colrI, true], [tHvcc, true]] })));
  const tileIds = Array.from({ length: rows * cols }, (_, n) => tiles.get(`t${n}`));
  [meta, grid] = addItems(meta, [{ key: "grid", itemType: "grid", refType: "auxl", refTo: targets,
    reuse: [[colrI, true], [dIspe, false], ...rot, [pixiI, false], [dAuxc, true]] }]);
  meta = appendIref(meta, refBox("dimg", grid.get("grid"), tileIds));
  meta = moveItemToIdat(meta, grid.get("grid"),
    concat([new Uint8Array([0, 0, rows - 1, cols - 1]), be(dw, 2), be(dh, 2)]));
  [meta, st] = addItems(meta, [{ key: "styles", itemType: "uri ", itemName: "metadata",
    contentType: URI_STYLES, refType: "cdsc", refTo: targets }]);

  const payloads = new Map([
    [lt.get("lt"), linearThumb.sample], [st.get("styles"), stylesBlob],
    [td.exifItem, injectAppleMakerNoteTag(extractItem(targetData, td.iloc, td.exifItem), mn54, 0x54, mn54Type)],
  ]);
  for (const t of tileIds) payloads.set(t, NEUTRAL_DELTA_SAMPLE);
  const report = { graph: "photo", styleDeltaMap: [dw, dh, rows, cols] };
  if (texture) {
    let texPayloads, summary;
    [meta, texPayloads, summary] = addTextureItems(meta, primary, extra.people || softSkinPeople(targetData, td),
      filmGrainSeed(targetData, td));
    for (const [iid, blob] of texPayloads) payloads.set(iid, blob);
    report.texture = summary;
  } else report.texture = "off";
  const ft = topBox(targetData, "ftyp");
  const ftyp = ftypWithStyleBrands(targetData.subarray(0, ft.size));
  return [rebuildHeic(targetData, td, ftyp, meta, payloads), report];
}

/** patch_with_photo_graph, browser flavour: reuse-thumbnail, optional decode for statistics. */
export async function graftPatch(targetData, profile, opts = {}) {
  const td = discoverHeic(targetData);
  const { manifest } = profile;
  const report = { warnings: [] };
  const primary = td.primary;
  const angle = irotAngleForItem(targetData, td.props, primary);
  const mirror = imirAxisForItem(targetData, td.props, primary);
  const thumb = td.thumbnail;
  const linearThumb = {
    sample: extractItem(targetData, td.iloc, thumb),
    hvcC: propertyBoxBytes(targetData, td.props, thumb, "hvcC"),
    ispe: propertyBoxBytes(targetData, td.props, thumb, "ispe"),
    pixi: propertyBoxBytes(targetData, td.props, thumb, "pixi"),
  };
  let blob = profile.retained.get(Number(manifest.donor_styles_item));

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
      sorted = Array.from(linearLumaFromRgb(await measure({ width: 256, height: 192 })))
        .sort((a, b) => a - b);
      report.decoded = true;
    } catch (e) { report.decodeError = (e && e.message) || String(e); }
  }
  const [b1, sr] = applySceneStatistics(blob, sorted ? (opts.sceneStats || "target") : "donor", sorted);
  blob = b1;
  report.sceneStats = sr;
  if (opts.decode && opts.lightMaps === "target" && report.decoded) {
    try {
      const grid = await measure({ width: LIGHTMAP_N, height: LIGHTMAP_N, angle, mirror });
      const [c, dmap] = buildLightMaps(linearLumaFromRgb(grid));
      const [b2, mr] = applyLightMaps(blob, c, dmap);
      blob = b2;
      report.lightMaps = mr;
    } catch (e) { report.decodeError = (e && e.message) || String(e); }
  }
  if ([...td.infos.keys()].some((i) => MATTE_URI_SET.has(auxUriForItem(td.props, i)))) {
    const [b3, before] = setPersonMasksValid(blob);
    blob = b3;
    report.personMasksValidHint = `${before} -> 1.0`;
  }
  // Same report shape as the donor path, which the app reads: here the photo's own mattes
  // and depth simply stay where they are.
  const auxNames = (pred) => [...td.infos.keys()]
    .map((i) => auxUriForItem(td.props, i)).filter((u) => u && pred(u)).map((u) => u.split(":").pop());
  report.mattes = {
    transplanted: auxNames((u) => MATTE_URI_SET.has(u)),
    added: auxNames((u) => u === DEPTH_URI).map(() => "depth"),
    neutralized: [], emptied: [],
  };
  const [data, gr] = graftStyleGraph(targetData, td, blob, profile.mn54,
    Number(manifest.smartstyle_makernote_type ?? 7), linearThumb, opts.texture !== false,
    { generic: !!opts.generic, people: opts.people });
  return { data, report: { ...report, ...gr } };
}
