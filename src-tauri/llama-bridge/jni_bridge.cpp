/**
 * JNI bridge for llama.cpp — exposes model loading, inference, and lifecycle
 * management to the Kotlin LlamaBridge via JNI.
 *
 * Hy-MT2 mobile configuration:
 * - llama_backend_init() is called in JNI_OnLoad before model operations.
 * - The GGUF's embedded Hunyuan-dense chat template is applied for every
 *   request. Exact token-level common prefixes reuse their resident KV state.
 * - STQ1_0 executes on the ARM CPU/NEON path (n_gpu_layers=0) with one
 *   inference thread per fast core, clamped to 4..6 and derived from the core
 *   topology in JNI_OnLoad (cpu_topology.h). OpenCL offload is intentionally
 *   disabled.
 * - Sampling follows the Hy-MT2 recommendation: temperature 0.7, top-k 20,
 *   top-p 0.6 (min_keep=1), repeat penalty 1.05, and seed 42.
 * - n_ctx=512 bounds memory for short comic text, and generation remains
 *   cancellable between tokens through an atomic flag.
 */

#include <jni.h>
#include <android/log.h>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <array>
#include <cstdio>
#include <string>
#include <vector>
#include <atomic>
#include <mutex>
#include <unordered_map>

#include "llama.h"
#include "ggml-cpu.h"
#include "prompt_cache.h"
#include "cpu_topology.h"
#include "manga_guidance.h"

#define LOG_TAG "FumetoLlama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Global state
static llama_model * g_model = nullptr;
static llama_context * g_ctx = nullptr;
static llama_sampler * g_sampler = nullptr;
static std::atomic<bool> g_cancelled{false};
static std::mutex g_mutex;

static constexpr int N_CTX = 512;
static constexpr int N_PREDICT = 128;
// The worker count is one thread per fast core, derived from MIDR_EL1 in
// JNI_OnLoad (cpu_topology.h): 5 on a Snapdragon 8 Gen 2 (3x A510 + 5 fast),
// 6 on a Snapdragon 8 Elite (eight fast cores, capped). Six workers won the
// matched cold-prefill trial on the 8 Elite and stayed stable in the separate
// sustained cached workload; the 2026-08-28 sweep there found generation flat
// from four workers up and eight buying 11% prompt speed (about 5 ms of a
// bubble) for every core the WebView and OCR would otherwise have, which is
// why six stays the cap. On the 8 Gen 2 a sixth worker lands on an in-order
// A510 and costs 10% with unstable throughput. Exact KV-prefix reuse avoids the
// repeated full prefills that caused the un-cached stress sweep to heat and
// slow down. The debug hook can still override the count on other devices.
static constexpr int FALLBACK_N_THREADS = 6;  // when the topology cannot be read
static constexpr int MIN_N_THREADS = 4;
static constexpr int MAX_N_THREADS = 6;
static constexpr uint32_t SAMPLER_SEED = 42;
static constexpr int REPEAT_LAST_N = 64;
// Measured 2026-08-21 over 25,596 generations on 237 held-out ja->en excerpts
// plus 714 blinded judge verdicts: 0.15 beats the previous 0.7 by +0.75 corpus
// chrF++ / +0.0045 COMET / +0.248 judge accuracy on manga-v3a, and the stock
// base model is indifferent. Kept in lockstep with llama.rs and recorded in
// the fine-tune eval changelog (item 5).
static constexpr float DEFAULT_TEMPERATURE = 0.15f;
static constexpr float MIN_TEMPERATURE = 0.0f;   // 0 == greedy/argmax in llama.cpp
static constexpr float MAX_TEMPERATURE = 1.0f;
// The temperature the currently built chain was constructed with, so a request
// only pays for a rebuild when the user actually moved the setting.
static float g_sampler_temperature = DEFAULT_TEMPERATURE;
static int g_thread_count = FALLBACK_N_THREADS;
// What JNI_OnLoad read from sysfs, reported through nativeGetRuntimeInfo so a
// device's derived count can be checked without a debugger.
static fumeto::cpu_topology::CoreCensus g_core_census;
static double g_last_load_ms = 0.0;
static std::string g_last_inference_metrics = "null";
// The previous request's prompt remains in sequence 0 after generation. Comic
// bubbles normally differ only at the final source-text tokens, so retaining
// their exact token-level common prefix avoids recomputing nearly the entire
// Hy-MT2 instruction on every block. This is safe for Hy-MT2's ordinary dense
// attention KV cache; runtime guards fall back to a full prefill if the cache
// ever cannot remove a suffix.
static std::vector<llama_token> g_cached_prompt_tokens;

// ISO 639-1 code to language name mapping for prompt construction
static const std::unordered_map<std::string, std::string> LANG_NAMES = {
    {"af", "Afrikaans"}, {"ar", "Arabic"}, {"be", "Belarusian"}, {"bg", "Bulgarian"},
    {"bn", "Bengali"}, {"ca", "Catalan"}, {"cs", "Czech"}, {"cy", "Welsh"},
    {"da", "Danish"}, {"de", "German"}, {"el", "Greek"}, {"en", "English"},
    {"eo", "Esperanto"}, {"es", "Spanish"}, {"et", "Estonian"}, {"fa", "Persian"},
    {"fi", "Finnish"}, {"fr", "French"}, {"ga", "Irish"}, {"gl", "Galician"},
    {"gu", "Gujarati"}, {"he", "Hebrew"}, {"hi", "Hindi"}, {"hr", "Croatian"},
    {"ht", "Haitian Creole"}, {"hu", "Hungarian"}, {"id", "Indonesian"},
    {"is", "Icelandic"}, {"it", "Italian"}, {"ja", "Japanese"}, {"ka", "Georgian"},
    {"kn", "Kannada"}, {"ko", "Korean"}, {"lt", "Lithuanian"}, {"lv", "Latvian"},
    {"mk", "Macedonian"}, {"mr", "Marathi"}, {"ms", "Malay"}, {"mt", "Maltese"},
    {"nl", "Dutch"}, {"no", "Norwegian"}, {"pl", "Polish"}, {"pt", "Portuguese"},
    {"ro", "Romanian"}, {"ru", "Russian"}, {"sk", "Slovak"}, {"sl", "Slovenian"},
    {"sq", "Albanian"}, {"sr", "Serbian"}, {"sv", "Swedish"}, {"sw", "Swahili"},
    {"ta", "Tamil"}, {"te", "Telugu"}, {"th", "Thai"}, {"tl", "Tagalog"},
    {"tr", "Turkish"}, {"uk", "Ukrainian"}, {"ur", "Urdu"}, {"vi", "Vietnamese"},
    {"zh", "Chinese"},
    // BCP-47 script subtags. Without these, getLangName() falls through to the
    // code itself and the prompt reads "into zh-Hans" — which is what shipped
    // until the v3 fine-tune made Simplified Chinese a target worth having.
    // The names are the canonical ones v3 trained on (the fine-tune's language table).
    {"zh-Hans", "Simplified Chinese"},
    {"zh-Hant", "Traditional Chinese"}
};

