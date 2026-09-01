# OpenCL ICD loader stub (link-time only)

`arm64-v8a/libOpenCL.so` is a locally built copy of the **Khronos OpenCL ICD
Loader** (<https://github.com/KhronosGroup/OpenCL-ICD-Loader>, Apache-2.0 —
the same licence as the vendored headers in `../opencl-headers/`). Its
identity is verifiable from the binary itself: it exports the loader-specific
`clGetICDLoaderInfoOCLICD` entry point and the `*_disp`/`*_unsupp` dispatch
symbols, and its build ID records NDK r27 / Android API 28.

It exists **only** so `ggml`'s OpenCL backend has something to link against
at build time. It is excluded from the APK (`packaging { jniLibs { excludes
… } }` in `app/build.gradle.kts`); at runtime the device's own vendor driver
is loaded instead. No Khronos code ships in the app binary.

To rebuild it:

```bash
git clone https://github.com/KhronosGroup/OpenCL-ICD-Loader
cd OpenCL-ICD-Loader
cmake -B build -DCMAKE_TOOLCHAIN_FILE=$NDK_HOME/build/cmake/android.toolchain.cmake \
      -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=28 \
      -DOPENCL_ICD_LOADER_HEADERS_DIR=$PWD/../opencl-headers
cmake --build build
# → build/libOpenCL.so
```
