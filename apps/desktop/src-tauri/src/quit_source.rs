//! How a quit was requested, in the words the shell log uses to tell a requested quit from a crash.
//! Free of AppKit so every wording is unit-tested on Linux.

/// A process that sent us a quit (an Apple Event or a signal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sender {
    pub pid: i32,
    pub name: Option<String>,
}

/// The `kAEQuitApplication` event AppKit is handling while it asks whether to terminate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleEventQuit {
    pub sender: Option<Sender>,
    /// The `kAEQuitReason` code, present when the system quits apps to log out, restart or shut down.
    pub reason: Option<u32>,
}

/// The user input AppKit was handling when `terminate:` arrived without an Apple Event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    KeyDown,
    MouseClick,
    Other(u64),
    Unknown,
}

pub const fn four_char_code(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

/// The Apple Event wins over the input event: a Dock or `osascript` quit arrives while AppKit's
/// current input is whatever the user last did, which says nothing about this quit.
pub fn describe_terminate(apple_event: Option<&AppleEventQuit>, input: Input) -> String {
    if let Some(event) = apple_event {
        let from = event
            .sender
            .as_ref()
            .map_or_else(|| "an unknown sender".to_string(), describe_sender);
        return match event.reason.map(quit_reason) {
            Some(reason) => format!("quit Apple Event from {from} ({reason})"),
            None => format!("quit Apple Event from {from}"),
        };
    }
    match input {
        Input::KeyDown => "keyboard shortcut for the Quit menu item (⌘Q)".to_string(),
        Input::MouseClick => "Quit menu item clicked".to_string(),
        Input::Other(kind) => format!("terminate request during input event type {kind}"),
        Input::Unknown => "terminate request with no input or Apple Event".to_string(),
    }
}

pub fn describe_signal(signal: &str, sender: Option<&Sender>) -> String {
    match sender {
        Some(sender) => format!("{signal} from {}", describe_sender(sender)),
        None => format!("{signal} from an unknown sender"),
    }
}

fn describe_sender(sender: &Sender) -> String {
    match &sender.name {
        Some(name) => format!("{name} (pid {})", sender.pid),
        None => format!("pid {}", sender.pid),
    }
}

fn quit_reason(code: u32) -> String {
    let label = match &code.to_be_bytes() {
        b"logo" | b"rlgo" => "log out",
        b"rrst" | b"rest" => "restart",
        b"rsdn" | b"shut" => "shut down",
        _ => return format!("reason '{}'", String::from_utf8_lossy(&code.to_be_bytes())),
    };
    format!("system {label}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dock() -> Sender {
        Sender {
            pid: 612,
            name: Some("Dock".to_string()),
        }
    }

    #[test]
    fn keyboard_and_mouse_quits_name_the_menu_item() {
        assert_eq!(
            describe_terminate(None, Input::KeyDown),
            "keyboard shortcut for the Quit menu item (⌘Q)"
        );
        assert_eq!(
            describe_terminate(None, Input::MouseClick),
            "Quit menu item clicked"
        );
    }

    #[test]
    fn unrecognised_input_is_still_recorded() {
        assert_eq!(
            describe_terminate(None, Input::Other(14)),
            "terminate request during input event type 14"
        );
        assert_eq!(
            describe_terminate(None, Input::Unknown),
            "terminate request with no input or Apple Event"
        );
    }

    #[test]
    fn an_apple_event_names_its_sender_even_during_a_key_press() {
        let event = AppleEventQuit {
            sender: Some(dock()),
            reason: None,
        };
        assert_eq!(
            describe_terminate(Some(&event), Input::KeyDown),
            "quit Apple Event from Dock (pid 612)"
        );
    }

    #[test]
    fn system_quits_carry_their_reason() {
        let cases = [
            (b"logo", "log out"),
            (b"rlgo", "log out"),
            (b"rrst", "restart"),
            (b"rest", "restart"),
            (b"rsdn", "shut down"),
            (b"shut", "shut down"),
        ];
        for (code, label) in cases {
            let event = AppleEventQuit {
                sender: Some(Sender {
                    pid: 100,
                    name: None,
                }),
                reason: Some(four_char_code(code)),
            };
            assert_eq!(
                describe_terminate(Some(&event), Input::Unknown),
                format!("quit Apple Event from pid 100 (system {label})")
            );
        }
    }

    #[test]
    fn an_unknown_reason_keeps_its_code() {
        let event = AppleEventQuit {
            sender: None,
            reason: Some(four_char_code(b"abcd")),
        };
        assert_eq!(
            describe_terminate(Some(&event), Input::Unknown),
            "quit Apple Event from an unknown sender (reason 'abcd')"
        );
    }

    #[test]
    fn signals_name_their_sender_when_known() {
        assert_eq!(
            describe_signal("SIGTERM", Some(&dock())),
            "SIGTERM from Dock (pid 612)"
        );
        assert_eq!(
            describe_signal("SIGINT", None),
            "SIGINT from an unknown sender"
        );
    }
}
