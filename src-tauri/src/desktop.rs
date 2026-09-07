//! Desktop host facts and start-up decisions (Linux, macOS, Windows).
//!
//! On Android the Kotlin side answers all of this. On desktop the WebView can
//! see neither the machine's memory nor its CPU, and two decisions have to be
//! taken by the shell before anything else runs: whether WebKitGTK may use its
//! DMA-BUF renderer, and how many threads llama.cpp gets. Nothing here is
//! durable; the only state is the record of what was decided at start-up,
//! which the frontend reads back through `desktop_system_info`.

use std::sync::OnceLock;

use serde::Serialize;

/// Read by WebKitGTK: any value disables its DMA-BUF renderer.
const WEBKIT_DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
/// `auto` (default), `on` or `off`: whether the shell sets the variable above.
const NVIDIA_WORKAROUND_VAR: &str = "FUMETO_NVIDIA_WORKAROUND";
/// `debug` or `trace` raises the log level and adds a log file.
const LOG_LEVEL_VAR: &str = "FUMETO_LOG";
/// Set by the AppImage runtime to the image's own path.
const APPIMAGE_VAR: &str = "APPIMAGE";

/// The thread count llama.cpp used before core topology was consulted; kept
/// as the fallback whenever the topology cannot be read, so an unknown
/// machine degrades to the old behaviour rather than to something slower.
const FALLBACK_LLAMA_THREADS: i32 = 6;
/// One worker per physical core, inside the window that measured well: below
/// two the model crawls, above six generation is flat and the WebView starves.
const MIN_LLAMA_THREADS: usize = 2;
const MAX_LLAMA_THREADS: usize = 6;

/// Verbose logging writes prompts; the plugin's default rotation size is a
/// few tens of kilobytes, which would keep only the last bubble or two.
const VERBOSE_LOG_FILE_BYTES: u128 = 20 * 1024 * 1024;

/// The x86-64 instruction sets the bundled llama.cpp is compiled for. This
/// list and the `GGML_*` defines in `build.rs` describe the same baseline;
/// change both or neither.
#[cfg(target_arch = "x86_64")]
const CPU_BASELINE_FEATURES: [&str; 6] = ["sse4.2", "avx", "avx2", "fma", "f16c", "bmi2"];

// ============================================================
// CPU baseline
// ============================================================

/// Baseline features this CPU lacks. Empty means llama.cpp may be initialised;
/// anything else would be an illegal-instruction crash on the first matmul.
#[cfg(target_arch = "x86_64")]
pub fn cpu_missing_features() -> Vec<&'static str> {
    let detected = [
        std::is_x86_feature_detected!("sse4.2"),
        std::is_x86_feature_detected!("avx"),
        std::is_x86_feature_detected!("avx2"),
        std::is_x86_feature_detected!("fma"),
        std::is_x86_feature_detected!("f16c"),
        std::is_x86_feature_detected!("bmi2"),
    ];
    CPU_BASELINE_FEATURES
        .iter()
        .zip(detected)
        .filter(|(_, present)| !present)
        .map(|(name, _)| *name)
        .collect()
}

/// Other architectures build llama.cpp for the host, so there is nothing to
/// check against.
#[cfg(not(target_arch = "x86_64"))]
pub fn cpu_missing_features() -> Vec<&'static str> {
    Vec::new()
}

#[cfg(target_arch = "x86_64")]
pub fn cpu_baseline_label() -> String {
    CPU_BASELINE_FEATURES.join(",")
}

#[cfg(not(target_arch = "x86_64"))]
pub fn cpu_baseline_label() -> String {
    "native".to_string()
}

// ============================================================
// Memory
// ============================================================

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct MemoryInfo {
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
}

/// Parses the two lines this app needs out of `/proc/meminfo`. Values there
/// are in kilobytes; the frontend wants bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_meminfo(text: &str) -> MemoryInfo {
    let mut info = MemoryInfo::default();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let slot = match key.trim() {
            "MemTotal" => &mut info.total_bytes,
            "MemAvailable" => &mut info.available_bytes,
            _ => continue,
        };
        let mut parts = rest.split_whitespace();
        let Some(value) = parts.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        let multiplier = match parts.next() {
            Some("kB") => 1024,
            None => 1,
            Some(_) => continue,
        };
        *slot = value.checked_mul(multiplier);
    }
    info
}

#[cfg(target_os = "linux")]
fn read_memory_info() -> MemoryInfo {
    std::fs::read_to_string("/proc/meminfo")
        .map(|text| parse_meminfo(&text))
        .unwrap_or_default()
}

