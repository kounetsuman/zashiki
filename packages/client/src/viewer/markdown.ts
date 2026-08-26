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

const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
}).use(taskLists);

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}
