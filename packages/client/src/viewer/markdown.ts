import MarkdownIt from "markdown-it";

type Markdown = InstanceType<typeof MarkdownIt>;

const TASK_MARKER = /^\[([ xX])\][ \u00A0]/;

const taskLists = (md: Markdown) => {
  md.core.ruler.after("inline", "task-list-items", (state) => {
    const { tokens } = state;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      const paragraph = tokens[i - 1];
      const listItem = tokens[i - 2];
      if (
        inline?.type !== "inline" ||
        paragraph?.type !== "paragraph_open" ||
        listItem?.type !== "list_item_open"
      ) {
        continue;
      }
      const match = TASK_MARKER.exec(inline.content);
      if (!match) continue;

      const checked = match[1] !== " ";
      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${
        checked ? " checked" : ""
      }>`;

      const firstText = inline.children?.[0];
      if (firstText?.type === "text") {
        firstText.content = firstText.content.replace(TASK_MARKER, "");
      }
      inline.content = inline.content.replace(TASK_MARKER, "");
      inline.children?.unshift(checkbox);

      listItem.attrJoin("class", "task-list-item");
    }
  });
};

const mermaidFences = (md: Markdown) => {
  const defaultFence =
    md.renderer.rules.fence ??
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token === undefined)
      return defaultFence(tokens, idx, options, env, self);
    const language = token.info.trim().split(/\s+/)[0]?.toLowerCase();
    if (language !== "mermaid")
      return defaultFence(tokens, idx, options, env, self);
    return `<div class="viewer-mermaid"><pre><code class="language-mermaid">${md.utils.escapeHtml(
      token.content,
    )}</code></pre></div>\n`;
  };
};

const REPO_BASE = "http://repo.invalid/";
const REPO_ORIGIN = new URL(REPO_BASE).origin;
const INERT_SCHEMES = new Set(["data:", "blob:"]);

/**
 * The host an image source would be fetched from when it lies outside the repo, or null for a
 * repo path or an inline (`data:` / `blob:`) image. Resolves the way the browser does, so
 * forms such as `//host` and `/\host` count as remote; an unparsable source counts as remote.
 */
export function remoteImageHost(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src, REPO_BASE);
  } catch {
    return "";
  }
  if (INERT_SCHEMES.has(url.protocol)) return null;
  if (url.origin === REPO_ORIGIN) return null;
  return url.host || url.protocol;
}

export interface RenderMarkdownOptions {
  /** Remote image sources the user has asked to load; every other remote image stays a button. */
  loadedRemoteImages?: ReadonlySet<string>;
  /** Tooltip of a remote image's load button, which otherwise shows the source URL. */
  remoteImageLabel?: (host: string) => string;
}

const remoteImages = (md: Markdown) => {
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = String(token?.attrGet("src") ?? "");
    const host = remoteImageHost(src);
    const { loadedRemoteImages, remoteImageLabel } = (env ??
      {}) as RenderMarkdownOptions;
    if (
      token === undefined ||
      host === null ||
      loadedRemoteImages?.has(src) === true
    ) {
      return defaultImage
        ? defaultImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
    }
    const { escapeHtml } = md.utils;
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    const title = remoteImageLabel?.(host) ?? src;
    return `<button type="button" class="viewer-remote-image" data-remote-src="${escapeHtml(src)}" title="${escapeHtml(title)}"><span class="material-symbols-outlined" aria-hidden="true">image</span><span class="viewer-remote-image-alt">${escapeHtml(
      alt,
    )}</span><span class="viewer-remote-image-host">${escapeHtml(host)}</span></button>`;
  };
};

const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})
  .use(taskLists)
  .use(mermaidFences)
  .use(remoteImages);

export function renderMarkdown(
  source: string,
  options: RenderMarkdownOptions = {},
): string {
  return renderer.render(source, { ...options });
}