#[cfg(not(target_os = "linux"))]
fn read_memory_info() -> MemoryInfo {
    MemoryInfo::default()
}

// ============================================================
// llama.cpp thread count
// ============================================================

/// Counts distinct sibling sets. Every hardware thread of one physical core
/// reports the same `thread_siblings_list`, so the number of distinct lists
/// is the number of physical cores.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn physical_cores_from_sibling_lists<I>(lists: I) -> usize
where
    I: IntoIterator<Item = String>,
{
    let mut distinct = std::collections::BTreeSet::new();
    for list in lists {
        let list = list.trim();
        if !list.is_empty() {
            distinct.insert(list.to_string());
        }
    }
    distinct.len()
}

#[cfg(target_os = "linux")]
fn read_physical_core_count() -> Option<usize> {
    let entries = std::fs::read_dir("/sys/devices/system/cpu").ok()?;
    let mut lists = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(index) = name.strip_prefix("cpu") else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // An offline CPU has no topology directory; count what is readable.
        let path = entry.path().join("topology/thread_siblings_list");
        if let Ok(list) = std::fs::read_to_string(path) {
            lists.push(list);
        }
    }
    let count = physical_cores_from_sibling_lists(lists);
    (count > 0).then_some(count)
}

#[cfg(not(target_os = "linux"))]
fn read_physical_core_count() -> Option<usize> {
    None
}

fn clamp_llama_threads(physical_cores: Option<usize>) -> i32 {
    match physical_cores {
        Some(cores) => cores.clamp(MIN_LLAMA_THREADS, MAX_LLAMA_THREADS) as i32,
        None => FALLBACK_LLAMA_THREADS,
    }
}

/// Worker threads for llama.cpp on this machine, decided once per process.
pub fn llama_thread_count() -> i32 {
    static THREADS: OnceLock<i32> = OnceLock::new();
    *THREADS.get_or_init(|| clamp_llama_threads(read_physical_core_count()))
}

// ============================================================
// GPU driver and the WebKitGTK renderer workaround
// ============================================================

#[cfg(target_os = "linux")]
pub fn nvidia_driver_present() -> bool {
    std::path::Path::new("/sys/module/nvidia").exists()
        || std::path::Path::new("/proc/driver/nvidia/version").exists()
}

#[cfg(not(target_os = "linux"))]
pub fn nvidia_driver_present() -> bool {
    false
}

/// Whether the kernel exposes a DRM render node. WebKitGTK's DMA-BUF renderer
/// allocates its buffers through GBM on such a node; a virtual machine with a
/// plain VGA device (no `/dev/dri`) has none, and the renderer then paints a
/// blank window, which is exactly what the workaround avoids.
#[cfg(target_os = "linux")]
pub fn drm_render_node_present() -> bool {
    std::fs::read_dir("/dev/dri")
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().starts_with("renderD"))
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
pub fn drm_render_node_present() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufDecision {
    /// The variable was already in the environment and was left exactly as
    /// found, whatever its value.
    LeftUntouched,
    /// The shell set the variable to `1`.
    Applied,
    /// Nothing was set: no NVIDIA driver, or the escape hatch said off.
    Skipped,
}

/// The whole policy, kept free of I/O so it can be tested: a value the user
/// set always wins; otherwise `FUMETO_NVIDIA_WORKAROUND` forces it on or off,
/// and the default applies it exactly when the DMA-BUF renderer is known to
/// paint nothing — the proprietary NVIDIA module is loaded, or there is no
/// DRM render node for it to allocate from (`known_bad`).
fn decide_dmabuf_workaround(mode: Option<&str>, env_present: bool, known_bad: bool) -> DmabufDecision {
    if env_present {
        return DmabufDecision::LeftUntouched;
    }
    let mode = mode.map(|value| value.trim().to_ascii_lowercase());
    match mode.as_deref() {
        Some("on") => DmabufDecision::Applied,
        Some("off") => DmabufDecision::Skipped,
        _ if known_bad => DmabufDecision::Applied,
        _ => DmabufDecision::Skipped,
    }
}

#[derive(Debug, Clone)]
struct StartupRecord {
    dmabuf_env_value: Option<String>,
    workaround_mode: Option<String>,
    nvidia_detected: bool,
    render_node_present: bool,
    decision: DmabufDecision,
}

