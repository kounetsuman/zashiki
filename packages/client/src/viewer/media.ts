/** How the Viewer renders a file: as an image, a video, audio, a font sample, a PDF, or (null) as text via CodeMirror. */
export type MediaKind = "image" | "video" | "audio" | "font" | "pdf";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
  "ico",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

/** Audio extensions and the content type `/api/media` serves them with (Opus is in an Ogg container). */
const AUDIO_CONTENT_TYPES = new Map([
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["wav", "audio/wav"],
  ["aiff", "audio/aiff"],
  ["aif", "audio/aiff"],
  ["flac", "audio/flac"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
]);

const FONT_EXTENSIONS = new Set(["ttf", "otf", "woff", "woff2"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The media kind a file name maps to by extension, or null when it should be shown as text. */
export function mediaKind(name: string): MediaKind | null {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_CONTENT_TYPES.has(ext)) return "audio";
  if (FONT_EXTENSIONS.has(ext)) return "font";
  if (ext === "pdf") return "pdf";
  return null;
}

/**
 * The content type for an audio file name. A dropped File's own type is the browser's guess and can be
 * empty, which leaves the webview unable to play the extensionless blob URL.
 */
export function audioContentType(name: string): string | undefined {
  return AUDIO_CONTENT_TYPES.get(extensionOf(name));
}
