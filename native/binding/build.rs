use std::{env, path::PathBuf, process::Command};

fn run(command: &mut Command) {
    let status = command
        .status()
        .expect("could not run the native platform compiler");
    assert!(
        status.success(),
        "native platform compilation failed: {command:?}"
    );
}

fn main() {
    napi_build::setup();
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let sources = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../pip");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("unsupported macOS PiP architecture: {other}"),
    };
    println!(
        "cargo:rerun-if-changed={}",
        sources.join("KlausPIP.h").display()
    );
    let mut objects = Vec::new();
    for name in ["KlausPIPHost", "KlausPIPTransport"] {
        let source = sources.join(format!("{name}.m"));
        println!("cargo:rerun-if-changed={}", source.display());
        let object = out.join(format!("{name}.o"));
        run(Command::new("xcrun")
            .args([
                "clang",
                "-O2",
                "-fobjc-arc",
                "-fblocks",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-mmacosx-version-min=10.15",
                "-arch",
                arch,
                "-c",
            ])
            .arg(source)
            .arg("-o")
            .arg(&object));
        objects.push(object);
    }
    let permissions = sources.join("../permissions");
    println!(
        "cargo:rerun-if-changed={}",
        permissions.join("KlausPermissions.h").display()
    );
    let source = permissions.join("KlausPermissions.m");
    println!("cargo:rerun-if-changed={}", source.display());
    let object = out.join("KlausPermissions.o");
    run(Command::new("xcrun")
        .args([
            "clang",
            "-O2",
            "-fobjc-arc",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-mmacosx-version-min=10.15",
            "-arch",
            arch,
            "-c",
        ])
        .arg(source)
        .arg("-o")
        .arg(&object));
    objects.push(object);
    let pet_source = sources.join("../pets/KlausPetPanel.m");
    println!("cargo:rerun-if-changed={}", pet_source.display());
    println!(
        "cargo:rerun-if-changed={}",
        sources.join("../pets/KlausPetPanel.h").display()
    );
    println!("cargo:rerun-if-changed={}", sources.join("../pets/KlausAppshotShortcut.h").display());
    let pet_object = out.join("KlausPetPanel.o");
    run(Command::new("xcrun")
        .args([
            "clang",
            "-O2",
            "-fobjc-arc",
            "-fblocks",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-mmacosx-version-min=10.15",
            "-arch",
            arch,
            "-c",
        ])
        .arg(pet_source)
        .arg("-o")
        .arg(&pet_object));
    objects.push(pet_object);
    run(Command::new("xcrun")
        .args(["ar", "rcs"])
        .arg(out.join("libklaus_pip_host.a"))
        .args(objects));
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=klaus_pip_host");
    // Rust links the Objective-C archive, so clang cannot add its availability
    // runtime automatically. N-API's dynamic lookup would otherwise hide this
    // missing symbol until the first @available check crashes at address zero.
    let runtime = Command::new("xcrun")
        .args(["clang", "-print-file-name=libclang_rt.osx.a"])
        .output()
        .expect("could not locate clang's macOS availability runtime");
    assert!(
        runtime.status.success(),
        "could not locate clang's macOS runtime"
    );
    let runtime = PathBuf::from(String::from_utf8(runtime.stdout).unwrap().trim());
    assert!(
        runtime.is_file(),
        "clang's macOS runtime archive is missing"
    );
    println!(
        "cargo:rustc-link-search=native={}",
        runtime.parent().unwrap().display()
    );
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
    for framework in [
        "AppKit",
        "QuartzCore",
        "CoreImage",
        "ApplicationServices",
        "CoreServices",
        "ImageIO",
        "Photos",
        "CoreLocation",
        "UserNotifications",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
