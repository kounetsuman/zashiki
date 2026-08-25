// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrgNotesEditor } from "./OrgNotesEditor.js";

afterEach(cleanup);

describe("OrgNotesEditor", () => {
  it("reloads the draft on org switch even when both notes are identical (no cross-org clobber)", () => {
    const onSave = vi.fn();
    render(
      <OrgNotesEditor
        orgs={["a", "b"]}
        notes={{ a: "same", b: "same" }}
        aliases={{}}
        onSave={onSave}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("same");

    // Unsaved edit to org "a".
    fireEvent.change(textarea, { target: { value: "edited-A" } });
    expect(textarea.value).toBe("edited-A");

    // Switching to "b" must reload b's stored note, not carry a's unsaved edit over — even though
    // both stored notes are the same string (a value-only reload would miss this switch).
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "same",
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSave).toHaveBeenCalledWith("b", "same");
  });

  it("does not clobber an in-progress edit when a notes.sync arrives for the selected org", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <OrgNotesEditor
        orgs={["a"]}
        notes={{ a: "orig" }}
        aliases={{}}
        onSave={onSave}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "typing" } });

    // A notes.sync for the same org (own-save echo or external edit) updates the note prop.
    rerender(
      <OrgNotesEditor
        orgs={["a"]}
        notes={{ a: "orig-edited-elsewhere" }}
        aliases={{}}
        onSave={onSave}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "typing",
    );
  });

  it("saves the selected org's edited note", () => {
    const onSave = vi.fn();
    render(
      <OrgNotesEditor orgs={["a"]} notes={{}} aliases={{}} onSave={onSave} />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "# hi" },
    });
    fireEvent.click(screen.getByRole("button"));
    expect(onSave).toHaveBeenCalledWith("a", "# hi");
  });

  it("renders a live Markdown preview of the draft", () => {
    render(
      <OrgNotesEditor
        orgs={["a"]}
        notes={{ a: "" }}
        aliases={{}}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("ここにプレビューが表示されます")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "# Hello\n\nbody text" },
    });
    expect(screen.getByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.getByText("body text")).toBeTruthy();
  });

  it("numbers each line in the gutter", () => {
    const { container } = render(
      <OrgNotesEditor
        orgs={["a"]}
        notes={{ a: "" }}
        aliases={{}}
        onSave={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "l1\nl2\nl3" },
    });
    expect(container.querySelector(".org-notes-gutter")?.textContent).toBe(
      "123",
    );
    // The gutter draws one number per newline, so the textarea must not soft-wrap or the numbers
    // would drift against wrapped rows.
    expect(screen.getByRole("textbox").getAttribute("wrap")).toBe("off");
  });
});
