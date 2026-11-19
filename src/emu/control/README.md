# Cross-platform control API

The control API uses HTTP/JSON on loopback. The versioned `/v1` contract remains
compatible with the iOS simulator automation. `GET /v1` lists endpoints and
`GET /v1/capabilities` describes frontend-specific features. Screenshots, icons,
logs and file downloads retain their native content types rather than a JSON
encoding.

Qt enables the listener only with `--debug-control-port <1..65535>`. Android
enables it only when a cold-start Activity Intent carries the integer extra
`debug_control_port` in that range. Neither setting is persisted. With no
argument/extra, neither frontend opens a control socket. Android host clients
can reach the listener through `adb forward tcp:<port> tcp:<port>`. Changing the
Android port requires a new process. The iOS simulator retains its default port
8765 and `-DebugServerPort`; physical iOS builds do not start the listener.

The `control` library owns the transport, endpoint index, jobs, input sequences,
key-name mapping, waits and host file/log I/O. Frontend adapters execute atomic operations on the
frontend's control or UI queue. The native backend shares the Qt and Android
emulator operations; iOS retains its DeviceStore/navigation adapter. Neither
HTTP parsing nor input timing belongs in the emulator kernel or guest services.
A second transport can call the service without duplicating task and input
semantics. Frontends depend on `control`; `control_native` depends on the emulator
libraries. Emulator libraries do not depend on either control target. File/log
I/O runs on control workers after the frontend resolves a path, without holding
the UI queue or Android lifecycle mutex.

The service is constructed only when enabled. Timed operations have four slots
separate from ordinary requests and the long-operation worker, so waits cannot
starve session close or job polling. Extra timed requests receive HTTP 503.
The transport limits connections to 32, headers to 16 KiB and aggregate incoming
bodies to 1 GiB. Binary bodies move through the C++ transport without extra
whole-body copies.

Long operations are jobs. The default request waits for the result; `async=1`
returns a job record and HTTP 202. Records include progress when the underlying
operation provides it, completion/error and timing. Only one long operation
owns the frontend at a time. Polling and waits remain available. Input sequences
run in order, release held input on errors, and are cancelled before an API
launch, close or device operation changes the session. A JSON-RPC batch would
not provide this ordering contract.