impl StartupRecord {
    /// What the environment looks like right now, for a platform on which
    /// the start-up hook does not run (or a caller that reached us first).
    fn observe() -> Self {
        let dmabuf_env_value = dmabuf_env_value();
        let decision = if dmabuf_env_value.is_some() {
            DmabufDecision::LeftUntouched
        } else {
            DmabufDecision::Skipped
        };
        Self {
            dmabuf_env_value,
            workaround_mode: std::env::var(NVIDIA_WORKAROUND_VAR).ok(),
            nvidia_detected: nvidia_driver_present(),
            render_node_present: drm_render_node_present(),
            decision,
        }
    }
}

static STARTUP: OnceLock<StartupRecord> = OnceLock::new();

fn dmabuf_env_value() -> Option<String> {
    std::env::var_os(WEBKIT_DMABUF_VAR).map(|value| value.to_string_lossy().into_owned())
}

fn startup_record() -> StartupRecord {
    STARTUP.get().cloned().unwrap_or_else(StartupRecord::observe)
}

/// Must run before the GTK/WebKit process starts, i.e. first thing in
/// `main`, because WebKitGTK reads the variable when its web process spawns.
/// Logging happens later in `log_startup_decisions`, once a logger exists.
#[cfg(target_os = "linux")]
pub fn apply_webkit_dmabuf_workaround() {
    let dmabuf_env_value = dmabuf_env_value();
    let workaround_mode = std::env::var(NVIDIA_WORKAROUND_VAR).ok();
    let nvidia_detected = nvidia_driver_present();
    let render_node_present = drm_render_node_present();
    let decision = decide_dmabuf_workaround(
        workaround_mode.as_deref(),
        dmabuf_env_value.is_some(),
        nvidia_detected || !render_node_present,
    );
    if decision == DmabufDecision::Applied {
        std::env::set_var(WEBKIT_DMABUF_VAR, "1");
    }
    let _ = STARTUP.set(StartupRecord {
        dmabuf_env_value,
        workaround_mode,
        nvidia_detected,
        render_node_present,
        decision,
    });
}

fn env_or_unset(name: &str) -> String {
    std::env::var_os(name)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<unset>".to_string())
}

/// One line per start-up decision, at Info, so a beta report's terminal
/// output says what the shell did and why.
pub fn log_startup_decisions() {
    let record = startup_record();
    let nvidia = match (record.nvidia_detected, record.render_node_present) {
        (true, _) => "nvidia detected",
        (false, false) => "no DRM render node",
        (false, true) => "nvidia not detected",
    };
    let mode = record.workaround_mode.as_deref().unwrap_or("auto");
    match record.decision {
        DmabufDecision::LeftUntouched => log::info!(
            "[gpu] {nvidia} → {WEBKIT_DMABUF_VAR}={} was already set, left untouched",
            record.dmabuf_env_value.as_deref().unwrap_or("")
        ),
        DmabufDecision::Applied => log::info!(
            "[gpu] {nvidia} → {WEBKIT_DMABUF_VAR}=1 set ({NVIDIA_WORKAROUND_VAR}={mode})"
        ),
        DmabufDecision::Skipped => log::info!(
            "[gpu] {nvidia} → renderer left at WebKit's default ({NVIDIA_WORKAROUND_VAR}={mode})"
        ),
    }
    log::info!(
        "[display] GDK_BACKEND={} XDG_SESSION_TYPE={} WAYLAND_DISPLAY={} DISPLAY={}",
        env_or_unset("GDK_BACKEND"),
        env_or_unset("XDG_SESSION_TYPE"),
        env_or_unset("WAYLAND_DISPLAY"),
        env_or_unset("DISPLAY"),
    );
}

// ============================================================
// Logging
// ============================================================

/// Stderr at Info for this crate's own lines, always. `FUMETO_LOG=debug` or
/// `trace` raises the level (the final prompt is logged at Debug) and adds a
/// file in the platform log directory for reports from users who cannot
/// easily capture a terminal.
pub fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use log::LevelFilter;
    use tauri_plugin_log::{Target, TargetKind};

    let requested = std::env::var(LOG_LEVEL_VAR)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase());
    let (level, verbose) = match requested.as_deref() {
        Some("trace") => (LevelFilter::Trace, true),
        Some("debug") => (LevelFilter::Debug, true),
        _ => (LevelFilter::Info, false),
    };

    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Stderr))
        .level(level)
        .filter(|metadata| metadata.target().starts_with("app_lib"));
    if verbose {
        builder = builder
            .target(Target::new(TargetKind::LogDir { file_name: None }))
            .max_file_size(VERBOSE_LOG_FILE_BYTES);
    }
    builder.build()
}

