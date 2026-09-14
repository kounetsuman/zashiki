//! Forwards the macOS "the machine woke from sleep" signal to the frontend, which decides whether
//! the configured dashboard page is due.

use std::ptr::NonNull;

use block2::RcBlock;
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::NSNotification;
use tauri::{AppHandle, Emitter};

/// The event the frontend listens for; it carries no payload.
pub const WOKE_EVENT: &str = "zashiki:did-wake";

/// Registers `on_wake` with NSWorkspace for the lifetime of the process. Kept free of Tauri so the
/// objc wiring can be exercised without an app instance.
fn observe_system_wake(on_wake: impl Fn() + Send + 'static) {
    let block = RcBlock::new(move |_notification: NonNull<NSNotification>| on_wake());
    // SAFETY: the name is AppKit's own constant, and the block is sendable as the method requires
    // (`on_wake: Send`), which matters because passing no queue delivers on the posting thread.
    let observer = unsafe {
        NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &block,
            )
    };
    // The observer stays registered until the process exits, so it is never released.
    std::mem::forget(observer);
}

/// Emits [`WOKE_EVENT`] on every wake. A delivery failure is not fatal: the cockpit works as before,
/// only the on-wake dashboard stays quiet.
pub fn forward_system_wake(app: AppHandle) {
    observe_system_wake(move || {
        if let Err(e) = app.emit(WOKE_EVENT, ()) {
            eprintln!("zashiki: failed to forward the wake event: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    #[test]
    fn observer_runs_on_each_wake_notification() {
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&wakes);
        observe_system_wake(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });

        // SAFETY: posting AppKit's own wake name to the workspace center, with no sender object.
        let post = || unsafe {
            NSWorkspace::sharedWorkspace()
                .notificationCenter()
                .postNotificationName_object(NSWorkspaceDidWakeNotification, None);
        };
        // Counted as deltas: the observer is registered for the life of the process on a shared
        // notification center, so a real wake during the run must not decide the result.
        let before = wakes.load(Ordering::SeqCst);
        post();
        let after_one = wakes.load(Ordering::SeqCst);
        assert!(after_one > before, "{before} -> {after_one}");
        post();
        assert!(wakes.load(Ordering::SeqCst) > after_one);
    }
}
