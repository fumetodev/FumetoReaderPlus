//! llama.cpp FFI bridge for desktop Hy-MT2 translation.
//!
//! Exposes model loading, inference, and lifecycle management as Tauri
//! commands callable from the frontend. The stock model's 1.25-bit STQ
//! weights run on llama.cpp's CPU backend everywhere; on a Mac, a caller may
//! ask for the GPU (Metal) for the Q4_K_M fine-tunes.
//!
//! Key design decisions:
//! - Validate the GGUF's embedded Hunyuan-dense chat template and apply its
//!   equivalent llama.cpp built-in formatter instead of hard-coding tokens
//! - Use the phase-tested Hy-MT2 manga translation instruction, with the
//!   guidance scope the Android bridge gives the same model
//! - CPU (`n_gpu_layers=0`) unless the caller asks for the GPU and one exists;
//!   a GPU load that fails is retried on the CPU. STQ1_0 has no Metal kernel,
//!   so the caller never asks for the stock model
//! - One worker thread per fast core, clamped to 4..6, as on Android
//! - n_ctx=512 to minimize RAM for short comic bubble text
//! - Per-token decode loop with atomic cancellation flag
//! - Global mutex protects all llama.cpp operations (single-threaded requirement)

#![allow(non_camel_case_types, non_upper_case_globals)]

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};

// ============================================================
// llama.cpp FFI declarations
// ============================================================

