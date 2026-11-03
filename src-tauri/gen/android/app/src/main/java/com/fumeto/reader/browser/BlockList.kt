package com.fumeto.reader.browser

/**
 * The browser's ad blocking, by domain only: a request is blocked when its host, or a domain above it, is named by a
 * plain domain rule in one of the downloaded lists. Element hiding and rules scoped to particular sites, paths or
 * resource types are not understood and are skipped, so a list can only ever block whole ad domains — the ones the
 * pop-under and banner networks serve from.
 *
 * Domains are kept as sorted 64-bit hashes: the lists name well over a hundred thousand domains, and a set of strings
 * that size is tens of megabytes of Java heap. A false match needs a 64-bit collision.
 */
class BlockList private constructor(private val blocked: LongArray, private val allowed: LongArray) {
    val size: Int get() = blocked.size

    fun isBlocked(host: String): Boolean {
        val h = host.lowercase().trimEnd('.')
        if (h.isEmpty()) return false
        return !matches(allowed, h) && matches(blocked, h)
    }

    private fun matches(set: LongArray, host: String): Boolean {
        if (set.isEmpty()) return false
        var start = 0
        while (true) {
            if (set.binarySearch(hash(host, start)) >= 0) return true
            val dot = host.indexOf('.', start)
            if (dot < 0) return false
            start = dot + 1
        }
    }

    companion object {
        val EMPTY = BlockList(LongArray(0), LongArray(0))

        // Options that leave a rule meaning "this whole domain". A rule limited to resource types, to the sites it
        // applies on (`domain=`), or that rewrites rather than blocks is skipped.
        private val DOMAIN_WIDE_OPTIONS = setOf("third-party", "3p", "important", "all", "popup", "document", "doc")
        private val HOSTNAME = Regex("^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$")

        /** Parses one list; Adblock-style (`||domain^`), hosts-file and bare-domain lines are understood. */
        fun parse(lines: Sequence<String>): BlockList = Builder().add(lines).build()

        /** `example.com^` or `example.com^$opts` → `example.com`, when the rule covers the whole domain. */
        private fun domainRule(body: String, exception: Boolean): String? {
            val caret = body.indexOf('^')
            if (caret <= 0) return null
            val name = body.substring(0, caret).lowercase()
            if (!HOSTNAME.matches(name)) return null
            val rest = body.substring(caret + 1)
            if (rest.isEmpty() || rest == "|") return name
            if (!rest.startsWith('$')) return null
            val options = rest.substring(1).split(',').map { it.trim().lowercase() }
            // An exception with options is scoped to something; honouring it as a whole-domain allowance would let a
            // blocked network back in everywhere.
            if (exception) return null
            return if (options.all { it in DOMAIN_WIDE_OPTIONS }) name else null
        }

        /** FNV-1a over `s` from `start`, so a host's parent domains hash without allocating substrings. */
        private fun hash(s: String, start: Int): Long {
            var h = -0x340d631b7bdddcdbL
            for (i in start until s.length) {
                h = h xor s[i].code.toLong()
                h *= 0x100000001b3L
            }
            return h
        }
    }

    /** Several lists into one, a file at a time, without holding any list's text. */
    class Builder {
        private var blocked = LongArray(1024)
        private var blockedCount = 0
        private var allowed = LongArray(64)
        private var allowedCount = 0

        fun add(lines: Sequence<String>): Builder {
            for (raw in lines) {
                val line = raw.trim()
                if (line.isEmpty() || line[0] == '!' || line[0] == '[' || line[0] == '#') continue
                if (line.contains("##") || line.contains("#@#") || line.contains("#?#") || line.contains("#$#")) continue
                when {
                    line.startsWith("@@||") -> domainRule(line.substring(4), exception = true)?.let { allow(it) }
                    line.startsWith("||") -> domainRule(line.substring(2), exception = false)?.let { block(it) }
                    line.startsWith("0.0.0.0 ") || line.startsWith("127.0.0.1 ") -> {
                        val name = line.substringAfter(' ').trim().substringBefore(' ').substringBefore('#').lowercase()
                        if (name != "localhost" && HOSTNAME.matches(name)) block(name)
                    }
                    else -> line.lowercase().let { if (HOSTNAME.matches(it)) block(it) }
                }
            }
            return this
        }

        private fun block(name: String) {
            if (blockedCount == blocked.size) blocked = blocked.copyOf(blocked.size * 2)
            blocked[blockedCount++] = hash(name, 0)
        }

        private fun allow(name: String) {
            if (allowedCount == allowed.size) allowed = allowed.copyOf(allowed.size * 2)
            allowed[allowedCount++] = hash(name, 0)
        }

        fun build(): BlockList = BlockList(distinct(blocked, blockedCount), distinct(allowed, allowedCount))

        private fun distinct(values: LongArray, count: Int): LongArray {
            val sorted = values.copyOf(count).also { it.sort() }
            var n = 0
            for (i in sorted.indices) if (i == 0 || sorted[i] != sorted[i - 1]) sorted[n++] = sorted[i]
            return sorted.copyOf(n)
        }
    }
}
