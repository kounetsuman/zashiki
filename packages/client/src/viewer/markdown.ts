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

const WEB_LINK = /^https?:\/\//i;

/**
 * The desktop window refuses to leave the app in place, so a web link has to ask for a new window,
 * which the shell hands to the default browser.
 */
const webLinksInNewWindow = (md: Markdown) => {
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token !== undefined && WEB_LINK.test(token.attrGet("href") ?? "")) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
};

const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})
  .use(taskLists)
  .use(mermaidFences)
  .use(webLinksInNewWindow);

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}
