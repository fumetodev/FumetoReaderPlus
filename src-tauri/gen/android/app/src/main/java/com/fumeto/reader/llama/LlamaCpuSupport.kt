package com.fumeto.reader.llama

/**
 * Whether this CPU can run the arm64 llama library.
 *
 * The arm64 library is built for armv8.2-a+dotprod (CMakeLists.txt), and its
 * quantized dot-product kernels issue SDOT unconditionally. An ARMv8.0 core
 * (Cortex-A53/A73 class) takes SIGILL on the first translation, so on such a
 * CPU the library is not loaded at all and the translator reports itself
 * unavailable. Only the arm64 build needs this; the other ABIs are compiled
 * for their baseline.
 *
 * The kernel reports dot product as `asimddp` only from Linux 4.15. An older
 * kernel leaves it out even on cores that have it (a Snapdragon 845 on 4.9
 * lists none), and the translator runs there today, so a missing flag is
 * believed only from 4.15 on. Anything unreadable keeps the old behaviour.
 */
internal object LlamaCpuSupport {
    /** `null` when the library may be loaded, else why not. */
    fun unsupportedReason(osArch: String?, cpuinfo: String?, osVersion: String?): String? {
        if (osArch != "aarch64") return null
        val features = cpuinfo?.lineSequence()
            ?.firstOrNull { it.startsWith("Features") }
            ?.substringAfter(':')?.trim()?.split(Regex("\\s+"))?.toSet()
            ?: return null
        if ("asimddp" in features) return null
        val kernel = Regex("^(\\d+)\\.(\\d+)").find(osVersion.orEmpty()) ?: return null
        val major = kernel.groupValues[1].toInt()
        val minor = kernel.groupValues[2].toInt()
        if (major < 4 || (major == 4 && minor < 15)) return null
        return "CPU lacks the ARMv8.2 dot-product instructions"
    }

    fun unsupportedReason(): String? = unsupportedReason(
        System.getProperty("os.arch"),
        try {
            java.io.File("/proc/cpuinfo").readText()
        } catch (_: Exception) {
            null
        },
        System.getProperty("os.version"),
    )
}
