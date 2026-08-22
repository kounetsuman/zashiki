// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  GitStatusResponse,
  GitStatusResult,
  RepoStatus,
} from "@zashiki/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { GitApi } from "../api/git.js";
import { SourceControlView } from "./SourceControlView.js";

function repo(partial: Partial<RepoStatus>): RepoStatus {
  return {
    org: "org1",
    repo: "repo-a",
    path: "/ws/org1/repo-a",
    branch: "main",
    staged: [],
    changed: [],
    ...partial,
  };
}

interface FakeGitApi extends GitApi {
  statusCalls: number;
  readonly calls: string[][];
  repos: RepoStatus[];
}

function createFakeGitApi(repos: RepoStatus[] = []): FakeGitApi {
  const record =
    (name: string) =>
    (...args: string[]): Promise<void> => {
      api.calls.push([name, ...args]);
      return Promise.resolve();
    };
  const api: FakeGitApi = {
    statusCalls: 0,
    calls: [],
    repos,
    status(): Promise<GitStatusResponse> {
      api.statusCalls += 1;
      return Promise.resolve({ repos: api.repos });
    },
    stage: record("stage"),
    unstage: record("unstage"),
    stageAll: record("stage-all"),
    unstageAll: record("unstage-all"),
    removeWorktree: record("remove-worktree"),
    open: record("open"),
    commit: (repoPath: string, message: string): Promise<void> => {
      api.calls.push(["commit", repoPath, message]);
      return Promise.resolve();
    },
    diff: (repoPath, file, staged, untracked) => {
      api.calls.push([
        "diff",
        repoPath,
        file,
        String(staged),
        String(untracked),
      ]);
      return Promise.resolve({
        oldText: "",
        newText: "",
        binary: false,
        tooLarge: false,
        added: 0,
        removed: 0,
      });
    },
  };
  return api;
}

function twoRepoFixture(): RepoStatus[] {
  return [
    repo({
      repo: "repo-a",
      path: "/ws/org1/repo-a",
      branch: "feature/x",
      staged: [{ code: "A", path: "new.ts" }],
      changed: [
        { code: "M", path: "app.ts" },
        { code: "??", path: "mem.md" },
        { code: "D", path: "gone.ts" },
      ],
    }),
    repo({ repo: "repo-b", path: "/ws/org1/repo-b" }),
  ];
}

interface Harness {
  api: FakeGitApi;
  fireDirty: () => void;
  copied: string[];
  diffed: string[][];
}

function renderView(repos: RepoStatus[], withDiff = false): Harness {
  const api = createFakeGitApi(repos);
  const dirtyListeners = new Set<() => void>();
  const copied: string[] = [];
  const diffed: string[][] = [];
  render(
    <SourceControlView
      api={api}
      onGitDirty={(fn) => {
        dirtyListeners.add(fn);
        return () => dirtyListeners.delete(fn);
      }}
      copyText={(text) => {
        copied.push(text);
        return Promise.resolve();
      }}
      onOpenDiff={
        withDiff
          ? (repoPath, file, staged, untracked) =>
              diffed.push([repoPath, file, String(staged), String(untracked)])
          : undefined
      }
    />,
  );
  return {
    api,
    copied,
    diffed,
    fireDirty: () => {
      for (const fn of dirtyListeners) fn();
    },
  };
}

/** Look up a row button by class + display name (avoids clashing with aria-labeled action buttons). */
function rowButton(cls: string, name: string): HTMLElement {
  const el = screen
    .getAllByRole("button")
    .find(
      (b) => b.classList.contains(cls) && (b.textContent ?? "").includes(name),
    );
  if (!el) throw new Error(`row not found: ${cls} ${name}`);
  return el;
}

async function expandToFiles(_h: Harness): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /org1 \(2\)/ }));
  fireEvent.click(rowButton("git-repo-row", "repo-a"));
}

afterEach(cleanup);