static std::string getLangName(const std::string & code) {
    auto it = LANG_NAMES.find(code);
    if (it != LANG_NAMES.end()) return it->second;
    return code; // Fallback to code itself
}

// All callers hold g_mutex. Keeping teardown in one helper makes reload,
// explicit unload, JNI unload, and partial-load failures follow the same
// lifecycle and prevents sampler/context state from crossing models.
// How the loaded model's prompt gets wrapped. Resolved once at load and then
// fixed for the lifetime of that model.
//
//   HunyuanDense  the bundled Hy-MT2 variants. Unchanged from before custom
//                 models existed, and still checked FIRST so nothing about the
//                 shipped models can be perturbed by the new branches.
//   Builtin       a model whose own embedded template llama.cpp recognises
//                 (llama2/3, chatml, gemma, qwen, mistral, phi3, deepseek, ...).
//   Manual        a user-supplied prefix/suffix, for a model llama.cpp does not
//                 recognise.
//
// A model that fits none of these is rejected at load rather than being run
// with the wrong protocol, which produces confident nonsense.
enum class TemplateMode { HunyuanDense, Builtin, Manual };

// All guarded by g_mutex like every other model global; written during load
// and never mutated afterwards.
static TemplateMode g_template_mode = TemplateMode::HunyuanDense;
static std::string g_manual_prefix;
static std::string g_manual_suffix;
static std::vector<std::string> g_manual_stops;

// Which terminology blocks the LOADED checkpoint was trained with.
//
// Only the v3 fine-tune saw a per-target block. Stock and v2 saw the English
// one and nothing else, so handing them a Korean or Farsi glossary preamble
// would be an unmeasured change to models people are already using — and v2 in
// particular is documented as collapsing to English on non-English targets, so
// an unfamiliar preamble is not obviously harmless. Default matches the
// behaviour that shipped before per-target blocks existed.
enum class GuidanceScope { EnglishOnly, AllTargets };
static GuidanceScope g_guidance_scope = GuidanceScope::EnglishOnly;

// Why the last load failed, in a form the UI can act on. Without this every
// failure reaches JS as "Failed to load model from: <path>", so a device that
// simply ran out of memory was told to go and write a prompt format.
static std::string g_last_load_error;

static void freeModelStateLocked() {
    if (g_sampler) { llama_sampler_free(g_sampler); g_sampler = nullptr; }
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_cancelled.store(false);
    g_cached_prompt_tokens.clear();
    g_last_inference_metrics = "null";
    // Reset to the bundled-model default so a failed or unloaded custom model
    // can never leave a stale prompt format applied to the next model loaded.
    g_template_mode = TemplateMode::HunyuanDense;
    g_manual_prefix.clear();
    g_manual_suffix.clear();
    g_manual_stops.clear();
    g_guidance_scope = GuidanceScope::EnglishOnly;
    g_last_load_error.clear();
    g_sampler_temperature = DEFAULT_TEMPERATURE;
}

static float clampTemperature(float requested) {
    if (!std::isfinite(requested)) return DEFAULT_TEMPERATURE;
    if (requested < MIN_TEMPERATURE) return MIN_TEMPERATURE;
    if (requested > MAX_TEMPERATURE) return MAX_TEMPERATURE;
    return requested;
}

/**
 * Build the sampler chain at a given temperature, replacing any existing one.
 *
 * Hy-MT2's chain, with the fixed seed and the per-request reset that together
 * make identical input reproducible. ORDER IS LOAD-BEARING: top_k and top_p run
 * on the UNTEMPERED distribution, so the candidate set is the same at every
 * temperature and temperature only reshapes probabilities inside it. Measured
 * consequence: top_p(0.6) leaves a single candidate on 65% of decoding steps.
 * Reordering this silently changes what the temperature setting does.
 *
 * llama.cpp has no way to replace one link in a live chain, so a temperature
 * change rebuilds the whole chain. That is a handful of small allocations and
 * touches no model weights, which is why the setting can apply without a
 * model reload.
 */
static bool rebuildSamplerLocked(float temperature) {
    const float value = clampTemperature(temperature);
    llama_sampler * built = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (!built) {
        LOGE("Failed to initialize sampler chain");
        return false;
    }
    llama_sampler_chain_add(built, llama_sampler_init_penalties(
        REPEAT_LAST_N, 1.05f, /*frequency=*/0.0f, /*presence=*/0.0f));
    llama_sampler_chain_add(built, llama_sampler_init_top_k(20));
    llama_sampler_chain_add(built, llama_sampler_init_top_p(0.6f, /*min_keep=*/1));
    llama_sampler_chain_add(built, llama_sampler_init_temp(value));
    llama_sampler_chain_add(built, llama_sampler_init_dist(SAMPLER_SEED));

    if (g_sampler) llama_sampler_free(g_sampler);
    g_sampler = built;
    g_sampler_temperature = value;
    return true;
}

static std::string trimWhitespace(const std::string & value) {
    const size_t start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return {};
    const size_t end = value.find_last_not_of(" \t\r\n");
    return value.substr(start, end - start + 1);
}

