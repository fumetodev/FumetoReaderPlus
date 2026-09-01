#pragma once

#include <algorithm>
#include <cstddef>
#include <vector>

// Returns the exact token prefix that can remain resident between requests.
// The final token of a fully identical next prompt is deliberately excluded:
// it must be decoded again so the context exposes prompt-final logits rather
// than logits left behind by the previous request's generated continuation.
template <typename Token>
inline size_t reusablePromptPrefix(
        const std::vector<Token> & cached,
        const std::vector<Token> & next) {
    const size_t comparable = std::min(cached.size(), next.size());
    size_t reusable = 0;
    while (reusable < comparable && cached[reusable] == next[reusable]) {
        ++reusable;
    }
    if (reusable == next.size() && reusable > 0) {
        --reusable;
    }
    return reusable;
}
