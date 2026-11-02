# Windows playback repair — 2026-10-26

The implementation follows the investigation in `docs/WINDOWS_PLAYBACK_DIAGNOSIS.md`. Changes apply to the source/development app. No portable folder or release package was rebuilt or modified.

## Changes

- Native playback now uses mpv `vo=gpu`, explicit Direct3D 11, and `hwdec=auto-safe`. The bundled `gpu-next`/libplacebo output lost its device on the test machine. The replacement retains `d3d11va` hardware decoding, including for 10-bit HEVC. The existing OpenGL/software-decoding recovery remains available.
- The desktop HWND is opaque. Only WebView2's backing becomes transparent after the shell paints. Missing or resizing native video consequently leaves black inside the app, rather than revealing other applications.
- Rust performs fullscreen placement changes on the Windows UI thread. It preserves the original `WINDOWPLACEMENT`, clears the native zoom style without first displaying the restored-size window, keeps Tao's fullscreen state synchronized, and restores the prior normal/maximized placement on exit. OS transition animations are disabled only around this operation and their previous setting is restored afterward.
- Healthy native video stays visible during window changes. The old fixed 100/120 ms transition sleeps and unconditional picture blanking were removed. Controls remain visible during transient focus/mouseleave events, then receive a fresh auto-hide interval. Fullscreen clicks queue, so a second click made before the first resize finishes is honored.
- Header/dock gradient RGB values are black instead of dark gray; the reference fade lengths and transparency remain intact.
- An actual EOF sets the displayed timeline fill and thumb to 100%, independently of the final decoded frame's timestamp. Retained-frame and replay behavior remain intact. Browser playback also updates the timeline on its `ended` event.

## Verification

Host: Windows, AMD Radeon Vega 8, driver `31.0.21925.1001`, 1920×1080 display at 125% scaling, system WebView2 155. Tests used a temporary `LINGO_CINEMA_DATA_DIR` and generated fixtures. No real YouTube account was mutated.

| Check | Result |
| --- | --- |
| `npm run build` | Passed |
| `npm run cargo:check` and Windows development EXE/runtime build | Passed |
| Rust unit tests | All 42 passed |
| `node --test scripts/window-config.test.mjs` | Both checks passed, including opaque desktop-host configuration |
| `cdp-startup-smoke.mjs` | Passed |
| `cdp-native-local-smoke.mjs` | Passed: playback, exact/repeated/rapid seeks, previews, fullscreen cycles, retained EOF frame and replay |
| `cdp-window-smoke.mjs` | Passed: fullscreen, maximized restoration, double-click, drag routing, chrome hide/reveal and shade geometry |
| `cdp-player-smoke.mjs` | Passed: HTML/blob fallback, transport, timeline dragging, modal pause behavior and subtitle cleanup |
| `cdp-windows-render-smoke.mjs` | Passed: twelve fullscreen round trips across normal/maximized and paused/playing states; six queued rapid clicks; control visibility/hit testing; H.264/10-bit HEVC; EOF/replay |
| `cdp-windows-composition-smoke.mjs` | Passed: actual native-video/compositor pixels in normal/fullscreen states and after deliberately destroying mpv |
| `cdp-youtube-network-smoke.mjs` | Passed: same-video audio, delayed-audio buffering, Pause preservation, quality/audio switching and restoration of local options |
| Live native and HTML YouTube smoke tests | Blocked before playback by YouTube's signed-in-session requirement; not reported as playback passes |

The HTML/blob smoke test contained an outdated `OFF` text assertion even though the current CC label is `Subtitles`. It now checks the actual disabled master toggle and inactive CC state alongside the existing cleared-caption assertions. The initial native smoke also exposed dropped fullscreen clicks; queuing clicks fixed that actual behavior, and the original smoke then passed without weakening its fullscreen assertions.

The final render run measured 112–201 ms for entry and 153–255 ms for exit, including native-output verification, across twelve round trips. There were no intermediate normal-size resize events when moving between maximized and fullscreen states. These are local development measurements, not guarantees for every machine.

Both the 640×360 H.264 fixture and 1280×720 10-bit HEVC MKV used `gpu` with `d3d11va`. The sparse-frame fixture reproduced the timeline problem: its last playback timestamp was 7 seconds while the container duration was 8 seconds. At EOF the fill and thumb were both exactly `100%`, the retained frame was loaded, and replay returned to live output.

## Actual compositor capture

FFmpeg's `gfxcapture` filter uses Windows Graphics Capture, so it includes native GPU child surfaces even when another app occludes the player. CDP and window-DC/GDI captures do not establish the final native picture. A temporary one-pixel corner tick makes the paused/occluded window submit new compositor frames while capture attaches; it is removed after each capture.

| Captured surface | Center RGBA | Header sample RGBA | Lower chrome sample RGBA |
| --- | --- | --- | --- |
| Normal, white native fixture | `255,255,255,255` | `0,0,0,255` | `0,0,0,255` |
| Fullscreen, white native fixture | `255,255,255,255` | `17,17,17,255` | `5,5,5,255` |
| mpv destroyed while WebView/page remain transparent | `0,0,0,255` | `0,0,0,255` | `0,0,0,255` |

The faint nonzero fullscreen samples are the expected black-alpha fades over white video. The missing-native test deliberately bypasses the frontend's opaque fallback so it tests the native host itself. Screenshots were also visually inspected for the actual frame, controls, and dark shading. The test reloads the player afterward to recreate mpv.

## Reproduction

Create a long H.264/AAC fixture, a white sparse-frame fixture, and a short 10-bit HEVC MKV with the bundled FFmpeg:

```powershell
$renderRoot = Join-Path $env:TEMP 'lingo-windows-validation'
New-Item -ItemType Directory -Force -Path $renderRoot | Out-Null
$ffmpeg = '.\src-tauri\binaries\ffmpeg.exe'
& $ffmpeg -y -f lavfi -i 'testsrc2=size=640x360:rate=30' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 360 -c:v libx264 -preset ultrafast -crf 30 -c:a aac (Join-Path $renderRoot 'long.mp4')
& $ffmpeg -y -f lavfi -i 'color=white:size=640x360:rate=1' -t 8 -c:v libx264 -preset ultrafast (Join-Path $renderRoot 'white.mp4')
& $ffmpeg -y -f lavfi -i 'testsrc2=size=1280x720:rate=24' -t 6 -vf format=yuv420p10le -c:v libx265 -preset ultrafast -x265-params 'log-level=error:pools=2' (Join-Path $renderRoot 'hevc10.mkv')
$env:LINGO_CINEMA_DATA_DIR = Join-Path $renderRoot 'data'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
npm.cmd run tauri dev
```

In a second terminal, after the player initializes:

```powershell
$renderRoot = Join-Path $env:TEMP 'lingo-windows-validation'
node scripts/cdp-windows-render-smoke.mjs (Join-Path $renderRoot 'long.mp4') (Join-Path $renderRoot 'white.mp4') (Join-Path $renderRoot 'hevc10.mkv')
$env:LINGO_RENDER_ARTIFACT_DIR = Join-Path $renderRoot 'composition'
node scripts/cdp-windows-composition-smoke.mjs (Join-Path $renderRoot 'white.mp4')
```

This run's raw logs, generated fixtures, final render summary and compositor PNGs are under `C:\Users\hamid\AppData\Local\Temp\lingo-windows-fix-20261026-194415`. Other GPUs, multiple-monitor/DPI transitions, long 4K playback, authenticated live YouTube playback, and distribution outputs were not validated in this run.
