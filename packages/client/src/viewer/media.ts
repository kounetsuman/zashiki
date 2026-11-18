/** How the Viewer renders a file: as an image, a video, audio, a PDF, or (null) as text via CodeMirror. */
export type MediaKind = "image" | "video" | "audio" | "pdf";

interface MediaType {
  readonly kind: MediaKind;
  readonly mime: string;
}

const MEDIA_TYPES: ReadonlyMap<string, MediaType> = new Map([
  ["png", { kind: "image", mime: "image/png" }],
  ["jpg", { kind: "image", mime: "image/jpeg" }],
  ["jpeg", { kind: "image", mime: "image/jpeg" }],
  ["gif", { kind: "image", mime: "image/gif" }],
  ["webp", { kind: "image", mime: "image/webp" }],
  ["avif", { kind: "image", mime: "image/avif" }],
  ["bmp", { kind: "image", mime: "image/bmp" }],
  ["svg", { kind: "image", mime: "image/svg+xml" }],
  ["ico", { kind: "image", mime: "image/x-icon" }],
  ["mp4", { kind: "video", mime: "video/mp4" }],
  ["webm", { kind: "video", mime: "video/webm" }],
  ["mov", { kind: "video", mime: "video/quicktime" }],
  ["m4v", { kind: "video", mime: "video/x-m4v" }],
  ["ogv", { kind: "video", mime: "video/ogg" }],
  ["mp3", { kind: "audio", mime: "audio/mpeg" }],
  ["m4a", { kind: "audio", mime: "audio/mp4" }],
  ["aac", { kind: "audio", mime: "audio/aac" }],
  ["wav", { kind: "audio", mime: "audio/wav" }],
  ["aiff", { kind: "audio", mime: "audio/aiff" }],
  ["aif", { kind: "audio", mime: "audio/aiff" }],
  ["flac", { kind: "audio", mime: "audio/flac" }],
  ["ogg", { kind: "audio", mime: "audio/ogg" }],
  ["oga", { kind: "audio", mime: "audio/ogg" }],
  ["opus", { kind: "audio", mime: "audio/ogg" }],
  ["caf", { kind: "audio", mime: "audio/x-caf" }],
  ["pdf", { kind: "pdf", mime: "application/pdf" }],
] satisfies [string, MediaType][]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The media kind a file name maps to by extension, or null when it should be shown as text. */
export function mediaKind(name: string): MediaKind | null {
  return MEDIA_TYPES.get(extensionOf(name))?.kind ?? null;
}

/** The MIME type `/api/media` serves a media file as, or "" when the name is not media. */
export function mediaMime(name: string): string {
  return MEDIA_TYPES.get(extensionOf(name))?.mime ?? "";
}
