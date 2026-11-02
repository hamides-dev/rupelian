fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let base: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("tauri.conf.json").expect("Tauri config")).expect("valid Tauri config");
    let overrides: serde_json::Value = std::env::var("TAURI_CONFIG").ok().and_then(|value| serde_json::from_str(&value).ok()).unwrap_or_default();
    let identifier = overrides.get("identifier").and_then(|value| value.as_str())
        .or_else(|| base.get("identifier").and_then(|value| value.as_str())).expect("app identifier");
    println!("cargo:rustc-env=LINGO_APP_IDENTIFIER={identifier}");
    tauri_build::build()
}