// Opaque types
#[repr(C)]
pub struct llama_model {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct llama_context {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct llama_sampler {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct llama_vocab {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct llama_memory {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct ggml_backend_dev {
    _opaque: [u8; 0],
}

/// `enum ggml_backend_dev_type` (ggml-backend.h): CPU = 0, GPU = 1, IGPU = 2,
/// ACCEL = 3, META = 4. A C enum crosses the ABI as an `int`.
const GGML_BACKEND_DEVICE_TYPE_GPU: i32 = 1;
const GGML_BACKEND_DEVICE_TYPE_IGPU: i32 = 2;

pub type llama_token = i32;
pub type llama_pos = i32;
pub type llama_seq_id = i32;

// Opaque forward-decl for the tensor-buffer override type added in newer llama.cpp.
// We never set this field — always pass NULL via llama_model_default_params() —
// so an opaque pointer is sufficient for layout compatibility.
#[repr(C)]
pub struct llama_model_tensor_buft_override {
    _opaque: [u8; 0],
}

// Opaque forward-decl for ggml_tensor. Needed so we can declare the correct
// arity for the `cb_eval` callback in llama_context_params (3 params in C:
// `(struct ggml_tensor * t, bool ask, void * user_data)`). We never set
// cb_eval, but the pointer size on the struct is what matters for layout;
// using the correct signature keeps this defensible if anyone ever does
// want to set it.
#[repr(C)]
pub struct ggml_tensor {
    _opaque: [u8; 0],
}

// Opaque forward-decl for the experimental backend sampler chain config added in
// llama.cpp master around early 2026. We never populate this either.
#[repr(C)]
pub struct llama_sampler_seq_config {
    _opaque: [u8; 0],
}

// Layout verified against the vendored llama.cpp b0be5d2 snapshot with the
// STQ kernel backport from PR #22836.
// 17 fields total; do NOT reorder. `tensor_buft_overrides` sits in position 2
// (right after `devices`), and the three new `no_*`/`use_extra_bufts` booleans
// live at the tail. Always initialize via llama_model_default_params() and
// only mutate the fields we care about (n_gpu_layers etc.).
#[repr(C)]
pub struct llama_model_params {
    pub devices: *const *mut ggml_backend_dev,
    pub tensor_buft_overrides: *const llama_model_tensor_buft_override,
    pub n_gpu_layers: i32,
    pub split_mode: i32,
    pub main_gpu: i32,
    pub tensor_split: *const f32,
    pub progress_callback: Option<extern "C" fn(f32, *mut std::ffi::c_void) -> bool>,
    pub progress_callback_user_data: *mut std::ffi::c_void,
    pub kv_overrides: *const std::ffi::c_void,
    pub vocab_only: bool,
    pub use_mmap: bool,
    pub use_direct_io: bool,
    pub use_mlock: bool,
    pub check_tensors: bool,
    pub use_extra_bufts: bool,
    pub no_host: bool,
    pub no_alloc: bool,
}

// Layout verified against the same llama.h. Keep this definition in exact C
// field order because llama_context_default_params() returns it by value.
#[repr(C)]
pub struct llama_context_params {
    pub n_ctx: u32,
    pub n_batch: u32,
    pub n_ubatch: u32,
    pub n_seq_max: u32,
    pub n_threads: i32,
    pub n_threads_batch: i32,
    pub rope_scaling_type: i32,
    pub pooling_type: i32,
    pub attention_type: i32,
    pub flash_attn_type: i32,
    pub rope_freq_base: f32,
    pub rope_freq_scale: f32,
    pub yarn_ext_factor: f32,
    pub yarn_attn_factor: f32,
    pub yarn_beta_fast: f32,
    pub yarn_beta_slow: f32,
    pub yarn_orig_ctx: u32,
    pub defrag_thold: f32,
    // ggml_backend_sched_eval_callback in C:
    //   typedef bool (*)(struct ggml_tensor * t, bool ask, void * user_data)
    pub cb_eval: Option<extern "C" fn(*mut ggml_tensor, bool, *mut std::ffi::c_void) -> bool>,
    pub cb_eval_user_data: *mut std::ffi::c_void,
    pub type_k: i32,
    pub type_v: i32,
    pub abort_callback: Option<extern "C" fn(*mut std::ffi::c_void) -> bool>,
    pub abort_callback_data: *mut std::ffi::c_void,
    pub embeddings: bool,
    pub offload_kqv: bool,
    pub no_perf: bool,
    pub op_offload: bool,
    pub swa_full: bool,
    pub kv_unified: bool,
    pub samplers: *mut llama_sampler_seq_config,
    pub n_samplers: usize,
}

#[repr(C)]
pub struct llama_sampler_chain_params {
    pub no_perf: bool,
}

#[repr(C)]
pub struct llama_chat_message {
    pub role: *const c_char,
    pub content: *const c_char,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct llama_batch {
    pub n_tokens: i32,
    pub token: *mut llama_token,
    pub embd: *mut f32,
    pub pos: *mut llama_pos,
    pub n_seq_id: *mut i32,
    pub seq_id: *mut *mut llama_seq_id,
    pub logits: *mut i8,
}

extern "C" {
    // Backend lifecycle
    pub fn llama_backend_init();
    /// Static, NUL-terminated summary of the compiled CPU features and
    /// registered backends (e.g. "DOTPROD = 1", Metal). Owned by llama.cpp.
    pub fn llama_print_system_info() -> *const c_char;

    // Model
    pub fn llama_model_default_params() -> llama_model_params;
    // Renamed from `llama_load_model_from_file` in llama.cpp master
    // (the old name is still present but marked DEPRECATED with a compiler hint
    // pointing at this one).
    pub fn llama_model_load_from_file(
        path_model: *const c_char,
        params: llama_model_params,
    ) -> *mut llama_model;
    pub fn llama_model_free(model: *mut llama_model);
    pub fn llama_model_get_vocab(model: *const llama_model) -> *const llama_vocab;
    pub fn llama_model_chat_template(
        model: *const llama_model,
        name: *const c_char,
    ) -> *const c_char;

    // Context
    pub fn llama_context_default_params() -> llama_context_params;
    // Renamed from `llama_new_context_with_model` in llama.cpp master.
    pub fn llama_init_from_model(
        model: *mut llama_model,
        params: llama_context_params,
    ) -> *mut llama_context;
    pub fn llama_free(ctx: *mut llama_context);
    pub fn llama_get_memory(ctx: *const llama_context) -> *mut llama_memory;
    pub fn llama_memory_clear(mem: *mut llama_memory, full: bool);
    pub fn llama_memory_seq_rm(
        mem: *mut llama_memory,
        seq_id: llama_seq_id,
        p0: llama_pos,
        p1: llama_pos,
    ) -> bool;
    pub fn llama_memory_seq_pos_min(mem: *mut llama_memory, seq_id: llama_seq_id) -> llama_pos;
    pub fn llama_memory_seq_pos_max(mem: *mut llama_memory, seq_id: llama_seq_id) -> llama_pos;
    // Sampling
    pub fn llama_sampler_chain_default_params() -> llama_sampler_chain_params;
    pub fn llama_sampler_chain_init(params: llama_sampler_chain_params) -> *mut llama_sampler;
    pub fn llama_sampler_chain_add(chain: *mut llama_sampler, smpl: *mut llama_sampler);
    pub fn llama_sampler_init_penalties(
        penalty_last_n: i32,
        penalty_repeat: f32,
        penalty_freq: f32,
        penalty_present: f32,
    ) -> *mut llama_sampler;
    pub fn llama_sampler_init_top_k(k: i32) -> *mut llama_sampler;
    pub fn llama_sampler_init_top_p(p: f32, min_keep: usize) -> *mut llama_sampler;
    pub fn llama_sampler_init_temp(temp: f32) -> *mut llama_sampler;
    pub fn llama_sampler_init_dist(seed: u32) -> *mut llama_sampler;
    pub fn llama_sampler_sample(
        smpl: *mut llama_sampler,
        ctx: *mut llama_context,
        idx: i32,
    ) -> llama_token;
    pub fn llama_sampler_reset(smpl: *mut llama_sampler);
    pub fn llama_sampler_free(smpl: *mut llama_sampler);

    // Tokenization
    pub fn llama_tokenize(
        vocab: *const llama_vocab,
        text: *const c_char,
        text_len: i32,
        tokens: *mut llama_token,
        n_tokens_max: i32,
        add_special: bool,
        parse_special: bool,
    ) -> i32;
    pub fn llama_token_to_piece(
        vocab: *const llama_vocab,
        token: llama_token,
        buf: *mut c_char,
        length: i32,
        lstrip: i32,
        special: bool,
    ) -> i32;
    pub fn llama_vocab_bos(vocab: *const llama_vocab) -> llama_token;
    pub fn llama_vocab_is_eog(vocab: *const llama_vocab, token: llama_token) -> bool;

    // Chat template
    pub fn llama_chat_apply_template(
        tmpl: *const c_char,
        chat: *const llama_chat_message,
        n_msg: usize,
        add_ass: bool,
        buf: *mut c_char,
        length: i32,
    ) -> i32;

    // Decode
    pub fn llama_batch_init(n_tokens: i32, embd: i32, n_seq_max: i32) -> llama_batch;
    pub fn llama_batch_free(batch: llama_batch);
    pub fn llama_decode(ctx: *mut llama_context, batch: llama_batch) -> i32;

    // Backend devices (ggml-backend.h), to find a GPU llama.cpp can offload to.
    // The registry is static and immutable once built, so these are safe to
    // call while another thread decodes.
    pub fn ggml_backend_dev_count() -> usize;
    pub fn ggml_backend_dev_get(index: usize) -> *mut ggml_backend_dev;
    pub fn ggml_backend_dev_type(device: *mut ggml_backend_dev) -> i32;
    pub fn ggml_backend_dev_description(device: *mut ggml_backend_dev) -> *const c_char;
}

// ============================================================
// Global state (mirrors jni_bridge.cpp)
// ============================================================

struct LlamaState {
    model: *mut llama_model,
    ctx: *mut llama_context,
    sampler: *mut llama_sampler,
    // Tokens for the last successfully decoded prompt. The associated KV
    // entries remain in sequence zero until the next request rewinds the
    // generated suffix or an error invalidates the cache.
    cached_prompt_tokens: Vec<llama_token>,
    /// Temperature the current chain was built with, so a request only pays for
    /// a rebuild when the setting actually moved.
    sampler_temperature: f32,
    /// Which guidance blocks this model's prompts carry; fixed at load.
    guidance: GuidanceScope,
}

/// Where the loaded model's layers run.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ComputeBackend {
    Cpu,
    /// Offloaded to the GPU llama.cpp describes this way (Metal: "Apple M1").
    Gpu(String),
}

impl ComputeBackend {
    /// The identifier the frontend reads (`getBackend()`/`hasGPU()` in
    /// llamacpp-bridge.ts): "cpu", or "metal:<GPU>" — Metal is the only GPU
    /// backend build.rs compiles.
    fn id(&self) -> String {
        match self {
            Self::Cpu => "cpu".into(),
            Self::Gpu(device) => format!("metal:{device}"),
        }
    }
}

/// Which manga guidance blocks a model's prompts carry. Mirrors
/// `jni_bridge.cpp`: only the v3 fine-tune was trained with a block for every
/// target, so every other model keeps the English-only guidance it shipped
/// with — handing v2 a Korean glossary preamble it never saw would be an
/// unmeasured change to a model people already use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GuidanceScope {
    EnglishOnly,
    AllTargets,
}

impl GuidanceScope {
    /// Anything but "all-targets" is English-only, exactly as the Android
    /// bridge parses the same value.
    fn parse(value: Option<&str>) -> Self {
        if value == Some("all-targets") {
            Self::AllTargets
        } else {
            Self::EnglishOnly
        }
    }
}

/// `llama_load`'s optional second argument (`DesktopLoadOptions` in
/// llamacpp-bridge.ts). Every field defaults, so a caller that sends none gets
/// what the bundled models other than v3 get.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoadOptions {
    /// "all-targets" for the v3 fine-tune, "english-only" for every other model.
    guidance_scope: Option<String>,
    /// Offload every layer to the GPU when there is one. Never sent for the
    /// stock model: Metal has no kernel for its STQ1_0 weights.
    gpu: bool,
}

fn clamp_temperature(requested: f32) -> f32 {
    if !requested.is_finite() {
        DEFAULT_TEMPERATURE
    } else {
        requested.clamp(MIN_TEMPERATURE, MAX_TEMPERATURE)
    }
}

/// Hy-MT2's chain. ORDER IS LOAD-BEARING: top_k and top_p run on the UNTEMPERED
/// distribution, so the candidate set is identical at every temperature and
/// temperature only reshapes probabilities inside it. min-p is intentionally
/// omitted (equivalent to disabled/0.0).
///
/// # Safety
/// `sampler` must be a live chain created by `llama_sampler_chain_init`.
unsafe fn add_sampler_links(sampler: *mut llama_sampler, temperature: f32) {
    llama_sampler_chain_add(
        sampler,
        llama_sampler_init_penalties(REPEAT_LAST_N, 1.05, 0.0, 0.0),
    );
    llama_sampler_chain_add(sampler, llama_sampler_init_top_k(20));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.6, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(42));
}

// Safety: llama.cpp state is protected by the LLAMA_MUTEX
unsafe impl Send for LlamaState {}
unsafe impl Sync for LlamaState {}

static LLAMA_STATE: Mutex<Option<LlamaState>> = Mutex::new(None);
/// The loaded model's backend, kept apart from LLAMA_STATE so that
/// `llama_get_backend` — a synchronous command, so it runs on the main thread —
/// never waits behind a translation holding the state lock for seconds.
static LOADED_BACKEND: Mutex<Option<ComputeBackend>> = Mutex::new(None);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static BACKEND_INITIALIZED: AtomicBool = AtomicBool::new(false);

const N_CTX: u32 = 512;
const N_PREDICT: i32 = 128;
/// Worker threads when the fast-core count is unknown: the fixed count every
/// desktop used before it was read, and `cpu_topology.h`'s fallback.
const FALLBACK_THREADS: i32 = 6;
const MIN_THREADS: i32 = 4;
const MAX_THREADS: i32 = 6;
const REPEAT_LAST_N: i32 = 64;
/// Kept byte-for-byte in step with `jni_bridge.cpp`'s DEFAULT_TEMPERATURE.
/// Measured 2026-08-21; see the fine-tune eval changelog (item 5).
const DEFAULT_TEMPERATURE: f32 = 0.15;
const MIN_TEMPERATURE: f32 = 0.0;
const MAX_TEMPERATURE: f32 = 1.0;

/// One worker per fast core, clamped to 4..6 — the rule `cpu_topology.h`
/// applies on Android (`inferenceThreadCount(census, 6, 4, 6)`). ggml's per-op
/// barrier runs at the slowest worker's pace, so a worker on an efficiency
/// core slows every op; an unknown count keeps the old fixed 6.
fn inference_thread_count(fast_cores: Option<i32>) -> i32 {
    match fast_cores {
        Some(cores) if cores > 0 => cores.clamp(MIN_THREADS, MAX_THREADS),
        _ => FALLBACK_THREADS,
    }
}

/// Apple Silicon's performance cores: `hw.perflevel0` is the fastest cluster.
/// `hw.physicalcpu` where the system reports no performance levels.
#[cfg(target_os = "macos")]
fn fast_core_count() -> Option<i32> {
    fn sysctl_i32(name: &CStr) -> Option<i32> {
        let mut value: i32 = 0;
        let mut size = std::mem::size_of::<i32>();
        // SAFETY: `name` is NUL-terminated and `value`/`size` describe a
        // writable buffer of exactly `size` bytes.
        let status = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut i32).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0 && size == std::mem::size_of::<i32>()).then_some(value)
    }
    sysctl_i32(c"hw.perflevel0.physicalcpu").or_else(|| sysctl_i32(c"hw.physicalcpu"))
}

