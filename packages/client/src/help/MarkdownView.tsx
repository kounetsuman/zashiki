import {
  type InlineSpan,
  type MarkdownBlock,
  parseMarkdownBlocks,
} from "./help-model.js";
import "./MarkdownView.css";

// What is rendered is immutable, static content that is just content/*.md parsed, with no
// reordering or insertion. So using the index as a key does not mix up element state.

function Inline({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.kind === "code" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
          <code key={i} className="help-md-code">
            {s.text}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case "heading":
      return block.level === 1 ? (
        <h3 className="help-md-h1">
          <Inline spans={block.spans} />
        </h3>
      ) : (
        <h4 className="help-md-h2">
          <Inline spans={block.spans} />
        </h4>
      );
    case "paragraph":
      return (
        <p className="help-md-p">
          <Inline spans={block.spans} />
        </p>
      );
    case "list":
      return (
        <ul className="help-md-ul">
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
            <li key={i}>
              <Inline spans={item} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="help-md-pre">
          <code>{block.text}</code>
        </pre>
      );
  }
}

/** Renders help body text (lightweight markdown). */
export function MarkdownView({ source }: { source: string }) {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div className="help-md">
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
