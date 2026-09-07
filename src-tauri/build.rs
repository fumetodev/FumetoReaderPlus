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
    // Note: use CARGO_CFG_TARGET_OS (not #[cfg]) because build scripts compile for the host.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
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
                // Only the library is linked. Under the cmake crate llama.cpp
                // sees itself as a standalone checkout and would otherwise
                // configure and compile `common/` and `tools/` (llama-bench,
                // the HTTP client and its OpenSSL probe) that nothing here uses.
                .define("LLAMA_BUILD_COMMON", "OFF")
                .define("LLAMA_BUILD_TOOLS", "OFF")
                .define("LLAMA_OPENSSL", "OFF");

            // Portable x86-64 instruction-set baseline. ggml defaults to
            // `-march=native`, so a release built on a machine with AVX-512
            // emits AVX-512 code and crashes with SIGILL on the far more
            // common AVX2-only CPU. Every flag is pinned explicitly because
            // ggml's own per-ISA defaults flip to OFF whenever the build is a
            // cross build or SOURCE_DATE_EPOCH is set, which would silently
            // produce a plain-SSE2 (several times slower) library instead.
            // The list is mirrored by `desktop::cpu_missing_features`, which
            // refuses to load a model on a CPU that lacks any of these.
            let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
            if target_arch == "x86_64" {
                cmake_cfg
                    .define("GGML_NATIVE", "OFF")
                    .define("GGML_SSE42", "ON")
                    .define("GGML_AVX", "ON")
                    .define("GGML_AVX2", "ON")
                    .define("GGML_FMA", "ON")
                    .define("GGML_F16C", "ON")
                    .define("GGML_BMI2", "ON")
                    .define("GGML_AVX_VNNI", "OFF")
                    .define("GGML_AVX512", "OFF")
                    .define("GGML_AVX512_VBMI", "OFF")
                    .define("GGML_AVX512_VNNI", "OFF")
                    .define("GGML_AVX512_BF16", "OFF")
                    // The tinyBLAS matmul kernels for the baseline above.
                    .define("GGML_LLAMAFILE", "ON");
            }

            // Enable Metal GPU acceleration on macOS
            if cfg!(target_os = "macos") {
                cmake_cfg.define("GGML_METAL", "ON");
                // llama.cpp uses std::filesystem which requires macOS 10.15+
                cmake_cfg.define("CMAKE_OSX_DEPLOYMENT_TARGET", "11.0");
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
            if cfg!(target_os = "macos") {
                println!("cargo:rustc-link-lib=static=ggml-metal");
                println!("cargo:rustc-link-lib=static=ggml-blas");
                println!("cargo:rustc-link-lib=framework=Metal");
                println!("cargo:rustc-link-lib=framework=MetalKit");
                println!("cargo:rustc-link-lib=framework=Foundation");
                println!("cargo:rustc-link-lib=framework=Accelerate");
            }

            // C++ standard library
            if cfg!(target_os = "macos") {
                println!("cargo:rustc-link-lib=c++");
            } else if cfg!(target_os = "linux") {
                println!("cargo:rustc-link-lib=stdc++");
            }

            println!("cargo:rerun-if-changed=llama-bridge/llama.cpp");
        }
    }

    tauri_build::build()
}
