#pragma once

// Inference thread count derived from the CPU's core topology.
//
// ggml runs every matmul behind a per-op barrier, so a forward pass moves at
// the pace of its slowest worker. On a big.LITTLE / DynamIQ SoC one worker more
// than there are fast cores lands on an in-order little core (roughly 3x slower
// per thread) and drags the whole model down to it — and migrates around, so
// the throughput is unstable as well as lower. Measured on a Snapdragon 8 Gen 2 (SM8550:
// 3x A510 + 4x A715/A710 + 1x X3), Hy-MT2 v4 Q4_K_M, pp128/tg32 tokens/s:
//
//   6 threads   61.8 +/- 6.4 / 22.9   (app default until 2026-08-28; a rerun gave 53.7)
//   5 threads   67.9 +/- 0.05 / 24.9
//   5 threads pinned to the five fast cores: identical to 5 unpinned
//
// Pinning bought nothing because the scheduler already places N hot threads on
// the N fastest cores, so this module only decides the COUNT and never sets an
// affinity. Leaving the little cores to the scheduler is also where the WebView
// main thread and the OCR workers belong. A per-SoC table would be wrong in
// both directions: the Snapdragon 8 Elite has no little cores at all (2 prime +
// 6 performance), and the same fast-core rule has to hold for Exynos, Dimensity
// and Tensor parts. Six remains the cap because on the 8 Elite's eight fast
// cores generation is flat from four threads up (memory-bound, 43-46 tg t/s at
// every count) and eight threads buys 11% on prompt processing — about 5 ms of
// a bubble — for every core the WebView main thread and OCR would otherwise
// have, on an SoC that throttled visibly under a back-to-back sweep.
//
// Classification reads MIDR_EL1 per core, which the kernel exposes unprivileged
// at /sys/devices/system/cpu/cpuN/regs/identification/midr_el1. Header-only and
// free of llama.cpp/NDK dependencies so `npm run test:native` covers it.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>

namespace fumeto::cpu_topology {

// MIDR_EL1 layout: [31:24] implementer, [23:20] variant, [19:16] architecture,
// [15:4] part number, [3:0] revision.
constexpr uint32_t IMPLEMENTER_ARM = 0x41;
constexpr uint32_t IMPLEMENTER_QUALCOMM = 0x51;

inline uint32_t midrImplementer(uint32_t midr) { return (midr >> 24) & 0xffu; }
inline uint32_t midrPart(uint32_t midr) { return (midr >> 4) & 0xfffu; }

// The in-order "little" microarchitectures. Everything not listed here counts
// as fast — an unknown part is a new core, not a slow one.
inline bool isInOrderLittleCore(uint32_t midr) {
    const uint32_t part = midrPart(midr);
    switch (midrImplementer(midr)) {
        case IMPLEMENTER_ARM:
            switch (part) {
                case 0xd02: // Cortex-A34
                case 0xd03: // Cortex-A53
                case 0xd04: // Cortex-A35
                case 0xd05: // Cortex-A55
                case 0xd46: // Cortex-A510
                case 0xd80: // Cortex-A520
                    return true;
                default:
                    return false;
            }
        case IMPLEMENTER_QUALCOMM:
            switch (part) {
                case 0x801: // Kryo 260/280 Silver (Cortex-A53 derived)
                case 0x803: // Kryo 385 Silver (Cortex-A55 derived)
                case 0x805: // Kryo 485/585 Silver (Cortex-A55 derived)
                    return true;
                default:
                    return false;
            }
        default:
            return false;
    }
}

// Parses the sysfs text form ("0x00000000411fd461\n"); false on anything else.
inline bool parseMidr(const std::string & text, uint32_t & out) {
    size_t begin = 0;
    while (begin < text.size() && (text[begin] == ' ' || text[begin] == '\t')) ++begin;
    if (begin >= text.size()) return false;
    const char * start = text.c_str() + begin;
    char * end = nullptr;
    const unsigned long long value = std::strtoull(start, &end, 16);
    if (end == start) return false;
    while (*end == '\n' || *end == '\r' || *end == ' ' || *end == '\t') ++end;
    if (*end != '\0') return false;
    if (value > 0xffffffffull) return false;
    out = static_cast<uint32_t>(value);
    return true;
}

struct CoreCensus {
    int cores = 0;       // cpuN directories found
    int fast = 0;        // cores whose MIDR is not an in-order little part
    int unreadable = 0;  // cores whose MIDR could not be read or parsed
};

inline bool readSmallFile(const std::string & path, std::string & out) {
    FILE * f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    char buf[128];
    const size_t n = std::fread(buf, 1, sizeof(buf) - 1, f);
    std::fclose(f);
    if (n == 0) return false;
    buf[n] = '\0';
    out.assign(buf, n);
    return true;
}

// Walks cpu0, cpu1, ... under `sysfsCpuRoot` until the first missing directory
// (the kernel numbers possible cores contiguously). A core whose register file
// is absent — hot-unplugged, or a kernel without the cpuregs sysfs — is counted
// separately so the caller can decide what an unknown core is worth.
inline CoreCensus countFastCores(const std::string & sysfsCpuRoot) {
    CoreCensus census;
    for (int index = 0; index < 1024; ++index) {
        const std::string dir = sysfsCpuRoot + "/cpu" + std::to_string(index);
        struct stat st {};
        if (::stat(dir.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) break;
        census.cores += 1;
        std::string text;
        uint32_t midr = 0;
        if (!readSmallFile(dir + "/regs/identification/midr_el1", text) || !parseMidr(text, midr)) {
            census.unreadable += 1;
            continue;
        }
        if (!isInOrderLittleCore(midr)) census.fast += 1;
    }
    return census;
}

// The worker count: fast cores, clamped to [minThreads, maxThreads]. An
// unreadable core is assumed fast, so a partial or absent register listing
// degrades to the old fixed count rather than to fewer workers than the SoC has
// fast cores. No cores at all means the topology could not be read; then the
// fallback is returned untouched.
inline int inferenceThreadCount(const CoreCensus & census, int fallback,
                                int minThreads = 4, int maxThreads = 6) {
    if (census.cores <= 0) return fallback;
    const int assumedFast = census.fast + census.unreadable;
    if (assumedFast < minThreads) return minThreads;
    if (assumedFast > maxThreads) return maxThreads;
    return assumedFast;
}

} // namespace fumeto::cpu_topology