API touches bypass host UI event delivery. Guest coordinates refer to guest
pixels; normalized coordinates are relative to the guest picture. Qt and Android
support these two spaces. iOS additionally supports render-surface coordinates.
The native screenshot path reads the guest render texture, which holds the
composited screen (window contents and any GLES surface drawn into it). That
texture is drawn at the scale the frontend shows the screen at, often a
fraction (3.4 times the guest's size, say); the screenshot brings it back to the
guest's size (or `scale` times that) by averaging the texels whose centres fall
in each pixel, so a guest pixel drawn as a block of texels keeps its own value
and text drawn at the full scale comes out smoothed. Its pixels are returned
opaque: the texture's alpha is whatever the last drawing left, and a GLES
surface brings its own, often 0. Only iOS currently
supports a screenshot of the entire host window. Accelerometer injection uses
the guest device's natural axes in m/s², or g with `unit: "g"`. Android and iOS
provide an override; Qt reports this capability as unavailable because its null
sensor backend does not deliver motion samples.

Paths in install requests belong to the machine running the emulator, including
Android's app-accessible filesystem. Clients can upload through `PUT /v1/files`
with a raw body, then pass the resulting `hostPath` to installation. `docs:/`
addresses the frontend's data root; `C:/`, `D:/` and `E:/` address the selected
device's own writable drives, including E underneath a mounted card. Components
of these virtual paths match case-insensitively. `host:` explicitly selects an
absolute host path, including Windows drive letters that would otherwise mean
a guest drive. Other absolute host paths remain accepted. On native frontends,
boot another device before deleting the active one. Config keys returned by a
frontend describe that frontend; iOS-only JIT and performance settings are not
portable.

In Android control mode the host process survives guest exits so that another
API launch can use the same listener. Launches still create EmulatorActivity,
use its profile and wait for its rendering surface. Ordinary Android launches
retain their process-exit behavior.

`GET|PUT /v1/clock` reads or sets the guest clock: `{"unixMs": ...}`, Unix
time in milliseconds. It starts at the host's time and runs on from the value
set until the kernel is created again. N-Gage 2.0's application checks its
certificates against it and refuses to install games from 2019 on, so a
frontend sets a date before that for an N-Gage 2.0 device.

`POST /v1/apps` takes `{"path": ...}` or `{"paths": [...]}` and an optional
`type`, guessed from the extension when absent: `sis` (`.sis`, `.sisx`),
`ngage` (an N-Gage card folder or zip), `ngage2` (`.n-gage`: the file is copied
to `E:\n-gage`, where the N-Gage application finds and installs it itself after
checking its certificate), or `ngage2-direct`. It answers
`{"results": [...], "added": [{uid, name, system}]}`, `added` being the apps
the install made appear.

`ngage2-direct` installs a `.n-gage` file without the N-Gage application, so a
game installs in the same way whether or not it is signed, and starts with
`POST /v1/apps/{uid}/launch` without Games running. The file is a MIME
multipart container (`Content-Description: Ngage-Install-File`) of three
parts: `RetailerInfo` (XML), `Metadata` (a SIS that drops `metadata.xml` and
banner PNGs into `c:\private\20007b38\import`) and `Game` (the game's SIS,
with the same package UID as the Metadata SIS, so installing the Metadata
part after it would replace the game). The control reads the title and
description from `metadata.xml` inside the Metadata part without installing
it, installs the Game part silently to E: (the default install drive when
there is no E:), and writes the registration the game packages lack and the
N-Gage application would otherwise stand in for: `<exe>_reg.rsc` in
`\private\10003a3f\import\apps` and `<exe>_loc.rsc` with the title as caption
in `\resource\apps`, both on the exe's drive. The exe is the one in
`\sys\bin` whose UID3 is the package UID (ONE also installs a helper exe), or
the only one there; a game that cannot be registered is uninstalled again and
the request fails with `install_failed`.
Both files are recorded with the package, so `DELETE /v1/apps/{uid}` removes
them with the game. No icon is registered: the metadata's PNG banners are not
an icon format apparc reads. Its result entry adds `package`, `title`,
`description` and `apps` (`[{uid, name, executable}]`), and the game is listed
in `added` even when it was installed before. The runtime libraries the games
link to come from the N-Gage application's own `.sis`, which still has to be
installed (as `sis`) first.

`GET /v1/ngage2/games` opens Games if needed and reads its PlayServer GamesList
catalogue. `POST /v1/ngage2/games/{uid}/launch` uses the same launch IPC as the
Games GUI. Both endpoints keep the session attached to Games. The guest IPC
agent is embedded in `control_guest`; its SDK sources live in `guest/ngage`.

`GET /v1/web/diag` exists on the web frontend only and returns the counters
behind the player's diagnostics (`src/emu/web/src/diag.cpp`, `web/diag.h`):
`{ "v": 1, "uptimeMs", "speed", "graphics", "audio", "exits" }`. Each part is
built and documented in `src/emu/web/src/diag_<part>.cpp` from the atomics in
`common/webdiag/<part>.h`. Numbers are totals since the page loaded. Like
`GET /v1/net` it is answered without the control lock, so it never reports
"busy".

`GET /v1/net` exists on the web frontend only and reports the Bluetooth link
between players (`src/emu/web/src/net.cpp`, `services/bluetooth/protocols/web`).
The page owns the transport and hands the emulator whole frames; this endpoint
shows what the emulator makes of them:

| Field | Content |
|---|---|
| `link` | `up`, `self` (our id in the room, 0 while down), `name` (the device name the page gave), `thread` (whether the link's thread was started: it is not until the link first comes up), `dropped` (frames thrown away because the emulator fell more than 8 MB behind; every connection is reset when that happens). |
| `attached` | Whether a guest is running and has a Bluetooth stack. Without one the lists below are empty and `address` is null. |
| `address` | The device's Bluetooth address, `aa:bb:cc:dd:ee:ff`. A new one for every start of the emulator. |
| `peers[]` | `id`, and `address` and `name` once that member's emulator has announced itself (null before). |
| `listeners[]` | `protocol` (`l2cap` or `rfcomm`), `port`, `queued` (connections not yet accepted by the guest), `accepting` (the guest has an accept pending). L2CAP port 1 is the guest's own service discovery server. |
| `connections[]` | `peer`, `id` and `initiator` (which together name a connection), `protocol`, `port`, `state` (`connecting`, `queued`, `open`, `closed`), `txBytes`, `rxBytes`, `rxQueued` (received and not yet read by the guest). |
| `totals` | `framesIn`, `framesOut` (since the page loaded), and for the running guest `badFrames`, `seqErrors`, `connectsIn`, `connectsOut`, `refused`, `inquiries`, `selections`, `sdpQueries`. |
| `events[]` | The last 32 operations: `ms` (since the guest started), `op` (`bind`, `listen`, `unlisten`, `accept`, `incoming`, `connect`, `send`, `shutdown`, `close`, `inquiry`, `select`, `sdp-connect`, `sdp-query`, `link-up`, `link-down`, `peer-join`, `peer-announce`, `peer-leave`, `overflow`), `protocol`, `port`, `peer` and `result`, a Symbian error code (0 is success, -36 a lost connection, -34 nobody to connect to, -25 the other side closed). |

## Looking into the guest, and enhancement profiles

These routes are served by `src/emu/enhance` on every frontend that links
`control_native`. The hooks they use exist only on the interpreter (`dyncom`):
`arm::core::set_hooks` puts a call in front of the instruction at an address
without changing guest code, so a hook may sit on a function that runs
thousands of times a frame. On another backend the routes answer, but no hook
is ever hit.

Addresses and UIDs are JSON numbers or hexadecimal strings (`"0xE00A280C"`).
An `at` together with an `image` (an executable's file name, any letter case)
is an offset from the start of that image's code section, resolved for every
process the image is loaded in and again whenever code is loaded or a process
ends. Without `image` it is an absolute address.

| Route | Content |
|---|---|
| `GET /v1/debug/codesegs` | Every code segment: `name`, `path`, `uid3`, `hash` (XXH32 of the code as it is in the file, seed `0x5B001101`), `rom`, `codeBase` (linked address), `codeSize`, `dataBase`, `dataSize`, `bssSize`, `exports`, `romCode`, and `attaches[]` (`process`, `uid`, and where `code` and `data` run there). |
| `GET /v1/debug/threads` | Every thread: `name`, `id`, `process`, `processUid`, `state`, `running`, `regs[16]`, `cpsr`. The running thread's registers are read from the core; pause the emulator for a steady picture. |
| `GET /v1/debug/mem?addr=&len=&process=` | Guest memory as bytes (at most 16 MB). `process` is a UID; without it the process that is running at that moment. Unmapped pages read as zero and `X-Mapped-Bytes` says how much was mapped. |
| `PUT /v1/debug/mem` | `{ "addr", "hex", "process" }`: write bytes. Code that was already translated keeps running as it was. |
| `POST /v1/debug/profile` | `{ "ms": 1000, "limit": 400 }`: sample the program counter and the link register for that long, from the request's own thread, and return the most frequent pairs as `top[]` of `[pc, lr, count]`, with `samples` and `distinct`. |
| `POST /v1/debug/hooks` | `{ "image", "hash", "at", "limit": 16, "stack": 0, "watch": [], "skip": false, "return" }`: hook an address. The first `limit` hits record the registers, `stack` words from the stack pointer, and the value of each `watch` expression; every hit is counted. With `skip` the hooked function returns at once (`return` sets r0), so the hook must be on a function's first instruction. |
| `GET /v1/debug/hooks`, `GET /v1/debug/hooks/{id}` | The hooks with their hit counts; one hook with what it `captured[]` (`regs`, `cpsr`, `stack`, `values`, `thread`). |
| `DELETE /v1/debug/hooks/{id}`, `DELETE /v1/debug/hooks` | Remove one (its last state is returned) or all. |
| `PUT /v1/enhance/profile` | Load an enhancement profile: which addresses of which images begin and end a frame and draw triangles, and how to read a triangle there. The format and its expression language are described in the arcade repository's `docs/enhancements.md` and `catalog/enhance.schema.json`. Returns the status below. `DELETE` unloads it. |
| `GET /v1/enhance` | `available` (a profile is loaded), `engine`, `active` (one of its images is loaded), `replace`, `frames`, `triangles` and `textures` of the last frame, `droppedDraws`, and `hooks[]` with `addresses`, `hits` and `faults` (draws dropped because memory they name is not mapped). The GPU layer: `scale` (the factor it draws at, 0 when it is off; a fraction with `"auto"`), `auto`, `filter`, `flat`, `composed` (pictures it drew), `cachedTextures`, `textureUploads`, `keyPixels` (guest pixels filled with the key colour), `layerFailed` (it tried to draw and cannot: no OpenGL, a shader that does not compile, an upside-down screen; the guest then draws its 3D itself). |
| `PATCH /v1/enhance` | `{ "scale": 0\|1\|2\|3\|4\|6\|"auto", "filter": "nearest"\|"linear", "flat": "scaler"\|"smooth"\|"sharp", "replace": bool }`, each optional. `scale` switches the GPU layer: 0 (the default) off, a whole number (up to 8) draws the loaded profile's triangles at that multiple of the screen's size, `"auto"` at the scale the frontend shows the screen at (at most 8). Setting it also sets `replace` (on with the layer, off without), since the layer shows what the guest no longer draws. `filter` is how the triangles' textures are sampled. While the layer is on, everything else the game shows (its menus, text, logos, the 2D over its 3D) is drawn at the same scale, enlarged as `flat` says: `"scaler"` (the default) with xBRZ, an edge-directed pixel-art scaler, which also rounds off the edges of what is over the 3D; `"smooth"` blended between pixels; `"sharp"` a block for each pixel. `replace` alone: whether hooks marked `skip` return from the guest function instead of letting it draw (off by default; for proving a profile). Returns the status above. |
| `GET /v1/enhance/frame` | The last completed frame: `width`, `height`, `vertexLayout`, `vertices` (eight numbers each: x, y, z, w, u, v, colour as `0xAARRGGBB`, and the palette row), `draws[]` (`first`, `count`, `texture`, `blend`, `depth`, `hook`), `textures[]` (with `paletteRows` and `paletteRowStride`, zero for a texture without palette rows) and `target`. |
| `POST /v1/enhance/test-frame` | Show a made-up frame, for testing the layer without a profile; the layer must be on (409 otherwise). The body is what `GET /v1/enhance/frame` returns (`width`, `height`, `vertices`, `draws`, `textures`), where a texture may carry its pixels inline as `data` (base64 of R, G, B, A bytes, `width` × `height` of them) instead of a guest address, or, for a texture with palette rows, `paletteRows` with `indices` (base64 of one byte a texel) and `table` (base64 of R, G, B, A bytes, 256 of them a row); `vertices` may have seven numbers each (no row) when `vertexLayout` lists seven; plus an optional `screen`: `{ "width", "height", "data" }`, a picture that stands in for the guest's screen while the frame is shown (pixels in the key colour `#FF00FF` are where the triangles show). It is drawn at once, also while the emulator is paused, and every time the guest presents after, until a captured frame with triangles replaces it, the layer is switched off, or `DELETE /v1/enhance/test-frame` removes it. `tools/re/layertest.py` in the arcade repository uses it. |
| `GET /v1/enhance/texture?index=`, `GET /v1/enhance/target` | A texture of that frame, or the buffer the guest draws into, read from guest memory now: two little-endian words (width, height), then R, G, B, A bytes. A texture with palette rows comes through each of its palettes, one picture under another (height × rows; 422 past 16 million pixels). |

`enhance::set_sink` (`enhance/enhance.h`) hands every completed frame to
whatever draws it, on the thread that runs the guest. The GPU layer
(`enhance/src/layer.cpp`) is that sink while it is on, and also the screens'
`screen_compositor` (`services/window/screen.h`): every time the guest presents,
also without 3D in the picture, it draws the screen texture again at its scale:
the guest's picture enlarged as `flat` says, with the triangles where it has
the key colour. How, and what it gets wrong, is in the
arcade repository's `docs/enhancements.md`. `GET /v1/screenshot` stays at the
guest's size, with the layer's picture scaled down into it.
