fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_OS");

    // build.rs is compiled for the host, so cfg!(target_os) reports Windows
    // even when Cargo is building the library for Android or iOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
