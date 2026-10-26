//! The file types `/api/media` is willing to serve, mirroring the client's `viewer/media.ts`.

/// A servable media type: the `Content-Type` we send, and whether it is a PDF (rendered by the
/// WebView's PDF viewer rather than as an `<img>` / `<video>` subresource).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaType {
    pub content_type: &'static str,
    pub is_pdf: bool,
}

impl MediaType {
    pub fn mime(&self) -> mime::Mime {
        self.content_type
            .parse()
            .expect("MEDIA_TYPES holds only valid MIME types")
    }
}

const fn media(content_type: &'static str) -> MediaType {
    MediaType {
        content_type,
        is_pdf: false,
    }
}

const PDF: MediaType = MediaType {
    content_type: "application/pdf",
    is_pdf: true,
};

const MEDIA_TYPES: &[(&str, MediaType)] = &[
    ("png", media("image/png")),
    ("jpg", media("image/jpeg")),
    ("jpeg", media("image/jpeg")),
    ("gif", media("image/gif")),
    ("webp", media("image/webp")),
    ("avif", media("image/avif")),
    ("bmp", media("image/bmp")),
    ("svg", media("image/svg+xml")),
    ("ico", media("image/x-icon")),
    ("mp4", media("video/mp4")),
    ("webm", media("video/webm")),
    ("mov", media("video/quicktime")),
    ("m4v", media("video/x-m4v")),
    ("ogv", media("video/ogg")),
    ("pdf", PDF),
];

/// The media type for a file name by its (case-insensitive) extension, or None when it is not media.
/// The extension is whatever follows the last `.`, as on the client, so `.png` is a PNG.
pub fn media_type_for(file: &str) -> Option<MediaType> {
    let (_, ext) = file.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    MEDIA_TYPES
        .iter()
        .find(|(known, _)| *known == ext)
        .map(|(_, media_type)| *media_type)
}

/// CSP for non-PDF media: inert for `<img>` / `<video>`, and stops an SVG opened as a page from
/// running script or loading anything. PDFs get no CSP because a sandboxed document cannot host
/// the WebView's PDF viewer plugin.
pub const MEDIA_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_image_video_and_pdf_extensions() {
        assert_eq!(
            media_type_for("logo.png").unwrap().content_type,
            "image/png"
        );
        assert_eq!(
            media_type_for("a/b/photo.JPG").unwrap().content_type,
            "image/jpeg"
        );
        assert_eq!(
            media_type_for("icon.svg").unwrap().content_type,
            "image/svg+xml"
        );
        assert_eq!(
            media_type_for("clip.mov").unwrap().content_type,
            "video/quicktime"
        );
        assert_eq!(media_type_for("doc.pdf"), Some(PDF));
        assert!(!media_type_for("clip.mp4").unwrap().is_pdf);
    }

    #[test]
    fn every_content_type_is_a_valid_mime() {
        for (ext, media_type) in MEDIA_TYPES {
            assert_eq!(media_type.mime().as_ref(), media_type.content_type, "{ext}");
        }
    }

    #[test]
    fn treats_dot_named_files_by_their_extension_like_the_client() {
        assert_eq!(media_type_for(".png").unwrap().content_type, "image/png");
        assert_eq!(
            media_type_for("assets/.mp4").unwrap().content_type,
            "video/mp4"
        );
    }

    #[test]
    fn rejects_non_media_and_extensionless_names() {
        for name in [
            "index.html",
            "page.htm",
            "app.js",
            "data.json",
            "README.md",
            "Makefile",
            "dir/",
            "v1.2/LICENSE",
            "",
        ] {
            assert_eq!(media_type_for(name), None, "{name}");
        }
    }

    #[test]
    fn covers_every_extension_the_client_treats_as_media() {
        let client = include_str!("../../../packages/client/src/viewer/media.ts");
        for (ext, _) in MEDIA_TYPES {
            assert!(
                client.contains(&format!("\"{ext}\"")),
                "{ext} missing on the client"
            );
        }
        let client_exts = client
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()))
            .filter(|s| !matches!(*s, "image" | "video"))
            .collect::<Vec<_>>();
        for ext in client_exts {
            assert!(
                MEDIA_TYPES.iter().any(|(known, _)| *known == ext),
                "{ext} is media on the client but not served"
            );
        }
    }
}
