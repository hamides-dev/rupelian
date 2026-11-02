#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod bootstrap;
#[cfg(windows)]
mod bootstrap_protocol;
#[cfg(windows)]
mod portable_payload;

fn main() {
    #[cfg(windows)]
    bootstrap::run();
    #[cfg(not(windows))]
    rupelian_lib::run();
}
