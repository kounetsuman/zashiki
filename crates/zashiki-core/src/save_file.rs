//! Parse/serialize the save/restore save file (`saves/last.tsv`).
//! The format is TSV of `widx\twname\tcwd\tsid`.

/// One line of the save file = one window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveEntry {
    /// Window ordinal (for display / compatibility; not used during restore).
    pub widx: String,
    pub wname: String,
    pub cwd: String,
    pub sid: String,
}

/// Whether it has the UUID shape (`8-4-4-4-12` hex with fixed dash positions). Uppercase is also allowed.
fn is_uuid_shape(b: &[u8]) -> bool {
    if b.len() != 36 {
        return false;
    }
    for (i, &c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if c != b'-' {
                    return false;
                }
            }
            _ => {
                if !c.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// Whether sid is in UUID format. Because the old cw jsonl fallback may save non-UUID values,
/// the restore side validates with this before passing to `claude --resume` (also a defense against
/// mixing arbitrary strings into literal keystrokes sent to the shell). Must match `^UUID$` exactly
/// (no surplus before or after).
pub fn is_uuid_sid(sid: &str) -> bool {
    is_uuid_shape(sid.as_bytes())
}

/// Parses the save file. Broken lines (fewer than 4 columns, empty cwd/sid) are skipped, and
/// surplus columns are ignored (the same leniency as how cw-restore reads it).
pub fn parse_save_file(text: &str) -> Vec<SaveEntry> {
    let mut entries = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 4 {
            continue;
        }
        let (widx, wname, cwd, sid) = (fields[0], fields[1], fields[2], fields[3]);
        if cwd.is_empty() || sid.is_empty() {
            continue;
        }
        entries.push(SaveEntry {
            widx: widx.to_string(),
            wname: wname.to_string(),
            cwd: cwd.to_string(),
            sid: sid.to_string(),
        });
    }
    entries
}

/// Keeps tabs and newlines out of fields (prevents format corruption):
/// collapses each run of tab/nl/cr (`[\t\n\r]+`) into a single space.
fn sanitize_field(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if c == '\t' || c == '\n' || c == '\r' {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// Renders back into `last.tsv`-compatible TSV (a newline at the end of each line).
pub fn serialize_save_file(entries: &[SaveEntry]) -> String {
    let mut out = String::new();
    for e in entries {
        out.push_str(&sanitize_field(&e.widx));
        out.push('\t');
        out.push_str(&sanitize_field(&e.wname));
        out.push('\t');
        out.push_str(&sanitize_field(&e.cwd));
        out.push('\t');
        out.push_str(&sanitize_field(&e.sid));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(widx: &str, wname: &str, cwd: &str, sid: &str) -> SaveEntry {
        SaveEntry {
            widx: widx.to_string(),
            wname: wname.to_string(),
            cwd: cwd.to_string(),
            sid: sid.to_string(),
        }
    }

    #[test]
    fn parse_basic() {
        assert_eq!(
            parse_save_file(
                "1\twhiskey:579f\t/Users/u/workspace/whiskey\t579fa8cf-4901-45cb-b9ec-17e229231a37\n"
            ),
            vec![entry(
                "1",
                "whiskey:579f",
                "/Users/u/workspace/whiskey",
                "579fa8cf-4901-45cb-b9ec-17e229231a37"
            )]
        );
    }

    #[test]
    fn parse_multiline_no_trailing_newline() {
        assert_eq!(
            parse_save_file(
                "1\ta\t/tmp/a\t11111111-1111-1111-1111-111111111111\n2\tb\t/tmp/b\t22222222-2222-2222-2222-222222222222"
            ),
            vec![
                entry("1", "a", "/tmp/a", "11111111-1111-1111-1111-111111111111"),
                entry("2", "b", "/tmp/b", "22222222-2222-2222-2222-222222222222"),
            ]
        );
    }

    #[test]
    fn parse_skips_blank_lines() {
        assert_eq!(
            parse_save_file("\n1\ta\t/tmp/a\t11111111-1111-1111-1111-111111111111\n\n   \n"),
            vec![entry(
                "1",
                "a",
                "/tmp/a",
                "11111111-1111-1111-1111-111111111111"
            )]
        );
    }

    #[test]
    fn parse_skips_short_lines() {
        assert_eq!(
            parse_save_file(
                "1\ta\t/tmp/a\nbroken line\n2\tb\t/tmp/b\t22222222-2222-2222-2222-222222222222\n"
            ),
            vec![entry(
                "2",
                "b",
                "/tmp/b",
                "22222222-2222-2222-2222-222222222222"
            )]
        );
    }

    #[test]
    fn parse_skips_empty_sid() {
        assert_eq!(
            parse_save_file("1\ta\t/tmp/a\t\n2\tb\t/tmp/b\t22222222-2222-2222-2222-222222222222\n"),
            vec![entry(
                "2",
                "b",
                "/tmp/b",
                "22222222-2222-2222-2222-222222222222"
            )]
        );
    }

    #[test]
    fn parse_skips_empty_cwd() {
        assert_eq!(
            parse_save_file("1\ta\t\t11111111-1111-1111-1111-111111111111\n"),
            Vec::<SaveEntry>::new()
        );
    }

    #[test]
    fn parse_ignores_extra_columns() {
        assert_eq!(
            parse_save_file("1\ta\t/tmp/a\t11111111-1111-1111-1111-111111111111\textra\tmore\n"),
            vec![entry(
                "1",
                "a",
                "/tmp/a",
                "11111111-1111-1111-1111-111111111111"
            )]
        );
    }

    #[test]
    fn parse_keeps_non_uuid_sid() {
        assert_eq!(
            parse_save_file("5\tdelta:03f2\t/tmp/x\tworkspace\n"),
            vec![entry("5", "delta:03f2", "/tmp/x", "workspace")]
        );
    }

    #[test]
    fn parse_empty_input() {
        assert_eq!(parse_save_file(""), Vec::<SaveEntry>::new());
    }

    #[test]
    fn serialize_tsv_with_trailing_newline() {
        let entries = vec![
            entry(
                "1",
                "whiskey",
                "/tmp/whiskey",
                "11111111-1111-1111-1111-111111111111",
            ),
            entry(
                "2",
                "delta",
                "/tmp/delta",
                "22222222-2222-2222-2222-222222222222",
            ),
        ];
        assert_eq!(
            serialize_save_file(&entries),
            "1\twhiskey\t/tmp/whiskey\t11111111-1111-1111-1111-111111111111\n\
             2\tdelta\t/tmp/delta\t22222222-2222-2222-2222-222222222222\n"
        );
    }

    #[test]
    fn serialize_empty() {
        assert_eq!(serialize_save_file(&[]), "");
    }

    #[test]
    fn serialize_collapses_tabs_and_newlines() {
        let out = serialize_save_file(&[entry(
            "1",
            "bad\tname\nx",
            "/tmp/a",
            "11111111-1111-1111-1111-111111111111",
        )]);
        assert_eq!(
            out,
            "1\tbad name x\t/tmp/a\t11111111-1111-1111-1111-111111111111\n"
        );
    }

    #[test]
    fn round_trips_with_parse() {
        let entries = vec![entry(
            "1",
            "a:b8b0",
            "/tmp/a",
            "11111111-1111-1111-1111-111111111111",
        )];
        assert_eq!(parse_save_file(&serialize_save_file(&entries)), entries);
    }

    #[test]
    fn uuid_sid_cases() {
        assert!(is_uuid_sid("579fa8cf-4901-45cb-b9ec-17e229231a37"));
        assert!(is_uuid_sid("579FA8CF-4901-45CB-B9EC-17E229231A37"));
        assert!(!is_uuid_sid("workspace"));
        assert!(!is_uuid_sid(""));
        assert!(!is_uuid_sid("11111111-1111-1111-1111-11111111111"));
        assert!(!is_uuid_sid("x; rm -rf /"));
    }
}