// JNI's GetStringUTFChars/NewStringUTF APIs use Modified UTF-8, not standard
// UTF-8. llama.cpp and filesystem paths use standard UTF-8, so marshal through
// Java's native UTF-16 representation to preserve supplementary characters
// such as emoji. Embedded NUL is rejected because llama_chat_message and the
// model loader both accept NUL-terminated C strings.
static bool jstringToUtf8(JNIEnv * env, jstring value, std::string & output) {
    if (!value) return false;

    const jsize length = env->GetStringLength(value);
    const jchar * chars = env->GetStringChars(value, nullptr);
    if (!chars) return false;

    output.clear();
    output.reserve(static_cast<size_t>(length) * 3);
    bool valid = true;
    for (jsize i = 0; i < length; ++i) {
        uint32_t codePoint = chars[i];
        if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
            if (i + 1 >= length) {
                valid = false;
                break;
            }
            const uint32_t low = chars[++i];
            if (low < 0xDC00 || low > 0xDFFF) {
                valid = false;
                break;
            }
            codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (low - 0xDC00);
        } else if (codePoint >= 0xDC00 && codePoint <= 0xDFFF) {
            valid = false;
            break;
        }

        if (codePoint == 0) {
            valid = false;
            break;
        } else if (codePoint <= 0x7F) {
            output.push_back(static_cast<char>(codePoint));
        } else if (codePoint <= 0x7FF) {
            output.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
            output.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        } else if (codePoint <= 0xFFFF) {
            output.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
            output.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
            output.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        } else {
            output.push_back(static_cast<char>(0xF0 | (codePoint >> 18)));
            output.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3F)));
            output.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
            output.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        }
    }
    env->ReleaseStringChars(value, chars);
    if (!valid) output.clear();
    return valid;
}

static jstring utf8ToJString(JNIEnv * env, const std::string & value) {
    std::vector<jchar> utf16;
    utf16.reserve(value.size());

    const auto * bytes = reinterpret_cast<const unsigned char *>(value.data());
    size_t offset = 0;
    while (offset < value.size()) {
        const unsigned char lead = bytes[offset];
        uint32_t codePoint = 0;
        size_t width = 0;
        if (lead <= 0x7F) {
            codePoint = lead;
            width = 1;
        } else if (lead >= 0xC2 && lead <= 0xDF) {
            codePoint = lead & 0x1F;
            width = 2;
        } else if (lead >= 0xE0 && lead <= 0xEF) {
            codePoint = lead & 0x0F;
            width = 3;
        } else if (lead >= 0xF0 && lead <= 0xF4) {
            codePoint = lead & 0x07;
            width = 4;
        }

        bool valid = width != 0 && offset + width <= value.size();
        for (size_t i = 1; valid && i < width; ++i) {
            const unsigned char continuation = bytes[offset + i];
            if ((continuation & 0xC0) != 0x80) {
                valid = false;
            } else {
                codePoint = (codePoint << 6) | (continuation & 0x3F);
            }
        }
        if (valid) {
            valid = (width != 2 || codePoint >= 0x80) &&
                    (width != 3 || codePoint >= 0x800) &&
                    (width != 4 || codePoint >= 0x10000) &&
                    !(codePoint >= 0xD800 && codePoint <= 0xDFFF) &&
                    codePoint <= 0x10FFFF;
        }

        if (!valid) {
            utf16.push_back(static_cast<jchar>(0xFFFD));
            ++offset;
            continue;
        }

        if (codePoint <= 0xFFFF) {
            utf16.push_back(static_cast<jchar>(codePoint));
        } else {
            codePoint -= 0x10000;
            utf16.push_back(static_cast<jchar>(0xD800 + (codePoint >> 10)));
            utf16.push_back(static_cast<jchar>(0xDC00 + (codePoint & 0x3FF)));
        }
        offset += width;
    }

    static constexpr jchar EMPTY_STRING_SENTINEL = 0;
    return env->NewString(
        utf16.empty() ? &EMPTY_STRING_SENTINEL : utf16.data(),
        static_cast<jsize>(utf16.size()));
}

static std::string buildMangaTranslationInstruction(
        const std::string & text,
        const std::string & sourceCode,
        const std::string & targetCode,
        const std::string & sourceName,
        const std::string & targetName) {
    // Hy-MT2 1.8B benefits from a compact terminology/idiom reference for
    // isolated bubbles where the missing page context otherwise changes the
    // subject or drops a concrete place noun.
    //
    // Keyed on the language CODES, not the display names. The v3 fine-tune was
    // trained with a per-target block, so "into Simplified Chinese" wants the
    // Chinese terminology, not English's — and matching on names would have
    // made "zh-Hans" vs "Simplified Chinese" a silent behaviour change.
    //
    // Scoped to the loaded checkpoint: only v3 saw the non-English blocks, so
    // every other model keeps exactly the ja->en-only behaviour it shipped
    // with. English's block is byte-identical to the one this replaced, so
    // that path is unchanged for all of them.
    const bool multilingual = g_guidance_scope == GuidanceScope::AllTargets;
    const std::string guidance = (multilingual || targetCode == "en")
        ? fumeto::mangaGuidanceFor(sourceCode, targetCode)
        : std::string();

    return guidance +
        "Translate the following text from " + sourceName + " into " + targetName +
        " as natural, concise manga dialogue. Preserve specific nouns, exact meaning, speaker intent, tone, punctuation, and sound effects. "
        "Output only the translated result without any explanation:\n\n" + text;
}

// ============================================================
// Chat template resolution
// ============================================================
//
// How the loaded model's prompt gets wrapped. Resolved once at load and then
// fixed for the lifetime of that model.
//
//   HunyuanDense  the bundled Hy-MT2 variants. Unchanged from before custom
//                 models existed, and still checked FIRST so nothing about the
//                 shipped models can be perturbed by the new branches.
//   Builtin       a model whose own embedded template llama.cpp recognises
//                 (llama2/3, chatml, gemma, qwen, mistral, phi3, deepseek, ...).
//   Manual        a user-supplied prefix/suffix, for a model llama.cpp does not
//                 recognise.
//
// A model that fits none of these is rejected at load rather than being run
// with the wrong protocol, which produces confident nonsense.
// (State declared with the other model globals above, so teardown can reset it.)

