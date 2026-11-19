//! For `cargo build` (no `nsh package`): writes the translations of
//! `locales/` and `nsh.json`'s window to `OUT_DIR`, which `main.rs` compiles
//! in. `nsh package` reads both itself.

use std::{env, fs, path::PathBuf};

fn main() {
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed=locales");
    println!("cargo:rerun-if-changed=nsh.json");

    let translations = nsh_i18n::read_translations(&dir).expect("locales/");
    fs::write(out.join("translations.json"), nsh_i18n::translations_json(&translations)).unwrap();

    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("nsh.json")).unwrap()).expect("nsh.json");
    fs::write(out.join("window.json"), manifest["window"].to_string()).unwrap();
}
