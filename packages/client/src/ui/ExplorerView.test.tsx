// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  FsEntry,
  FsListResponse,
  FsRepo,
  FsReposResponse,
} from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FsApi } from "../api/fs.js";
import { ExplorerView } from "./ExplorerView.js";

afterEach(cleanup);

const REPO = "/ws/org1/repo-a";

interface FakeFsApi extends FsApi {
  readonly listCalls: [string, string][];
  readonly revealCalls: [string, string][];
  readonly renameCalls: [string, string, string][];
  readonly deleteCalls: [string, string][];
  /** dir (repo-relative) -> that directory's listing result. */
  tree: Map<string, FsListResponse>;
  /** Storage for resolvers, used to defer list and test delayed responses. */
  deferred: Map<string, (r: FsListResponse) => void> | null;
}

function resp(entries: FsEntry[], truncated = false): FsListResponse {
  return { entries, truncated };
}

function createFakeFsApi(
  tree: Record<string, FsListResponse>,
  repos: FsRepo[] = [{ org: "org1", repo: "repo-a", path: REPO }],
): FakeFsApi {
  const api: FakeFsApi = {
    listCalls: [],
    revealCalls: [],
    renameCalls: [],
    deleteCalls: [],
    tree: new Map(Object.entries(tree)),
    deferred: null,
    repos(): Promise<FsReposResponse> {
      return Promise.resolve({ repos });
    },
    list(repoPath, dir): Promise<FsListResponse> {
      api.listCalls.push([repoPath, dir]);
      if (api.deferred) {
        return new Promise<FsListResponse>((resolve) => {
          api.deferred?.set(dir, resolve);
        });
      }
      return Promise.resolve(api.tree.get(dir) ?? resp([]));
    },
    reveal(repoPath, path): Promise<void> {
      api.revealCalls.push([repoPath, path]);
      return Promise.resolve();
    },
    rename(repoPath, path, newName): Promise<string> {
      api.renameCalls.push([repoPath, path, newName]);
      const parent = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
      return Promise.resolve(parent === "" ? newName : `${parent}/${newName}`);
    },
    delete(repoPath, path): Promise<void> {
      api.deleteCalls.push([repoPath, path]);
      return Promise.resolve();
    },
  };
  return api;
}

async function renderView(
  api: FakeFsApi,
  onOpenFile?: (r: string, f: string) => void,
) {
  await act(async () => {
    render(<ExplorerView api={api} onOpenFile={onOpenFile} />);
  });
}

describe("ExplorerView", () => {
  it("shows the root repo and lazily enumerates its direct children when expanded", async () => {
    const api = createFakeFsApi({
      "": resp([
        { name: "src", kind: "dir" },
        { name: "package.json", kind: "file" },
      ]),
    });
    await renderView(api);
    // Wait until the repo row appears (repos resolves immediately).
    await waitFor(() => screen.getByText("repo-a"));
    // Do not call list before expanding (lazy expansion).
    expect(api.listCalls).toEqual([]);

    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    await waitFor(() => screen.getByText("src"));
    expect(screen.getByText("package.json")).toBeTruthy();
    expect(api.listCalls).toEqual([[REPO, ""]]);
  });

  it("lists with that path when a subdirectory is expanded", async () => {
    const api = createFakeFsApi({
      "": resp([{ name: "src", kind: "dir" }]),
      src: resp([{ name: "app.ts", kind: "file" }]),
    });
    await renderView(api);
    await waitFor(() => screen.getByText("repo-a"));
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    await waitFor(() => screen.getByText("src"));
    await act(async () => {
      fireEvent.click(screen.getByText("src"));
    });
    await waitFor(() => screen.getByText("app.ts"));
    expect(api.listCalls).toContainEqual([REPO, "src"]);
  });

  it("calls onOpenFile with the repo-relative path on file click", async () => {
    const onOpen = vi.fn();
    const api = createFakeFsApi({
      "": resp([{ name: "src", kind: "dir" }]),
      src: resp([{ name: "app.ts", kind: "file" }]),
    });
    await renderView(api, onOpen);
    await waitFor(() => screen.getByText("repo-a"));
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    await waitFor(() => screen.getByText("src"));
    await act(async () => {
      fireEvent.click(screen.getByText("src"));
    });
    await waitFor(() => screen.getByText("app.ts"));
    await act(async () => {
      fireEvent.click(screen.getByText("app.ts"));
    });
    expect(onOpen).toHaveBeenCalledWith(REPO, "src/app.ts");
  });

  it('shows "showing partial results only" when truncated', async () => {
    const api = createFakeFsApi({
      "": resp([{ name: "a", kind: "file" }], true),
    });
    await renderView(api);
    await waitFor(() => screen.getByText("repo-a"));
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    await waitFor(() => screen.getByText(/一部のみ表示/));
  });

  it("shows a list error under that directory (without breaking the others)", async () => {
    const api = createFakeFsApi({});
    api.list = (repoPath, dir) => {
      api.listCalls.push([repoPath, dir]);
      return Promise.reject(new Error("permission denied"));
    };
    await renderView(api);
    await waitFor(() => screen.getByText("repo-a"));
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    await waitFor(() => screen.getByText(/permission denied/));
  });

  it("does not revive from a stale response received while collapsed, even after reopening (generation tracking)", async () => {
    const api = createFakeFsApi({});
    api.deferred = new Map();
    await renderView(api);
    await waitFor(() => screen.getByText("repo-a"));

    // First expansion (list is deferred).
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    // Collapse.
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    // Now resolve the previously deferred stale response.
    await act(async () => {
      api.deferred?.get("")?.(resp([{ name: "stale.txt", kind: "file" }]));
      await Promise.resolve();
    });
    // Since it is collapsed, the stale response's contents are not shown.
    expect(screen.queryByText("stale.txt")).toBeNull();
  });

  it("groups a repo and its linked worktrees under one heading (main first, worktrees after)", async () => {
    const main = "/ws/org1/proj";
    const wt = "/ws/org1/proj-42-fix";
    const api = createFakeFsApi({}, [
      {
        org: "org1",
        repo: "proj",
        path: main,
        isWorktree: false,
        mainPath: main,
      },
      {
        org: "org1",
        repo: "proj-42-fix",
        path: wt,
        isWorktree: true,
        mainPath: main,
      },
    ]);
    await renderView(api);
    await waitFor(() => screen.getByText("proj-42-fix"));
    expect(screen.getAllByText("proj").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("main")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("proj-42-fix"));
    });
    expect(api.listCalls).toContainEqual([wt, ""]);
  });

  it("renders a per-extension icon on file rows (data-icon reflects fileIconKind)", async () => {
    const api = createFakeFsApi({
      "": resp([
        { name: "app.ts", kind: "file" },
        { name: "main.rs", kind: "file" },
      ]),
    });
    await renderView(api);
    await waitFor(() => screen.getByText("repo-a"));
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    const ts = await waitFor(() => screen.getByText("app.ts"));
    const tsRow = ts.closest(".explorer-file");
    const rsRow = screen.getByText("main.rs").closest(".explorer-file");
    expect(tsRow?.getAttribute("data-icon")).toBe("ts");
    expect(rsRow?.getAttribute("data-icon")).toBe("rust");
    expect(tsRow?.querySelector(".explorer-file-icon")).toBeTruthy();
  });

  it("shows the header as EXPLORER (uppercase, shared view-title)", async () => {
    const api = createFakeFsApi({ "": resp([]) });
    await renderView(api);
    const title = screen.getByText("EXPLORER");
    expect(title).toBeTruthy();
    expect(title.className).toContain("view-title");
  });
});

