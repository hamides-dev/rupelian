# Windows playback investigation — 2026-10-23

**Historical investigation.** The follow-up implementation and Windows verification are recorded in `tests/windows-playback-validation.md` (2026-10-26). The statements below describe the diagnosis before those fixes were applied.

Scope: investigate whether the reported Windows regressions share a cause before changing individual symptoms. No application source, renderer defaults, dependencies, settings, or distribution outputs were changed. Only this report and the agent guide were updated.

## Confirmed findings

- This workspace has no `.git` directory. The Linux-port change set and a known-good Windows revision cannot be reconstructed from local Git history. The timing of the symptoms alone does not establish that the Linux port caused them.
- The existing development EXE/runtime DLL was launched against the current Vite frontend with a temporary `LINGO_CINEMA_DATA_DIR`. Tests did not use the user's Documents data. The fixture was a generated 60-second 1280×720 H.264/AAC MP4.
- Hardware: AMD Radeon Vega 8; driver `31.0.21925.1001`; WebView2 `155.0.0.0`; bundled mpv reports `v0.41.0-1109-g36abaa32d`.
- With the current default `gpu-next` / `hwdec=auto-safe`, mpv selected `d3d11va`, then logged `Couldn't resize swapchain` and `0x887a0005` (device removed). It reported `Could not initialize video chain` and disabled the video track (`vid=no`, `vo-configured=false`). The app subsequently recovered using its existing OpenGL/software-decoding fallback. That fallback makes playback possible; it does not demonstrate that the original graphics path is healthy.
- A backend-only `d3d11-flip=no` probe also failed with the same device error after briefly reporting a configured output. This is **not** a verified fix. An OpenGL/automatic-hardware-decoding probe also logged a hardware-frame copy failure with `887a0005` and became unresponsive; its isolated app process was stopped.
- A temporary runtime-only probe changed `hwdec` to `no` while retaining `gpu-next` and its default graphics selection. The same fixture then progressed normally, retained valid video output, completed three normal-window and three maximized-window fullscreen round trips, and displayed its retained EOF frame. This isolates a hardware-decoding/graphics interaction on this machine. It does not yet identify the responsible driver, FFmpeg/mpv component, or interop operation. Permanently disabling hardware decoding has not been adopted or evaluated for high-resolution/HEVC performance.
- `setPlayerFullscreen` explicitly unmaximizes before entering fullscreen, and remaximizes after leaving it. The resize event trace confirms the intermediate 1180×720 restored window between the maximized and fullscreen sizes. In the software-decode diagnostic session, maximized-window entries took 386–615 ms and exits took 511–579 ms to report the requested window state and a visible native-surface flag. These measurements include existing transition waits and property polling; they are not pure rendering times or a controlled performance comparison.

## Symptoms not established by this investigation

- The actual computed upper/lower vignette gradients remain black (`rgba(0, 0, 0, ...)`). This rules out a simple change of those gradient RGB values to gray, but does not verify the final pixels composed over native video. Gray-looking shadows remain unverified.
- The generated fixture reached EOF at approximately 60/60 seconds with both progress fill and thumb at `100%`. The reported short-of-end timeline behavior was not reproduced on that fixture. Other containers, duration metadata, and audio/video endpoints remain untested.
- Window-state flags, selected tracks, and `vo-configured` are not proof that every desktop-composited pixel is correct. The six diagnostic cycles do not establish that controls never disappear, or that underlying windows can never show through. A complete desktop visual check during repeated transitions is still required.
- YouTube, 10-bit HEVC, long playback, release packages, and other machines were outside this diagnostic run.

## Recommended implementation direction

Address the Windows native playback boundary first: identify a hardware-decoding/output combination that remains healthy on this GPU, and make fullscreen transitions preserve one coherent native-window/video-surface state. Test that combination with actual composited desktop visuals, repeated transitions, paused playback, and representative codecs. Reassess the remaining visual and timeline symptoms afterward; the current evidence does not justify promising that one renderer change will remove every symptom.

Raw diagnostic logs and JSON traces were saved under the temporary directory `C:\Users\hamid\AppData\Local\Temp\lingo-windows-audit-20261023-040444` (`mpv-accelerated.log`, `mpv-d3d11-no-flip.log`, `mpv-opengl-hardware-auto.log`, `mpv-software-app.log`, `software-app-comparison.json`, and `maximized-cycles.json`). The initial renderer-comparison process was interrupted by the unresponsive OpenGL probe, so it did not produce a completed comparison report. Temporary runtime options disappeared when the diagnostic app was closed.
