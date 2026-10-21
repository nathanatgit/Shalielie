#!/usr/bin/env python3
"""Shalielie Shortcut Server -- run the porter on this computer for iPhone Shortcuts.

An iOS shortcut POSTs a photo to http://shalielie.local:8765/patch and gets the patched
HEIC back. The server runs the unmodified photographic_style_port.py in a subprocess, so
results are exactly those of the command-line tool, including the default encoder mode
(ffmpeg + heif-convert) that the phone cannot run on its own.

Standard library only, apart from the optional `zeroconf` package that advertises the
`shalielie.local` name over mDNS. Without it the server still works by IP address.

Nothing is kept: each photo goes into a temporary directory that is deleted as soon as
the response is sent.
"""
from __future__ import annotations

import argparse
import ipaddress
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
import zipfile
from email import policy
from email.parser import BytesParser
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PORTER = REPO / "photographic_style_port.py"
TOOLS = REPO / "tools"
INDEX_HTML = HERE / "index.html"

DEFAULT_PORT = 8765
DEFAULT_HOSTNAME = "shalielie"
MAX_UPLOAD = 200 * 1024 * 1024  # a 48 MP ProRAW-sized HEIC is well under this
PORT_TIMEOUT = 600

# The validated no-encoder mode from the README, for machines without ffmpeg/libheif.
NO_ENCODER_FLAGS = ["--linear-thumb", "reuse-thumbnail", "--scene-stats", "donor",
                    "--light-maps", "flat"]

HEIF_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"}

# Adapters an iPhone on the same Wi-Fi cannot reach: proxies' TUN devices (Clash/Mihomo
# claim 198.18.0.0/15), overlay VPNs, hypervisor NICs. Advertising one of these as
# shalielie.local would send the phone nowhere.
VIRTUAL_ADAPTER = re.compile(
    r"tunnel|tun\b|\btap\b|wintun|virtual|vpn|zerotier|tailscale|wireguard|vmware|"
    r"virtualbox|hyper-v|vethernet|wsl|docker|meta|clash|mihomo|bluetooth|loopback|utun",
    re.IGNORECASE)