// Hy-MT2's official GGUF embeds the Hunyuan-dense Jinja template. Requiring
// its distinctive markers is what tells us a model speaks the protocol the
// manga prompt and the hy_* stop markers assume.
/** Split a newline-separated list, dropping empties. */
static std::vector<std::string> splitLines(const std::string & text) {
    std::vector<std::string> lines;
    size_t start = 0;
    while (start <= text.size()) {
        const size_t end = text.find('\n', start);
        const std::string line = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (!line.empty()) lines.push_back(line);
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return lines;
}

/**
 * Whether llama.cpp recognises the model's OWN embedded chat template.
 *
 * The template string must be passed explicitly. Passing nullptr does NOT mean
 * "use the model's template" — llama.cpp substitutes the literal "chatml"
 * (llama.cpp:1176), which detects successfully for every model and would wrap
 * a Gemma or Llama-3 prompt in ChatML markers. That is the "wrong protocol,
 * confident nonsense" failure this whole branch exists to avoid, and it also
 * makes the manual-format path unreachable, because nothing ever fails to
 * "load".
 *
 * Probed rather than assumed: llama_chat_apply_template runs no Jinja engine,
 * it matches the template against a fixed list of known families and returns a
 * negative size for anything else.
 */
static bool modelSupportsBuiltinTemplate() {
    if (!g_model) return false;
    const char * tmpl = llama_model_chat_template(g_model, /*name=*/nullptr);
    if (tmpl == nullptr) return false;
    const llama_chat_message probe = {"user", "probe"};
    return llama_chat_apply_template(tmpl, &probe, 1, /*add_ass=*/true, nullptr, 0) > 0;
}

static bool hasHunyuanDenseTemplate() {
    if (!g_model) return false;
    const char * tmpl = llama_model_chat_template(g_model, /*name=*/nullptr);
    return tmpl != nullptr &&
           std::strstr(tmpl, "<｜hy_Assistant｜>") != nullptr &&
           std::strstr(tmpl, "<｜hy_place▁holder▁no▁3｜>") != nullptr;
}

static bool applyHunyuanChatTemplate(const std::string & userContent, std::string & prompt) {
    const char * embeddedTemplate = llama_model_chat_template(g_model, /*name=*/nullptr);
    if (!embeddedTemplate || !hasHunyuanDenseTemplate()) {
        LOGE("Hy-MT2 Hunyuan-dense chat template is missing or unsupported");
        return false;
    }

    // This llama.cpp revision's heuristic detector checks Hunyuan-VL before
    // Hunyuan-dense. Hy-MT2's official dense template contains both the BOS
    // marker used by VL and dense's placeholder-3 marker, so passing the raw
    // embedded Jinja string would be misclassified as VL. After validating
    // the embedded template above, select llama.cpp's equivalent built-in
    // dense formatter explicitly. tokenizeFullPrompt() then prepends the
    // model BOS, yielding the same sequence as the official Jinja:
    // BOS, hy_User, content, hy_Assistant.
    static constexpr const char * DENSE_TEMPLATE_SELECTOR = "hunyuan-dense";

    const llama_chat_message message = {"user", userContent.c_str()};
    int32_t required = llama_chat_apply_template(
        DENSE_TEMPLATE_SELECTOR, &message, 1, /*add_ass=*/true, nullptr, 0);
    if (required <= 0) {
        LOGE("Failed to size Hunyuan chat template output (%d)", required);
        return false;
    }

    std::vector<char> buffer(static_cast<size_t>(required) + 1, '\0');
    int32_t written = llama_chat_apply_template(
        DENSE_TEMPLATE_SELECTOR, &message, 1, /*add_ass=*/true,
        buffer.data(), static_cast<int32_t>(buffer.size()));
    if (written < 0) {
        LOGE("Failed to apply Hunyuan chat template (%d)", written);
        return false;
    }
    if (written >= static_cast<int32_t>(buffer.size())) {
        buffer.assign(static_cast<size_t>(written) + 1, '\0');
        written = llama_chat_apply_template(
            DENSE_TEMPLATE_SELECTOR, &message, 1, /*add_ass=*/true,
            buffer.data(), static_cast<int32_t>(buffer.size()));
        if (written < 0 || written >= static_cast<int32_t>(buffer.size())) {
            LOGE("Hunyuan chat template output changed while resizing (%d)", written);
            return false;
        }
    }

    prompt.assign(buffer.data(), static_cast<size_t>(written));
    return true;
}

/**
 * Wrap a user turn using whichever template the loaded model resolved to.
 *
 * Builtin mode passes nullptr so llama.cpp uses the model's OWN embedded
 * template and its built-in formatter for that family. Hy-MT2 cannot use that
 * path — this revision's heuristic detector misclassifies its template as
 * Hunyuan-VL — which is exactly why HunyuanDense stays a separate branch.
 */
static bool applyChatTemplate(const std::string & userContent, std::string & prompt) {
    switch (g_template_mode) {
        case TemplateMode::HunyuanDense:
            return applyHunyuanChatTemplate(userContent, prompt);

        case TemplateMode::Manual:
            prompt = g_manual_prefix + userContent + g_manual_suffix;
            return true;

        case TemplateMode::Builtin: {
            // The model's own template string, never nullptr — see
            // modelSupportsBuiltinTemplate() for why that distinction matters.
            const char * tmpl = llama_model_chat_template(g_model, /*name=*/nullptr);
            if (tmpl == nullptr) {
                LOGE("Model lost its chat template between load and inference");
                return false;
            }
            const llama_chat_message message = {"user", userContent.c_str()};
            int32_t required = llama_chat_apply_template(
                tmpl, &message, 1, /*add_ass=*/true, nullptr, 0);
            if (required <= 0) {
                LOGE("Model's embedded chat template could not be applied (%d)", required);
                return false;
            }
            std::vector<char> buffer(static_cast<size_t>(required) + 1, '\0');
            int32_t written = llama_chat_apply_template(
                tmpl, &message, 1, /*add_ass=*/true,
                buffer.data(), static_cast<int32_t>(buffer.size()));
            if (written < 0) {
                LOGE("Embedded chat template failed (%d)", written);
                return false;
            }
            if (written >= static_cast<int32_t>(buffer.size())) {
                buffer.assign(static_cast<size_t>(written) + 1, '\0');
                written = llama_chat_apply_template(
                    tmpl, &message, 1, /*add_ass=*/true,
                    buffer.data(), static_cast<int32_t>(buffer.size()));
                if (written < 0 || written >= static_cast<int32_t>(buffer.size())) {
                    LOGE("Embedded chat template output changed while resizing (%d)", written);
                    return false;
                }
            }
            prompt.assign(buffer.data(), static_cast<size_t>(written));
            return true;
        }
    }
    return false;
}

static bool tokenizeFullPrompt(const std::string & prompt, std::vector<llama_token> & tokens) {
    const llama_vocab * vocab = llama_model_get_vocab(g_model);
    const llama_token bos = llama_vocab_bos(vocab);

    // The official Hy-MT2 Jinja emits BOS itself, while llama.cpp's built-in
    // hunyuan-dense formatter intentionally emits only role markers. The
    // official GGUF does not carry tokenizer.ggml.add_bos_token, so relying
    // on add_special=true would silently omit BOS. Prepend its declared BOS
    // token explicitly, then tokenize the formatted body without auto-added
    // specials to reproduce the model-card template exactly.
    //
    // A user-supplied model is a different case: it may legitimately have no
    // BOS, or may declare add_bos_token itself, in which case forcing one on
    // would double it. Honour what its vocabulary actually says.
    const bool prependBos = g_template_mode == TemplateMode::HunyuanDense
        ? true
        : llama_vocab_get_add_bos(vocab);
    if (prependBos && bos == LLAMA_TOKEN_NULL) {
        LOGE("Model vocabulary declares add_bos but has no BOS token");
        return false;
    }

    const int32_t countResult = llama_tokenize(
        vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()),
        nullptr, 0, /*add_special=*/false, /*parse_special=*/true);
    if (countResult >= 0) {
        LOGE("Unable to size prompt tokenization (%d)", countResult);
        return false;
    }

    const int32_t required = -countResult;
    std::vector<llama_token> bodyTokens(static_cast<size_t>(required));
    const int32_t written = llama_tokenize(
        vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()),
        bodyTokens.data(), required, /*add_special=*/false, /*parse_special=*/true);
    if (written < 0) {
        LOGE("Prompt tokenization failed (%d)", written);
        tokens.clear();
        return false;
    }
    bodyTokens.resize(static_cast<size_t>(written));
    tokens.clear();
    tokens.reserve(bodyTokens.size() + 1);
    if (prependBos) tokens.push_back(bos);
    tokens.insert(tokens.end(), bodyTokens.begin(), bodyTokens.end());
    return !tokens.empty() && tokens.size() > (prependBos ? 1u : 0u);
}

