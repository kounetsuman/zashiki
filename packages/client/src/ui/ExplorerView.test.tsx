// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FsEntry, FsListResponse, FsReposResponse } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FsApi } from "../api/fs.js";
import { ExplorerView } from "./ExplorerView.js";

afterEach(cleanup);

const REPO = "/ws/org1/repo-a";

interface FakeFsApi extends FsApi {
  readonly listCalls: [string, string][];
  /** dir (repo-relative) -> that directory's listing result. */
  tree: Map<string, FsListResponse>;
  /** Storage for resolvers, used to defer list and test delayed responses. */
  deferred: Map<string, (r: FsListResponse) => void> | null;
}

function resp(entries: FsEntry[], truncated = false): FsListResponse {
  return { entries, truncated };
}

function createFakeFsApi(tree: Record<string, FsListResponse>): FakeFsApi {
  const api: FakeFsApi = {
    listCalls: [],
    tree: new Map(Object.entries(tree)),
    deferred: null,
    repos(): Promise<FsReposResponse> {
      return Promise.resolve({
        repos: [{ org: "org1", repo: "repo-a", path: REPO }],
      });
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

  it("shows the header as EXPLORER (uppercase, shared view-title)", async () => {
    const api = createFakeFsApi({ "": resp([]) });
    await renderView(api);
    const title = screen.getByText("EXPLORER");
    expect(title).toBeTruthy();
    expect(title.className).toContain("view-title");
  });
});
