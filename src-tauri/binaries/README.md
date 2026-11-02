# Windows media helpers

Run `npm run setup:media` from the repository root to restore the pinned Windows x64 yt-dlp, Deno, FFmpeg, and FFprobe executables. Their versions, upstream download URLs, and expected SHA256 hashes are in `scripts/media-dependencies.json`.

Executables are local dependencies and are excluded from Git. Keep the included license notices. Updating a dependency requires updating its manifest hashes and rerunning its relevant playback checks.