static bool tokenToPiece(const llama_vocab * vocab, llama_token token, std::string & piece) {
    char stackBuffer[256];
    int32_t length = llama_token_to_piece(
        vocab, token, stackBuffer, sizeof(stackBuffer), 0, /*special=*/true);
    if (length >= 0) {
        piece.assign(stackBuffer, static_cast<size_t>(length));
        return true;
    }

    std::vector<char> buffer(static_cast<size_t>(-length));
    length = llama_token_to_piece(
        vocab, token, buffer.data(), static_cast<int32_t>(buffer.size()),
        0, /*special=*/true);
    if (length < 0) return false;
    piece.assign(buffer.data(), static_cast<size_t>(length));
    return true;
}

static constexpr std::array<const char *, 8> HY_SPECIAL_MARKERS = {
    "<｜hy_place▁holder▁no▁2｜>", // Hy-MT2 EOS
    "<｜hy_place▁holder▁no▁3｜>",
    "<｜hy_place▁holder▁no▁8｜>",
    "<｜hy_User｜>",
    "<｜hy_Assistant｜>",
    "<｜hy_begin▁of▁sentence｜>",
    "<｜hy_", // catches other Hunyuan special-token text defensively
    "<|hy_"   // ASCII-pipe rendering seen in some detokenizers
};

// Strip both complete Hunyuan control tokens and an incomplete token prefix
// left at the prediction cap. EOG detection remains the primary stop path;
// this protects output if GGUF metadata fails to flag a special token as EOG
// or a backend returns its printable form in fragments.
static bool stripHunyuanStop(std::string & output, bool stripTrailingFragment) {
    size_t first = std::string::npos;
    for (const char * marker : HY_SPECIAL_MARKERS) {
        first = std::min(first, output.find(marker));
    }
    // A user-supplied model has its own terminators. The hy_* list above stays
    // active for it too — those strings cannot occur in a non-Hunyuan model's
    // output, so leaving them costs nothing — but they cannot be the ONLY stop
    // source, or a model whose EOG metadata is wrong runs to the token cap and
    // emits its own chat scaffolding into the bubble.
    for (const std::string & marker : g_manual_stops) {
        first = std::min(first, output.find(marker));
    }
    if (first != std::string::npos) {
        output.erase(first);
        return true;
    }

    if (stripTrailingFragment) {
        for (const char * markerValue : HY_SPECIAL_MARKERS) {
            const std::string marker(markerValue);
            for (size_t length = marker.size(); length >= 4; --length) {
                if (output.size() >= length &&
                    output.compare(output.size() - length, length, marker, 0, length) == 0) {
                    output.erase(output.size() - length);
                    return true;
                }
                if (length == 4) break;
            }
        }
    }
    return false;
}

