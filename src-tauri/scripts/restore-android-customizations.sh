#!/bin/bash
# Restore Android customizations after `tauri android init`
# Run from the Fumeto/ project root.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Restoring Android customizations..."

# 1. Restore OpenCL ICD Loader stub (required for link-time dependency resolution)
OPENCL_SRC="$PROJECT_ROOT/src-tauri/llama-bridge/opencl-lib/arm64-v8a/libOpenCL.so"
OPENCL_DST="$PROJECT_ROOT/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libOpenCL.so"
mkdir -p "$(dirname "$OPENCL_DST")"
if [ -f "$OPENCL_SRC" ]; then
    cp "$OPENCL_SRC" "$OPENCL_DST"
    echo "  ✓ Copied libOpenCL.so (ICD Loader stub) to jniLibs"
else
    echo "  ✗ OpenCL stub not found at $OPENCL_SRC"
fi

# 2. Restore git-tracked files
echo ""
echo "  Git-tracked files (build.gradle.kts, MainActivity.kt, LlamaBridge.kt, MLKitBridge.kt, BackgroundServiceBridge.kt, TranslationForegroundService.kt)"
echo "  can be restored with: git checkout -- src-tauri/gen/android/"
echo ""
echo "Done."