// ============================================================
// Tauri commands
// ============================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSystemInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub total_memory_bytes: Option<u64>,
    pub available_memory_bytes: Option<u64>,
    pub cpu_logical_cores: usize,
    pub llama_threads: i32,
    pub cpu_baseline: String,
    pub cpu_baseline_ok: bool,
    pub cpu_missing_features: Vec<&'static str>,
    pub nvidia_driver_detected: bool,
    pub webkit_dmabuf_workaround_applied: bool,
    pub webkit_dmabuf_env_present: bool,
    pub app_image_path: Option<String>,
}

/// Everything the frontend needs to size a model download, explain a refused
/// model load, and describe the machine in a diagnostics report.
#[tauri::command]
pub fn desktop_system_info() -> DesktopSystemInfo {
    let memory = read_memory_info();
    let missing = cpu_missing_features();
    let record = startup_record();
    DesktopSystemInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        total_memory_bytes: memory.total_bytes,
        available_memory_bytes: memory.available_bytes,
        cpu_logical_cores: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        llama_threads: llama_thread_count(),
        cpu_baseline: cpu_baseline_label(),
        cpu_baseline_ok: missing.is_empty(),
        cpu_missing_features: missing,
        nvidia_driver_detected: record.nvidia_detected,
        webkit_dmabuf_workaround_applied: record.decision == DmabufDecision::Applied,
        webkit_dmabuf_env_present: record.dmabuf_env_value.is_some(),
        app_image_path: std::env::var(APPIMAGE_VAR)
            .ok()
            .filter(|path| !path.is_empty()),
    }
}

/// Lets the frontend put a timing line into the same stream as the shell's
/// own lines, so one terminal capture carries both halves of a page.
#[tauri::command]
pub fn perf_log(line: String) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    log::info!("{}", line.replace(['\n', '\r'], " "));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meminfo_values_are_converted_from_kilobytes() {
        let text = "MemTotal:       32768000 kB\nMemFree:         1000 kB\nMemAvailable:   16384000 kB\nBuffers:            5 kB\n";
        let info = parse_meminfo(text);
        assert_eq!(info.total_bytes, Some(32_768_000 * 1024));
        assert_eq!(info.available_bytes, Some(16_384_000 * 1024));
    }

    #[test]
    fn meminfo_without_usable_fields_reports_nothing() {
        let info = parse_meminfo("Garbage\nMemTotal: notanumber kB\nMemAvailable: 12 MB\n");
        assert_eq!(info, MemoryInfo::default());
    }

    #[test]
    fn this_host_meets_the_cpu_baseline() {
        // The build itself targets the same baseline (build.rs), so a host
        // that fails this could not have run the test binary either.
        assert!(cpu_missing_features().is_empty());
    }

    #[test]
    fn sibling_lists_count_each_physical_core_once() {
        let smt = ["0,8", "1,9", "2,10", "3,11", "0,8", "1,9", "2,10", "3,11"].map(String::from);
        assert_eq!(physical_cores_from_sibling_lists(smt), 4);
        let no_smt = ["0\n", "1\n", "2\n"].map(String::from);
        assert_eq!(physical_cores_from_sibling_lists(no_smt), 3);
        assert_eq!(physical_cores_from_sibling_lists(Vec::<String>::new()), 0);
    }

    #[test]
    fn llama_threads_clamp_to_the_window_and_degrade_to_the_old_default() {
        assert_eq!(clamp_llama_threads(None), 6);
        assert_eq!(clamp_llama_threads(Some(1)), 2);
        assert_eq!(clamp_llama_threads(Some(4)), 4);
        assert_eq!(clamp_llama_threads(Some(6)), 6);
        assert_eq!(clamp_llama_threads(Some(16)), 6);
    }

    #[test]
    fn dmabuf_workaround_respects_the_user_and_the_escape_hatch() {
        use DmabufDecision::*;
        // A value the user set is never touched, whatever else is true.
        assert_eq!(decide_dmabuf_workaround(None, true, true), LeftUntouched);
        assert_eq!(decide_dmabuf_workaround(Some("on"), true, false), LeftUntouched);
        // Default: exactly when the NVIDIA module is loaded.
        assert_eq!(decide_dmabuf_workaround(None, false, true), Applied);
        assert_eq!(decide_dmabuf_workaround(Some("auto"), false, true), Applied);
        assert_eq!(decide_dmabuf_workaround(None, false, false), Skipped);
        // The escape hatch overrides the detection in both directions.
        assert_eq!(decide_dmabuf_workaround(Some("off"), false, true), Skipped);
        assert_eq!(decide_dmabuf_workaround(Some("ON "), false, false), Applied);
        // An unrecognised value behaves like auto.
        assert_eq!(decide_dmabuf_workaround(Some("maybe"), false, false), Skipped);
    }
}