UNREACHABLE_NETS = [ipaddress.ip_network(n) for n in
                    ("198.18.0.0/15", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8")]


def porter_version() -> str:
    m = re.search(r'^VERSION\s*=\s*"([^"]+)"', PORTER.read_text(encoding="utf-8"), re.M)
    return m.group(1) if m else "unknown"


# ---------------------------------------------------------------------------
# Environment: which porter mode this machine can run
# ---------------------------------------------------------------------------

def tool_env() -> dict:
    """The porter's environment: repo tools/ first, so the Windows heif-convert shim resolves."""
    env = dict(os.environ)
    env["PATH"] = str(TOOLS) + os.pathsep + env.get("PATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def detect_tools() -> dict:
    path = tool_env()["PATH"]
    ffmpeg = shutil.which("ffmpeg", path=path)
    heif = shutil.which("heif-convert", path=path)
    shim_ok = True
    if heif and Path(heif).resolve().parent == TOOLS.resolve():
        # The shim is only a wrapper; it needs pillow-heif in the project venv.
        venv_py = REPO / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        py = str(venv_py) if venv_py.exists() else sys.executable
        shim_ok = subprocess.run([py, "-c", "import pillow_heif"],
                                 capture_output=True).returncode == 0
        if not shim_ok:
            heif = None
    return {"ffmpeg": ffmpeg, "heif_convert": heif, "shim_ok": shim_ok}


# ---------------------------------------------------------------------------
# Network: LAN addresses and the mDNS name
# ---------------------------------------------------------------------------

def lan_addresses() -> list[str]:
    """Private IPv4 addresses on physical adapters, best guess first."""
    found: list[str] = []
    try:
        import ifaddr  # installed alongside zeroconf
        for adapter in ifaddr.get_adapters():
            if VIRTUAL_ADAPTER.search(adapter.nice_name or ""):
                continue
            for ip in adapter.ips:
                if isinstance(ip.ip, str):
                    found.append(ip.ip)
    except ImportError:
        # Without ifaddr, ask the OS which address the default route would use.
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.168.255.255", 1))
                found.append(s.getsockname()[0])
        except OSError:
            pass
    good = []
    for a in found:
        ip = ipaddress.ip_address(a)
        if ip.is_private and not any(ip in n for n in UNREACHABLE_NETS) and a not in good:
            good.append(a)
    # Home routers hand out 192.168.x.x; prefer those over 10.x / 172.16.x.
    good.sort(key=lambda a: (not a.startswith("192.168."), a))
    return good


class Mdns:
    def __init__(self, hostname: str, port: int, addresses: list[str]):
        self.hostname = hostname
        self.zc = None
        self.info = None
        self.error = None
        try:
            from zeroconf import IPVersion, ServiceInfo, Zeroconf
        except ImportError:
            self.error = "zeroconf is not installed"
            return
        if not addresses:
            self.error = "no LAN address found"
            return
        try:
            self.info = ServiceInfo(
                "_http._tcp.local.",
                "Shalielie Shortcut Server._http._tcp.local.",
                addresses=[socket.inet_aton(a) for a in addresses],
                port=port,
                server=f"{hostname}.local.",
                properties={"path": "/"},
            )
            self.zc = Zeroconf(ip_version=IPVersion.V4Only)
            self.zc.register_service(self.info, allow_name_change=True)
        except Exception as e:  # noqa: BLE001 -- any mDNS failure just means "use the IP"
            self.error = str(e) or type(e).__name__
            self.close()

    @property
    def ok(self) -> bool:
        return self.zc is not None and self.error is None

    def close(self):
        if self.zc is not None:
            try:
                if self.info is not None:
                    self.zc.unregister_service(self.info)
                self.zc.close()
            except Exception:  # noqa: BLE001
                pass
            self.zc = None


# ---------------------------------------------------------------------------
# Porting
# ---------------------------------------------------------------------------

class PortFailure(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def sniff(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[4:8] == b"ftyp":
        brands = {data[8:12]} | {data[i:i + 4] for i in range(16, min(len(data), 64), 4)}
        return "heic" if brands & HEIF_BRANDS else "other-iso"
    return "unknown"


def safe_stem(name: str | None) -> str:
    stem = Path(name or "").stem if name else ""
    stem = re.sub(r"[^\w.-]+", "_", stem, flags=re.UNICODE).strip("._")
    return stem[:80] or time.strftime("IMG_%Y%m%d_%H%M%S")


class Porter:
    def __init__(self, full_mode: bool):
        self.full_mode = full_mode
        self.lock = threading.Lock()
        self.jobs: deque[dict] = deque(maxlen=25)
        self.busy = False

    def run(self, data: bytes, name: str | None, client: str) -> tuple[bytes, str, dict]:
        kind = sniff(data)
        if kind == "jpeg":
            raise PortFailure(HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                              "Received a JPEG, not the original HEIC. iOS converted the photo "
                              "before sending it. Check the shortcut sends the photo itself, "
                              "and that Camera > Formats is set to High Efficiency.")
        if kind != "heic":
            raise PortFailure(HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                              f"Not a HEIC photo (looks like {kind}). Send an original iPhone HEIC.")

        stem = safe_stem(name)
        out_name = f"{stem}_PhotographicStyle.HEIC"
        job = {"time": time.strftime("%H:%M:%S"), "client": client, "name": stem,
               "bytes": len(data), "status": "running", "detail": "", "seconds": None}
        self.jobs.appendleft(job)
        started = time.monotonic()
        with self.lock, tempfile.TemporaryDirectory(prefix="shalielie-") as tmp:
            self.busy = True
            try:
                src, dst = Path(tmp) / "in.HEIC", Path(tmp) / "out.HEIC"
                src.write_bytes(data)
                cmd = [sys.executable, str(PORTER), "patch", str(src), str(dst), "--report"]
                if not self.full_mode:
                    cmd += NO_ENCODER_FLAGS
                try:
                    proc = subprocess.run(cmd, cwd=tmp, env=tool_env(), capture_output=True,
                                          encoding="utf-8", errors="replace",
                                          timeout=PORT_TIMEOUT)
                except subprocess.TimeoutExpired:
                    self._fail(job, started, "timed out")
                    raise PortFailure(HTTPStatus.GATEWAY_TIMEOUT, "The porter timed out.")
                if proc.returncode != 0 or not dst.exists():
                    msg = _porter_error(proc.stderr) or "The porter failed without a message."
                    self._fail(job, started, msg)
                    # "already has ..." = nothing to do (iPhone 18, or a photo patched twice)
                    status = (HTTPStatus.CONFLICT if "already" in msg
                              else HTTPStatus.UNPROCESSABLE_ENTITY)
                    raise PortFailure(status, msg)
                report = {}
                rpath = Path(str(dst) + ".report.json")
                if rpath.exists():
                    try:
                        report = json.loads(rpath.read_text(encoding="utf-8"))
                    except ValueError:
                        pass
                result = dst.read_bytes()
            finally:
                self.busy = False
        route = "add-texture" if report.get("mode") == "add-texture" else "port"
        job.update(status="ok", route=route, seconds=round(time.monotonic() - started, 1))
        return result, out_name, report

    def run_live(self, photo: bytes, video: bytes, name: str | None, client: str):
        """Return a HEIC+MOV ZIP. Use the same CLI video correction as drag and drop."""
        if video[4:8] != b"ftyp" or video[8:12] in HEIF_BRANDS:
            raise PortFailure(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "The video field must hold an original MOV.")
        try:
            result, out_name, photo_report = self.run(photo, name, client)
        except PortFailure as error:
            if error.status != HTTPStatus.CONFLICT or "already carries texture_styles" not in error.message:
                raise
            result, out_name, photo_report = photo, safe_stem(name) + "_PhotographicStyle.HEIC", {"mode": "unchanged"}
        with self.lock, tempfile.TemporaryDirectory(prefix="shalielie-live-") as tmp:
            self.busy = True
            try:
                folder = Path(tmp)
                still, source, output = folder / "photo.HEIC", folder / "original.MOV", folder / "styled.MOV"
                still.write_bytes(result)
                source.write_bytes(video)
                report_file = folder / "video-report.json"
                cmd = [sys.executable, str(PORTER), "patch-video", str(source), str(output),
                       "--photo", str(still), "--report", str(report_file)]
                try:
                    process = subprocess.run(cmd, cwd=tmp, env=tool_env(), capture_output=True,
                                             encoding="utf-8", errors="replace", timeout=PORT_TIMEOUT)
                except subprocess.TimeoutExpired:
                    raise PortFailure(HTTPStatus.GATEWAY_TIMEOUT, "Live Photo video processing timed out.")
                if process.returncode or not output.exists():
                    raise PortFailure(HTTPStatus.UNPROCESSABLE_ENTITY,
                                      _porter_error(process.stderr) or "Live Photo video processing failed.")
                video_report = json.loads(report_file.read_text(encoding="utf-8"))
                archive = io.BytesIO()
                with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as z:
                    z.writestr(out_name, result)
                    z.writestr(Path(out_name).with_suffix(".MOV").name, output.read_bytes())
                    z.writestr("report.json", json.dumps({"photo": photo_report, "video": video_report}, indent=2))
                return archive.getvalue(), Path(out_name).with_suffix(".zip").name, video_report
            finally:
                self.busy = False

    @staticmethod
    def _fail(job: dict, started: float, msg: str):
        job.update(status="error", detail=msg, seconds=round(time.monotonic() - started, 1))


def _porter_error(stderr: str) -> str:
    lines = [ln.strip() for ln in (stderr or "").splitlines() if ln.strip()]
    for ln in reversed(lines):
        if ln.startswith("ERROR:"):
            return ln[len("ERROR:"):].strip()
    return lines[-1] if lines else ""


def parse_multipart(body: bytes, content_type: str) -> tuple[bytes | None, str | None]:
    """First file part of a multipart/form-data body, as (data, filename)."""
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        return None, None
    delim = b"--" + m.group(1).encode("latin-1")
    fallback = (None, None)
    for part in body.split(delim)[1:]:
        if part.startswith(b"--"):
            break
        head, sep, payload = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        headers = head.decode("utf-8", "replace")
        fn = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";\r\n]*)"?', headers, re.I)
        if fn:
            return payload, fn.group(1)
        if fallback[0] is None and payload:
            fallback = (payload, None)
    return fallback


def parse_live_multipart(body: bytes, content_type: str):
    message = BytesParser(policy=policy.default).parsebytes(
        ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("utf-8") + body)
    fields = {}
    if message.is_multipart():
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if name in ("photo", "video"):
                if name in fields:
                    raise ValueError("Each of photo and video must be supplied exactly once.")
                fields[name] = (part.get_payload(decode=True), part.get_filename())
    if set(fields) != {"photo", "video"} or any(not value[0] for value in fields.values()):
        raise ValueError("Send multipart File fields named photo (HEIC) and video (MOV).")
    return fields


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class State:
    porter: Porter
    tools: dict
    mdns: Mdns
    port: int
    addresses: list[str]
    version: str


def is_local_client(addr: str) -> bool:
    ip = ipaddress.ip_address(addr)
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_private or ip.is_loopback or ip.is_link_local


class Handler(BaseHTTPRequestHandler):
    server_version = "ShalielieShortcutServer"
    state: State  # set on the class in main()

    def log_message(self, fmt, *args):  # quieter than the default
        pass

    # -- helpers --
    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _text(self, status: int, msg: str):
        self._send(status, (msg + "\n").encode("utf-8"), "text/plain; charset=utf-8",
                   {"X-Shalielie-Status": "error"})

    def _json(self, obj):
        self._send(200, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _guard(self) -> bool:
        if not is_local_client(self.client_address[0]):
            self._text(403, "This server only answers devices on the local network.")
            return False
        return True

    # -- routes --
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._guard():
            return
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self._send(200, INDEX_HTML.read_bytes(), "text/html; charset=utf-8")
        elif path == "/api/status":
            self._json(status_payload(self.state))
        elif path == "/patch":
            self._text(405, "POST a HEIC photo to this address. Open / in a browser for help.")
        elif path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
        else:
            self._text(404, "Not found. Open / in a browser for help.")

    def do_POST(self):
        if not self._guard():
            return
        url = urlsplit(self.path)
        if url.path not in ("/patch", "/patch-live"):
            self._text(404, "Not found. Photos go to /patch; Live Photo pairs go to /patch-live.")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._text(411, "No photo received. In the shortcut, set Request Body to File "
                            "(or Form with a File field) and pick the photo.")
            return
        if length > MAX_UPLOAD:
            self._text(413, "Photo is larger than 200 MB.")
            return
        body = self.rfile.read(length)
        name = parse_qs(url.query).get("name", [None])[0]
        ctype = self.headers.get("Content-Type", "")
        if url.path == "/patch-live":
            try:
                fields = parse_live_multipart(body, ctype)
            except ValueError as error:
                self._text(400, str(error))
                return
            photo, filename = fields["photo"]
            video, _video_name = fields["video"]
            try:
                result, out_name, report = self.state.porter.run_live(
                    photo, video, name or filename, self.client_address[0])
            except PortFailure as error:
                self._text(error.status, error.message)
                return
            self._send(200, result, "application/zip", {
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(out_name)}",
                "X-Shalielie-Status": "ok", "X-Shalielie-Mode": "live-photo",
                "X-Shalielie-Video-Reencoded": str(report["video_reencoded"]).lower(),
            })
            return
        if ctype.lower().startswith("multipart/form-data"):
            data, fn = parse_multipart(body, ctype)
            if data is None:
                self._text(400, "The form has no file field. Add a File field holding the photo.")
                return
            body, name = data, name or fn
        client = self.client_address[0]
        log(f"<- {client}  {safe_stem(name)}  {len(body) / 1e6:.1f} MB")
        try:
            result, out_name, report = self.state.porter.run(body, name, client)
        except PortFailure as e:
            log(f"   failed: {e.message}")
            self._text(e.status, e.message)
            return
        log(f"-> {out_name}  {len(result) / 1e6:.1f} MB")
        mode = "add-texture" if report.get("mode") == "add-texture" else "port"
        self._send(200, result, "image/heic", {
            "Content-Disposition":
                f"attachment; filename=\"{out_name}\"; filename*=UTF-8''{quote(out_name)}",
            "X-Shalielie-Status": "ok",
            "X-Shalielie-Mode": mode,
        })


def status_payload(st: State) -> dict:
    urls = []
    if st.mdns.ok:
        urls.append(f"http://{st.mdns.hostname}.local:{st.port}")
    urls += [f"http://{a}:{st.port}" for a in st.addresses]
    return {
        "version": st.version,
        "port": st.port,
        "urls": urls,
        "mdns": {"ok": st.mdns.ok, "name": f"{st.mdns.hostname}.local", "error": st.mdns.error},
        "mode": "full" if st.porter.full_mode else "no-encoder",
        "tools": st.tools,
        "busy": st.porter.busy,
        "jobs": list(st.porter.jobs),
    }


def log(msg: str):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Shalielie Shortcut Server")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"default {DEFAULT_PORT}")
    ap.add_argument("--name", default=DEFAULT_HOSTNAME,
                    help=f"mDNS host name, served as NAME.local (default {DEFAULT_HOSTNAME})")
    ap.add_argument("--ip", action="append",
                    help="LAN address to advertise (repeatable); default: auto-detect")
    ap.add_argument("--no-encoder", action="store_true",
                    help="use the no-encoder mode even when ffmpeg and heif-convert exist")
    ap.add_argument("--no-browser", action="store_true", help="do not open the status page")
    args = ap.parse_args()

    if not PORTER.exists():
        print(f"Cannot find {PORTER}. Keep shortcut-server/ inside the Shalielie folder.")
        return 1

    st = State()
    st.version = porter_version()
    st.port = args.port
    st.tools = detect_tools()
    full = bool(st.tools["ffmpeg"] and st.tools["heif_convert"]) and not args.no_encoder
    st.porter = Porter(full_mode=full)
    st.addresses = args.ip or lan_addresses()

    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    except OSError as e:
        print(f"\nPort {args.port} is not available ({e.strerror or e}).")
        print(f"The server may already be running -- open http://localhost:{args.port}/ ,")
        print("or start this one on another port with --port.")
        return 1
    httpd.daemon_threads = True
    Handler.state = st
    st.mdns = Mdns(args.name, args.port, st.addresses)

    payload = status_payload(st)
    bar = "=" * 64
    print(bar)
    print(f"  Shalielie Shortcut Server  (porter v{st.version})")
    print(bar)
    print("  Shortcut URL:   " + payload["urls"][0] + "/patch" if payload["urls"]
          else f"  Shortcut URL:   http://<this computer's IP>:{args.port}/patch")
    for u in payload["urls"][1:]:
        print("  also reachable: " + u)
    if not st.mdns.ok:
        print(f"  ({args.name}.local unavailable: {st.mdns.error}; use the IP address)")
    if full:
        print("  Mode:           full (ffmpeg + heif-convert), same as the command line")
    else:
        missing = [n for n, k in (("ffmpeg", "ffmpeg"), ("heif-convert", "heif_convert"))
                   if not st.tools[k]]
        why = "forced by --no-encoder" if args.no_encoder else "missing " + ", ".join(missing)
        print(f"  Mode:           no-encoder ({why})")
    print(f"  Status page:    http://localhost:{args.port}/")
    print("  Stop:           close this window or press Ctrl+C")
    print("  Privacy:        only send photos from your own devices to this computer. Never")
    print("                  use a shortcut server someone else runs: that leaks your photos.")
    print(bar, flush=True)

    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, (f"http://localhost:{args.port}/",)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        st.mdns.close()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