describe("ExplorerView context menu", () => {
  const treeWithFile = {
    "": resp([{ name: "src", kind: "dir" as const }]),
    src: resp([{ name: "app.ts", kind: "file" as const }]),
  };

  async function openFileMenu(handlers: {
    onCopyText?: (t: string) => void;
    onPathRenamed?: (r: string, o: string, n: string, k: string) => void;
    onPathDeleted?: (r: string, rel: string, k: string) => void;
  }) {
    const api = createFakeFsApi(treeWithFile);
    await act(async () => {
      render(<ExplorerView api={api} {...handlers} />);
    });
    await waitFor(() => screen.getByText("repo-a"));
    await act(async () => {
      fireEvent.click(screen.getByText("repo-a"));
    });
    await waitFor(() => screen.getByText("src"));
    await act(async () => {
      fireEvent.click(screen.getByText("src"));
    });
    await waitFor(() => screen.getByText("app.ts"));
    await act(async () => {
      fireEvent.contextMenu(screen.getByText("app.ts"));
    });
    return api;
  }

  it("opens the entry menu on right-click with the file actions", async () => {
    await openFileMenu({});
    for (const label of [
      "Finderで表示",
      "パスをコピー",
      "相対パスをコピー",
      "名前を変更",
      "削除",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }
  });

  it("copies the absolute and relative paths via onCopyText", async () => {
    const onCopyText = vi.fn();
    await openFileMenu({ onCopyText });
    await act(async () => {
      fireEvent.click(screen.getByText("パスをコピー"));
    });
    expect(onCopyText).toHaveBeenCalledWith(`${REPO}/src/app.ts`);

    await act(async () => {
      fireEvent.contextMenu(screen.getByText("app.ts"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("相対パスをコピー"));
    });
    expect(onCopyText).toHaveBeenLastCalledWith("src/app.ts");
  });

  it("renames inline, calling api.rename and onPathRenamed", async () => {
    const onPathRenamed = vi.fn();
    const api = await openFileMenu({ onPathRenamed });
    await act(async () => {
      fireEvent.click(screen.getByText("名前を変更"));
    });
    const input = screen.getByLabelText("名前を変更") as HTMLInputElement;
    expect(input.value).toBe("app.ts");
    await act(async () => {
      fireEvent.change(input, { target: { value: "main.ts" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() =>
      expect(api.renameCalls).toContainEqual([REPO, "src/app.ts", "main.ts"]),
    );
    expect(onPathRenamed).toHaveBeenCalledWith(
      REPO,
      "src/app.ts",
      "src/main.ts",
      "file",
    );
  });

  it("cancels an inline rename on Escape without calling api.rename", async () => {
    const onPathRenamed = vi.fn();
    const api = await openFileMenu({ onPathRenamed });
    await act(async () => {
      fireEvent.click(screen.getByText("名前を変更"));
    });
    const input = screen.getByLabelText("名前を変更") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "main.ts" } });
      fireEvent.keyDown(input, { key: "Escape" });
      // The blur that follows the input's removal must not re-commit the draft.
      fireEvent.blur(input);
    });
    expect(api.renameCalls).toEqual([]);
    expect(onPathRenamed).not.toHaveBeenCalled();
    await waitFor(() => screen.getByText("app.ts"));
  });

  it("deletes only after confirming, then calls api.delete and onPathDeleted", async () => {
    const onPathDeleted = vi.fn();
    const api = await openFileMenu({ onPathDeleted });
    await act(async () => {
      fireEvent.click(screen.getByText("削除"));
    });
    // Confirmation is required before any delete call.
    expect(api.deleteCalls).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ゴミ箱に移動" }));
    });
    await waitFor(() =>
      expect(api.deleteCalls).toContainEqual([REPO, "src/app.ts"]),
    );
    expect(onPathDeleted).toHaveBeenCalledWith(REPO, "src/app.ts", "file");
  });
});
