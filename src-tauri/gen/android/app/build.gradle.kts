import java.net.URI
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing reads from the gitignored app/key.properties (created per
// gitignored). Absent that file, release builds stay unsigned so
// CI/dev machines without the upload keystore can still assemble.
val keyProperties = Properties().apply {
    val propFile = file("key.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Keep one authoritative PP-OCRv6 detector model in the repository while also
// making it available to Android's native ONNX Runtime. Tauri embeds the web
// assets in its own resource bundle, which Android's AssetManager cannot open,
// so this generated asset is required by the native session. Generating it at
// build time avoids checking in a second 62 MB copy of the model.
val ppocrNativeAssetsDir = layout.buildDirectory.dir("generated/ppocrNativeAssets")
val generatePpocrNativeAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../../../static/models")) {
        include(
            "ppocr-det-v6-medium.onnx",
            "ppocr-rec-v6-small.onnx",
            "ppocrv6_dict.txt",
        )
    }
    into(ppocrNativeAssetsDir.map { it.dir("models") })
}

// The bespoke rtmdet-manga layout model (Apache-2.0, ours) is bundled the same
// way, but the 43 MB binary stays out of git: prefer the local eval-artifacts
// copy, otherwise fetch from the canonical Hugging Face repo at build time.
val rtmdetNativeAssetsDir = layout.buildDirectory.dir("generated/rtmdetNativeAssets")
val rtmdetModelName = "rtmdet-manga-layout-1024.onnx"
val rtmdetModelBytes = 43_227_772L
val rtmdetModelUrl =
    "https://huggingface.co/fumetodev/rtmdet-manga-layout-onnx/resolve/main/$rtmdetModelName"
val prepareRtmdetNativeAssets by tasks.registering {
    val outDirProvider = rtmdetNativeAssetsDir.map { it.dir("models") }
    outputs.dir(rtmdetNativeAssetsDir)
    doLast {
        val outDir = outDirProvider.get().asFile
        outDir.mkdirs()
        val out = File(outDir, rtmdetModelName)
        if (out.length() != rtmdetModelBytes) {
            val local = rootProject.file("../../../artifacts/model-candidates/models/$rtmdetModelName")
            if (local.isFile && local.length() == rtmdetModelBytes) {
                local.copyTo(out, overwrite = true)
            } else {
                URI(rtmdetModelUrl).toURL().openStream().use { input ->
                    out.outputStream().use { output -> input.copyTo(output) }
                }
            }
            check(out.length() == rtmdetModelBytes) {
                "rtmdet model asset has ${out.length()} bytes; expected $rtmdetModelBytes"
            }
        }
    }
}

android {
    compileSdk = 36
    namespace = "com.fumeto.reader"
    // Pin to NDK 29 (shipped in AGP 8.7+). AGP's default NDK pick was NDK 27
    // on this system, whose clang is slightly older and produces spurious
    // FP16 intrinsic errors when compiling llama.cpp for armv7. Explicit
    // Tauri targets select the generated per-ABI product flavors below the
    // app module. Pinning to 29 keeps the toolchain consistent with the
    // desktop Linux cargo build and avoids the older-clang failure path.
    ndkVersion = "29.0.13846066"
    defaultConfig {
        // YACReaderLibraryServer and user-hosted OpenAI-compatible endpoints
        // commonly run over plain HTTP on private LAN addresses. Android's
        // network-security policy cannot whitelist arbitrary user-entered IPs,
        // so release builds must permit these explicit user-configured URLs.
        // The WebView CSP still prevents untrusted script/object execution.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.fumeto.reader"
        minSdk = 26
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        externalNativeBuild {
            cmake {
                // ggml's quantized dot-product kernels are C sources. `cppFlags`
                // does not reach them, so debug APKs previously compiled the
                // STQ1_0 hot loop at -O0 despite enabling ARM dot-product
                // instructions. Keep both halves of llama.cpp optimized for
                // physical-device inference benchmarks and production use.
                cFlags += "-O3"
                cppFlags += "-std=c++17 -O3"
                arguments += "-DANDROID_STL=c++_shared"
                // ABI selection belongs to the generated RustPlugin product
                // flavors (arm64, x86_64, and so on). Adding a second filter
                // here is a union, not an intersection: the previous arm64
                // default made an x86_64 APK package both architectures and
                // roughly doubled its size. Explicit Tauri --target builds
                // select one flavor, whose ndk.abiFilters also constrain this
                // CMake build and packaged AAR/JNI libraries.
            }
        }
    }
    externalNativeBuild {
        cmake {
            path = file("../../../llama-bridge/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    signingConfigs {
        create("release") {
            if (keyProperties.isNotEmpty()) {
                storeFile = file(keyProperties.getProperty("storeFile"))
                storePassword = keyProperties.getProperty("storePassword")
                keyAlias = keyProperties.getProperty("keyAlias")
                keyPassword = keyProperties.getProperty("keyPassword")
            }
        }
    }
    androidResources {
        // Only the locales the app can show; keeps every library's other translations out of the APK.
        localeFilters += listOf("en", "de", "es", "fr", "in", "it", "pt-rBR", "ru")
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            if (keyProperties.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
            // Package native symbol tables into the bundle so Play can
            // symbolicate native crashes/ANRs (llama.cpp, detection bridges)
            // without a separate manual symbols upload per release.
            ndk {
                debugSymbolLevel = "SYMBOL_TABLE"
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    sourceSets.getByName("main").assets.srcDir(ppocrNativeAssetsDir)
    sourceSets.getByName("main").assets.srcDir(rtmdetNativeAssetsDir)
    packaging {
        jniLibs {
            // Exclude the OpenCL ICD Loader stub that CMake copies into the build.
            // The vendor's real OpenCL driver is loaded at runtime via System.loadLibrary.
            excludes += setOf("**/libOpenCL.so")
        }
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("com.google.android.material:material:1.12.0")

    // Google ML Kit (text recognition + translation) was removed on 2026-07-24:
    // its attribution requirements and SDK telemetry did not fit a closed-source
    // release, and PP-OCRv6 + Hy-MT2 already cover on-device OCR and translation.

    // Kotlin coroutines for async ML Kit operations
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")

    // OkHttp for streaming the Hy-MT2 1.25-bit GGUF download (~440 MiB)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Native PP-OCRv6 detector inference. The Android artifact includes the
    // XNNPACK execution provider; the regular CPU EP remains the mandatory
    // fallback for unsupported graph nodes and devices.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.27.0")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json implementation is a compile-only stub in local JVM
    // tests; this exercises the same profile parser against real JSON values.
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test:core-ktx:1.5.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

tasks.named("preBuild").configure {
    dependsOn(generatePpocrNativeAssets)
    dependsOn(prepareRtmdetNativeAssets)
}

apply(from = "tauri.build.gradle.kts")