// ============================================================
// JNI Lifecycle
// ============================================================

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM * /*vm*/, void * /*reserved*/) {
    LOGI("JNI_OnLoad: initializing llama backend");
    llama_backend_init();
    g_core_census = fumeto::cpu_topology::countFastCores("/sys/devices/system/cpu");
    g_thread_count = fumeto::cpu_topology::inferenceThreadCount(
        g_core_census, FALLBACK_N_THREADS, MIN_N_THREADS, MAX_N_THREADS);
    LOGI("JNI_OnLoad: %d cores, %d fast, %d unreadable -> %d inference threads",
         g_core_census.cores, g_core_census.fast, g_core_census.unreadable, g_thread_count);
    return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL JNI_OnUnload(JavaVM * /*vm*/, void * /*reserved*/) {
    LOGI("JNI_OnUnload: freeing llama backend");
    std::lock_guard<std::mutex> lock(g_mutex);
    freeModelStateLocked();
    llama_backend_free();
}

// ============================================================
// Model Loading
// ============================================================

extern "C" JNIEXPORT jboolean JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeLoadModel(
        JNIEnv * env, jobject /*obj*/, jstring jModelPath,
        jstring jManualPrefix, jstring jManualSuffix, jstring jManualStops,
        jstring jGuidanceScope) {
    std::lock_guard<std::mutex> lock(g_mutex);

    freeModelStateLocked();

    std::string modelPath;
    if (!jstringToUtf8(env, jModelPath, modelPath)) {
        LOGE("Failed to read model path");
        return JNI_FALSE;
    }

    // A manual prompt format, supplied only for a user-imported model whose
    // template llama.cpp does not recognise. Passed as three plain strings
    // rather than JSON so the bridge keeps its zero parsing dependencies; all
    // empty means "no manual format available".
    std::string manualPrefix;
    std::string manualSuffix;
    std::string manualStops;
    jstringToUtf8(env, jManualPrefix, manualPrefix);
    jstringToUtf8(env, jManualSuffix, manualSuffix);
    jstringToUtf8(env, jManualStops, manualStops);
    // Stop strings count as a format. A model whose template is unrecognised
    // but whose wrapping is genuinely empty still needs its terminators, and
    // ignoring them here rejected the model after the user had filled the
    // field in — with no indication why.
    const bool hasManualFormat =
        !manualPrefix.empty() || !manualSuffix.empty() || !manualStops.empty();

    std::string guidanceScope;
    jstringToUtf8(env, jGuidanceScope, guidanceScope);
    g_guidance_scope = guidanceScope == "all-targets" ? GuidanceScope::AllTargets
                                                      : GuidanceScope::EnglishOnly;
    LOGI("Loading model from: %s", modelPath.c_str());
    const int64_t loadStartedUs = llama_time_us();

    // STQ1_0 has an ARM NEON CPU kernel. OpenCL does not implement this
    // quantization and must not receive any layers.
    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0;
    g_model = llama_model_load_from_file(modelPath.c_str(), model_params);

    if (!g_model) {
        LOGE("Failed to load model");
        g_last_load_error = "unreadable";
        return JNI_FALSE;
    }

    // Resolve how this model's prompts get wrapped. Hunyuan-dense is checked
    // first so the three bundled variants take exactly the path they always
    // have; only a model that fails that check reaches the new branches.
    if (hasHunyuanDenseTemplate()) {
        g_template_mode = TemplateMode::HunyuanDense;
    } else if (modelSupportsBuiltinTemplate()) {
        g_template_mode = TemplateMode::Builtin;
        LOGI("Model uses its own embedded chat template");
    } else if (hasManualFormat) {
        g_template_mode = TemplateMode::Manual;
        g_manual_prefix = manualPrefix;
        g_manual_suffix = manualSuffix;
        g_manual_stops = splitLines(manualStops);
        LOGI("Model uses a user-supplied prompt format (%zu stop strings)", g_manual_stops.size());
    } else {
        // Distinguish the two reasons: "this GGUF has no chat template at all"
        // needs a prompt format from the user, whereas a template llama.cpp
        // cannot apply is a different conversation.
        const char * tmpl = llama_model_chat_template(g_model, /*name=*/nullptr);
        LOGE("Rejected model: %s and no prompt format was supplied",
             tmpl == nullptr ? "it embeds no chat template"
                             : "llama.cpp does not recognise its chat template");
        freeModelStateLocked();
        // Set AFTER teardown: freeModelStateLocked clears this field, and the
        // caller needs the reason to survive.
        g_last_load_error = "needs-prompt-format";
        return JNI_FALSE;
    }

    // Create context with small n_ctx for comic bubble translation
    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = N_CTX;
    ctx_params.n_batch = N_CTX;
    ctx_params.n_threads = g_thread_count;
    ctx_params.n_threads_batch = g_thread_count;
    // llama.cpp disables its phase timers by default. The debug/runtime JSON
    // reports prompt and generation throughput, so opt in explicitly; the
    // counter overhead is negligible compared with model evaluation.
    ctx_params.no_perf = false;

    g_ctx = llama_init_from_model(g_model, ctx_params);
    if (!g_ctx) {
        LOGE("Failed to create context");
        freeModelStateLocked();
        return JNI_FALSE;
    }

    if (!rebuildSamplerLocked(DEFAULT_TEMPERATURE)) {
        freeModelStateLocked();
        return JNI_FALSE;
    }

    // Exercise the embedded template once during load, before reporting the
    // model ready. Every real request still applies the complete template.
    std::string templateProbe;
    if (!applyChatTemplate(
            buildMangaTranslationInstruction("test", "ja", "en", "Japanese", "English"),
            templateProbe)) {
        freeModelStateLocked();
        return JNI_FALSE;
    }

    char modelDescription[256] = {};
    llama_model_desc(g_model, modelDescription, sizeof(modelDescription));
    g_last_load_ms = static_cast<double>(llama_time_us() - loadStartedUs) / 1000.0;
    // Names the resolved template mode rather than assuming Hy-MT2: this line
    // is the first thing read when diagnosing a user-supplied model, and
    // labelling a Qwen or Gemma build "Hy-MT2" sends that search the wrong way.
    const char * modeName =
        g_template_mode == TemplateMode::HunyuanDense ? "hunyuan-dense"
        : g_template_mode == TemplateMode::Builtin ? "embedded-template"
        : "manual-format";
    LOGI("Model loaded: %s; template=%s, n_ctx=%d, threads=%d, n_gpu_layers=0, seed=%u, temp=%.2f, load_ms=%.2f",
         modelDescription[0] ? modelDescription : "unknown",
         modeName, N_CTX, g_thread_count, SAMPLER_SEED, g_sampler_temperature, g_last_load_ms);
    return JNI_TRUE;
}

// ============================================================
// Inference
// ============================================================

extern "C" JNIEXPORT jstring JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeTranslate(
        JNIEnv * env, jobject /*obj*/,
        jstring jText, jstring jSourceLang, jstring jTargetLang, jfloat jTemperature) {
    std::lock_guard<std::mutex> lock(g_mutex);

    if (!g_model || !g_ctx || !g_sampler) {
        return utf8ToJString(env, "[ERROR] Model not loaded");
    }

    // The setting travels with the request rather than through a separate
    // setter: it is then applied under the same lock that guards the chain, so
    // there is no window where a request can run against a half-applied change.
    const float requestedTemperature = clampTemperature(static_cast<float>(jTemperature));
    if (requestedTemperature != g_sampler_temperature &&
        !rebuildSamplerLocked(requestedTemperature)) {
        return utf8ToJString(env, "[ERROR] Failed to apply sampler temperature");
    }

    std::string text;
    std::string srcLang;
    std::string tgtLang;
    if (!jstringToUtf8(env, jText, text) ||
        !jstringToUtf8(env, jSourceLang, srcLang) ||
        !jstringToUtf8(env, jTargetLang, tgtLang)) {
        return utf8ToJString(env, "[ERROR] Unable to read translation input");
    }

    const std::string textValue = trimWhitespace(text);
    const std::string sourceName = getLangName(srcLang);
    const std::string targetName = getLangName(tgtLang);

    if (textValue.empty()) return utf8ToJString(env, "");
    const int64_t inferenceStartedUs = llama_time_us();

    // Phase-tested Hy-MT2 manga instruction, represented as a single user
    // message with no system prompt. llama_chat_apply_template adds the
    // Hunyuan user/assistant markers; tokenizeFullPrompt prepends GGUF BOS.
    const std::string userInstruction = buildMangaTranslationInstruction(
        textValue, srcLang, tgtLang, sourceName, targetName);

    std::string prompt;
    if (!applyChatTemplate(userInstruction, prompt)) {
        return utf8ToJString(env, "[ERROR] Chat template failed");
    }

    std::vector<llama_token> promptTokens;
    if (!tokenizeFullPrompt(prompt, promptTokens)) {
        return utf8ToJString(env, "[ERROR] Tokenization failed");
    }
    if (promptTokens.size() >= static_cast<size_t>(N_CTX)) {
        LOGE("Prompt exceeds context: %zu/%d tokens", promptTokens.size(), N_CTX);
        return utf8ToJString(env, "[ERROR] Input is too long for the local model");
    }

    const int maxPredict = std::min(
        N_PREDICT, N_CTX - static_cast<int>(promptTokens.size()));
    if (maxPredict <= 0) {
        return utf8ToJString(env, "[ERROR] No context space remains for translation");
    }

    const llama_vocab * vocab = llama_model_get_vocab(g_model);
    llama_memory_t memory = llama_get_memory(g_ctx);

    // Reuse only an exact token prefix that is verifiably present in sequence
    // zero. Re-decode at least the last prompt token even for identical input,
    // because generation leaves the context's active logits at a later token.
    size_t reusedPromptTokens = reusablePromptPrefix(
        g_cached_prompt_tokens, promptTokens);
    if (!g_cached_prompt_tokens.empty()) {
        llama_synchronize(g_ctx);
        const llama_pos minPosition = llama_memory_seq_pos_min(memory, 0);
        const llama_pos maxPosition = llama_memory_seq_pos_max(memory, 0);
        const bool prefixIsResident = reusedPromptTokens > 0 &&
            minPosition == 0 &&
            maxPosition >= static_cast<llama_pos>(reusedPromptTokens - 1);
        if (!prefixIsResident ||
            !llama_memory_seq_rm(
                memory, 0, static_cast<llama_pos>(reusedPromptTokens), -1) ||
            llama_memory_seq_pos_max(memory, 0) !=
                static_cast<llama_pos>(reusedPromptTokens - 1)) {
            reusedPromptTokens = 0;
        }
    }
    if (reusedPromptTokens == 0) {
        llama_memory_clear(memory, /*data=*/true);
    }

    llama_sampler_reset(g_sampler); // resets the dist RNG to seed 42
    llama_perf_context_reset(g_ctx);

    auto decodePromptFrom = [&](size_t firstToken) -> bool {
        llama_batch promptBatch = llama_batch_init(
            static_cast<int32_t>(promptTokens.size() - firstToken), 0, 1);
        for (size_t i = firstToken; i < promptTokens.size(); ++i) {
            promptBatch.token[promptBatch.n_tokens] = promptTokens[i];
            promptBatch.pos[promptBatch.n_tokens] = static_cast<llama_pos>(i);
            promptBatch.n_seq_id[promptBatch.n_tokens] = 1;
            promptBatch.seq_id[promptBatch.n_tokens][0] = 0;
            promptBatch.logits[promptBatch.n_tokens] = (i + 1 == promptTokens.size());
            ++promptBatch.n_tokens;
        }
        const bool succeeded = llama_decode(g_ctx, promptBatch) == 0;
        llama_batch_free(promptBatch);
        return succeeded;
    };

    bool promptDecoded = decodePromptFrom(reusedPromptTokens);
    if (!promptDecoded && reusedPromptTokens > 0) {
        // A backend/cache change must degrade to the old full-prefill behavior,
        // never to a failed translation or a partially resident prompt.
        LOGE("Reused prompt decode failed after %zu cached tokens; retrying full prefill",
             reusedPromptTokens);
        // Fatal/aborted llama_decode calls may leave completed ubatches queued.
        // Flush them before invalidating their memory or resetting perf state.
        llama_synchronize(g_ctx);
        reusedPromptTokens = 0;
        g_cached_prompt_tokens.clear();
        llama_memory_clear(memory, /*data=*/true);
        llama_perf_context_reset(g_ctx);
        promptDecoded = decodePromptFrom(0);
    }

    if (!promptDecoded) {
        LOGE("Initial prompt decode failed (%zu tokens)", promptTokens.size());
        llama_synchronize(g_ctx);
        g_cached_prompt_tokens.clear();
        llama_memory_clear(memory, /*data=*/true);
        llama_perf_context_reset(g_ctx);
        llama_sampler_reset(g_sampler);
        return utf8ToJString(env, "[ERROR] Decode failed");
    }
    g_cached_prompt_tokens = promptTokens;
    const size_t promptDecodedTokens = promptTokens.size() - reusedPromptTokens;

    // llama.cpp records a one-token decode in the eval bucket even when that
    // token is the cache-hit prompt suffix. Snapshot and reset the counters at
    // the phase boundary so prompt work can never be misreported as generated
    // work. Summing both timing buckets covers full, partial, and single-token
    // prompt batches; the explicit decoded-token count avoids clamped counters.
    llama_synchronize(g_ctx);
    const llama_perf_context_data promptPerf = llama_perf_context(g_ctx);
    const double promptMs = promptPerf.t_p_eval_ms + promptPerf.t_eval_ms;
    const double promptTps = promptMs > 0.0
        ? static_cast<double>(promptDecodedTokens) * 1000.0 / promptMs
        : 0.0;
    llama_perf_context_reset(g_ctx);

    llama_batch batch = llama_batch_init(1, 0, 1);

    std::string output;
    int generated = 0;
    int generationDecodedTokens = 0;
    bool decodeFailed = false;
    bool stoppedOnEog = false;
    bool wasCancelled = false;

    while (generated < maxPredict) {
        if (g_cancelled.load()) {
            LOGI("Inference cancelled after %d tokens", generated);
            wasCancelled = true;
            break;
        }

        const llama_token token = llama_sampler_sample(g_sampler, g_ctx, -1);
        ++generated;
        if (llama_vocab_is_eog(vocab, token)) {
            stoppedOnEog = true;
            break;
        }

        std::string piece;
        if (!tokenToPiece(vocab, token, piece)) {
            LOGE("Failed to detokenize token %d", token);
            decodeFailed = true;
            break;
        }
        output += piece;
        if (stripHunyuanStop(output, /*stripTrailingFragment=*/false)) {
            stoppedOnEog = true;
            break;
        }

        // Decoding the final permitted token cannot produce another sample,
        // so avoid one unnecessary model step at the context boundary.
        if (generated >= maxPredict) break;

        batch.n_tokens = 1;
        batch.token[0] = token;
        batch.pos[0] = static_cast<llama_pos>(
            promptTokens.size() + static_cast<size_t>(generated - 1));
        batch.n_seq_id[0] = 1;
        batch.seq_id[0][0] = 0;
        batch.logits[0] = true;

        if (llama_decode(g_ctx, batch) != 0) {
            LOGE("Decode failed after generated token %d", generated);
            decodeFailed = true;
            break;
        }
        ++generationDecodedTokens;
    }

    llama_batch_free(batch);
    llama_sampler_reset(g_sampler);
    stripHunyuanStop(output, /*stripTrailingFragment=*/true);
    output = trimWhitespace(output);

    llama_synchronize(g_ctx);
    const llama_perf_context_data generationPerf = llama_perf_context(g_ctx);
    const double totalMs = static_cast<double>(llama_time_us() - inferenceStartedUs) / 1000.0;
    const double generationMs =
        generationPerf.t_p_eval_ms + generationPerf.t_eval_ms;
    const double generationTps = generationMs > 0.0
        ? static_cast<double>(generationDecodedTokens) * 1000.0 / generationMs
        : 0.0;
    char metrics[768];
    std::snprintf(metrics, sizeof(metrics),
        "{\"threads\":%d,\"cache_hit\":%s,\"prompt_tokens\":%d,"
        "\"prompt_total_tokens\":%zu,"
        "\"prompt_reused_tokens\":%zu,\"prompt_decoded_tokens\":%zu,"
        "\"prompt_ms\":%.3f,"
        "\"prompt_tps\":%.3f,\"generated_tokens\":%d,\"sampled_tokens\":%d,"
        "\"generation_decoded_tokens\":%d,"
        "\"generation_ms\":%.3f,"
        "\"generation_tps\":%.3f,\"total_ms\":%.3f,\"cancelled\":%s,\"eog\":%s}",
        g_thread_count, reusedPromptTokens > 0 ? "true" : "false",
        static_cast<int>(promptDecodedTokens), promptTokens.size(), reusedPromptTokens,
        promptDecodedTokens,
        promptMs, promptTps,
        generated, generated, generationDecodedTokens,
        generationMs, generationTps, totalMs,
        wasCancelled ? "true" : "false", stoppedOnEog ? "true" : "false");
    g_last_inference_metrics.assign(metrics);

    LOGI("Inference complete: %d tokens, eog=%d, cancelled=%d",
         generated, static_cast<int>(stoppedOnEog),
         static_cast<int>(wasCancelled));
    LOGI("Inference metrics: %s", g_last_inference_metrics.c_str());

    if (decodeFailed) {
        // A failed decode can leave a partially processed ubatch in memory.
        // Discard it rather than trusting the next request's prefix rewind.
        llama_memory_clear(memory, /*data=*/true);
        g_cached_prompt_tokens.clear();
        return utf8ToJString(env, "[ERROR] Decode failed");
    }
    if (wasCancelled) return utf8ToJString(env, "[ERROR] Translation cancelled");
    return utf8ToJString(env, output);
}

// ============================================================
// Active Backend
// ============================================================

extern "C" JNIEXPORT jstring JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeGetBackend(
        JNIEnv * env, jobject /*obj*/) {
    // Report the backend actually selected by nativeLoadModel, rather than
    // advertising an installed GPU that receives zero layers.
    return utf8ToJString(env, "cpu");
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeSetThreadCount(
        JNIEnv * /*env*/, jobject /*obj*/, jint threadCount) {
    if (threadCount < 1 || threadCount > 8) return JNI_FALSE;
    std::lock_guard<std::mutex> lock(g_mutex);
    g_thread_count = static_cast<int>(threadCount);
    if (g_ctx) {
        llama_set_n_threads(g_ctx, g_thread_count, g_thread_count);
        // A benchmark thread sweep must begin from a clean prefill generated
        // with the selected worker count; production never changes this value.
        llama_memory_clear(llama_get_memory(g_ctx), /*data=*/true);
        g_cached_prompt_tokens.clear();
    }
    LOGI("Inference thread count set to %d", g_thread_count);
    return JNI_TRUE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeGetRuntimeInfo(
        JNIEnv * env, jobject /*obj*/) {
    std::lock_guard<std::mutex> lock(g_mutex);
    char runtimeInfo[1536];
    std::snprintf(runtimeInfo, sizeof(runtimeInfo),
        "{\"backend\":\"cpu\",\"threads\":%d,"
        "\"cores\":%d,\"fast_cores\":%d,\"unreadable_cores\":%d,"
        "\"model_loaded\":%s,"
        "\"neon\":%s,\"dotprod\":%s,\"i8mm\":%s,\"sve\":%s,\"sme\":%s,"
        "\"last_load_ms\":%.3f,\"temperature\":%.3f,\"last_inference\":%s}",
        g_thread_count, g_core_census.cores, g_core_census.fast, g_core_census.unreadable,
        g_model && g_ctx && g_sampler ? "true" : "false",
        ggml_cpu_has_neon() ? "true" : "false",
        ggml_cpu_has_dotprod() ? "true" : "false",
        ggml_cpu_has_matmul_int8() ? "true" : "false",
        ggml_cpu_has_sve() ? "true" : "false",
        ggml_cpu_has_sme() ? "true" : "false",
        g_last_load_ms, g_sampler_temperature, g_last_inference_metrics.c_str());
    return utf8ToJString(env, runtimeInfo);
}

// ============================================================
// Model Management
// ============================================================

/**
 * Why the last load failed, as a stable machine-readable token.
 *
 * "needs-prompt-format" is the only cause the user can act on; everything else
 * ("unreadable", or an empty string when the failure happened outside the
 * native layer) means the file or the device is the problem, and telling
 * someone to write a chat template for an out-of-memory failure just wastes
 * their time.
 */
extern "C" JNIEXPORT jstring JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeGetLastLoadError(
        JNIEnv * env, jobject /*obj*/) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return utf8ToJString(env, g_last_load_error);
}

extern "C" JNIEXPORT void JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeUnloadModel(
        JNIEnv * /*env*/, jobject /*obj*/) {
    std::lock_guard<std::mutex> lock(g_mutex);
    LOGI("Unloading model");
    freeModelStateLocked();
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeIsLoaded(
        JNIEnv * /*env*/, jobject /*obj*/) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return (g_model != nullptr && g_ctx != nullptr && g_sampler != nullptr)
        ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_fumeto_reader_llama_LlamaBridge_nativeSetCancelled(
        JNIEnv * /*env*/, jobject /*obj*/, jboolean cancelled) {
    g_cancelled.store(cancelled == JNI_TRUE);
}