/// Not read on Windows and Linux, which keep the fixed fallback.
#[cfg(not(target_os = "macos"))]
fn fast_core_count() -> Option<i32> {
    None
}

/// The worker count for every context, read once.
fn inference_threads() -> i32 {
    static THREADS: OnceLock<i32> = OnceLock::new();
    *THREADS.get_or_init(|| inference_thread_count(fast_core_count()))
}

/// The GPU llama.cpp can offload to, by its description (Metal reports the
/// GPU's name, e.g. "Apple M1"), or None where the build has no GPU backend.
/// Read once: the device list is fixed for the life of the process.
fn gpu_device() -> Option<String> {
    static DEVICE: OnceLock<Option<String>> = OnceLock::new();
    DEVICE
        .get_or_init(|| unsafe {
            (0..ggml_backend_dev_count()).find_map(|index| {
                let device = ggml_backend_dev_get(index);
                if device.is_null() {
                    return None;
                }
                let kind = ggml_backend_dev_type(device);
                if kind != GGML_BACKEND_DEVICE_TYPE_GPU && kind != GGML_BACKEND_DEVICE_TYPE_IGPU {
                    return None;
                }
                let description = ggml_backend_dev_description(device);
                Some(if description.is_null() {
                    "GPU".to_string()
                } else {
                    CStr::from_ptr(description).to_string_lossy().into_owned()
                })
            })
        })
        .clone()
}

/// Load the weights, every layer on the GPU or none of them.
///
/// Safety: `path` must stay valid for the duration of the call.
unsafe fn load_model_weights(path: &CStr, on_gpu: bool) -> *mut llama_model {
    let mut model_params = llama_model_default_params();
    // -1 is llama.cpp's "every layer, plus the output layer"; 0 keeps them all
    // on the CPU, which is what every model got before the GPU was offered.
    model_params.n_gpu_layers = if on_gpu { -1 } else { 0 };
    llama_model_load_from_file(path.as_ptr(), model_params)
}

/// Small n_ctx for comic bubble translation.
fn translation_context_params(threads: i32) -> llama_context_params {
    let mut ctx_params = unsafe { llama_context_default_params() };
    ctx_params.n_ctx = N_CTX;
    ctx_params.n_batch = N_CTX;
    ctx_params.n_threads = threads;
    ctx_params.n_threads_batch = threads;
    ctx_params
}

/// Return the exact token prefix which can stay resident for the next prompt.
///
/// Even when the prompts are identical, the final prompt token is decoded
/// again so the context exposes its logits rather than the logits left by the
/// previous generated continuation.
fn reusable_prompt_prefix(cached: &[llama_token], next: &[llama_token]) -> usize {
    let comparable = cached.len().min(next.len());
    let mut reusable = 0;
    while reusable < comparable && cached[reusable] == next[reusable] {
        reusable += 1;
    }
    if reusable == next.len() && reusable > 0 {
        reusable -= 1;
    }
    reusable
}

/// Invalidate both the Rust cache metadata and its backing llama.cpp memory.
/// All callers hold `LLAMA_MUTEX` and own a live context.
unsafe fn invalidate_prompt_cache(state: &mut LlamaState) {
    llama_memory_clear(llama_get_memory(state.ctx), true);
    state.cached_prompt_tokens.clear();
}

fn lang_names() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("af", "Afrikaans");
    m.insert("ar", "Arabic");
    m.insert("be", "Belarusian");
    m.insert("bg", "Bulgarian");
    m.insert("bn", "Bengali");
    m.insert("ca", "Catalan");
    m.insert("cs", "Czech");
    m.insert("cy", "Welsh");
    m.insert("da", "Danish");
    m.insert("de", "German");
    m.insert("el", "Greek");
    m.insert("en", "English");
    m.insert("eo", "Esperanto");
    m.insert("es", "Spanish");
    m.insert("et", "Estonian");
    m.insert("fa", "Persian");
    m.insert("fi", "Finnish");
    m.insert("fr", "French");
    m.insert("ga", "Irish");
    m.insert("gl", "Galician");
    m.insert("gu", "Gujarati");
    m.insert("he", "Hebrew");
    m.insert("hi", "Hindi");
    m.insert("hr", "Croatian");
    m.insert("ht", "Haitian Creole");
    m.insert("hu", "Hungarian");
    m.insert("id", "Indonesian");
    m.insert("is", "Icelandic");
    m.insert("it", "Italian");
    m.insert("ja", "Japanese");
    m.insert("ka", "Georgian");
    m.insert("kn", "Kannada");
    m.insert("ko", "Korean");
    m.insert("lt", "Lithuanian");
    m.insert("lv", "Latvian");
    m.insert("mk", "Macedonian");
    m.insert("mr", "Marathi");
    m.insert("ms", "Malay");
    m.insert("mt", "Maltese");
    m.insert("nl", "Dutch");
    m.insert("no", "Norwegian");
    m.insert("pl", "Polish");
    m.insert("pt", "Portuguese");
    m.insert("ro", "Romanian");
    m.insert("ru", "Russian");
    m.insert("sk", "Slovak");
    m.insert("sl", "Slovenian");
    m.insert("sq", "Albanian");
    m.insert("sr", "Serbian");
    m.insert("sv", "Swedish");
    m.insert("sw", "Swahili");
    m.insert("ta", "Tamil");
    m.insert("te", "Telugu");
    m.insert("th", "Thai");
    m.insert("tl", "Tagalog");
    m.insert("tr", "Turkish");
    m.insert("uk", "Ukrainian");
    m.insert("ur", "Urdu");
    m.insert("vi", "Vietnamese");
    m.insert("zh", "Chinese");
    // BCP-47 script subtags. Without these, get_lang_name() falls through to
    // the code itself and the prompt reads "into zh-Hans". The names are the
    // canonical ones the v3 fine-tune trained on (the fine-tune's language table).
    m.insert("zh-Hans", "Simplified Chinese");
    m.insert("zh-Hant", "Traditional Chinese");
    m
}

