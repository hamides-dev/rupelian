// Stable C ABI shared by the small Windows EXE and the deferred runtime DLL.
// Keep this module independent of Tauri, serde, and the application's services.
pub const BOOTSTRAP_ABI: u32 = 1;
pub const FINISH_BOOTSTRAP: u32 = 0x8000 + 41;
pub const READ_BOOTSTRAP_BOUNDS: u32 = 0x8000 + 42;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BootstrapInfo {
    pub abi_version: u32,
    pub window: usize,
    pub entry_unix_ms: u64,
    pub first_paint_unix_ms: u64,
    pub first_paint_elapsed_ms: u64,
    pub runtime_load_started_unix_ms: u64,
}
