fn main() {
    // `tauri::generate_context!()` embeds frontendDist into the Rust library.
    // Make that otherwise implicit macro input visible to Cargo so an Android
    // build cannot relink a fresh APK around a stale embedded web application.
    // The Tauri CLI runs the Vite beforeBuildCommand before invoking Cargo.
    println!("cargo:rerun-if-changed=../build");

    // On desktop (macOS/Windows/Linux), build llama.cpp from source via CMake
    // and link it into the Rust binary for the Tauri llama commands.
    // On mobile (Android), llama.cpp is built separately via Gradle/CMake
    // and accessed through the JNI bridge — no Rust linking needed.
    // Note: use CARGO_CFG_TARGET_* (not #[cfg] or cfg!) because build scripts
    // compile for the host — cfg! here describes the build machine.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_os != "android" && target_os != "ios" {
        let llama_dir = std::path::Path::new("llama-bridge/llama.cpp");
        if llama_dir.exists() {
            let mut cmake_cfg = cmake::Config::new(llama_dir);
            cmake_cfg
                .define("BUILD_SHARED_LIBS", "OFF")
                .define("LLAMA_BUILD_TESTS", "OFF")
                .define("LLAMA_BUILD_EXAMPLES", "OFF")
                .define("LLAMA_BUILD_SERVER", "OFF")
                .define("LLAMA_CURL", "OFF")
                // Newer llama.cpp snapshots default GGML_OPENMP=ON, which pulls
                // libgomp into ggml-cpu.c and breaks linking (neither rust-lld
                // on the Linux desktop nor the NDK clang driver on Android is
                // wired to find libgomp on its default path). The pthread
                // fallback is equally fast for our short-prompt translation
                // workload. Mirror this flag in llama-bridge/CMakeLists.txt for
                // the Android gradle path, which is a separate build system.
                .define("GGML_OPENMP", "OFF")
                // ggml defaults to GGML_NATIVE=ON for a non-cross build, which
                // compiles for the build machine's CPU (-mcpu=native /
                // -march=native): a bundle built on a CI runner would then use
                // instructions an older user machine lacks and crash. Build for
                // a fixed baseline instead, as llama-bridge/CMakeLists.txt does
                // for Android. On x86_64 this turns on ggml's SSE4.2/AVX/AVX2/
                // BMI2/FMA/F16C baseline.
                .define("GGML_NATIVE", "OFF");

            if target_os == "macos" {
                cmake_cfg
                    .define("GGML_METAL", "ON")
                    // Compile the Metal shaders into the binary rather than
                    // looking a default.metallib up on disk at runtime. This is
                    // already ggml's default with Metal on; pinned so a snapshot
                    // bump cannot silently change it.
                    .define("GGML_METAL_EMBED_LIBRARY", "ON")
                    // Tauri sets MACOSX_DEPLOYMENT_TARGET from the bundle's
                    // minimumSystemVersion (tauri.macos.conf.json); 14.0 matches
                    // it for plain `cargo build`. llama.cpp itself needs 10.15+
                    // for std::filesystem.
                    .define(
                        "CMAKE_OSX_DEPLOYMENT_TARGET",
                        std::env::var("MACOSX_DEPLOYMENT_TARGET")
                            .unwrap_or_else(|_| "14.0".to_string()),
                    );
                if target_arch == "aarch64" {
                    // The Apple M1 baseline, which every Apple Silicon Mac
                    // meets. Hy-MT2's STQ1_0 fast path is an ARM dot-product
                    // kernel, so dotprod must be on (Android pins it the same
                    // way).
                    cmake_cfg.define("GGML_CPU_ARM_ARCH", "armv8.4-a+dotprod+fp16");
                }
            }

            let dst = cmake_cfg.build();

            // Link the built libraries
            println!("cargo:rustc-link-search=native={}/lib", dst.display());
            println!("cargo:rustc-link-search=native={}/lib64", dst.display());
            println!("cargo:rustc-link-lib=static=llama");
            println!("cargo:rustc-link-lib=static=ggml");
            println!("cargo:rustc-link-lib=static=ggml-base");
            println!("cargo:rustc-link-lib=static=ggml-cpu");

            // Metal + BLAS frameworks on macOS
            if target_os == "macos" {
                println!("cargo:rustc-link-lib=static=ggml-metal");
                println!("cargo:rustc-link-lib=static=ggml-blas");
                println!("cargo:rustc-link-lib=framework=Metal");
                println!("cargo:rustc-link-lib=framework=MetalKit");
                println!("cargo:rustc-link-lib=framework=Foundation");
                println!("cargo:rustc-link-lib=framework=Accelerate");
            }

            // C++ standard library
            if target_os == "macos" {
                println!("cargo:rustc-link-lib=c++");
            } else if target_os == "linux" {
                println!("cargo:rustc-link-lib=stdc++");
            }

            println!("cargo:rerun-if-changed=llama-bridge/llama.cpp");
            println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
        }
    }

    tauri_build::build()
}
