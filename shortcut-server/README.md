# Shortcut server

**English** | [简体中文](README.zh-CN.md)

Run the porter on your computer and use it from an **iOS shortcut**: pick a photo on the
iPhone, and the patched HEIC comes back to your photo library a few seconds later.

The server runs the unmodified `photographic_style_port.py`, so results are identical to the
command-line tool, including the default encoder mode the iPhone cannot run on its own.
Photos are processed in a temporary folder and deleted as soon as they are sent back.

> [!CAUTION]
> **Only use a shortcut server you run yourself, on your own computer.**
>
> The server receives your full original photo. Never use a server someone else runs, or a
> shortcut someone else gives you that points to one: **sending a photo there is the same as
> posting it online**, and you should assume it will be kept and leaked. An original HEIC
> holds much more than the picture: GPS location, date and time, device details and, for
> photos of people, face and depth data.
>
> - If you got a shortcut from someone else, check the URL in **Get Contents of URL**. It must
>   be `shalielie.local` or your own computer's local address (`192.168.…`, `10.…`,
>   `172.16.…`–`172.31.…`), as shown on the status page.
> - Never make your own server reachable from the internet (port forwarding, tunnels, cloud
>   hosting). It has no login and is meant for your home network only.

## Start it

Double-click the launcher for your system:

| System        | Launcher                                  |
| ------------- | ----------------------------------------- |
| Windows       | `Start Shalielie Server.cmd`              |
| macOS / Linux | `start-server.command` (Linux: run it in a terminal) |

A console window shows the address and a status page opens in your browser. Close the window
to stop the server.

Requirements are the same as for the command-line tool (see the [main README](../README.md#install-from-source)):
[uv](https://docs.astral.sh/uv/), plus `ffmpeg` for full results. Without `ffmpeg` the server
falls back to the [no-encoder mode](../README.md#no-encoder-mode) and says so on the status page.

## Address

```
http://shalielie.local:8765/patch
```

`shalielie.local` is announced over mDNS (Bonjour) by the optional `zeroconf` package, which
the launcher installs through uv. If the name does not resolve on your iPhone, use one of the
IP addresses printed in the console. VPN, proxy TUN (Clash/Mihomo), ZeroTier and virtual-machine
adapters are not advertised, since an iPhone on the same Wi-Fi cannot reach them.

The server only answers devices on the local network.

## First run

- **Windows** asks whether Python may use the network: allow it on **private networks**.
- **iPhone**: Shortcuts asks to access the **local network** the first time: allow it.
- The iPhone and the computer must be on the same Wi-Fi. Guest networks and routers with
  "AP isolation" block this.

## The shortcut

The status page walks through it, with your actual address filled in:

1. **Select Photos**
2. **Get Contents of URL** — URL `http://shalielie.local:8765/patch`, Method **POST**,
   Request Body **Form**, one **File** field `photo` = Photos
3. **Get Details of Files** → File Extension (of Contents of URL)
4. **If** File Extension is `heic` → **Save to Photo Album**; **Otherwise** → **Show Result**

## API

`POST /patch` with the HEIC as the raw body (`?name=photo.HEIC` optional) or as
`multipart/form-data`. Responses:

| Status | Body                                  | When                                              |
| ------ | ------------------------------------- | ------------------------------------------------- |
| 200    | patched HEIC (`image/heic`)           | `X-Shalielie-Mode: port` or `add-texture`         |
| 409    | text                                  | nothing to do (an iPhone 18 photo, or one already patched) |
| 415    | text                                  | not a HEIC — usually a JPEG that iOS converted     |
| 422    | text                                  | the porter refused the photo; the message says why |
| 504    | text                                  | the porter timed out                              |

`GET /api/status` returns the server's mode, addresses and recent jobs as JSON.

Options: `--port`, `--name` (mDNS host name), `--ip` (advertise a specific address),
`--no-encoder`, `--no-browser`. Pass them after the launcher name, or run
`uv run --group server python shortcut-server/server.py --help`.


## Live Photo pairs (0.7.1 test build)

POST `/patch-live` with a multipart form containing exactly two File fields:
`photo` (original HEIC) and `video` (its original MOV). FFmpeg is required for motion.
The response is a ZIP containing the styled HEIC, matching MOV and `report.json`.
Videos with a smaller clean aperture are cropped and re-encoded to remove the padded
edge exposed by Photos while styling. Original files and audio samples are preserved.
The report states whether the video was re-encoded.

Save and extract the ZIP in Files, then import both files together in Palettify as a
new Live Photo. Saving the HEIC alone through Shortcuts produces a still; the existing
`/patch` endpoint remains the still-photo route. A failed MOV returns an error rather
than a silent still-only result. The iOS test build is distributed as an Actions artifact;
a proper iOS release awaits phone validation.
