import { discoverHeic, removeItems, parseIloc, extractItemData } from "./heif.js?v=0.6.0-web";
import { topBox, concat, be, bytesEqual } from "./box.js?v=0.6.0-web";

/** Decode the preserved SDR primary, without asking the browser to apply HDR/styles. */
export function isolatePrimaryImage(data) {
  const source = discoverHeic(data), keep = new Set([source.primary, ...source.primaryTiles]);
  const removed = [...source.infos.keys()].filter(id => !keep.has(id));
  const { off, size } = source.meta;
  const meta = removeItems(data.slice(off, off + size), removed);
  const growth = meta.length - size, iloc = parseIloc(meta, topBox(meta, "meta"));
  for (const item of iloc.items.values()) if (item.constructionMethod === 0) for (const extent of item.extents) {
    if (item.baseOffset + extent.offset < off + size) throw new Error("Primary decode payload overlaps metadata");
    const offset = extent.offset + growth;
    if (!iloc.offsetSize || offset < 0 || offset >= 2 ** (iloc.offsetSize * 8)) throw new Error("Primary decode offset exceeds capacity");
    meta.set(be(offset, iloc.offsetSize), extent.offsetPos);
  }
  const result = concat([data.subarray(0, off), meta, data.subarray(off + size)]), check = discoverHeic(result);
  if (check.hdrGrid !== null || check.deltaGrid !== null || check.stylesItem !== null || check.linearThumb !== null)
    throw new Error("Primary decode isolation failed");
  for (const id of keep) if (!bytesEqual(extractItemData(data, source, id), extractItemData(result, check, id)))
    throw new Error(`Primary decode payload changed: ${id}`);
  return result;
}
