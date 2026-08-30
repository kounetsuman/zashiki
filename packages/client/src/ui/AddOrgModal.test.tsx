// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FsValidateResponse } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReposAddError, type ReposApi } from "../api/repos.js";
import { AddOrgModal } from "./AddOrgModal.js";

afterEach(cleanup);

function api(overrides: Partial<ReposApi> = {}): ReposApi {
  return {
    add: vi.fn(async () => ({ org: "x" })),
    validate: vi.fn(
      async () => ({ status: "ok", org: "x" }) as FsValidateResponse,
    ),
    browse: vi.fn(async () => ({ entries: [], truncated: false })),
    list: vi.fn(async () => ({ orgs: [] })),
    setNote: vi.fn(async () => undefined),
    setColor: vi.fn(async () => undefined),
    setAlias: vi.fn(async () => undefined),
    setMemo: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("AddOrgModal", () => {
  it("submits the entered path and closes on success", async () => {
    const add = vi.fn(async () => ({ org: "myorg" }));
    const onClose = vi.fn();
    render(<AddOrgModal api={api({ add })} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("ディレクトリのパス"), {
      target: { value: "/ws/myorg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("/ws/myorg"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("localizes the server error by code and stays open on failure", async () => {
    const add = vi.fn(async () => {
      throw new ReposAddError("this path is already registered", "duplicate");
    });
    const onClose = vi.fn();
    render(<AddOrgModal api={api({ add })} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("ディレクトリのパス"), {
      target: { value: "/ws/dup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "このパスは既に登録されています。",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables submit while the path is empty", () => {
    render(<AddOrgModal api={api()} onClose={() => {}} />);
    const submit = screen.getByRole("button", {
      name: "追加",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("shows directory completions and fills the input on pick", async () => {
    const browse = vi.fn(async () => ({
      entries: [{ name: "workshop", kind: "dir" as const }],
      truncated: false,
    }));
    render(<AddOrgModal api={api({ browse })} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("ディレクトリのパス"), {
      target: { value: "/ws/wo" },
    });
    const option = await screen.findByRole("button", { name: "workshop" });
    fireEvent.click(option);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("ディレクトリのパス") as HTMLInputElement).value,
      ).toBe("/ws/workshop/"),
    );
  });

  it("blocks submit when validation reports a non-ok status", async () => {
    const validate = vi.fn(
      async () => ({ status: "duplicate" }) as FsValidateResponse,
    );
    render(<AddOrgModal api={api({ validate })} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("ディレクトリのパス"), {
      target: { value: "/ws/dup" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "このパスは既に登録されています。",
      ),
    );
    expect(
      (screen.getByRole("button", { name: "追加" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("lists the currently registered orgs (name + absolute path)", async () => {
    const list = vi.fn(async () => ({
      orgs: [{ org: "myorg", path: "/Users/me/ws/myorg" }],
    }));
    render(<AddOrgModal api={api({ list })} onClose={() => {}} />);
    const cell = await screen.findByText("/Users/me/ws/myorg");
    const row = cell.closest("tr") as HTMLTableRowElement;
    expect(row.textContent).toContain("myorg");
  });

  it("shows the empty message when no orgs are registered", async () => {
    render(<AddOrgModal api={api()} onClose={() => {}} />);
    expect(
      await screen.findByText("まだ組織が登録されていません。"),
    ).toBeTruthy();
  });
});
