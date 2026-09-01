package com.fumeto.reader.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PPOcrOrtProviderProfileTest {
    @Test
    fun parsesActualNodeProvidersAndFallbackOps() {
        val summary = PPOcrOrtProviderProfileParser.parseJson(
            """
            [
              {"cat":"Session","name":"model_run","dur":120},
              {"cat":"Node","name":"conv_1_kernel_time","dur":40,
               "args":{"provider":"XnnpackExecutionProvider","op_name":"Conv"}},
              {"cat":"Node","name":"relu_1_kernel_time","dur":5,
               "args":{"provider":"XnnpackExecutionProvider","op_name":"Relu"}},
              {"cat":"Node","name":"shape_1_kernel_time","dur":3,
               "args":{"provider":"CPUExecutionProvider","op_name":"Shape"}},
              {"cat":"Node","name":"unassigned_fence","dur":1,"args":{}}
            ]
            """.trimIndent(),
        )

        assertEquals(5, summary.traceEvents)
        assertEquals(4, summary.nodeEvents)
        assertEquals(3, summary.assignedNodeEvents)
        assertEquals(1, summary.unassignedNodeEvents)
        assertEquals(2, summary.nodeEventsFor("XnnpackExecutionProvider"))
        assertEquals(1, summary.nodeEventsFor("CPUExecutionProvider"))
        assertEquals(2, summary.providerUniqueNodes["XnnpackExecutionProvider"])
        assertEquals(45.0, summary.providerDurationMicros["XnnpackExecutionProvider"]!!, 0.0)
        assertEquals(1, summary.providerOpCounts["CPUExecutionProvider"]?.get("Shape"))

        val evidence = PPOcrOrtProviderProfileParser.evidence(
            component = "detector",
            config = PPOcrSessionConfig(PPOcrExecutionProvider.XNNPACK, 4),
            inputCount = 1,
            outputCount = 7,
            profile = summary,
        )
        assertTrue(evidence.requestedProviderAssigned)
        assertTrue(evidence.xnnpackAssigned)
        assertTrue(evidence.cpuFallbackObserved)
        assertEquals(2, evidence.xnnpackNodeEvents)
        assertEquals(1, evidence.cpuNodeEvents)
        assertTrue(evidence.isolatedOneShotSession)
        assertTrue(evidence.profileDeleted)
    }

    @Test
    fun acceptsTraceEventsObjectAndDoesNotClaimXnnpackForCpuOnlyProfile() {
        val summary = PPOcrOrtProviderProfileParser.parseJson(
            """
            {"traceEvents":[
              {"name":"gemm_kernel_time","dur":7,
               "args":{"execution_provider":"CPUExecutionProvider","opName":"Gemm"}}
            ]}
            """.trimIndent(),
        )
        val evidence = PPOcrOrtProviderProfileParser.evidence(
            component = "recognizer",
            config = PPOcrSessionConfig(PPOcrExecutionProvider.XNNPACK, 2),
            inputCount = 2,
            outputCount = 2,
            profile = summary,
        )

        assertEquals(1, summary.nodeEvents)
        assertFalse(evidence.requestedProviderAssigned)
        assertFalse(evidence.xnnpackAssigned)
        assertTrue(evidence.cpuFallbackObserved)
    }
}
