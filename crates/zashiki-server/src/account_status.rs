//! The signed-in Claude account, read from `claude auth status --json`.
//!
//! Claude Code auth is global per OS user (a single macOS Keychain item + `~/.claude.json`), so this
//! one reading reflects every session at once. The source of truth for the parse is the `tests` below.

use serde::Deserialize;

use crate::protocol::ServerMessage;

/// The signed-in account. `email` is `None` when not signed in or when the status could not be read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountStatus {
    pub logged_in: bool,
    pub email: Option<String>,
}

impl AccountStatus {
    pub fn to_message(&self) -> ServerMessage {
        ServerMessage::AccountStatus {
            logged_in: self.logged_in,
            email: self.email.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStatus {
    #[serde(default)]
    logged_in: bool,
    #[serde(default)]
    email: Option<String>,
}

/// Parses `claude auth status --json` output. Anything unparsable, or a blank email, yields a
/// logged-out reading (the indicator falls back to "not signed in").
pub fn parse_account_status(json: &str) -> AccountStatus {
    match serde_json::from_str::<RawStatus>(json) {
        Ok(raw) => AccountStatus {
            logged_in: raw.logged_in,
            email: raw.email.filter(|s| !s.is_empty()),
        },
        Err(_) => AccountStatus::default(),
    }
}

/// Runs `claude auth status --json` and parses stdout. Any failure (claude missing, spawn error) is a
/// logged-out reading; the command is read-only and local, so it returns promptly.
pub async fn read_account_status(claude_program: &str) -> AccountStatus {
    match tokio::process::Command::new(claude_program)
        .args(["auth", "status", "--json"])
        .output()
        .await
    {
        Ok(out) => parse_account_status(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => AccountStatus::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_signed_in_status() {
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"user@example.com","subscriptionType":"max"}"#;
        assert_eq!(
            parse_account_status(json),
            AccountStatus {
                logged_in: true,
                email: Some("user@example.com".into()),
            }
        );
    }

    #[test]
    fn treats_signed_out_and_blank_email_as_logged_out() {
        assert_eq!(
            parse_account_status(r#"{"loggedIn":false}"#),
            AccountStatus { logged_in: false, email: None }
        );
        assert_eq!(
            parse_account_status(r#"{"loggedIn":true,"email":""}"#),
            AccountStatus { logged_in: true, email: None }
        );
    }

    #[test]
    fn unparsable_output_is_logged_out() {
        assert_eq!(parse_account_status(""), AccountStatus::default());
        assert_eq!(parse_account_status("not json"), AccountStatus::default());
    }
}
