//! Generates the launchd LaunchAgent plist (daemonization).
//!
//! Decision: KeepAlive on / RunAtLoad off (lazy launch when the app starts).
//! The source of truth for the plist is this pure function. The install script generates it by calling `zashiki-server print-plist`.

/// Values to embed in the plist. program is the absolute path to the Rust server binary.
pub struct PlistParams {
    pub label: String,
    pub program: String,
    pub env: Vec<(String, String)>,
    pub stdout_path: String,
    pub stderr_path: String,
    pub keep_alive: bool,
    pub run_at_load: bool,
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn bool_tag(b: bool) -> &'static str {
    if b {
        "<true/>"
    } else {
        "<false/>"
    }
}

/// Generates the LaunchAgent plist (XML).
pub fn plist_xml(p: &PlistParams) -> String {
    let mut env_block = String::new();
    if !p.env.is_empty() {
        env_block.push_str("    <key>EnvironmentVariables</key>\n    <dict>\n");
        for (k, v) in &p.env {
            env_block.push_str(&format!(
                "      <key>{}</key>\n      <string>{}</string>\n",
                xml_escape(k),
                xml_escape(v)
            ));
        }
        env_block.push_str("    </dict>\n");
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>{program}</string>
    </array>
    <key>KeepAlive</key>
    {keep_alive}
    <key>RunAtLoad</key>
    {run_at_load}
    <key>ProcessType</key>
    <string>Interactive</string>
{env_block}    <key>StandardOutPath</key>
    <string>{stdout_path}</string>
    <key>StandardErrorPath</key>
    <string>{stderr_path}</string>
  </dict>
</plist>
"#,
        label = xml_escape(&p.label),
        program = xml_escape(&p.program),
        keep_alive = bool_tag(p.keep_alive),
        run_at_load = bool_tag(p.run_at_load),
        env_block = env_block,
        stdout_path = xml_escape(&p.stdout_path),
        stderr_path = xml_escape(&p.stderr_path),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PlistParams {
        PlistParams {
            label: "io.github.kounetsuman.zashiki".to_string(),
            program: "/Applications/Zashiki.app/Contents/MacOS/zashiki-server".to_string(),
            env: vec![("ZK_PORT".to_string(), "8790".to_string())],
            stdout_path: "/Users/x/Library/Logs/zashiki-server.out.log".to_string(),
            stderr_path: "/Users/x/Library/Logs/zashiki-server.err.log".to_string(),
            keep_alive: true,
            run_at_load: false,
        }
    }

    #[test]
    fn plist_はkeepalive真_runatload偽_を出す() {
        let xml = plist_xml(&sample());
        // KeepAlive true / RunAtLoad false (decision: resident but not auto-loaded at startup)
        assert!(xml.contains("<key>KeepAlive</key>\n    <true/>"), "{xml}");
        assert!(xml.contains("<key>RunAtLoad</key>\n    <false/>"), "{xml}");
        assert!(xml.contains("<string>io.github.kounetsuman.zashiki</string>"));
        assert!(xml.contains("<string>/Applications/Zashiki.app/Contents/MacOS/zashiki-server</string>"));
    }

    #[test]
    fn plist_は環境変数dictを出す() {
        let xml = plist_xml(&sample());
        assert!(xml.contains("<key>EnvironmentVariables</key>"));
        assert!(xml.contains("<key>ZK_PORT</key>\n      <string>8790</string>"), "{xml}");
    }

    #[test]
    fn plist_は環境変数なしでdictを省く() {
        let mut p = sample();
        p.env.clear();
        let xml = plist_xml(&p);
        assert!(!xml.contains("EnvironmentVariables"), "{xml}");
    }

    #[test]
    fn plist_はxmlエスケープする() {
        let mut p = sample();
        p.env = vec![("K".to_string(), "a&b<c>".to_string())];
        let xml = plist_xml(&p);
        assert!(xml.contains("a&amp;b&lt;c&gt;"), "{xml}");
        assert!(!xml.contains("a&b<c>"));
    }
}