fn get_lang_name(code: &str) -> String {
    lang_names()
        .get(code)
        .map(|s| s.to_string())
        .unwrap_or_else(|| code.to_string())
}

fn build_manga_translation_instruction(
    text: &str,
    source_code: &str,
    target_code: &str,
    source_name: &str,
    target_name: &str,
    scope: GuidanceScope,
) -> String {
    // The compact reference keeps common isolated manga bubbles from losing a
    // concrete place noun or inventing the wrong implied subject.
    //
    // Keyed on language CODES: the v3 fine-tune was trained with a per-target
    // block, so a Simplified Chinese target wants the Chinese terminology
    // rather than English's. English's block is byte-identical to the literal
    // this replaced.
    //
    // Scoped to the loaded checkpoint, as in jni_bridge.cpp: only v3 saw the
    // non-English blocks, so every other model keeps exactly the ja->en-only
    // behaviour it shipped with.
    let guidance = if scope == GuidanceScope::AllTargets || target_code == "en" {
        crate::manga_guidance::manga_guidance_for(source_code, target_code)
    } else {
        ""
    };

    format!(
        "{guidance}Translate the following text from {source_name} into {target_name} as natural, concise manga dialogue. Preserve specific nouns, exact meaning, speaker intent, tone, punctuation, and sound effects. Output only the translated result without any explanation:\n\n{text}"
    )
}

fn ensure_backend_init() {
    if !BACKEND_INITIALIZED.swap(true, Ordering::SeqCst) {
        unsafe {
            llama_backend_init();
        }
        log::info!("llama backend initialized");
        // What this binary was actually compiled for — the way to confirm a
        // bundle carries the fixed CPU baseline from build.rs (GGML_NATIVE off,
        // dotprod on Apple Silicon) and that Metal is registered.
        let system_info = unsafe { llama_print_system_info() };
        if !system_info.is_null() {
            log::info!(
                "llama system info: {}",
                unsafe { CStr::from_ptr(system_info) }.to_string_lossy()
            );
        }
        // FFI layout sanity check: log the sizes of the two structs we hand
        // across the C boundary by value. Any future llama.cpp bump that
        // silently adds/removes/reorders a field will change these numbers,
        // and the crash on first llama_model_load_from_file will be
        // accompanied by a logged size mismatch relative to the last known
        // good values. A parallel `sizeof` printout from a small C program
        // built against the same llama.h is the canonical cross-check.
        // Last verified against the vendored b0be5d2 + STQ backport on
        // x86_64-linux-gnu: model_params=72 bytes, context_params=136 bytes.
        // These values are platform- and compiler-dependent (padding/alignment),
        // so they serve as diagnostics, not exact equality checks.
        log::info!(
            "llama FFI layout: llama_model_params={} bytes, llama_context_params={} bytes",
            std::mem::size_of::<llama_model_params>(),
            std::mem::size_of::<llama_context_params>(),
        );
        log::info!(
            "llama inference threads: {} (fast cores: {:?}); GPU: {:?}",
            inference_threads(),
            fast_core_count(),
            gpu_device(),
        );
    }
}

// ============================================================
// Tauri commands
// ============================================================

#[tauri::command(async)]
pub fn llama_load(model_path: String, options: Option<LoadOptions>) -> Result<bool, String> {
    ensure_backend_init();
    let options = options.unwrap_or_default();
    let guidance = GuidanceScope::parse(options.guidance_scope.as_deref());
    let threads = inference_threads();
    let gpu = if options.gpu { gpu_device() } else { None };

    if !Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {}", model_path));
    }

    let mut state = LLAMA_STATE.lock().map_err(|e| e.to_string())?;

    // Unload existing model if any
    if let Some(s) = state.take() {
        unsafe {
            llama_sampler_free(s.sampler);
            llama_free(s.ctx);
            llama_model_free(s.model);
        }
    }
    set_loaded_backend(None);
    CANCELLED.store(false, Ordering::SeqCst);

    let c_path = CString::new(model_path.clone()).map_err(|e| e.to_string())?;

    unsafe {
        // The GPU only when asked for and present. Anything that fails there
        // is retried with exactly the CPU parameters every model loaded with
        // before the GPU was offered.
        let mut on_gpu = gpu.is_some();
        let mut model = load_model_weights(&c_path, on_gpu);
        if model.is_null() && on_gpu {
            log::warn!("Model failed to load on the GPU; retrying on the CPU");
            on_gpu = false;
            model = load_model_weights(&c_path, false);
        }
        if model.is_null() {
            return Err("Failed to load model".into());
        }

        // Reject unrelated/legacy GGUFs during load rather than leaving the
        // model apparently ready until the first translation request.
        if let Err(error) = render_hymt_chat_prompt(model, "test") {
            llama_model_free(model);
            return Err(error);
        }

        let mut ctx = llama_init_from_model(model, translation_context_params(threads));
        if ctx.is_null() && on_gpu {
            log::warn!("Context failed on the GPU; reloading the model on the CPU");
            llama_model_free(model);
            on_gpu = false;
            model = load_model_weights(&c_path, false);
            if model.is_null() {
                return Err("Failed to load model".into());
            }
            ctx = llama_init_from_model(model, translation_context_params(threads));
        }
        if ctx.is_null() {
            llama_model_free(model);
            return Err("Failed to create context".into());
        }
        let backend = match (&gpu, on_gpu) {
            (Some(device), true) => ComputeBackend::Gpu(device.clone()),
            _ => ComputeBackend::Cpu,
        };

        // Hy-MT2's mobile-oriented sampling profile. min-p is intentionally
        // omitted (equivalent to disabled/0.0).
        let chain_params = llama_sampler_chain_default_params();
        let sampler = llama_sampler_chain_init(chain_params);
        if sampler.is_null() {
            llama_free(ctx);
            llama_model_free(model);
            return Err("Failed to create sampler chain".into());
        }
        add_sampler_links(sampler, DEFAULT_TEMPERATURE);

        *state = Some(LlamaState {
            model,
            ctx,
            sampler,
            cached_prompt_tokens: Vec::new(),
            sampler_temperature: DEFAULT_TEMPERATURE,
            guidance,
        });

        log::info!(
            "Hy-MT2 model loaded: {}, n_ctx={}, n_threads={}, backend={}, guidance={:?}",
            model_path,
            N_CTX,
            threads,
            backend.id(),
            guidance,
        );
        set_loaded_backend(Some(backend));
    }

    Ok(true)
}

