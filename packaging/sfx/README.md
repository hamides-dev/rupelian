# Portable archive tools

The current portable EXE uses the native Rust bootstrap in
`src-tauri/src/bootstrap.rs` and `portable_payload.rs`. `7zr.exe` extracts its
appended archive once into a hash-named Local App Data cache after the native
window paints. `scripts/package-portable.ps1` appends the helper, archive, and
integrity footer to the small application EXE. The old SFX below is retained
only as a historical build input and is not used by the current packager.

`7zS2-x64.sfx` was compiled from the public-domain LZMA SDK 26.04:
https://github.com/ip7z/7zip/releases/download/26.04/lzma2604.7z

Using the Visual Studio x64 developer shell, copy `src-tauri/icons/icon.ico`
over the SDK's `C/Util/SfxSetup/setup.ico`, then run `nmake /f makefile PLATFORM=x64`
in that directory. Copy `x64/7zS2.sfx` here as `7zS2-x64.sfx`; `7zr.exe` comes
from the SDK's `bin/x64` folder. No runtime installation is performed by this stub.
Its payload is extracted to a temporary directory, the application runs there,
and the temporary directory is removed after the application exits.

`../runtime/vcruntime140.dll` is from Visual Studio Build Tools
`VC/Redist/MSVC/14.51.36231/x64/Microsoft.VC145.CRT` (14.51.36247.0).
`../runtime/vulkan-1.dll` is the installed Khronos loader 1.3.250.0.
These DLLs are copied next to the application for application-local loading.
See `../THIRD-PARTY-NOTICES.txt` and `../licenses`.
