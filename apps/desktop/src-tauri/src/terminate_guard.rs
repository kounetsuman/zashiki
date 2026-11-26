//! Routes every `-[NSApplication terminate:]` (⌘Q, the Quit menu item, Dock "Quit", a quit Apple
//! Event, log out / restart / shut down) through the guarded quit.
//!
//! tao's app delegate does not implement `applicationShouldTerminate:`, so AppKit terminates at
//! once and Tauri never sees an `ExitRequested`. The method is added to that delegate's class.

use std::ffi::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEventType};
use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};

use crate::quit_source::{four_char_code, AppleEventQuit, Input, Sender};

/// Given how the quit was requested, returns whether AppKit may terminate right now.
type Handler = Box<dyn Fn(String) -> bool + Send + Sync>;

static HANDLER: OnceLock<Handler> = OnceLock::new();

type ShouldTerminate = extern "C-unwind" fn(&AnyObject, Sel, *mut c_void) -> usize;

const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;
const QUIT_APPLICATION: u32 = four_char_code(b"quit");
const SENDER_PID: u32 = four_char_code(b"spid");
const QUIT_REASON: u32 = four_char_code(b"why?");
/// `NSApplicationTerminateReply (*)(id, SEL, NSApplication *)`.
const SHOULD_TERMINATE_TYPES: &[u8] = b"Q@:@\0";

pub fn install(mtm: MainThreadMarker, handler: Handler) -> Result<(), String> {
    if HANDLER.set(handler).is_err() {
        return Err("the terminate guard is already installed".to_string());
    }
    let app = NSApplication::sharedApplication(mtm);
    let delegate = app
        .delegate()
        .ok_or_else(|| "NSApplication has no delegate".to_string())?;
    let object: &AnyObject = delegate.as_ref();
    let class: &AnyClass = object.class();
    let imp = should_terminate as ShouldTerminate;
    // SAFETY: the function matches the selector's signature and the type encoding given with it,
    // and the class is the live delegate's own, which outlives the process's run loop.
    let added = unsafe {
        class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:),
            std::mem::transmute::<ShouldTerminate, Imp>(imp),
            SHOULD_TERMINATE_TYPES.as_ptr() as *const c_char,
        )
    };
    if added.as_bool() {
        Ok(())
    } else {
        Err(format!(
            "{} already implements applicationShouldTerminate:",
            class.name().to_string_lossy()
        ))
    }
}

extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut c_void) -> usize {
    // A panic must not unwind into AppKit; refusing keeps the app open, which the next quit retries.
    catch_unwind(AssertUnwindSafe(|| {
        let source =
            crate::quit_source::describe_terminate(current_quit_event().as_ref(), current_input());
        match HANDLER.get() {
            Some(handler) if handler(source) => TERMINATE_NOW,
            Some(_) => TERMINATE_CANCEL,
            None => TERMINATE_NOW,
        }
    }))
    .unwrap_or(TERMINATE_CANCEL)
}

fn current_quit_event() -> Option<AppleEventQuit> {
    let event = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()?;
    if event_id(&event) != QUIT_APPLICATION {
        return None;
    }
    let sender = attribute(&event, SENDER_PID)
        .map(|pid| pid.int32Value())
        .filter(|&pid| pid > 0)
        .map(|pid| Sender {
            pid,
            name: process_name(pid),
        });
    let reason = attribute(&event, QUIT_REASON).and_then(|reason| {
        [reason.enumCodeValue(), reason.typeCodeValue()]
            .into_iter()
            .find(|&code| code != 0)
    });
    Some(AppleEventQuit { sender, reason })
}

// The typed bindings for these two sit behind objc2-core-services, a whole framework for two getters.
fn event_id(event: &NSAppleEventDescriptor) -> u32 {
    // SAFETY: `-eventID` takes no arguments and returns an `AEEventID` (a `u32` four-char code).
    unsafe { msg_send![event, eventID] }
}

fn attribute(
    event: &NSAppleEventDescriptor,
    keyword: u32,
) -> Option<Retained<NSAppleEventDescriptor>> {
    // SAFETY: `-attributeDescriptorForKeyword:` takes an `AEKeyword` (`u32`) and returns a nullable descriptor.
    unsafe { msg_send![event, attributeDescriptorForKeyword: keyword] }
}

fn current_input() -> Input {
    let Some(mtm) = MainThreadMarker::new() else {
        return Input::Unknown;
    };
    let Some(event) = NSApplication::sharedApplication(mtm).currentEvent() else {
        return Input::Unknown;
    };
    match event.r#type() {
        NSEventType::KeyDown => Input::KeyDown,
        NSEventType::LeftMouseUp | NSEventType::LeftMouseDown => Input::MouseClick,
        other => Input::Other(other.0 as u64),
    }
}

pub fn process_name(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is writable for the length passed, and proc_name NUL-terminates within it.
    let written =
        unsafe { libc::proc_name(pid, buffer.as_mut_ptr() as *mut c_void, buffer.len() as u32) };
    if written <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buffer[..written as usize]).into_owned())
}
