// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  summarizeUnsaved,
  UnsavedChangesBar,
  UnsavedChangesProvider,
  UnsavedField,
} from "./unsaved-changes.js";

afterEach(cleanup);

describe("summarizeUnsaved", () => {
  it("counts only dirty fields and touches only them on save/discard", () => {
    const saveA = vi.fn();
    const saveB = vi.fn();
    const discardA = vi.fn();
    const discardB = vi.fn();
    const summary = summarizeUnsaved(
      new Map([
        ["a", { dirty: true, save: saveA, discard: discardA }],
        ["b", { dirty: false, save: saveB, discard: discardB }],
      ]),
    );

    expect(summary.dirtyCount).toBe(1);
    summary.saveAll();
    expect(saveA).toHaveBeenCalledOnce();
    expect(saveB).not.toHaveBeenCalled();
    summary.discardAll();
    expect(discardA).toHaveBeenCalledOnce();
    expect(discardB).not.toHaveBeenCalled();
  });
});

/** A field whose draft starts equal to `initial` and is edited through a text box. */
function Field({
  id,
  initial,
  onSave,
}: {
  id: string;
  initial: string;
  onSave(value: string): void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <input
        aria-label={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <UnsavedField
        id={id}
        dirty={draft !== initial}
        save={() => onSave(draft)}
        discard={() => setDraft(initial)}
      />
    </>
  );
}

describe("UnsavedChangesBar", () => {
  it("stays hidden until a field is dirty, then saves or discards every dirty field", () => {
    const onSave = vi.fn();
    render(
      <UnsavedChangesProvider>
        <Field id="one" initial="a" onSave={onSave} />
        <Field id="two" initial="b" onSave={onSave} />
        <UnsavedChangesBar />
      </UnsavedChangesProvider>,
    );

    expect(screen.queryByText("編集が保存されていません")).toBeNull();

    fireEvent.change(screen.getByLabelText("one"), { target: { value: "a1" } });
    fireEvent.change(screen.getByLabelText("two"), { target: { value: "b1" } });
    expect(screen.getByText("編集が保存されていません")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "すべて保存" }));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenCalledWith("a1");
    expect(onSave).toHaveBeenCalledWith("b1");
  });

  it("discards edits and hides once every field is clean again", () => {
    render(
      <UnsavedChangesProvider>
        <Field id="one" initial="a" onSave={vi.fn()} />
        <UnsavedChangesBar />
      </UnsavedChangesProvider>,
    );

    const box = screen.getByLabelText("one") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "edited" } });
    expect(screen.getByText("編集が保存されていません")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "破棄" }));
    expect(box.value).toBe("a");
    expect(screen.queryByText("編集が保存されていません")).toBeNull();
  });
});
