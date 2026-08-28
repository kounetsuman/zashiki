//! Shell built-in pages (loading / error display).
//! Self-contained via a data: URL that needs no server (immediate window display and
//! visibility of failures; the foundation for a startup UX that does not block setup).

/// A minimal encoder that turns anything outside RFC 3986 unreserved into %XX (for data: URLs).
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn data_url(html: &str) -> String {
    format!("data:text/html;charset=utf-8,{}", percent_encode(html))
}

pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn page(body: &str) -> String {
    format!(
        r#"<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Zashiki</title><style>
body{{background:#1e2a1e;color:#f0ead6;font-family:-apple-system,'Hiragino Sans',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}}
main{{max-width:44rem;padding:2rem}}
h1{{font-size:1.2rem}}
pre{{background:#162016;padding:1rem;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:.85rem;line-height:1.5}}
.spinner{{width:28px;height:28px;border:3px solid #4a6b4a;border-top-color:#f0ead6;border-radius:50%;animation:s 1s linear infinite;margin-bottom:1rem}}
@keyframes s{{to{{transform:rotate(360deg)}}}}
</style></head><body><main>{body}</main></body></html>"#
    )
}

pub fn loading_html() -> String {
    page(
        r#"<div class="spinner"></div><h1>zashiki を起動しています…</h1><p>server の確認・起動とトークンの検証をしています（通常は数秒です）。</p>"#,
    )
}

pub fn error_html(message: &str) -> String {
    page(&format!(
        r#"<h1>zashiki を起動できませんでした</h1><pre>{}</pre><p>詳しい経過はシェルを起動したターミナルの stderr（[zashiki-shell] 行）にあります。対処後にこのウィンドウを閉じて、もう一度起動してください。</p>"#,
        escape_html(message)
    ))
}

/// JS that sends the WebView to `url` with `location.replace` so the splash is dropped from history
/// and can't be reached again by a back gesture. JSON-encoded so a quote-bearing `ZK_SHELL_URL`
/// override stays inside the string literal.
pub fn redirect_script(url: &str) -> String {
    format!(
        "location.replace({})",
        serde_json::to_string(url).expect("&str の JSON エンコードは失敗しない")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_はunreservedを素通しし他をエンコードする() {
        assert_eq!(percent_encode("Abc-123._~"), "Abc-123._~");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("#?%"), "%23%3F%25");
    }

    #[test]
    fn escape_html_はタグと引用符を無害化する() {
        assert_eq!(
            escape_html(r#"<script>"a"&'b'</script>"#),
            "&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;"
        );
    }

    #[test]
    fn data_url_はhtmlをdata_urlにする() {
        let url = data_url("<p>hi</p>");
        assert!(url.starts_with("data:text/html;charset=utf-8,"));
        assert!(url.contains("%3Cp%3Ehi%3C%2Fp%3E"));
        // It must parse through the URL parser as a data: URL (it is passed to WebviewUrl::External)
        assert!(url.parse::<tauri::Url>().is_ok());
    }

    #[test]
    fn error_html_はメッセージをエスケープして含める() {
        let html = error_html("<b>失敗 & 対処: `pnpm build`");
        assert!(html.contains("&lt;b&gt;失敗 &amp; 対処"));
        assert!(!html.contains("<b>失敗"));
    }

    #[test]
    fn loading_html_は起動中表示を含む() {
        assert!(loading_html().contains("起動しています"));
    }

    #[test]
    fn redirect_script_はlocation_replaceで飛ばす() {
        assert_eq!(
            redirect_script("http://127.0.0.1:8790/?token=abc123"),
            r#"location.replace("http://127.0.0.1:8790/?token=abc123")"#
        );
    }

    #[test]
    fn redirect_script_はjsメタ文字を含むurlをリテラル内に閉じ込める() {
        let js = redirect_script(r#"http://x/'");alert(1)//"#);
        assert_eq!(js, r#"location.replace("http://x/'\");alert(1)//")"#);
    }
}
