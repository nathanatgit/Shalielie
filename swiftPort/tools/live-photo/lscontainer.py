import asyncio, inspect, sys
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.house_arrest import HouseArrestService
async def m(v): return await v if inspect.isawaitable(v) else v
async def main(bundle):
    ld = await m(create_using_usbmux())
    ha = await m(HouseArrestService.create(ld, bundle))
    async def walk(d, depth):
        if depth > 4: return
        for name in await m(ha.listdir(d)):
            p = f"{d.rstrip('/')}/{name}"
            st = await m(ha.stat(p))
            isdir = st.get("st_ifmt") == "S_IFDIR"
            if "Library/Caches" in p or "SplashBoard" in p: continue
            print(("  " * depth) + name + ("/" if isdir else f"  {st.get('st_size')}"))
            if isdir: await walk(p, depth + 1)
    await walk("/", 0)
asyncio.run(main(sys.argv[1]))
