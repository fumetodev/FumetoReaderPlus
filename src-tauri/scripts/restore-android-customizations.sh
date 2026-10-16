#!/bin/bash
# Restore Android customizations after `tauri android init`
# Run from the Fumeto/ project root.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Restoring Android customizations..."

# Restore git-tracked files
echo ""
echo "  Git-tracked files (build.gradle.kts, MainActivity.kt, LlamaBridge.kt, MLKitBridge.kt, BackgroundServiceBridge.kt, TranslationForegroundService.kt)"
echo "  can be restored with: git checkout -- src-tauri/gen/android/"
echo ""
echo "Done."
