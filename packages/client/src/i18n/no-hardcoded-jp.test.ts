import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Mechanically guards against gaps in moving UI text into resources. Fails if Japanese is
// hardcoded in strings/templates/JSX text under src (= it should be extracted to ja.json and
// go through t()/Trans). Comments and JSDoc are out of scope since they do not appear as
// string nodes in the AST (Japanese comments for developers are allowed).

// Hiragana, katakana, CJK unified ideographs (including extension A), 々〆, half-width kana.
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿々〆ｦ-ﾟ]/;

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Excluded from scanning: tests, translation resources, type declarations. */
function isExcluded(path: string): boolean {
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx") ||
    path.endsWith(".d.ts") ||
    path.includes(`${join("i18n", "locales")}`)
  );
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !isExcluded(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Looks only at string, template, and JSX text nodes to catch hardcoded Japanese. */
function findViolations(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  const report = (node: ts.Node, raw: string): void => {
    if (!JAPANESE.test(raw)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({
      file: file.slice(SRC_ROOT.length + 1),
      line: line + 1,
      text: raw.trim().replace(/\s+/g, " ").slice(0, 60),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text);
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      report(node, node.text);
    } else if (ts.isJsxText(node)) {
      report(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

describe("no hardcoded Japanese remains in UI text", () => {
  it("no Japanese is hardcoded in strings/JSX under src (excluding tests and locales)", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const violations = files.flatMap(findViolations);
    const message = violations
      .map((v) => `  ${v.file}:${v.line}  「${v.text}」`)
      .join("\n");
    expect(violations, `日本語ハードコードが残っています:\n${message}`).toEqual(
      [],
    );
  });
});
