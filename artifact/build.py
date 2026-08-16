"""Bundle the browser build into one self-contained page for a Claude Artifact.

This is NOT part of the GitHub Pages site — `web/` is the site, and nothing there
depends on anything here. The artifact needs its own shell because that sandbox
blocks relative fetches (so profiles are inlined) and blocks the libheif CDN (so
decoding falls back to the browser's own HEIC support).

Emits two files from one concatenation, so the published page runs exactly the code
the Node comparison test covers:

  build/bundle.core.mjs   modules only, re-exported, for tests/web/compare_bundle.mjs
  build/artifact.html     the same modules plus the artifact UI
"""
import base64
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
WEB = HERE.parent / "web"
BUILD = HERE / "build"
BUILD.mkdir(exist_ok=True)

# Dependency order.
MODULES = ["box.js", "bplist.js", "heif.js", "exif.js", "styles.js", "zip.js", "port.js"]

IMPORT_RE = re.compile(r'^import[\s\S]*?from\s+["\'][^"\']+["\'];?[ \t]*$', re.M)
EXPORT_BLOCK_RE = re.compile(r'^export\s*\{[^}]*\};?[ \t]*$', re.M)
EXPORT_DECL_RE = re.compile(r'^export\s+(?=(?:const|let|var|function|class|async)\b)', re.M)


def strip_module(text: str) -> str:
    text = IMPORT_RE.sub("", text)
    text = EXPORT_BLOCK_RE.sub("", text)
    text = EXPORT_DECL_RE.sub("", text)
    return text.strip()


core = "\n\n".join(f"// ---- {m} ----\n{strip_module((WEB / 'src' / m).read_text(encoding='utf-8'))}"
                   for m in MODULES)

EXPORTS = "export { patch, selectProfile, loadProfile, discoverHeic, VERSION };"
(BUILD / "bundle.core.mjs").write_text(core + "\n\n" + EXPORTS + "\n", encoding="utf-8")

profiles = {}
index = json.loads((WEB / "profiles" / "index.json").read_text(encoding="utf-8"))
for name, info in index.items():
    raw = (WEB / "profiles" / info["file"]).read_bytes()
    profiles[name] = {"b64": base64.b64encode(raw).decode("ascii"),
                      "primary_tiles": info["primary_tiles"], "hdr_tiles": info["hdr_tiles"]}

profile_js = "const PROFILE_DATA = {\n" + "".join(
    f'  "{n}": {{ primary_tiles: {p["primary_tiles"]}, hdr_tiles: {p["hdr_tiles"]}, '
    f'b64: "{p["b64"]}" }},\n' for n, p in profiles.items()) + "};\n"

html = (HERE / "template.html").read_text(encoding="utf-8")
app = (HERE / "app.js").read_text(encoding="utf-8")
script = f"{core}\n\n{profile_js}\n{app}"
out = html.replace("/*__BUNDLE__*/", script)
(BUILD / "artifact.html").write_text(out, encoding="utf-8")

print(f"bundle.core.mjs  {len((BUILD / 'bundle.core.mjs').read_text(encoding='utf-8')):,} chars")
print(f"artifact.html    {len(out):,} chars  ({len(out)/1024:.0f} KB)")
