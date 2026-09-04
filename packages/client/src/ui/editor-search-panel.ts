import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { Prec } from "@codemirror/state";
import type { EditorView, Panel } from "@codemirror/view";

import i18n from "../i18n/index.js";
import { matchLabel, matchStats } from "../lib/editor-search.js";

/** All query hit ranges in document order for the current search query (empty when the query is invalid). */
function matchRanges(view: EditorView): { from: number; to: number }[] {
  const query = getSearchQuery(view.state);
  if (!query.valid) return [];
  const cursor = query.getCursor(view.state);
  const ranges: { from: number; to: number }[] = [];
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    ranges.push({ from: step.value.from, to: step.value.to });
  }
  return ranges;
}

function iconButton(
  icon: string,
  tooltip: string,
  className: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = tooltip;
  button.setAttribute("aria-label", tooltip);
  const glyph = document.createElement("span");
  glyph.className = "material-symbols-outlined";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = icon;
  button.append(glyph);
  return button;
}

/**
 * A compact, VSCode-style find/replace panel for CodeMirror editors, floated top-right. Shared by the
 * Memo and clipboard editors. All state reads and writes go through @codemirror/search, so the panel
 * stays in sync with the Cmd+F / Enter / Escape keymap rather than tracking its own copy of the query.
 */
