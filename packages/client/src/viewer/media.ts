/** How the Viewer renders a file: as an image, a video, audio, a font sample, a PDF, or (null) as text via CodeMirror. */
export type MediaKind = "image" | "video" | "audio" | "font" | "pdf";

/**
 * Each media extension, the kind it renders as, and its content type. Audio is the case `/api/media`
 * serves with these types (Opus is in an Ogg container); a file opened from the desktop shell carries
 * no type of its own, so the rest are needed there too.
 */
const MEDIA_TYPE_ROWS: readonly [string, MediaKind, string][] = [
  ["png", "image", "image/png"],
  ["jpg", "image", "image/jpeg"],
  ["jpeg", "image", "image/jpeg"],
  ["gif", "image", "image/gif"],
  ["webp", "image", "image/webp"],
  ["avif", "image", "image/avif"],
  ["bmp", "image", "image/bmp"],
  ["svg", "image", "image/svg+xml"],
  ["ico", "image", "image/x-icon"],
  ["mp4", "video", "video/mp4"],
  ["webm", "video", "video/webm"],
  ["mov", "video", "video/quicktime"],
  ["m4v", "video", "video/x-m4v"],
  ["ogv", "video", "video/ogg"],
  ["mp3", "audio", "audio/mpeg"],
  ["m4a", "audio", "audio/mp4"],
  ["aac", "audio", "audio/aac"],
  ["wav", "audio", "audio/wav"],
  ["aiff", "audio", "audio/aiff"],
  ["aif", "audio", "audio/aiff"],
  ["flac", "audio", "audio/flac"],
  ["ogg", "audio", "audio/ogg"],
  ["oga", "audio", "audio/ogg"],
  ["opus", "audio", "audio/ogg"],
  ["ttf", "font", "font/ttf"],
  ["otf", "font", "font/otf"],
  ["woff", "font", "font/woff"],
  ["woff2", "font", "font/woff2"],
  ["pdf", "pdf", "application/pdf"],
];

const MEDIA_TYPES = new Map(
  MEDIA_TYPE_ROWS.map(([ext, kind, contentType]) => [
    ext,
    { kind, contentType },
  ]),
);

/** Every extension {@link mediaKind} renders as media, for the desktop shell to hold such files as bytes. */
export const MEDIA_EXTENSIONS: readonly string[] = [...MEDIA_TYPES.keys()];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The media kind a file name maps to by extension, or null when it should be shown as text. */
export function mediaKind(name: string): MediaKind | null {
  return MEDIA_TYPES.get(extensionOf(name))?.kind ?? null;
}

/** The content type of a media file name, or undefined when it is not media. */
export function mediaContentType(name: string): string | undefined {
  return MEDIA_TYPES.get(extensionOf(name))?.contentType;
}

/**
 * The content type for an audio file name. A dropped File's own type is the browser's guess and can be
 * empty, which leaves the webview unable to play the extensionless blob URL.
 */
export function audioContentType(name: string): string | undefined {
  const media = MEDIA_TYPES.get(extensionOf(name));
  return media?.kind === "audio" ? media.contentType : undefined;
}
