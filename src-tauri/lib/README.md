# Native Windows playback libraries

Run `npm run setup:media` to restore the pinned x64 `libmpv-2.dll` and `libmpv-wrapper.dll`. The manifest selects the baseline LGPL x86_64 mpv build, not the CPU-specific v3 build.

These third-party binaries are excluded from source control. See `packaging/THIRD-PARTY-NOTICES.txt` and `packaging/licenses/` for upstream references and license texts. Do not replace them with a newer build without playback validation.
