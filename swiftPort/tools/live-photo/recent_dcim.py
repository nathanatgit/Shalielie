"""List the newest HEIC/MOV files in the iPhone's DCIM folders over AFC."""
import asyncio
import inspect
import sys

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.afc import AfcService


async def maybe(value):
    return await value if inspect.isawaitable(value) else value


async def main(limit: int):
    lockdown = await maybe(create_using_usbmux())
    afc = AfcService(lockdown)
    rows = []
    for folder in await maybe(afc.listdir("/DCIM")):
        if not folder.endswith("APPLE"):
            continue
        for name in await maybe(afc.listdir(f"/DCIM/{folder}")):
            if name.upper().endswith((".HEIC", ".MOV")):
                info = await maybe(afc.stat(f"/DCIM/{folder}/{name}"))
                rows.append((info["st_mtime"], info["st_size"], f"/DCIM/{folder}/{name}"))
    for mtime, size, path in sorted(rows)[-limit:]:
        print(mtime, size, path)


asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 30))
