# Startup validation — 2026-10-15

The current Windows EXE paints a native loading window before loading the
player runtime DLL. The visible native message loop stays responsive during
runtime loading and portable extraction; the single WebView takes over after
its shell paints. Settings, credentials, library, and native video
initialization remain deferred. The user subsequently requested a portable EXE.

## Current native bootstrap

### Loading-screen refinement

The native loading surface now has no top bar and uses native caption dragging
over the entire window. Switching to another application minimizes it while
initialization continues. The player remains minimized through handoff and
restores at the loading window's last visible position. Alt+F4 and taskbar Close
remain available. No extra WebView, startup dependency, or timed reveal was added.

The isolated development interaction test passed at 125% desktop scaling:

- The native renderer's bitmap has no title-bar pixels and was visually reviewed.
- Nine points across the surface returned the native caption drag hit code.
- Moving the loader and sending application deactivation minimized it.
- Initialization completed while minimized; reopening restored the same WebView
  in 252 ms, without another cover or document reload, at the moved position
  and the expected 1180×720 client size.

The probe targets only the test child window. It tests native messages and
position changes directly, rather than driving the global mouse. Its thread
uses the same DPI awareness as the app so physical positions compare correctly.
The delayed-runtime regression also passed: heavy modules absent at first
paint, continued native animation, normal handoff, second-launch forwarding,
and cancellation during loading.

Three new development launches measured 226 / 218 / 202 ms to the native
loading window and 3459 / 2766 / 2803 ms to the player handoff. These runs used
Vite, temporary data and a fresh test profile, with an isolated
`com.webler.lingocinema.loader-ui-test` application identifier. OS caches were
not flushed. These small samples verify fast visible startup on this PC; they
do not establish a controlled before/after speed comparison.

Reports: [loading-window interaction](startup-loader-interaction.json),
[delayed runtime](startup-loader-bootstrap.json),
[launch measurements](startup-loader-after.json).

With Vite running and an isolated development executable built as described
below, run these tests sequentially:

```powershell
$testExe='C:/Users/webler/AppData/Local/LingoCinema/cargo-target/debug/lingo-cinema.exe'
node scripts/cdp-bootstrap-interaction-smoke.mjs $testExe tests/startup-loader-interaction.json
node scripts/cdp-bootstrap-smoke.mjs $testExe tests/startup-loader-bootstrap.json
node scripts/benchmark-startup.mjs $testExe 3 tests/startup-loader-after.json
```

### Original bootstrap and requested package verification

The release entry image is 373,248 bytes. It does not import the player DLL;
the bootstrap calls `LoadLibraryExW` only after the first native paint completes.
The runtime then initializes Tauri, WebView2, and player services.

Three development launches measured 156 / 179 / 202 ms from process creation
to the native loading window. Controls followed at 2927 / 2130 / 1925 ms.
These timings include process loading, and distinguish visible feedback from
full player readiness. They are measurements on this PC, not cold-boot
guarantees. Disk and OS caches were not flushed.

The delayed-runtime test deliberately pauses DLL loading for six seconds. It
verified no player/WebView/mpv/SQLite modules at first paint, an animated native
message loop during the delay, immediate closing, normal handoff, and no new
loading cover on second-click forwarding. The native surface was visually
reviewed using a bitmap captured from its own rendering code. The final delayed
test measured 278 ms from process launch (113 ms after Rust entry), verified
1180×720 after handoff, and closed during loading in 917 ms including process
launch/cleanup. A run during compilation was slower, illustrating the effect
of concurrent system load.

The final portable package extracts its payload only once per payload hash,
after the window appears. Its cache survives normal exit. A marker and required
file checks permit later launches to skip decompression. Runtime DLLs and media
helpers resolve from that cache; the installed system WebView2 supplies the UI.

Final EXE measurements on this PC:

| Launch | Native loading window | Player handoff | Native engine ready |
| --- | ---: | ---: | ---: |
| First use, including extraction | 503 ms | 13,288 ms | 13,874 ms |
| Cached runtime, run 2 | 156 ms | 2,402 ms | 2,658 ms |
| Cached runtime, run 3 | 263 ms | 2,033 ms | 2,337 ms |

The file is `artifacts/Lingo-Cinema-0.1.0-win-x64-fast-start.exe`
(139,322,415 bytes). SHA256:
`656620BF333C5EFDB42B6E52A237CF80D1F5EA86DFB8DA8B100EECFD401FDD87`.
Archive integrity and x64 PE checks passed. The release contains the embedded
frontend and bundled tools, with no WebView2 runtime or installer.

