package com.fumeto.reader.llama

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class LlamaCpuSupportTest {
    private fun cpuinfo(features: String) =
        "processor\t: 0\nBogoMIPS\t: 38.40\nFeatures\t: $features\nCPU implementer\t: 0x41\n"

    private val dotprodCore =
        "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp"
    private val armv80Core = "fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid"

    @Test
    fun dotProductCoreLoads() {
        assertNull(LlamaCpuSupport.unsupportedReason("aarch64", cpuinfo(dotprodCore), "6.1.99-android14-11"))
    }

    @Test
    fun armv80CoreOnACurrentKernelIsRefused() {
        assertNotNull(LlamaCpuSupport.unsupportedReason("aarch64", cpuinfo(armv80Core), "4.19.157-perf+"))
        assertNotNull(LlamaCpuSupport.unsupportedReason("aarch64", cpuinfo(armv80Core), "4.15.0"))
    }

    @Test
    fun kernelTooOldToReportDotProductIsNotBelieved() {
        // A Snapdragon 845 on 4.9 lists no asimddp although its cores run SDOT.
        val sd845 = "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp"
        assertNull(LlamaCpuSupport.unsupportedReason("aarch64", cpuinfo(sd845), "4.9.165-gfff483291c07-ab5725533"))
        assertNull(LlamaCpuSupport.unsupportedReason("aarch64", cpuinfo(sd845), "4.14.190-perf+"))
    }

    @Test
    fun otherArchitecturesAreNotChecked() {
        assertNull(LlamaCpuSupport.unsupportedReason("x86_64", "flags\t: fpu sse2\n", "6.6.30"))
        assertNull(LlamaCpuSupport.unsupportedReason("armv8l", cpuinfo(armv80Core), "5.10.0"))
    }

    @Test
    fun unreadableInputKeepsTheLibrary() {
        assertNull(LlamaCpuSupport.unsupportedReason("aarch64", null, "5.10.0"))
        assertNull(LlamaCpuSupport.unsupportedReason("aarch64", "processor\t: 0\n", "5.10.0"))
        assertNull(LlamaCpuSupport.unsupportedReason("aarch64", cpuinfo(armv80Core), null))
        assertNull(LlamaCpuSupport.unsupportedReason("aarch64", cpuinfo(armv80Core), "unknown"))
    }
}