describe("SourceControlView", () => {
  it("fetches status on mount and renders org rows (collapsed)", async () => {
    const h = renderView(twoRepoFixture());
    const orgRow = await screen.findByRole("button", { name: /org1 \(2\)/ });
    expect(orgRow.textContent).toContain("org1 (2)");
    expect(h.api.statusCalls).toBe(1);
    // Do not show repo rows while collapsed.
    expect(screen.queryByRole("button", { name: /repo-a/ })).toBeNull();
  });

  it("shows repo rows (with branch and count badges) when an org is expanded", async () => {
    renderView(twoRepoFixture());
    fireEvent.click(await screen.findByRole("button", { name: /org1 \(2\)/ }));
    const repoRow = rowButton("git-repo-row", "repo-a");
    const branch = repoRow.querySelector(".git-branch");
    expect(branch?.textContent).toBe("feature/x");
    expect(repoRow.querySelector(".git-count-staged")?.textContent).toBe("●1");
    expect(repoRow.querySelector(".git-count-changed")?.textContent).toBe("+3");
    // A repo with zero changes shows no count badges.
    const repoB = rowButton("git-repo-row", "repo-b");
    expect(repoB.querySelector(".git-count-staged")).toBeNull();
    expect(repoB.querySelector(".git-count-changed")).toBeNull();
  });

  it("shows STAGED/CHANGED sections and file rows (with color classes) when a repo is expanded", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    expect(screen.getByText("STAGED").className).toContain(
      "git-section-staged",
    );
    expect(screen.getByText("CHANGED").className).toContain(
      "git-section-changed",
    );
    const codeOf = (text: string): Element | null =>
      screen
        .getByText(text)
        .closest(".git-file-row")
        ?.querySelector(".git-code") ?? null;
    expect(codeOf("new.ts")?.className).toContain("git-code-added");
    expect(codeOf("app.ts")?.className).toContain("git-code-modified");
    expect(codeOf("mem.md")?.className).toContain("git-code-untracked");
    expect(codeOf("gone.ts")?.className).toContain("git-code-deleted");
  });

  it("calls stage and refetches via + on a changed file", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    const before = h.api.statusCalls;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stage app.ts" }));
    });
    expect(h.api.calls).toContainEqual(["stage", "/ws/org1/repo-a", "app.ts"]);
    expect(h.api.statusCalls).toBe(before + 1);
  });

  it("calls unstage via the remove button on a staged file", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "unstage new.ts" }));
    });
    expect(h.api.calls).toContainEqual([
      "unstage",
      "/ws/org1/repo-a",
      "new.ts",
    ]);
  });

  it("opens the viewer (open) on file name click", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    await act(async () => {
      fireEvent.click(screen.getByText("app.ts"));
    });
    expect(h.api.calls).toContainEqual(["open", "/ws/org1/repo-a", "app.ts"]);
  });

  // A real double-click delivers click, click, then dblclick; the deferred open must be cancelled.
  function doubleClick(el: HTMLElement): void {
    fireEvent.click(el);
    fireEvent.click(el);
    fireEvent.doubleClick(el);
  }

  it("double-clicking a changed file opens its diff and cancels the editor open", async () => {
    const h = renderView(twoRepoFixture(), true);
    await expandToFiles(h);
    await act(async () => {
      doubleClick(screen.getByText("app.ts"));
    });
    // changed side: staged=false, untracked=false.
    expect(h.diffed).toContainEqual([
      "/ws/org1/repo-a",
      "app.ts",
      "false",
      "false",
    ]);
    // The double-click cancels the deferred open, so the external editor is not launched.
    expect(h.api.calls.some((c) => c[0] === "open")).toBe(false);
  });

  it("double-clicking a staged file diffs its staged side, and an untracked file its untracked side", async () => {
    const h = renderView(twoRepoFixture(), true);
    await expandToFiles(h);
    await act(async () => {
      doubleClick(screen.getByText("new.ts"));
      doubleClick(screen.getByText("mem.md"));
    });
    expect(h.diffed).toContainEqual([
      "/ws/org1/repo-a",
      "new.ts",
      "true",
      "false",
    ]);
    expect(h.diffed).toContainEqual([
      "/ws/org1/repo-a",
      "mem.md",
      "false",
      "true",
    ]);
  });

  it("does not offer a diff for an untracked directory (--no-index cannot diff a dir)", async () => {
    const withDir = [
      repo({
        repo: "repo-a",
        path: "/ws/org1/repo-a",
        branch: "main",
        staged: [],
        changed: [{ code: "??", path: "newdir/" }],
      }),
    ];
    const h = renderView(withDir, true);
    fireEvent.click(await screen.findByRole("button", { name: /org1 \(1\)/ }));
    fireEvent.click(rowButton("git-repo-row", "repo-a"));
    // An untracked dir has no diff, so a single click falls straight through to the editor.
    await act(async () => {
      fireEvent.click(screen.getByText("newdir/"));
    });
    expect(h.diffed).toEqual([]);
    expect(h.api.calls).toContainEqual(["open", "/ws/org1/repo-a", "newdir/"]);
  });

  it("copies the absolute path via the copy button", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "copy app.ts" }));
    });
    expect(h.copied).toEqual(["/ws/org1/repo-a/app.ts"]);
  });

  it('shows a "copied!" popup on copy success', async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    expect(screen.queryByText("copied!")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "copy app.ts" }));
    });
    expect(screen.getByText("copied!")).toBeTruthy();
  });

  it("repo row add-all / reset-all", async () => {
    const h = renderView(twoRepoFixture());
    fireEvent.click(await screen.findByRole("button", { name: /org1 \(2\)/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stage-all repo-a" }));
    });
    expect(h.api.calls).toContainEqual(["stage-all", "/ws/org1/repo-a"]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "unstage-all repo-a" }),
      );
    });
    expect(h.api.calls).toContainEqual(["unstage-all", "/ws/org1/repo-a"]);
  });

  it("repo row actions use add/remove icons and do not show add./reset. text", async () => {
    renderView(twoRepoFixture());
    fireEvent.click(await screen.findByRole("button", { name: /org1 \(2\)/ }));
    expect(screen.queryByText("add .")).toBeNull();
    expect(screen.queryByText("reset .")).toBeNull();
    expect(
      screen.getByRole("button", { name: "stage-all repo-a" }).textContent,
    ).toBe("add");
    expect(
      screen.getByRole("button", { name: "unstage-all repo-a" }).textContent,
    ).toBe("remove");
  });

  it("shows a delete button only on worktree rows, and removes on inline confirm", async () => {
    const repos = [
      repo({ repo: "repo-a", path: "/ws/org1/repo-a", isWorktree: false }),
      repo({ repo: "repo-wt", path: "/ws/org1/repo-wt", isWorktree: true }),
    ];
    const h = renderView(repos);
    fireEvent.click(await screen.findByRole("button", { name: /org1 \(2\)/ }));

    // The main working tree has no delete button; the worktree does (labels are pinned to ja).
    expect(
      screen.queryByRole("button", { name: /ワークツリー repo-a を削除/ }),
    ).toBeNull();
    const del = screen.getByRole("button", {
      name: /ワークツリー repo-wt を削除/,
    });

    // First click asks for confirmation (does not delete yet).
    fireEvent.click(del);
    expect(h.api.calls.some((c) => c[0] === "remove-worktree")).toBe(false);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: /ワークツリー repo-wt の削除を確定/,
        }),
      );
    });
    expect(h.api.calls).toContainEqual(["remove-worktree", "/ws/org1/repo-wt"]);
  });

  it("marks worktree rows with the account_tree icon and main repos with folder", async () => {
    const repos = [
      repo({ repo: "repo-a", path: "/ws/org1/repo-a", isWorktree: false }),
      repo({ repo: "repo-wt", path: "/ws/org1/repo-wt", isWorktree: true }),
    ];
    renderView(repos);
    fireEvent.click(await screen.findByRole("button", { name: /org1 \(2\)/ }));
    expect(
      rowButton("git-repo-row", "repo-a").querySelector(".git-repo-icon")
        ?.textContent,
    ).toBe("folder");
    expect(
      rowButton("git-repo-row", "repo-wt").querySelector(".git-repo-icon")
        ?.textContent,
    ).toBe("account_tree");
  });

  it("shows the header as SOURCE CONTROL (VSCode-style)", async () => {
    renderView(twoRepoFixture());
    await screen.findByRole("button", { name: /org1 \(2\)/ });
    expect(screen.getByText("SOURCE CONTROL")).toBeTruthy();
  });

  it("shows a commit box on an expanded repo (not on an unexpanded repo)", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    expect(
      screen.getByRole("textbox", { name: "commit message repo-a" }),
    ).toBeTruthy();
    // repo-b is not expanded, so it has no commit box.
    expect(
      screen.queryByRole("textbox", { name: "commit message repo-b" }),
    ).toBeNull();
  });

  it("enables the Commit button when there are staged files and a message, and commits on press", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    const commitBtn = screen.getByRole("button", { name: "commit repo-a" });
    expect((commitBtn as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByRole("textbox", {
      name: "commit message repo-a",
    });
    fireEvent.change(input, { target: { value: "feat: add" } });
    expect((commitBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(commitBtn);
    });
    expect(h.api.calls).toContainEqual([
      "commit",
      "/ws/org1/repo-a",
      "feat: add",
    ]);
    // After success, the message is cleared.
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("commits with Cmd+Enter (ignores the Enter that confirms IME composition)", async () => {
    const h = renderView(twoRepoFixture());
    await expandToFiles(h);
    const input = screen.getByRole("textbox", {
      name: "commit message repo-a",
    });
    fireEvent.change(input, { target: { value: "msg" } });
    // Enter during IME composition does not commit.
    fireEvent.keyDown(input, {
      key: "Enter",
      metaKey: true,
      isComposing: true,
    });
    expect(h.api.calls.some((c) => c[0] === "commit")).toBe(false);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(h.api.calls).toContainEqual(["commit", "/ws/org1/repo-a", "msg"]);
  });

  it("keeps Commit disabled on a repo with no staged files even when a message is entered", async () => {
    renderView([
      repo({ org: "solo", repo: "solo", path: "/ws/solo", staged: [] }),
    ]);
    const name = await screen.findByText("solo", {
      selector: ".git-repo-name",
    });
    fireEvent.click(name.closest("button") as HTMLElement);
    const input = screen.getByRole("textbox", { name: "commit message solo" });
    fireEvent.change(input, { target: { value: "x" } });
    const commitBtn = screen.getByRole("button", { name: "commit solo" });
    expect((commitBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("refetches on receiving git.dirty", async () => {
    const h = renderView(twoRepoFixture());
    await screen.findByRole("button", { name: /org1 \(2\)/ });
    const before = h.api.statusCalls;
    await act(async () => {
      h.fireDirty();
    });
    expect(h.api.statusCalls).toBe(before + 1);
  });

  it("surfaces an initial fetch error as the red body text", async () => {
    const rejecters: ((e: unknown) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((_resolve, reject) => rejecters.push(reject)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    render(
      <SourceControlView
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    await act(async () => {
      rejecters[0]?.(new Error("boom"));
    });
    expect(document.querySelector(".git-error")?.textContent).toContain("boom");
  });

  it("a late-returning old status does not overwrite the newer display (generation guard)", async () => {
    const resolvers: ((r: GitStatusResponse) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    const dirty = new Set<() => void>();
    render(
      <SourceControlView
        api={api}
        onGitDirty={(fn) => {
          dirty.add(fn);
          return () => dirty.delete(fn);
        }}
        copyText={() => Promise.resolve()}
      />,
    );
    // While the mount fetch(1) is still in-flight, git.dirty triggers fetch(2).
    act(() => {
      for (const fn of dirty) fn();
    });
    // The newer fetch(2) returns first.
    await act(async () => {
      resolvers[1]?.({
        repos: [repo({ org: "fresh", repo: "fresh", path: "/ws/fresh" })],
      });
    });
    // Even if the older fetch(1) returns later, do not roll back the display.
    await act(async () => {
      resolvers[0]?.({
        repos: [repo({ org: "stale", repo: "stale", path: "/ws/stale" })],
      });
    });
    expect(screen.queryByText(/stale/)).toBeNull();
    expect(
      screen.getByText("fresh", { selector: ".git-repo-name" }),
    ).toBeTruthy();
  });

  it("shows the loading UI (role=status) and no tree while the initial status fetch is in flight", async () => {
    const resolvers: ((r: GitStatusResponse) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    render(
      <SourceControlView
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    // Before fetch completes: the loading UI shows and there is no view-tree.
    expect(screen.getByRole("status")).toBeTruthy();
    expect(document.querySelector(".view-tree")).toBeNull();
    // After fetch completes: the loading UI disappears and the tree shows.
    await act(async () => {
      resolvers[0]?.({ repos: twoRepoFixture() });
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      await screen.findByRole("button", { name: /org1 \(2\)/ }),
    ).toBeTruthy();
  });

  it("shows the empty state (no changes) and clears the loading UI when the initial fetch returns 0 items", async () => {
    const resolvers: ((r: GitStatusResponse) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    render(
      <SourceControlView
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    await act(async () => {
      resolvers[0]?.({ repos: [] });
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("変更なし")).toBeTruthy();
  });

  it("renders the healthy repos and a non-fatal notice when some repos are skipped", async () => {
    const resolvers: ((r: GitStatusResult) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    render(
      <SourceControlView
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    await act(async () => {
      resolvers[0]?.({ repos: twoRepoFixture(), skipped: [{ index: 53 }] });
    });
    // The healthy repos still render, and only a non-fatal warning is shown (not the fatal error block).
    expect(
      await screen.findByRole("button", { name: /org1 \(2\)/ }),
    ).toBeTruthy();
    expect(document.querySelector(".git-warning")).not.toBeNull();
    expect(document.querySelector(".git-error")).toBeNull();
  });

  it("does not show the empty state when every repo was skipped", async () => {
    const resolvers: ((r: GitStatusResult) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    render(
      <SourceControlView
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    await act(async () => {
      resolvers[0]?.({ repos: [], skipped: [{ index: 0 }] });
    });
    expect(document.querySelector(".git-warning")).not.toBeNull();
    expect(screen.queryByText("変更なし")).toBeNull();
  });

  it("clears loading and shows only the error on an initial fetch error (no double display)", async () => {
    const rejecters: ((e: unknown) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((_resolve, reject) => rejecters.push(reject)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    render(
      <SourceControlView
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    await act(async () => {
      rejecters[0]?.(new Error("boom"));
    });
    // The error shows but the loading UI does not coexist with it.
    expect(screen.getByText(/boom/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not revert to the loading UI on subsequent refetches (git.dirty)", async () => {
    const resolvers: ((r: GitStatusResponse) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    const dirty = new Set<() => void>();
    render(
      <SourceControlView
        api={api}
        onGitDirty={(fn) => {
          dirty.add(fn);
          return () => dirty.delete(fn);
        }}
        copyText={() => Promise.resolve()}
      />,
    );
    // Complete the initial fetch.
    await act(async () => {
      resolvers[0]?.({ repos: twoRepoFixture() });
    });
    expect(screen.queryByRole("status")).toBeNull();
    // git.dirty triggers a second fetch (while in-flight).
    act(() => {
      for (const fn of dirty) fn();
    });
    // Even during the second fetch, do not revert to the loading UI (keep the previous contents).
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /org1 \(2\)/ })).toBeTruthy();
  });

  it("clears the loading UI when a newer fetch triggered by git.dirty during the initial in-flight settles first", async () => {
    const resolvers: ((r: GitStatusResponse) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      diff: () =>
        Promise.resolve({
          oldText: "",
          newText: "",
          binary: false,
          tooLarge: false,
          added: 0,
          removed: 0,
        }),
    };
    const dirty = new Set<() => void>();
    render(
      <SourceControlView
        api={api}
        onGitDirty={(fn) => {
          dirty.add(fn);
          return () => dirty.delete(fn);
        }}
        copyText={() => Promise.resolve()}
      />,
    );
    // While the initial fetch(1) is still in-flight, git.dirty triggers fetch(2).
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => {
      for (const fn of dirty) fn();
    });
    // The newer fetch(2) returns first -> the loading UI is cleared and the tree shows.
    await act(async () => {
      resolvers[1]?.({ repos: twoRepoFixture() });
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /org1 \(2\)/ })).toBeTruthy();
    // Even if the older fetch(1) returns later, do not roll back the state.
    await act(async () => {
      resolvers[0]?.({ repos: [] });
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /org1 \(2\)/ })).toBeTruthy();
  });

  it("flattens an org whose root is itself a single repo and shows the repo row directly", async () => {
    renderView([
      repo({ org: "obsidian", repo: "obsidian", path: "/ws/obsidian" }),
    ]);
    const name = await screen.findByText("obsidian", {
      selector: ".git-repo-name",
    });
    const row = name.closest("button");
    // Shows as a repo row, not an org row (with "(1)").
    expect(row?.textContent).not.toContain("(1)");
    expect(row?.querySelector(".git-branch")).not.toBeNull();
  });
});
