cmake_minimum_required(VERSION 3.22.1)
project(fumeto_llama)

# OpenCL acceleration is an arm64/Adreno feature in this app. Emulator builds
# use llama.cpp's CPU backend; pointing an x86_64 linker at the arm64 OpenCL
# stub would otherwise make the JNI library impossible to build or load.
if(ANDROID_ABI STREQUAL "arm64-v8a")
    # Hy-MT2's STQ1_0 fast path is an ARM NEON dot-product kernel. Android's
    # default arm64 target is only armv8-a, which leaves __ARM_FEATURE_DOTPROD
    # undefined and silently selects the much slower scalar-emulation path.
    # Snapdragon 8 Elite supports dotprod; compile the arm64 translation
    # runtime for that instruction level so the intended kernel is used.
    set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
    set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod" CACHE STRING "" FORCE)
    set(OpenCL_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/opencl-headers" CACHE PATH "" FORCE)
    set(OpenCL_LIBRARY "${CMAKE_CURRENT_SOURCE_DIR}/opencl-lib/arm64-v8a/libOpenCL.so" CACHE FILEPATH "" FORCE)
    set(GGML_OPENCL ON CACHE BOOL "" FORCE)
    set(GGML_OPENCL_USE_ADRENO_KERNELS ON CACHE BOOL "" FORCE)
    set(GGML_OPENCL_EMBED_KERNELS ON CACHE BOOL "" FORCE)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
    # llama.cpp's llamafile SGEMM specializes its NEON half loads with
    # AArch64 FP16-vector intrinsics. They are unavailable in the NDK's
    # armeabi-v7a target, even though ordinary ARMv7 NEON is enabled. Keep the
    # portable ggml matmul path for this compatibility ABI; arm64 retains the
    # optimized llamafile and STQ kernels used by production devices.
    set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
    set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
    set(GGML_OPENCL_USE_ADRENO_KERNELS OFF CACHE BOOL "" FORCE)
    set(GGML_OPENCL_EMBED_KERNELS OFF CACHE BOOL "" FORCE)
else()
    set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
    set(GGML_LLAMAFILE ON CACHE BOOL "" FORCE)
    set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
    set(GGML_OPENCL_USE_ADRENO_KERNELS OFF CACHE BOOL "" FORCE)
    set(GGML_OPENCL_EMBED_KERNELS OFF CACHE BOOL "" FORCE)
endif()

# llama.cpp build settings
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)

# Disable OpenMP for ggml-cpu: the previous vendored llama.cpp snapshot had
# OpenMP off by default, newer ones flip it on which pulls in libgomp as a
# link dependency. Neither the desktop build (rust-lld doesn't have libgomp
# on the default link path) nor the Android NDK build (clang OpenMP runtime
# has a different symbol set) is wired to handle this, and for short-prompt
# translation inference the pthread path is equally fast. Leave OFF unless
# someone later needs OpenMP parallelism and is willing to plumb libgomp
# through both build systems.
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
add_subdirectory(llama.cpp)

# JNI wrapper — links llama (carries ggml + ggml-opencl transitively)
add_library(fumeto_llama SHARED jni_bridge.cpp)
target_link_libraries(fumeto_llama PRIVATE llama log)
target_include_directories(fumeto_llama PRIVATE llama.cpp/include llama.cpp/ggml/include)