function createEditorSearchPanel(view: EditorView): Panel {
  const t = (key: string) => i18n.t(`find.${key}`);
  const initial = getSearchQuery(view.state);
  const flags = {
    caseSensitive: initial.caseSensitive,
    wholeWord: initial.wholeWord,
    regexp: initial.regexp,
  };

  const dom = document.createElement("div");
  dom.className = "cm-find";
  dom.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // Closing the panel is the whole intent of Escape here; don't let it also bubble to an outer
      // dismiss handler (e.g. the clipboard-edit dialog closing on Escape).
      event.stopPropagation();
      closeSearchPanel(view);
      view.focus();
    }
  });

  const toggleReplace = iconButton(
    "chevron_right",
    t("toggleReplace"),
    "cm-find-expand",
  );
  toggleReplace.setAttribute("aria-expanded", "false");

  const rows = document.createElement("div");
  rows.className = "cm-find-rows";

  const findRow = document.createElement("div");
  findRow.className = "cm-find-row";

  const findField = document.createElement("div");
  findField.className = "cm-find-field";

  const findInput = document.createElement("input");
  findInput.type = "text";
  findInput.className = "cm-find-input";
  findInput.placeholder = t("placeholder");
  findInput.setAttribute("aria-label", t("placeholder"));
  findInput.setAttribute("main-field", "true");
  findInput.value = initial.search;

  const toggles = document.createElement("div");
  toggles.className = "cm-find-toggles";

  const caseToggle = iconButton("match_case", t("matchCase"), "cm-find-toggle");
  const wordToggle = iconButton("match_word", t("wholeWord"), "cm-find-toggle");
  const regexpToggle = iconButton(
    "regular_expression",
    t("regexp"),
    "cm-find-toggle",
  );
  toggles.append(caseToggle, wordToggle, regexpToggle);

  findField.append(findInput, toggles);

  const count = document.createElement("span");
  count.className = "cm-find-count";
  count.setAttribute("aria-live", "polite");

  const previous = iconButton(
    "keyboard_arrow_up",
    t("previous"),
    "cm-find-btn",
  );
  const next = iconButton("keyboard_arrow_down", t("next"), "cm-find-btn");
  const close = iconButton("close", t("close"), "cm-find-btn");

  findRow.append(findField, count, previous, next, close);

  const replaceRow = document.createElement("div");
  replaceRow.className = "cm-find-row cm-find-replace-row";

  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.className = "cm-find-input";
  replaceInput.placeholder = t("replacePlaceholder");
  replaceInput.setAttribute("aria-label", t("replacePlaceholder"));
  replaceInput.value = initial.replace;

  const replaceField = document.createElement("div");
  replaceField.className = "cm-find-field";
  replaceField.append(replaceInput);

  const replaceOne = iconButton("find_replace", t("replace"), "cm-find-btn");
  const replaceEvery = iconButton(
    "published_with_changes",
    t("replaceAll"),
    "cm-find-btn",
  );

  replaceRow.append(replaceField, replaceOne, replaceEvery);

  rows.append(findRow, replaceRow);
  dom.append(toggleReplace, rows);

  function buildQuery(): SearchQuery {
    return new SearchQuery({
      search: findInput.value,
      replace: replaceInput.value,
      caseSensitive: flags.caseSensitive,
      wholeWord: flags.wholeWord,
      regexp: flags.regexp,
    });
  }

  function commit(): void {
    view.dispatch({ effects: setSearchQuery.of(buildQuery()) });
  }

  function incrementalFind(): void {
    const query = buildQuery();
    const effects = setSearchQuery.of(query);
    // A done cursor still exposes a stale {from:0,to:0} on `.value`, so gate on `.done`.
    const firstFrom = (from: number) => {
      const step = query.getCursor(view.state, from).next();
      return step.done ? null : step.value;
    };
    // selection.from (not .to): a refined query that still matches here stays put rather than jumping.
    const origin = view.state.selection.main.from;
    const match = query.valid ? (firstFrom(origin) ?? firstFrom(0)) : null;
    if (match)
      view.dispatch({
        effects,
        selection: { anchor: match.from, head: match.to },
        scrollIntoView: true,
      });
    else view.dispatch({ effects });
  }

  function syncToggles(): void {
    for (const [button, on] of [
      [caseToggle, flags.caseSensitive],
      [wordToggle, flags.wholeWord],
      [regexpToggle, flags.regexp],
    ] as const) {
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-pressed", String(on));
    }
  }

  function bindToggle(
    button: HTMLButtonElement,
    key: keyof typeof flags,
  ): void {
    button.addEventListener("click", () => {
      flags[key] = !flags[key];
      syncToggles();
      incrementalFind();
      findInput.focus();
    });
  }

  bindToggle(caseToggle, "caseSensitive");
  bindToggle(wordToggle, "wholeWord");
  bindToggle(regexpToggle, "regexp");

  findInput.addEventListener("input", incrementalFind);
  findInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey) findPrevious(view);
    else findNext(view);
  });

  replaceInput.addEventListener("input", commit);
  replaceInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    replaceNext(view);
  });

  previous.addEventListener("click", () => findPrevious(view));
  next.addEventListener("click", () => findNext(view));
  close.addEventListener("click", () => {
    closeSearchPanel(view);
    view.focus();
  });
  replaceOne.addEventListener("click", () => replaceNext(view));
  replaceEvery.addEventListener("click", () => replaceAll(view));

  toggleReplace.addEventListener("click", () => {
    const expanded = dom.classList.toggle("is-replace-open");
    toggleReplace.setAttribute("aria-expanded", String(expanded));
    if (expanded) replaceInput.focus();
    else findInput.focus();
  });

  function refreshCount(): void {
    const query = getSearchQuery(view.state);
    const main = view.state.selection.main;
    const stats = matchStats(matchRanges(view), {
      from: main.from,
      to: main.to,
    });
    count.textContent = matchLabel(query.search, stats, t("noMatches"));
    count.classList.toggle(
      "is-empty",
      query.search.length > 0 && stats.total === 0,
    );
  }

  syncToggles();

  return {
    dom,
    top: true,
    mount() {
      refreshCount();
    },
    update(update) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(setSearchQuery)),
        )
      ) {
        refreshCount();
      }
    },
  };
}

/** The find/replace extension: replaces CodeMirror's default panel with the compact top-right widget. */
export function editorSearch() {
  return Prec.high(search({ top: true, createPanel: createEditorSearchPanel }));
}
