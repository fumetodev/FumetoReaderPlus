//! Total and available memory, for the on-device model advice on desktop.
//!
//! The frontend reads RAM from the Android bridge; a desktop had nothing to
//! ask (`navigator.deviceMemory` does not exist in WebKit), so every model's
//! memory advice said "unknown". Returns `None` where it cannot tell.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemory {
    pub total_bytes: u64,
    pub avail_bytes: u64,
}

#[tauri::command]
pub fn system_memory() -> Option<SystemMemory> {
    imp::read()
}

/// `MemTotal` and `MemAvailable` (kB) from Linux's `/proc/meminfo`.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
fn parse_meminfo(text: &str) -> Option<SystemMemory> {
    let mut total = None;
    let mut avail = None;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let (Some(key), Some(value)) = (fields.next(), fields.next()) else {
            continue;
        };
        let Ok(kib) = value.parse::<u64>() else {
            continue;
        };
        match key {
            "MemTotal:" => total = Some(kib.saturating_mul(1024)),
            "MemAvailable:" => avail = Some(kib.saturating_mul(1024)),
            _ => {}
        }
    }
    let total_bytes = total.filter(|bytes| *bytes > 0)?;
    Some(SystemMemory {
        total_bytes,
        avail_bytes: avail.unwrap_or(0).min(total_bytes),
    })
}

/// What macOS can hand back without paging anything out: free pages plus the
/// speculative (read-ahead) and inactive pages it reclaims first.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
fn mac_available_bytes(free: u64, speculative: u64, inactive: u64, page_size: u64) -> u64 {
    free.saturating_add(speculative)
        .saturating_add(inactive)
        .saturating_mul(page_size)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{mac_available_bytes, SystemMemory};
    use std::ffi::CStr;

    fn sysctl_u64(name: &CStr) -> Option<u64> {
        let mut value: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        // SAFETY: `value` is a u64 and `size` tells sysctl exactly that.
        let status = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0 && size == std::mem::size_of::<u64>()).then_some(value)
    }

    // libc marks its mach bindings deprecated in favour of the mach2 crate;
    // these two calls are stable ABI and not worth another dependency.
    #[allow(deprecated)]
    fn vm_statistics() -> Option<libc::vm_statistics64> {
        // SAFETY: vm_statistics64 is plain integers; zero is a valid value,
        // and `count` is its size in integer_t units, as the API requires.
        let mut stats: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let status = unsafe {
            libc::host_statistics64(
                libc::mach_host_self(),
                libc::HOST_VM_INFO64,
                (&mut stats as *mut libc::vm_statistics64).cast(),
                &mut count,
            )
        };
        (status == libc::KERN_SUCCESS).then_some(stats)
    }

    pub fn read() -> Option<SystemMemory> {
        let total_bytes = sysctl_u64(c"hw.memsize").filter(|bytes| *bytes > 0)?;
        // SAFETY: sysconf has no preconditions.
        let page_size = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(0);
        let avail_bytes = match vm_statistics() {
            Some(stats) if page_size > 0 => mac_available_bytes(
                stats.free_count.into(),
                stats.speculative_count.into(),
                stats.inactive_count.into(),
                page_size,
            ),
            _ => 0,
        };
        Some(SystemMemory {
            total_bytes,
            avail_bytes: avail_bytes.min(total_bytes),
        })
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::SystemMemory;

    pub fn read() -> Option<SystemMemory> {
        super::parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use super::SystemMemory;

    pub fn read() -> Option<SystemMemory> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMINFO: &str = "MemTotal:       16303428 kB\nMemFree:         1204560 kB\nMemAvailable:    9876544 kB\nBuffers:          123456 kB\n";

    #[test]
    fn parses_total_and_available_from_meminfo() {
        assert_eq!(
            parse_meminfo(MEMINFO),
            Some(SystemMemory {
                total_bytes: 16303428 * 1024,
                avail_bytes: 9876544 * 1024
            })
        );
    }

    #[test]
    fn meminfo_without_available_reports_zero_available() {
        let parsed = parse_meminfo("MemTotal: 2048 kB\nMemFree: 512 kB\n").unwrap();
        assert_eq!(parsed.total_bytes, 2048 * 1024);
        assert_eq!(parsed.avail_bytes, 0);
    }

    #[test]
    fn meminfo_without_total_is_unknown() {
        assert_eq!(parse_meminfo("MemAvailable: 512 kB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: 0 kB\n"), None);
        assert_eq!(parse_meminfo("garbage\n\n"), None);
    }

    #[test]
    fn mac_available_counts_free_speculative_and_inactive_pages() {
        // 16 KiB pages, as on Apple Silicon.
        assert_eq!(mac_available_bytes(100, 20, 300, 16384), 420 * 16384);
        assert_eq!(mac_available_bytes(u64::MAX, 1, 1, 2), u64::MAX);
    }

    #[test]
    fn serializes_as_camel_case_for_the_frontend() {
        let json = serde_json::to_string(&SystemMemory {
            total_bytes: 1,
            avail_bytes: 2,
        })
        .unwrap();
        assert_eq!(json, r#"{"totalBytes":1,"availBytes":2}"#);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_this_machine() {
        let memory = system_memory().expect("/proc/meminfo is readable on Linux");
        assert!(memory.total_bytes > 64 * 1024 * 1024);
        assert!(memory.avail_bytes <= memory.total_bytes);
    }
}