/// Render one user message with the Hunyuan-dense protocol validated from the
/// Hy-MT2 GGUF's embedded template. The returned bytes are not NUL-terminated
/// because llama_tokenize() accepts an explicit byte length.
///
/// Safety: `model` must remain valid for the duration of the call.
unsafe fn render_hymt_chat_prompt(
    model: *const llama_model,
    user_content: &str,
) -> Result<Vec<u8>, String> {
    let embedded_template = llama_model_chat_template(model, std::ptr::null());
    if embedded_template.is_null() {
        return Err("Hy-MT2 GGUF does not contain a chat template".into());
    }

    // This vendored llama.cpp checks its Hunyuan-OCR heuristic before the
    // dense heuristic. Hy-MT2's official Jinja contains both OCR's BOS marker
    // and dense's placeholder-3 marker, so passing the raw template pointer
    // renders the roles backwards. Validate the model-provided template is
    // truly Hunyuan-dense, then select llama.cpp's equivalent built-in
    // formatter explicitly. tokenize_hymt_prompt() adds the BOS declared by
    // the vocabulary, reproducing the official Jinja token sequence exactly.
    let embedded_bytes = CStr::from_ptr(embedded_template).to_bytes();
    if find_subslice(embedded_bytes, "<｜hy_Assistant｜>".as_bytes()).is_none()
        || find_subslice(embedded_bytes, "<｜hy_place▁holder▁no▁3｜>".as_bytes()).is_none()
    {
        return Err("GGUF chat template is not Hy-MT2 Hunyuan-dense".into());
    }
    const DENSE_TEMPLATE_SELECTOR: &[u8] = b"hunyuan-dense\0";
    let template = DENSE_TEMPLATE_SELECTOR.as_ptr() as *const c_char;

    let role = CString::new("user").expect("static role cannot contain NUL");
    let content = CString::new(user_content)
        .map_err(|_| "Translation text contains an unsupported NUL byte".to_string())?;
    let message = llama_chat_message {
        role: role.as_ptr(),
        content: content.as_ptr(),
    };

    let required = llama_chat_apply_template(template, &message, 1, true, std::ptr::null_mut(), 0);
    if required <= 0 {
        return Err(format!(
            "Failed to apply the Hy-MT2 chat template (size={required})"
        ));
    }

    // Leave one spare byte for implementations which opportunistically append
    // NUL, even though the API's returned length excludes it.
    let mut rendered = vec![0u8; required as usize + 1];
    let mut written = llama_chat_apply_template(
        template,
        &message,
        1,
        true,
        rendered.as_mut_ptr() as *mut c_char,
        rendered.len() as i32,
    );
    if written > rendered.len() as i32 {
        rendered.resize(written as usize + 1, 0);
        written = llama_chat_apply_template(
            template,
            &message,
            1,
            true,
            rendered.as_mut_ptr() as *mut c_char,
            rendered.len() as i32,
        );
    }
    if written <= 0 || written > rendered.len() as i32 {
        return Err(format!(
            "Failed to render the Hy-MT2 chat template (written={written})"
        ));
    }

    rendered.truncate(written as usize);
    Ok(rendered)
}

/// Tokenize a rendered Hy-MT2 user turn without relying on GGUF
/// `tokenizer.ggml.add_bos_token` metadata. The embedded template normally
/// renders BOS itself; this explicit check prepends llama.cpp's authoritative
/// vocabulary BOS only when that rendered marker was not recognized, avoiding
/// both a missing BOS and a duplicate one.
unsafe fn tokenize_hymt_prompt(
    vocab: *const llama_vocab,
    prompt: &[u8],
) -> Result<Vec<llama_token>, String> {
    let mut tokens = vec![0i32; N_CTX as usize];
    let n_tokens = llama_tokenize(
        vocab,
        prompt.as_ptr() as *const c_char,
        prompt.len() as i32,
        tokens.as_mut_ptr(),
        tokens.len() as i32,
        false, // add_special: BOS is enforced explicitly below
        true,  // parse_special
    );
    if n_tokens <= 0 {
        return Err(format!("Tokenization failed (n_tokens={n_tokens})"));
    }
    tokens.truncate(n_tokens as usize);

    let bos = llama_vocab_bos(vocab);
    ensure_hymt_bos(&mut tokens, bos, N_CTX as usize)?;
    Ok(tokens)
}

