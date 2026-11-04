// Turn low-level HEIF/parser failures into stable user-facing categories.  The complete Error
// is still logged to the console by app.js; this module only decides which useful explanation
// belongs in the result row.

export function diagnosePortError(error) {
  const message = String(error?.message || error || "Unknown error");
  const lower = message.toLowerCase();
  if (/8-bit linear thumbnail/.test(lower))
    return { code: "linear8", detail: message };

  if (/unsupported tile layout|tile count mismatch/.test(lower)) {
    const counts = message.match(/(\d+)\s*(?:primary)?\s*[\/]\s*(\d+)\s*hdr/i);
    return { code: "layout", detail: counts ? `${counts[1]}/${counts[2]}` : "" };
  }
  if (/hdr gain|hdr grid|hdr tiles|missing hdr/.test(lower))
    return { code: "hdr", detail: "" };
  if (/exif|makernote|tiff|apple ios/.test(lower))
    return { code: "metadata", detail: "" };
  if (/profile fetch|profile index|not a donor profile|not a zip|bad central directory|profile is missing/.test(lower))
    return { code: "profile", detail: "" };
  if (/file too large|32-bit offsets/.test(lower))
    return { code: "size", detail: "" };
  if (/self-check failed/.test(lower))
    return { code: "integrity", detail: "" };
  if (/hevc webcodecs encoder unavailable|hevc encoder returned/.test(lower))
    return { code: "encoder", detail: "" };
  if (/raster image decode failed|raster import canvas/.test(lower))
    return { code: "raster", detail: "" };
  if (/iloc|iref|ipma|grid\/dimg|construction_method|missing top-level|missing child|property index|payload before end of meta|truncated|unsupported .*layout|unsupported .*version/.test(lower))
    return { code: "structure", detail: message };
  return { code: "unexpected", detail: message };
}
