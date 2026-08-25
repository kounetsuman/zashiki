import { Fragment } from "react";

import {
  type InlineSpan,
  type MarkdownBlock,
  parseMarkdownBlocks,
  splitHighlight,
} from "./help-model.js";
import "./MarkdownView.css";

// What is rendered is immutable, static content that is just content/*.md parsed, with no
// reordering or insertion. So using the index as a key does not mix up element state.

/** Wraps case-insensitive `query` occurrences in `text` with a highlight mark. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((seg, i) =>
        seg.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional segments, re-derived each render
          <mark key={i} className="help-md-mark">
            {seg.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional segments, re-derived each render
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

function Inline({ spans, query }: { spans: InlineSpan[]; query: string }) {
  return (
    <>
      {spans.map((s, i) =>
        s.kind === "code" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
          <code key={i} className="help-md-code">
            <Highlighted text={s.text} query={query} />
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
          <span key={i}>
            <Highlighted text={s.text} query={query} />
          </span>
        ),
      )}
    </>
  );
}

function Block({ block, query }: { block: MarkdownBlock; query: string }) {
  switch (block.kind) {
    case "heading":
      return block.level === 1 ? (
        <h3 className="help-md-h1">
          <Inline spans={block.spans} query={query} />
        </h3>
      ) : (
        <h4 className="help-md-h2">
          <Inline spans={block.spans} query={query} />
        </h4>
      );
    case "paragraph":
      return (
        <p className="help-md-p">
          <Inline spans={block.spans} query={query} />
        </p>
      );
    case "list":
      return (
        <ul className="help-md-ul">
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
            <li key={i}>
              <Inline spans={item} query={query} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="help-md-pre">
          <code>
            <Highlighted text={block.text} query={query} />
          </code>
        </pre>
      );
  }
}

/** Renders help body text (lightweight markdown), highlighting `query` occurrences when set. */
export function MarkdownView({
  source,
  query = "",
}: {
  source: string;
  query?: string;
}) {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div className="help-md">
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static content, no reordering
        <Block key={i} block={b} query={query} />
      ))}
    </div>
  );
}