fn ensure_hymt_bos(
    tokens: &mut Vec<llama_token>,
    bos: llama_token,
    capacity: usize,
) -> Result<(), String> {
    if bos < 0 {
        return Err("Hy-MT2 vocabulary does not define a BOS token".into());
    }
    if tokens.first().copied() != Some(bos) {
        if tokens.len() >= capacity {
            return Err(format!(
                "Translation prompt has no room for the required BOS token ({}/{capacity})",
                tokens.len()
            ));
        }
        tokens.insert(0, bos);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn llama_translate(
    text: String,
    source_lang: String,
    target_lang: String,
    temperature: Option<f32>,
) -> Result<String, String> {
    let mut state = LLAMA_STATE.lock().map_err(|e| e.to_string())?;
    let s = state.as_mut().ok_or("Model not loaded")?;

    // Applied under the same lock that guards the chain, so a request can never
    // run against a half-applied change. llama.cpp cannot replace one link in a
    // live chain, so a change rebuilds the whole chain -- a few small
    // allocations, touching no model weights, hence no model reload.
    let requested = clamp_temperature(temperature.unwrap_or(DEFAULT_TEMPERATURE));
    if requested != s.sampler_temperature {
        unsafe {
            let rebuilt = llama_sampler_chain_init(llama_sampler_chain_default_params());
            if rebuilt.is_null() {
                return Err("Failed to apply sampler temperature".into());
            }
            add_sampler_links(rebuilt, requested);
            llama_sampler_free(s.sampler);
            s.sampler = rebuilt;
        }
        s.sampler_temperature = requested;
    }

    let tgt_name = get_lang_name(&target_lang);
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }

    // Reset before template rendering and prompt prefill so a cancellation
    // received during either phase is not accidentally erased afterward.
    CANCELLED.store(false, Ordering::SeqCst);

    // Phase-tested Hy-MT2 manga prompt. Full language names disambiguate short
    // OCR samples while the explicit constraints keep speech and SFX concise.
    let src_name = get_lang_name(&source_lang);
    let instruction = build_manga_translation_instruction(
        text,
        &source_lang,
        &target_lang,
        &src_name,
        &tgt_name,
        s.guidance,
    );
    log::debug!(
        "Hy-MT2 translation request: {} -> {}",
        source_lang,
        target_lang
    );

    unsafe {
        let inference_started = Instant::now();
        let result = (|| -> Result<String, String> {
            let vocab = llama_model_get_vocab(s.model);
            if vocab.is_null() {
                return Err("Failed to access model vocabulary".into());
            }

            let prompt = render_hymt_chat_prompt(s.model, &instruction)?;

            // Tokenize the template body with automatic special insertion off,
            // then enforce the vocabulary's BOS explicitly. This is necessary for
            // the official GGUF, which omits tokenizer.ggml.add_bos_token.
            let tokens = tokenize_hymt_prompt(vocab, &prompt)?;
            let n_tokens = tokens.len() as i32;
            if n_tokens >= N_CTX as i32 {
                return Err(format!(
                    "Translation prompt is too long ({n_tokens} prompt tokens exceeds n_ctx={N_CTX})"
                ));
            }
            let max_predict = N_PREDICT.min(N_CTX as i32 - n_tokens);
            let mem = llama_get_memory(s.ctx);

            // The previous request leaves its prompt and generated continuation
            // in sequence zero. Keep only an exact, resident token prefix and
            // remove everything from the first changed token onward. Re-decode
            // at least the final prompt token to restore prompt-final logits.
            let had_cached_prompt = !s.cached_prompt_tokens.is_empty();
            let mut reused_prompt_tokens = reusable_prompt_prefix(&s.cached_prompt_tokens, &tokens);
            if had_cached_prompt {
                let min_position = llama_memory_seq_pos_min(mem, 0);
                let max_position = llama_memory_seq_pos_max(mem, 0);
                let prefix_is_resident = reused_prompt_tokens > 0
                    && min_position == 0
                    && max_position >= reused_prompt_tokens as llama_pos - 1;
                if !prefix_is_resident
                    || !llama_memory_seq_rm(mem, 0, reused_prompt_tokens as llama_pos, -1)
                    || llama_memory_seq_pos_max(mem, 0) != reused_prompt_tokens as llama_pos - 1
                {
                    reused_prompt_tokens = 0;
                }
            }
            if reused_prompt_tokens == 0 {
                llama_memory_clear(mem, true);
            }
            llama_sampler_reset(s.sampler);

            let ctx = s.ctx;
            let decode_prompt_from = |first_token: usize| -> bool {
                let mut prompt_batch = llama_batch_init((tokens.len() - first_token) as i32, 0, 1);
                for (i, &token) in tokens.iter().enumerate().skip(first_token) {
                    let idx = prompt_batch.n_tokens as isize;
                    *prompt_batch.token.offset(idx) = token;
                    *prompt_batch.pos.offset(idx) = i as llama_pos;
                    *prompt_batch.n_seq_id.offset(idx) = 1;
                    *(*prompt_batch.seq_id.offset(idx)) = 0;
                    *prompt_batch.logits.offset(idx) = if i + 1 == tokens.len() { 1 } else { 0 };
                    prompt_batch.n_tokens += 1;
                }
                let succeeded = llama_decode(ctx, prompt_batch) == 0;
                llama_batch_free(prompt_batch);
                succeeded
            };

            let prompt_started = Instant::now();
            let mut prompt_decoded = decode_prompt_from(reused_prompt_tokens);
            if !prompt_decoded && reused_prompt_tokens > 0 {
                // Cache/backend incompatibility must degrade to a full prefill,
                // not a failed request or a partially resident prompt.
                log::warn!(
                    "Hy-MT2 cached-prefix decode failed after {} tokens; retrying full prefill",
                    reused_prompt_tokens
                );
                reused_prompt_tokens = 0;
                s.cached_prompt_tokens.clear();
                llama_memory_clear(mem, true);
                prompt_decoded = decode_prompt_from(0);
            }
            if !prompt_decoded {
                return Err("Initial decode failed".into());
            }
            let prompt_elapsed = prompt_started.elapsed();
            s.cached_prompt_tokens.clone_from(&tokens);

            // Per-token decode loop with cancellation.
            let mut batch = llama_batch_init(1, 0, 1);
            let mut output_bytes: Vec<u8> = Vec::with_capacity(512);
            let mut n_decoded = 0i32;
            let mut generation_failed = false;
            let mut was_cancelled = false;

            while n_decoded < max_predict {
                if CANCELLED.load(Ordering::SeqCst) {
                    log::info!("Inference cancelled after {} tokens", n_decoded);
                    was_cancelled = true;
                    break;
                }

                let token = llama_sampler_sample(s.sampler, s.ctx, -1);
                n_decoded += 1;

                if llama_vocab_is_eog(vocab, token) {
                    break;
                }

                match token_to_piece_bytes(vocab, token) {
                    Ok(piece) => output_bytes.extend_from_slice(&piece),
                    Err(error) => {
                        log::warn!("Failed to decode Hy-MT2 output token: {}", error);
                        generation_failed = true;
                        break;
                    }
                }

                // The vocabulary's EOG flag above is authoritative. These raw-byte
                // checks also catch split, unregistered, or text-rendered Hunyuan
                // control tokens before they leak into the visible translation.
                if truncate_at_hymt_stop(&mut output_bytes) {
                    break;
                }

                // Decoding the final permitted token cannot produce another
                // sample, so avoid one unnecessary model step at the boundary.
                if n_decoded >= max_predict {
                    break;
                }

                // Feed the generated token back to obtain logits for the next one.
                batch.n_tokens = 0;
                *batch.token = token;
                *batch.pos = n_tokens + n_decoded - 1;
                *batch.n_seq_id = 1;
                **batch.seq_id = 0;
                *batch.logits = 1;
                batch.n_tokens = 1;

                if llama_decode(s.ctx, batch) != 0 {
                    log::error!("Decode failed at token {}", n_decoded);
                    generation_failed = true;
                    break;
                }
            }

            llama_batch_free(batch);
            llama_sampler_reset(s.sampler);
            truncate_partial_hymt_stop(&mut output_bytes);
            log::info!(
                "Hy-MT2 inference complete: prompt_total={}, prompt_reused={}, prompt_decoded={}, prompt_ms={:.3}, generated={}, total_ms={:.3}",
                tokens.len(),
                reused_prompt_tokens,
                tokens.len() - reused_prompt_tokens,
                prompt_elapsed.as_secs_f64() * 1000.0,
                n_decoded,
                inference_started.elapsed().as_secs_f64() * 1000.0,
            );

            if generation_failed {
                return Err("Hy-MT2 generation failed".into());
            }
            if was_cancelled {
                return Err("Translation cancelled".into());
            }

            let output = String::from_utf8_lossy(&output_bytes).into_owned();
            Ok(output.trim().to_string())
        })();

        // A failed/cancelled request must never leave cache metadata pointing
        // at a context that may contain a partial prefill or continuation.
        if result.is_err() {
            invalidate_prompt_cache(s);
            llama_sampler_reset(s.sampler);
        }
        result
    }
}

/// Convert one token to raw bytes, retrying if a piece is larger than the
/// normal stack-sized buffer. Keeping bytes intact prevents corruption when a
/// UTF-8 codepoint spans token boundaries.
unsafe fn token_to_piece_bytes(
    vocab: *const llama_vocab,
    token: llama_token,
) -> Result<Vec<u8>, String> {
    let mut piece = vec![0u8; 256];
    let mut n = llama_token_to_piece(
        vocab,
        token,
        piece.as_mut_ptr() as *mut c_char,
        piece.len() as i32,
        0,
        true,
    );
    if n < 0 {
        piece.resize((-n) as usize, 0);
        n = llama_token_to_piece(
            vocab,
            token,
            piece.as_mut_ptr() as *mut c_char,
            piece.len() as i32,
            0,
            true,
        );
    }
    if n < 0 {
        return Err(format!("llama_token_to_piece failed (required={})", -n));
    }
    piece.truncate(n as usize);
    Ok(piece)
}

// The GGUF declares placeholder no. 2 as EOS. The remaining entries cover
// malformed follow-up turns and normalized ASCII spellings seen in diagnostic
// output from older llama.cpp revisions.
const HY_STOP_MARKERS: &[&str] = &[
    "<｜hy_place▁holder▁no▁2｜>",
    "<｜hy_end▁of▁sentence｜>",
    "<｜hy_place▁holder▁no▁8｜>",
    "<｜hy_User｜>",
    "<｜hy_Assistant｜>",
    "<|hy_place_holder_no_2|>",
    "<|hy_end_of_sentence|>",
    "<|hy_User|>",
    "<|hy_Assistant|>",
    "<｜hy_",
    "<|hy_",
];

fn truncate_at_hymt_stop(output: &mut Vec<u8>) -> bool {
    let first_stop = HY_STOP_MARKERS
        .iter()
        .filter_map(|marker| find_subslice(output, marker.as_bytes()))
        .min();
    if let Some(position) = first_stop {
        output.truncate(position);
        true
    } else {
        false
    }
}

/// Remove a truncated control-token prefix if generation stopped at the token
/// limit or was cancelled between pieces.
fn truncate_partial_hymt_stop(output: &mut Vec<u8>) {
    let partial_start = HY_STOP_MARKERS
        .iter()
        .filter_map(|marker| {
            let marker = marker.as_bytes();
            let max_prefix = marker.len().saturating_sub(1).min(output.len());
            (3..=max_prefix)
                .rev()
                .find(|&len| output.ends_with(&marker[..len]))
                .map(|len| output.len() - len)
        })
        .min();
    if let Some(position) = partial_start {
        output.truncate(position);
    }
}

/// Find the first occurrence of `needle` in `haystack`, returning the byte
/// index. Used for defense-in-depth stop conditions in the decode loop where
/// the output buffer is raw bytes (not UTF-8 validated).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    /// "metal:<GPU>" while the loaded model runs on the GPU, otherwise "cpu".
    pub backend: String,
    pub description: String,
    /// The GPU a load could use, whether or not the loaded model does.
    pub gpu_device: Option<String>,
    pub threads: i32,
    /// Whether a model is loaded; without one, `backend` is "cpu".
    pub loaded: bool,
}

