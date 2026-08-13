//! Parsing of `git status --porcelain=v1` and path validation (decision-oriented pure functions).
//! Does not invoke git. Corresponds 1:1 with the pure-function part of the TS `packages/shared/src/git.ts`, and
//! the vitest table tests (`git.test.ts`) were also ported to `cargo test`.
//!
//! The zod schemas and REST types (wire types such as `RepoStatus`) belong to the view/protocol layer and stay in TS
//! (only the decision logic is moved to Rust).

/// A pair of the display code and the display path. `code` is one character from the X/Y column (A/M/D/R…) or `"??"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitFileEntry {
    pub code: String,
    pub path: String,
}

/// The result classified into staged (index side) and changed (worktree side).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedGitStatus {
    pub staged: Vec<GitFileEntry>,
    pub changed: Vec<GitFileEntry>,
}

/// The `-> ` split token (searched only outside quotes, so the same sequence inside a C-quoted string isn't misdetected).
const ARROW: [char; 4] = [' ', '-', '>', ' '];

fn starts_with_arrow(chars: &[char]) -> bool {
    chars.len() >= 4 && chars[..4] == ARROW
}

/// Return the char index of the first ` -> ` outside quotes.
fn find_arrow(chars: &[char]) -> Option<usize> {
    chars.windows(4).position(|w| w == ARROW)
}

/// Restore a C-quoted string (starting with `"`) and return the char position just after the closing `"`.
/// As in the TS version, assemble a byte sequence and then decode it as UTF-8 (octal escapes can represent
/// intermediate bytes of a multi-byte character, so accumulate by byte rather than by char).
fn parse_c_quoted(chars: &[char]) -> (String, usize) {
    let mut bytes: Vec<u8> = Vec::new();
    let mut i = 1;
    while i < chars.len() && chars[i] != '"' {
        let ch = chars[i];
        if ch == '\\' {
            let Some(&next) = chars.get(i + 1) else { break };
            let simple = match next {
                'n' => Some(0x0a),
                't' => Some(0x09),
                'r' => Some(0x0d),
                'a' => Some(0x07),
                'b' => Some(0x08),
                'f' => Some(0x0c),
                'v' => Some(0x0b),
                '"' => Some(0x22),
                '\\' => Some(0x5c),
                _ => None,
            };
            if let Some(byte) = simple {
                bytes.push(byte);
                i += 2;
                continue;
            }
            if next.is_digit(8) {
                let mut octal = String::new();
                let mut j = i + 1;
                while j < chars.len() && octal.len() < 3 && chars[j].is_digit(8) {
                    octal.push(chars[j]);
                    j += 1;
                }
                let value = u32::from_str_radix(&octal, 8).unwrap_or(0) & 0xff;
                bytes.push(value as u8);
                i += 1 + octal.len();
                continue;
            }
            push_char(&mut bytes, next);
            i += 2;
            continue;
        }
        push_char(&mut bytes, ch);
        i += 1;
    }
    (String::from_utf8_lossy(&bytes).into_owned(), i + 1)
}

fn push_char(bytes: &mut Vec<u8>, ch: char) {
    let mut buf = [0u8; 4];
    bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
}

fn unquote_field(chars: &[char]) -> String {
    if chars.first() == Some(&'"') {
        parse_c_quoted(chars).0
    } else {
        chars.iter().collect()
    }
}

/// Extract the display path (the new path) from the path field, accounting for renames (` -> `).
fn path_from_field(rest: &[char]) -> String {
    if rest.first() == Some(&'"') {
        let (value, end) = parse_c_quoted(rest);
        let remainder = &rest[end.min(rest.len())..];
        if starts_with_arrow(remainder) {
            return unquote_field(&remainder[4..]);
        }
        return value;
    }
    if let Some(idx) = find_arrow(rest) {
        return unquote_field(&rest[idx + 4..]);
    }
    rest.iter().collect()
}

