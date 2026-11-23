//! When the user last did something in a Cockpit Terminal: what counts as a keystroke, and how the
//! keystroke clock combines with the last prompt in the Claude Session transcript. Canonical spec: the
//! tests below.

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Whether input written to the PTY came from the user, rather than being made up entirely of replies
/// xterm.js sends on its own (focus reports, cursor position reports, device attributes, OSC / DCS
/// replies).
pub fn is_user_keystroke(data: &[u8]) -> bool {
    let mut rest = data;
    while !rest.is_empty() {
        match automatic_reply_len(rest) {
            Some(len) => rest = &rest[len..],
            None => return true,
        }
    }
    false
}

/// The length of the automatic reply `data` starts with, if it starts with one.
fn automatic_reply_len(data: &[u8]) -> Option<usize> {
    if data.first() != Some(&ESC) {
        return None;
    }
    match data.get(1)? {
        b'[' => automatic_csi_len(data),
        b']' => string_end(data, true),
        b'P' => string_end(data, false),
        _ => None,
    }
}

fn automatic_csi_len(data: &[u8]) -> Option<usize> {
    let body = &data[2..];
    let final_at = body.iter().position(|b| (0x40..=0x7e).contains(b))?;
    let (params, final_byte) = (&body[..final_at], body[final_at]);
    let automatic = match final_byte {
        b'I' | b'O' => params.is_empty(),
        b'R' => is_row_col(params),
        b'c' => matches!(params.first(), Some(b'?' | b'>')),
        _ => false,
    };
    automatic.then_some(2 + final_at + 1)
}

fn is_row_col(params: &[u8]) -> bool {
    let mut parts = params.split(|b| *b == b';');
    let is_number = |p: &[u8]| !p.is_empty() && p.iter().all(u8::is_ascii_digit);
    matches!((parts.next(), parts.next(), parts.next()), (Some(r), Some(c), None) if is_number(r) && is_number(c))
}

/// The end of an OSC (`bel_ends` true) or DCS string: past its `ESC \`, or past its BEL for an OSC.
fn string_end(data: &[u8], bel_ends: bool) -> Option<usize> {
    let mut i = 2;
    while i < data.len() {
        match data[i] {
            BEL if bel_ends => return Some(i + 1),
            ESC if data.get(i + 1) == Some(&b'\\') => return Some(i + 2),
            _ => i += 1,
        }
    }
    None
}

/// The epoch ms a terminal was last used. The spawn time is only a fallback for a terminal without a
/// transcript prompt: a terminal respawned to resume a Claude Session must not look freshly used.
pub fn last_user_activity_ms(spawned_at_ms: u64, last_keystroke_ms: Option<u64>, last_prompt_ms: Option<u64>) -> u64 {
    match last_prompt_ms {
        Some(prompt) => prompt.max(last_keystroke_ms.unwrap_or(0)),
        None => last_keystroke_ms.unwrap_or(spawned_at_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_keys_count() {
        for keys in [&b"a"[..], b"hello", b"\r", b"\x1b[A", b"\x1b[B", b"\x03", b"\x1b", b"\x1b[200~paste\x1b[201~"] {
            assert!(is_user_keystroke(keys), "{keys:?}");
        }
    }

    #[test]
    fn focus_reports_do_not_count() {
        assert!(!is_user_keystroke(b"\x1b[I"));
        assert!(!is_user_keystroke(b"\x1b[O"));
    }

    #[test]
    fn cursor_position_reports_do_not_count() {
        assert!(!is_user_keystroke(b"\x1b[12;80R"));
        assert!(!is_user_keystroke(b"\x1b[1;1R"));
    }

    #[test]
    fn device_attribute_replies_do_not_count() {
        assert!(!is_user_keystroke(b"\x1b[?1;2c"));
        assert!(!is_user_keystroke(b"\x1b[>0;276;0c"));
    }

    #[test]
    fn osc_replies_do_not_count_with_either_terminator() {
        assert!(!is_user_keystroke(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07"));
        assert!(!is_user_keystroke(b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"));
    }

    #[test]
    fn dcs_replies_do_not_count() {
        assert!(!is_user_keystroke(b"\x1bP1$r0m\x1b\\"));
    }

    #[test]
    fn several_replies_in_one_chunk_do_not_count() {
        assert!(!is_user_keystroke(b"\x1b[I\x1b[?1;2c\x1b]11;rgb:0/0/0\x07\x1b[O"));
    }

    #[test]
    fn a_reply_mixed_with_a_typed_key_counts() {
        assert!(is_user_keystroke(b"\x1b[Ia"));
        assert!(is_user_keystroke(b"x\x1b[12;80R"));
    }

    #[test]
    fn csi_sequences_that_only_look_like_replies_count() {
        assert!(is_user_keystroke(b"\x1b[1I"));
        assert!(is_user_keystroke(b"\x1b[5R"));
        assert!(is_user_keystroke(b"\x1b[1c"));
    }

    #[test]
    fn an_unterminated_osc_or_dcs_counts() {
        assert!(is_user_keystroke(b"\x1b]11;rgb:0/0/0"));
        assert!(is_user_keystroke(b"\x1bP1$r0m"));
    }

    #[test]
    fn empty_input_does_not_count() {
        assert!(!is_user_keystroke(b""));
    }

    #[test]
    fn without_a_prompt_the_keystroke_wins_and_falls_back_to_the_spawn() {
        assert_eq!(last_user_activity_ms(100, None, None), 100);
        assert_eq!(last_user_activity_ms(100, Some(250), None), 250);
    }

    #[test]
    fn with_a_prompt_the_later_of_prompt_and_keystroke_wins_and_the_spawn_is_ignored() {
        assert_eq!(last_user_activity_ms(1_000, None, Some(10)), 10);
        assert_eq!(last_user_activity_ms(1_000, Some(500), Some(10)), 500);
        assert_eq!(last_user_activity_ms(1_000, Some(5), Some(10)), 10);
    }
}
