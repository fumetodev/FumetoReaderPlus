package com.fumeto.reader.llama

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BenchmarkMonotonicClockTest {
    @Test
    fun preservesNanosecondsAsAnExactDecimalString() {
        assertEquals("9007199254740993", BenchmarkMonotonicClock.encodeNanos(9_007_199_254_740_993L))
    }

    @Test
    fun rejectsNegativeElapsedRealtime() {
        assertThrows(IllegalArgumentException::class.java) {
            BenchmarkMonotonicClock.encodeNanos(-1L)
        }
    }
}
