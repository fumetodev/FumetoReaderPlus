//! Keep the Mac awake while a volume translates in the background.
//!
//! The desktop counterpart of Android's foreground service and wake lock
//! (`__fumeto_service`). While the frontend holds a keep-awake claim, macOS
//! gets an `NSProcessInfo` user-initiated activity: the process is exempt from
//! App Nap (which would throttle timers and lower the priority of the llama.cpp
//! threads while the window is hidden) and idle system sleep is blocked. The
//! display may still sleep.
//!
//! The frontend reference-counts concurrent jobs (`src/lib/desktop/keep-awake.ts`)
//! and only toggles one claim, so this holds at most one activity.

/// Begin (`enabled`) or end the background-work activity. Returns whether the
/// request reached the platform — `false` where there is nothing to do.
#[tauri::command]
pub fn app_keep_awake<R: tauri::Runtime>(app: tauri::AppHandle<R>, enabled: bool) -> bool {
    imp::set(&app, enabled)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    thread_local! {
        // The activity token is an Objective-C object and not Send, so it lives
        // on the main thread and is only touched there.
        static ACTIVITY: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
            const { RefCell::new(None) };
    }

    pub fn set<R: tauri::Runtime>(app: &tauri::AppHandle<R>, enabled: bool) -> bool {
        app.run_on_main_thread(move || {
            ACTIVITY.with(|slot| {
                let mut slot = slot.borrow_mut();
                let process = NSProcessInfo::processInfo();
                match (enabled, slot.take()) {
                    (true, Some(held)) => *slot = Some(held),
                    (true, None) => {
                        let reason = NSString::from_str("Translating a volume in the background");
                        *slot = Some(process.beginActivityWithOptions_reason(
                            NSActivityOptions::UserInitiated,
                            &reason,
                        ));
                    }
                    // SAFETY: `held` is the token beginActivityWithOptions_reason
                    // returned, which is exactly what endActivity expects.
                    (false, Some(held)) => unsafe { process.endActivity(&held) },
                    (false, None) => {}
                }
            })
        })
        .is_ok()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn set<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _enabled: bool) -> bool {
        false
    }
}
