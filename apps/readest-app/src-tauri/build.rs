use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    propagate_sentry_dsn();
    propagate_app_version();

    // Declare the app's own (non-plugin) commands in the ACL app manifest.
    // Since tauri 2.11, IPC from remote origins is always subject to ACL
    // resolution (upstream #15266); without a manifest the app commands have
    // no ACL entries at all and remote pages get "not allowed. Plugin not
    // found". The webdriver test harness serves the vitest tester page from
    // its own port, which is a remote origin, so it needs these permissions
    // granted via capabilities (see capabilities/webdriver-remote.json).
    // With a manifest defined, LOCAL windows also resolve app commands
    // through the ACL, so capabilities/default.json must grant them too.
    // Keep this list in sync with the generate_handler! list in lib.rs.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "start_server",
            "download_file",
            "upload_file",
            "get_environment_variable",
            "get_executable_dir",
            "set_webview_info",
            "fetch_kavita_cover",
            "cancel_kavita_cover_fetch",
            "is_updater_disabled",
            "allow_paths_in_scopes",
            "read_dir",
            "parse_epub_metadata",
            "extract_epub_cover_full",
            "parse_epub_full",
            "parse_mobi_metadata",
            "extract_mobi_cover_full",
            "auth_with_safari",
            "start_apple_sign_in",
            "set_traffic_lights",
            "show_lookup_popover",
            "update_book_presence",
            "clear_book_presence",
            "clip_url",
            "spawn_fresh_browser",
            "verify_update_signature",
            "install_nightly_update",
        ]),
    ))
    .expect("failed to run tauri-build");
}

/// Bake the app version from `package.json` into the crate as `READEST_APP_VERSION`
/// (read back via `option_env!`). Sentry keys its release/environment off this
/// rather than `CARGO_PKG_VERSION`, because the crate version in `Cargo.toml` is
/// not kept in sync with the app version (and only `package.json` carries the
/// nightly `-YYYYMMDDHH` stamp). Absent/unparseable => unset, so the Rust code
/// falls back to the crate version.
fn propagate_app_version() {
    let package_json = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("..")
        .join("package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());

    if let Some(version) = read_json_string_field(&package_json, "version") {
        println!("cargo:rustc-env=READEST_APP_VERSION={version}");
    }
}

/// Read a top-level `"key": "value"` string from a JSON file without pulling in a
/// JSON parser. Returns the first match; `None` if the file/key is absent or the
/// value is empty. `package.json`'s own `"version"` is the first `"version"` key.
fn read_json_string_field(path: &Path, key: &str) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    let needle = format!("\"{key}\"");
    for line in contents.lines() {
        let Some(rest) = line.trim_start().strip_prefix(&needle) else {
            continue;
        };
        let value = rest
            .trim_start()
            .strip_prefix(':')?
            .trim()
            .trim_end_matches(',')
            .trim()
            .trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Bake only an explicitly configured Remote-owned Sentry DSN into the crate.
/// Upstream environment variables and dotenv files are deliberately ignored.
///
/// Debug builds never bake a DSN, whatever the environment
/// say. `tauri dev` and `tauri ios dev` serve the app from the dev server, which
/// puts the page on a different origin than Tauri's IPC custom protocol, so every
/// report the injected `@sentry/browser` sends over that bridge fails -- and each
/// failure logs an error that Sentry turns into another report, which spins until
/// the WebView is too busy to render. The DSN is cleared rather than merely left
/// unset because `option_env!` would otherwise still see a `SENTRY_DSN` exported
/// in the developer's shell.
fn propagate_sentry_dsn() {
    println!("cargo:rerun-if-env-changed=READEST_REMOTE_SENTRY_DSN");

    if env::var("PROFILE").as_deref() != Ok("release") {
        println!("cargo:rustc-env=SENTRY_DSN=");
        return;
    }

    let dsn = env::var("READEST_REMOTE_SENTRY_DSN")
        .ok()
        .filter(|value| !value.trim().is_empty());

    if let Some(dsn) = dsn {
        println!("cargo:rustc-env=SENTRY_DSN={dsn}");
    } else {
        println!("cargo:rustc-env=SENTRY_DSN=");
    }
}