Raw current reports: [development launches](startup-native-bootstrap.json),
[delayed runtime](bootstrap-delayed-runtime.json),
[final portable launches](startup-portable.json),
[final package validation](portable-cache-validation.json),
[window controls](startup-window-validation.json).

Current verification also passed native local playback with a 360-second
fixture, repeated/rapid seeks, cached thumbnails, isolated Documents settings
and encrypted credentials, and deterministic native network/audio recovery.
Live YouTube tests in both native and HTML modes reached YouTube's sign-in
requirement; online playback is not claimed as verified for this build.
The Windows handoff uses Tauri's show operation before measuring the visible
frame, keeping internal visibility state synchronized and preserving the
1180×720 client area at the tested 125% desktop scale. Window checks verified
fullscreen, maximize/restore, double-click fullscreen, and chrome visibility;
synthetic drag events verified routing but did not physically move the window.

## Earlier single-WebView attempt

### Measurements

These are Windows development-executable runs on this PC, with a separate
`com.webler.lingocinema.startup-test` identifier, temporary persistent data, and
CDP port 9237. Each run starts a new process and closes that exact test instance.
The normal player was left open. Disk/OS/WebView caches were not flushed; these
are not controlled cold-boot measurements. The first run after rebuilding was
slower and is included rather than discarded.

| Frontend / implementation | Run 1 controls | Run 2 controls | Run 3 controls |
| --- | ---: | ---: | ---: |
| Original two-window startup, Vite | 2106 ms | 1578 ms | 1811 ms |
| Single-window startup, Vite | 4782 ms | 1748 ms | 1531 ms |
| Single-window startup, compiled frontend | 3823 ms | 1564 ms | 1556 ms |

The original timings above exclude the additional 240 ms splash handoff.
The original first-content paint occurred in the hidden main window and does
not represent a user-visible paint. New compiled-frontend runs acknowledged
native backing release at 3844 / 1617 / 1610 ms from process launch. Native
engine readiness followed at 5579 / 2036 / 2003 ms without blocking controls.

Removing a second WebView and fixed handoff eliminates work, but these small,
noisy samples do not establish a large general startup speedup. Millisecond
cold launch has **not** been achieved. A document reload within an existing
WebView reached the shell in 179 ms; that is not a new-process launch result.

Raw reports: [before](startup-before.json), [single-window Vite](startup-after.json),
[compiled frontend](startup-compiled-frontend.json).

## Reproduce

Build an isolated development executable (not a distribution package):

```powershell
$env:TAURI_CONFIG='{"identifier":"com.webler.lingocinema.startup-test"}'
cargo build --manifest-path src-tauri/Cargo.toml
```

In one terminal run `npm.cmd run dev`. For compiled-frontend measurements,
instead run `npm.cmd run build` and
`node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 1420 --strictPort`.

```powershell
node scripts/benchmark-startup.mjs C:/Users/webler/AppData/Local/LingoCinema/cargo-target/debug/lingo-cinema.exe 3
```

Unset `TAURI_CONFIG` before an ordinary development build. Do not benchmark a
normal build while another normal player is running: single-instance routing
would measure forwarding instead of startup.

## Verification

- Frontend production build and Rust development build passed.
- Desktop startup smoke passed: one configured/live WebView, visible window,
  opaque initial backing, deferred persistence/library, native startup timing.
- Native startup timing remains the first launch measurement after page reload.
- Native local playback smoke passed with a 360-second MP4: first frame,
  duration/dimensions, repeated seeks, rapid seek burst, loader-free local seeks,
  thumbnails, and immediate pointer following. Earlier runs with 30/45-second
  fixtures failed because the existing rapid-seek test adds 60 seconds and
  requires a longer video; they were rerun with the correct fixture.
- Window smoke passed fullscreen/maximize, chrome hiding, and drag dispatch.
- Isolated persistence smoke passed settings authority, encrypted credentials,
  translated-subtitle restoration, and hydration after shell paint.
- Desktop screenshot helper failed to connect even after retry/reset. Native
  layer visual confirmation remains unverified; behavioral checks ran in the
  actual desktop WebView and libmpv.

The source-only scope above describes the earlier attempt. The user's later
explicit request authorized the final portable build.