/// Classify porcelain v1 into staged/changed. Classification rules:
/// - Non-empty X column (index) -> staged; non-empty Y column (worktree) -> changed
/// - `??` (untracked) becomes one entry on the changed side
/// - A rename `old -> new` takes the new path
/// - C-quoted paths are returned unquoted
pub fn parse_git_status(porcelain: &str) -> ParsedGitStatus {
    let mut staged = Vec::new();
    let mut changed = Vec::new();
    for line in porcelain.split('\n') {
        let chars: Vec<char> = line.chars().collect();
        if chars.len() < 4 {
            continue;
        }
        let x = chars[0];
        let y = chars[1];
        let path = path_from_field(&chars[3..]);
        if path.is_empty() {
            continue;
        }
        if x == '?' {
            changed.push(GitFileEntry {
                code: "??".to_string(),
                path,
            });
            continue;
        }
        if x != ' ' {
            staged.push(GitFileEntry {
                code: x.to_string(),
                path: path.clone(),
            });
        }
        if y != ' ' {
            changed.push(GitFileEntry {
                code: y.to_string(),
                path,
            });
        }
    }
    ParsedGitStatus { staged, changed }
}

/// Whether this is a Windows drive prefix (`^[A-Za-z]:[\\/]`).
fn has_windows_drive_prefix(file: &str) -> bool {
    let b = file.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// Whether the path is safe as a repo-relative path (a pure function guarding against path traversal).
/// Rejects absolute paths, `..`/`.` segments, empty segments, and NUL.
/// Allows a single trailing slash for an untracked directory (`dir/`).
pub fn is_safe_repo_relative_path(file: &str) -> bool {
    if file.is_empty() {
        return false;
    }
    if file.contains('\0') {
        return false;
    }
    if file.starts_with('/') {
        return false;
    }
    if has_windows_drive_prefix(file) {
        return false;
    }
    let trimmed = file.strip_suffix('/').unwrap_or(file);
    if trimmed.is_empty() {
        return false;
    }
    trimmed
        .split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// Whether the string is valid as a commit message (rejects empty or whitespace-only).
pub fn is_valid_commit_message(message: &str) -> bool {
    !message.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(code: &str, path: &str) -> GitFileEntry {
        GitFileEntry {
            code: code.to_string(),
            path: path.to_string(),
        }
    }

    fn status(staged: Vec<GitFileEntry>, changed: Vec<GitFileEntry>) -> ParsedGitStatus {
        ParsedGitStatus { staged, changed }
    }

    #[test]
    fn empty_input_is_empty() {
        assert_eq!(parse_git_status(""), status(vec![], vec![]));
        assert_eq!(parse_git_status("\n\n"), status(vec![], vec![]));
    }

    #[test]
    fn staged_only_a() {
        assert_eq!(
            parse_git_status("A  new.ts\n"),
            status(vec![entry("A", "new.ts")], vec![])
        );
    }

    #[test]
    fn changed_only_m() {
        assert_eq!(
            parse_git_status(" M lib/app.ts\n"),
            status(vec![], vec![entry("M", "lib/app.ts")])
        );
    }

    #[test]
    fn both_sides_mm() {
        assert_eq!(
            parse_git_status("MM both.ts\n"),
            status(vec![entry("M", "both.ts")], vec![entry("M", "both.ts")])
        );
    }

    #[test]
    fn untracked_goes_to_changed() {
        assert_eq!(
            parse_git_status("?? mem.md\n"),
            status(vec![], vec![entry("??", "mem.md")])
        );
    }

    #[test]
    fn untracked_directory_trailing_slash() {
        assert_eq!(
            parse_git_status("?? newdir/\n"),
            status(vec![], vec![entry("??", "newdir/")])
        );
    }

    #[test]
    fn rename_takes_new_path() {
        assert_eq!(
            parse_git_status("R  old.ts -> new.ts\n"),
            status(vec![entry("R", "new.ts")], vec![])
        );
    }

    #[test]
    fn rename_plus_worktree_change_rm() {
        assert_eq!(
            parse_git_status("RM src/a.ts -> src/b.ts\n"),
            status(vec![entry("R", "src/b.ts")], vec![entry("M", "src/b.ts")])
        );
    }

    #[test]
    fn deletion_staged_and_changed() {
        assert_eq!(
            parse_git_status("D  gone.ts\n D also.ts\n"),
            status(vec![entry("D", "gone.ts")], vec![entry("D", "also.ts")])
        );
    }

    #[test]
    fn submodule_like_normal_path() {
        assert_eq!(
            parse_git_status(" M vendor/submodule\n"),
            status(vec![], vec![entry("M", "vendor/submodule")])
        );
    }

    #[test]
    fn conflict_uu_both_sides() {
        assert_eq!(
            parse_git_status("UU conflict.ts\n"),
            status(
                vec![entry("U", "conflict.ts")],
                vec![entry("U", "conflict.ts")]
            )
        );
    }

    #[test]
    fn path_with_space_unquoted() {
        assert_eq!(
            parse_git_status(" M my file.txt\n"),
            status(vec![], vec![entry("M", "my file.txt")])
        );
    }

    #[test]
    fn japanese_path_raw_utf8() {
        assert_eq!(
            parse_git_status("?? メモ/日誌.md\n"),
            status(vec![], vec![entry("??", "メモ/日誌.md")])
        );
    }

    #[test]
    fn quoted_path_with_double_quote() {
        assert_eq!(
            parse_git_status("?? \"we \\\"quoted\\\".txt\"\n"),
            status(vec![], vec![entry("??", "we \"quoted\".txt")])
        );
    }

    #[test]
    fn quoted_path_newline_tab_escapes() {
        assert_eq!(
            parse_git_status("?? \"line\\nbreak\\tta.txt\"\n"),
            status(vec![], vec![entry("??", "line\nbreak\tta.txt")])
        );
    }

    #[test]
    fn quoted_path_octal_restored_as_utf8() {
        assert_eq!(
            parse_git_status("?? \"\\343\\203\\241\\343\\203\\242.md\"\n"),
            status(vec![], vec![entry("??", "メモ.md")])
        );
    }

    #[test]
    fn quoted_rename_both_sides() {
        assert_eq!(
            parse_git_status("R  \"old name.ts\" -> \"new name.ts\"\n"),
            status(vec![entry("R", "new name.ts")], vec![])
        );
    }

    #[test]
    fn quoted_old_path_containing_arrow_not_missplit() {
        assert_eq!(
            parse_git_status("R  \"a -> b.ts\" -> plain.ts\n"),
            status(vec![entry("R", "plain.ts")], vec![])
        );
    }

    #[test]
    fn multiline_mixed() {
        assert_eq!(
            parse_git_status("A  a.ts\n M b.ts\n?? c.ts\nD  d.ts\n"),
            status(
                vec![entry("A", "a.ts"), entry("D", "d.ts")],
                vec![entry("M", "b.ts"), entry("??", "c.ts")]
            )
        );
    }

    #[test]
    fn broken_short_lines_ignored() {
        assert_eq!(
            parse_git_status("M\n\nA  ok.ts\n"),
            status(vec![entry("A", "ok.ts")], vec![])
        );
    }

    #[test]
    fn safe_repo_relative_path_allows() {
        for p in [
            "a.ts",
            "dir/sub/a.ts",
            "newdir/",
            "日本語/ファイル.md",
            "-starts-with-dash.txt",
            "has space.txt",
            "we \"quoted\".txt",
            "line\nbreak.txt",
        ] {
            assert!(is_safe_repo_relative_path(p), "should allow {p:?}");
        }
    }

    #[test]
    fn safe_repo_relative_path_rejects() {
        for p in [
            "",
            "/abs/path.ts",
            "../escape.ts",
            "dir/../../escape.ts",
            "dir/..",
            "..",
            ".",
            "./a.ts",
            "dir//double.ts",
            "nul\0byte.ts",
            "C:\\windows\\path",
        ] {
            assert!(!is_safe_repo_relative_path(p), "should reject {p:?}");
        }
    }

    #[test]
    fn valid_commit_message_non_empty() {
        assert!(is_valid_commit_message("fix: bug"));
        assert!(is_valid_commit_message("日本語のコミット"));
        assert!(is_valid_commit_message("  前後空白あり  "));
    }

    #[test]
    fn valid_commit_message_blank_rejected() {
        assert!(!is_valid_commit_message(""));
        assert!(!is_valid_commit_message("   "));
        assert!(!is_valid_commit_message("\n\t "));
    }
}
