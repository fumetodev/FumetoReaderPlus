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
                .define("GGML_OPENMP", "OFF");

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
