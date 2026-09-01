package com.fumeto.reader.llama

/** Pure serialization boundary shared by the debug JavaScript bridge and JVM tests. */
internal object BenchmarkMonotonicClock {
    fun encodeNanos(value: Long): String {
        require(value >= 0L) { "Elapsed realtime must be non-negative" }
        return value.toString()
    }
}
