#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "llama.h"

// Prompt-prefix reuse for models whose memory cannot be rewound.
//
// A dense transformer keeps one KV entry per token, so dropping a prompt's tail
// is a range removal and the shared instruction stays resident between
// bubbles. A hybrid model (Qwen3.5 interleaves recurrent layers with attention
// layers) also carries one running state per recurrent layer, and a running
// state has no earlier value to return to: llama_memory_seq_rm refuses any
// removal that would cut into it, so every bubble would pay for the whole
// prompt again.
//
// The recurrent state is small and can be copied. Taking a copy at the end of
// the instruction and putting it back before the next bubble returns the
// recurrent half to that point; after that the attention half can be trimmed
// like any other KV cache. llama.cpp's own server checkpoints hybrid models the
// same way.
namespace fumeto {

struct RecurrentPrefix {
    // The prompt prefix the state below was captured after.
    std::vector<llama_token> tokens;
    // Sequence zero's recurrent state at that point (partial-state image).
    std::vector<uint8_t> state;

    bool empty() const { return tokens.empty() || state.empty(); }
    void clear() {
        tokens.clear();
        state.clear();
    }
};

inline size_t commonPrefixLength(
        const std::vector<llama_token> & a,
        const std::vector<llama_token> & b) {
    const size_t comparable = std::min(a.size(), b.size());
    size_t length = 0;
    while (length < comparable && a[length] == b[length]) ++length;
    return length;
}

inline bool startsWith(
        const std::vector<llama_token> & tokens,
        const std::vector<llama_token> & prefix) {
    return tokens.size() >= prefix.size() &&
           std::equal(prefix.begin(), prefix.end(), tokens.begin());
}

// Record sequence zero's recurrent state. Call when exactly `prefixTokens` have
// been decoded into an otherwise empty sequence zero. On failure the snapshot
// is left empty, which only costs the reuse.
inline bool captureRecurrentPrefix(
        llama_context * ctx,
        const std::vector<llama_token> & prefixTokens,
        RecurrentPrefix & snapshot) {
    snapshot.clear();
    const size_t size = llama_state_seq_get_size_ext(ctx, 0, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
    if (size == 0) return false;
    std::vector<uint8_t> state(size);
    const size_t written = llama_state_seq_get_data_ext(
        ctx, state.data(), state.size(), 0, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
    if (written == 0 || written > state.size()) return false;
    state.resize(written);
    snapshot.state = std::move(state);
    snapshot.tokens = prefixTokens;
    return true;
}

// Rewind sequence zero to the end of the snapshot's prefix.
//
// `resident` is the prompt whose attention entries are in the cache now, and
// `next` the prompt about to be decoded. Both must begin with the snapshot's
// tokens: the snapshot carries only the recurrent half, so the attention half
// of the prefix has to be the one already resident.
//
// Returns the number of leading tokens of `next` that need no decoding, or 0
// when nothing can be reused. A 0 after the state was touched leaves the cache
// in no usable shape, so the caller must clear the memory before decoding.
inline size_t restoreRecurrentPrefix(
        llama_context * ctx,
        const RecurrentPrefix & snapshot,
        const std::vector<llama_token> & resident,
        const std::vector<llama_token> & next) {
    if (snapshot.empty()) return 0;
    const size_t prefix = snapshot.tokens.size();
    // Strictly longer: at least one token must be decoded to produce logits.
    if (next.size() <= prefix) return 0;
    if (!startsWith(resident, snapshot.tokens) || !startsWith(next, snapshot.tokens)) return 0;

    if (llama_state_seq_set_data_ext(
            ctx, snapshot.state.data(), snapshot.state.size(), 0,
            LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY) == 0) {
        return 0;
    }
    llama_memory_t memory = llama_get_memory(ctx);
    const llama_pos boundary = static_cast<llama_pos>(prefix);
    if (!llama_memory_seq_rm(memory, 0, boundary, -1)) return 0;
    if (llama_memory_seq_pos_max(memory, 0) != boundary - 1) return 0;
    return prefix;
}

} // namespace fumeto