fn set_loaded_backend(backend: Option<ComputeBackend>) {
    if let Ok(mut loaded) = LOADED_BACKEND.lock() {
        *loaded = backend;
    }
}

#[tauri::command]
pub fn llama_get_backend() -> BackendInfo {
    ensure_backend_init();
    let threads = inference_threads();
    let loaded = LOADED_BACKEND
        .lock()
        .ok()
        .and_then(|backend| backend.clone());
    let description = match &loaded {
        Some(ComputeBackend::Gpu(device)) => format!("llama.cpp Metal ({device})"),
        _ => format!("llama.cpp CPU ({threads} threads)"),
    };
    BackendInfo {
        backend: loaded
            .as_ref()
            .map_or_else(|| "cpu".into(), ComputeBackend::id),
        description,
        gpu_device: gpu_device(),
        threads,
        loaded: loaded.is_some(),
    }
}

#[tauri::command(async)]
pub fn llama_unload() -> Result<(), String> {
    let mut state = LLAMA_STATE.lock().map_err(|e| e.to_string())?;

    if let Some(s) = state.take() {
        unsafe {
            llama_sampler_free(s.sampler);
            llama_free(s.ctx);
            llama_model_free(s.model);
        }
        log::info!("Model unloaded");
    }
    set_loaded_backend(None);
    CANCELLED.store(false, Ordering::SeqCst);

    Ok(())
}

#[tauri::command(async)]
pub fn llama_is_loaded() -> bool {
    LLAMA_STATE.lock().map(|s| s.is_some()).unwrap_or(false)
}

#[tauri::command]
pub fn llama_cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hymt_stop_marker_is_removed_even_when_split_across_pieces() {
        let mut output = "Translated dialogue<｜hy_place▁holder▁no▁2｜>ignored"
            .as_bytes()
            .to_vec();
        assert!(truncate_at_hymt_stop(&mut output));
        assert_eq!(output, b"Translated dialogue");
    }

    #[test]
    fn truncated_hymt_control_fragment_is_removed() {
        let mut output = "Translated dialogue<｜hy".as_bytes().to_vec();
        truncate_partial_hymt_stop(&mut output);
        assert_eq!(output, b"Translated dialogue");
    }

    #[test]
    fn missing_hymt_bos_is_prepended_once() {
        let mut tokens = vec![120006, 4953, 120007];
        ensure_hymt_bos(&mut tokens, 120000, 512).unwrap();
        assert_eq!(tokens, [120000, 120006, 4953, 120007]);

        ensure_hymt_bos(&mut tokens, 120000, 512).unwrap();
        assert_eq!(tokens, [120000, 120006, 4953, 120007]);
    }

    #[test]
    fn prompt_cache_reuses_only_the_exact_common_prefix() {
        assert_eq!(reusable_prompt_prefix(&[], &[]), 0);
        assert_eq!(reusable_prompt_prefix(&[], &[1, 2]), 0);
        assert_eq!(reusable_prompt_prefix(&[1, 2], &[9, 2]), 0);
        assert_eq!(reusable_prompt_prefix(&[1, 2, 3], &[1, 2, 9]), 2);
        assert_eq!(reusable_prompt_prefix(&[1, 2], &[1, 2, 3]), 2);
    }

    #[test]
    fn identical_or_shorter_prompt_redecodes_its_final_token() {
        assert_eq!(reusable_prompt_prefix(&[1, 2, 3], &[1, 2, 3]), 2);
        assert_eq!(reusable_prompt_prefix(&[1, 2, 3], &[1, 2]), 1);
        assert_eq!(reusable_prompt_prefix(&[1], &[1]), 0);
    }

    #[test]
    fn japanese_english_prompt_includes_phase_tested_manga_guidance() {
        let prompt = build_manga_translation_instruction(
            "ついたー",
            "ja",
            "en",
            "Japanese",
            "English",
            GuidanceScope::EnglishOnly,
        );
        assert!(prompt.contains("部室 translates to clubroom"));
        assert!(prompt.contains("ついたー translates to I'm here!"));
        assert!(prompt.ends_with("ついたー"));

        // A non-Japanese source carries no terminology block: every frozen
        // block is Japanese-source and would be noise in another direction.
        let other = build_manga_translation_instruction(
            "Bonjour",
            "fr",
            "en",
            "French",
            "English",
            GuidanceScope::AllTargets,
        );
        assert!(!other.contains("部室"));
        assert!(other.contains("from French into English"));
    }

    #[test]
    fn every_v3_target_gets_its_own_guidance_block() {
        // The v3 fine-tune was trained with a per-target terminology block.
        // Sending English's block (or none) to a Chinese target is the shape
        // of mistake that produced v2's 99.7% off-target rate there.
        let english = build_manga_translation_instruction(
            "x",
            "ja",
            "en",
            "Japanese",
            "English",
            GuidanceScope::AllTargets,
        );
        for (code, name) in [
            ("zh-Hans", "Simplified Chinese"),
            ("fa", "Persian"),
            ("ko", "Korean"),
            ("ar", "Arabic"),
        ] {
            let prompt = build_manga_translation_instruction(
                "x",
                "ja",
                code,
                "Japanese",
                name,
                GuidanceScope::AllTargets,
            );
            assert!(
                prompt.contains("Reference the following manga translations:"),
                "{code} lost its guidance block"
            );
            assert!(prompt != english, "{code} reused the English block");
            assert!(prompt.contains(&format!("from Japanese into {name}")));
        }
    }

    #[test]
    fn script_subtags_resolve_to_real_language_names() {
        // These fell through to the raw code, so the shipped prompt read
        // "into zh-Hans" — the exact string the model never saw in training.
        assert_eq!(get_lang_name("zh-Hans"), "Simplified Chinese");
        assert_eq!(get_lang_name("zh-Hant"), "Traditional Chinese");
        assert_eq!(get_lang_name("fa"), "Persian");
        // Unknown codes still fall back to themselves rather than panicking.
        assert_eq!(get_lang_name("xx-Fake"), "xx-Fake");
    }

    #[test]
    fn an_unknown_target_gets_no_guidance_rather_than_english() {
        let prompt = build_manga_translation_instruction(
            "x",
            "ja",
            "el",
            "Japanese",
            "Greek",
            GuidanceScope::AllTargets,
        );
        assert!(!prompt.contains("Reference the following manga translations:"));
        assert!(!prompt.contains("部室"));
        assert!(prompt.contains("from Japanese into Greek"));
    }

    #[test]
    fn english_only_models_keep_their_guidance_to_english_targets() {
        // Every model but v3: Korean gets no block at all, and English gets
        // exactly the block the multilingual scope gives it.
        let korean = build_manga_translation_instruction(
            "x",
            "ja",
            "ko",
            "Japanese",
            "Korean",
            GuidanceScope::EnglishOnly,
        );
        assert!(!korean.contains("Reference the following manga translations:"));
        assert!(korean.contains("from Japanese into Korean"));

        let english_only = build_manga_translation_instruction(
            "x",
            "ja",
            "en",
            "Japanese",
            "English",
            GuidanceScope::EnglishOnly,
        );
        let all_targets = build_manga_translation_instruction(
            "x",
            "ja",
            "en",
            "Japanese",
            "English",
            GuidanceScope::AllTargets,
        );
        assert!(english_only.contains("Reference the following manga translations:"));
        assert_eq!(english_only, all_targets);
    }

    #[test]
    fn guidance_scope_parses_like_the_android_bridge() {
        use GuidanceScope::{AllTargets, EnglishOnly};
        assert_eq!(GuidanceScope::parse(Some("all-targets")), AllTargets);
        assert_eq!(GuidanceScope::parse(Some("english-only")), EnglishOnly);
        assert_eq!(GuidanceScope::parse(Some("All-Targets")), EnglishOnly);
        assert_eq!(GuidanceScope::parse(None), EnglishOnly);
    }

    #[test]
    fn load_options_arrive_in_camel_case_and_default_when_absent() {
        let options: LoadOptions =
            serde_json::from_str(r#"{"guidanceScope":"all-targets","gpu":true}"#).unwrap();
        assert_eq!(options.guidance_scope.as_deref(), Some("all-targets"));
        assert!(options.gpu);

        let empty: LoadOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.guidance_scope, None);
        assert!(!empty.gpu);
    }

    #[test]
    fn backend_ids_are_what_the_frontend_reads() {
        assert_eq!(ComputeBackend::Cpu.id(), "cpu");
        assert_eq!(
            ComputeBackend::Gpu("Apple M1".into()).id(),
            "metal:Apple M1"
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_linux_build_has_no_gpu_so_a_gpu_request_loads_on_the_cpu() {
        // build.rs compiles no GPU backend off macOS, so `gpu: true` resolves
        // to no device and llama_load takes exactly the CPU parameters.
        assert_eq!(gpu_device(), None);
        let info = llama_get_backend();
        assert_eq!(info.gpu_device, None);
        assert_eq!(info.threads, inference_threads());
    }

    #[test]
    fn one_thread_per_fast_core_clamped_to_four_to_six() {
        assert_eq!(inference_thread_count(None), 6);
        assert_eq!(inference_thread_count(Some(0)), 6);
        assert_eq!(inference_thread_count(Some(-1)), 6);
        assert_eq!(inference_thread_count(Some(2)), 4);
        // An M1 or M2: four performance cores.
        assert_eq!(inference_thread_count(Some(4)), 4);
        assert_eq!(inference_thread_count(Some(5)), 5);
        // An M1 Pro or M4 Pro: more than six.
        assert_eq!(inference_thread_count(Some(8)), 6);
        assert_eq!(inference_thread_count(Some(10)), 6);
    }

    #[test]
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    fn ffi_param_layout_matches_vendored_header() {
        assert_eq!(std::mem::size_of::<llama_model_params>(), 72);
        assert_eq!(std::mem::size_of::<llama_context_params>(), 136);
        assert_eq!(std::mem::size_of::<llama_sampler_chain_params>(), 1);
        assert_eq!(std::mem::size_of::<llama_chat_message>(), 16);
    }

    #[test]
    #[ignore = "requires HYM_T2_TEST_MODEL to point to a Hy-MT2 GGUF"]
    fn live_hymt_translation_smoke() {
        let model_path = std::env::var("HYM_T2_TEST_MODEL")
            .expect("HYM_T2_TEST_MODEL must point to a Hy-MT2 GGUF");
        assert!(llama_load(model_path, None).expect("Hy-MT2 model must load"));

        // Official tokenizer contract for one rendered User/test/Assistant
        // turn. This proves BOS is present even though the 1.25-bit GGUF does
        // not declare tokenizer.ggml.add_bos_token.
        let template_probe_tokens = {
            let state = LLAMA_STATE.lock().expect("llama state mutex");
            let loaded = state.as_ref().expect("Hy-MT2 model state");
            unsafe {
                let vocab = llama_model_get_vocab(loaded.model);
                let prompt = render_hymt_chat_prompt(loaded.model, "test")
                    .expect("embedded chat template must render");
                eprintln!(
                    "Hy-MT2 template probe: {}",
                    String::from_utf8_lossy(&prompt)
                );
                tokenize_hymt_prompt(vocab, &prompt).expect("template probe must tokenize")
            }
        };
        assert_eq!(template_probe_tokens, [120000, 120006, 4953, 120007]);

        let full_started = Instant::now();
        let translation = llama_translate("こんにちは！".into(), "ja".into(), "en".into(), None)
            .expect("Hy-MT2 inference must succeed");
        let full_elapsed = full_started.elapsed();
        assert!(!translation.is_empty());
        assert!(!translation.contains("<｜hy_"));
        assert!(!translation.contains("<|hy_"));

        // The repeated request exercises the identical-prompt fast path. Its
        // output must match a fresh prefill exactly because the sampler is
        // reset to the same seed and the final prompt token is re-decoded.
        let cached_started = Instant::now();
        let cached_translation = llama_translate("こんにちは！".into(), "ja".into(), "en".into(), None)
            .expect("cached Hy-MT2 inference must succeed");
        let cached_elapsed = cached_started.elapsed();
        assert_eq!(cached_translation, translation);

        {
            let mut state = LLAMA_STATE.lock().expect("llama state mutex");
            let loaded = state.as_mut().expect("Hy-MT2 model state");
            unsafe { invalidate_prompt_cache(loaded) };
        }
        let fresh_started = Instant::now();
        let fresh_translation = llama_translate("こんにちは！".into(), "ja".into(), "en".into(), None)
            .expect("fresh Hy-MT2 inference must succeed");
        let fresh_elapsed = fresh_started.elapsed();
        assert_eq!(fresh_translation, translation);
        eprintln!(
            "Hy-MT2 cache equivalence: output={translation:?}, first_full_ms={:.3}, cached_ms={:.3}, second_full_ms={:.3}",
            full_elapsed.as_secs_f64() * 1000.0,
            cached_elapsed.as_secs_f64() * 1000.0,
            fresh_elapsed.as_secs_f64() * 1000.0,
        );

        llama_unload().expect("Hy-MT2 model must unload cleanly");
    }
}
