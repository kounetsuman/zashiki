// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { GitStatusResponse, RepoStatus } from "@zashiki/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { GitApi } from "../api/git.js";
import { GitPanel } from "./GitPanel.js";

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
    open: record("open"),
    commit: (repoPath: string, message: string): Promise<void> => {
      api.calls.push(["commit", repoPath, message]);
      return Promise.resolve();
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
}

function renderPanel(repos: RepoStatus[]): Harness {
  const api = createFakeGitApi(repos);
  const dirtyListeners = new Set<() => void>();
  const copied: string[] = [];
  render(
    <GitPanel
      api={api}
      onGitDirty={(fn) => {
        dirtyListeners.add(fn);
        return () => dirtyListeners.delete(fn);
      }}
      copyText={(text) => {
        copied.push(text);
        return Promise.resolve();
      }}
    />,
  );
  return {
    api,
    copied,
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

describe("GitPanel", () => {
  it("fetches status on mount and renders org rows (collapsed)", async () => {
    const h = renderPanel(twoRepoFixture());
    const orgRow = await screen.findByRole("button", { name: /org1 \(2\)/ });
    expect(orgRow.textContent).toContain("org1 (2)");
    expect(h.api.statusCalls).toBe(1);
    // Do not show repo rows while collapsed.
    expect(screen.queryByRole("button", { name: /repo-a/ })).toBeNull();
  });

  it("shows repo rows (with branch and count badges) when an org is expanded", async () => {
    renderPanel(twoRepoFixture());
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
    const h = renderPanel(twoRepoFixture());
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
    const h = renderPanel(twoRepoFixture());
    await expandToFiles(h);
    const before = h.api.statusCalls;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stage app.ts" }));
    });
    expect(h.api.calls).toContainEqual(["stage", "/ws/org1/repo-a", "app.ts"]);
    expect(h.api.statusCalls).toBe(before + 1);
  });

  it("calls unstage via the remove button on a staged file", async () => {
    const h = renderPanel(twoRepoFixture());
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

  it("opens the editor (open) on file name click", async () => {
    const h = renderPanel(twoRepoFixture());
    await expandToFiles(h);
    await act(async () => {
      fireEvent.click(screen.getByText("app.ts"));
    });
    expect(h.api.calls).toContainEqual(["open", "/ws/org1/repo-a", "app.ts"]);
  });

  it("copies the absolute path via the copy button", async () => {
    const h = renderPanel(twoRepoFixture());
    await expandToFiles(h);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "copy app.ts" }));
    });
    expect(h.copied).toEqual(["/ws/org1/repo-a/app.ts"]);
  });

  it('shows a "copied!" popup on copy success', async () => {
    const h = renderPanel(twoRepoFixture());
    await expandToFiles(h);
    expect(screen.queryByText("copied!")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "copy app.ts" }));
    });
    expect(screen.getByText("copied!")).toBeTruthy();
  });

  it("repo row add-all / reset-all", async () => {
    const h = renderPanel(twoRepoFixture());
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
    renderPanel(twoRepoFixture());
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

  it("shows the header as SOURCE CONTROL (VSCode-style)", async () => {
    renderPanel(twoRepoFixture());
    await screen.findByRole("button", { name: /org1 \(2\)/ });
    expect(screen.getByText("SOURCE CONTROL")).toBeTruthy();
  });

  it("shows a commit box on an expanded repo (not on an unexpanded repo)", async () => {
    const h = renderPanel(twoRepoFixture());
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
    const h = renderPanel(twoRepoFixture());
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
    const h = renderPanel(twoRepoFixture());
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
    renderPanel([
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
    const h = renderPanel(twoRepoFixture());
    await screen.findByRole("button", { name: /org1 \(2\)/ });
    const before = h.api.statusCalls;
    await act(async () => {
      h.fireDirty();
    });
    expect(h.api.statusCalls).toBe(before + 1);
  });

  it("refetches via the manual refresh button", async () => {
    const h = renderPanel(twoRepoFixture());
    await screen.findByRole("button", { name: /org1 \(2\)/ });
    const before = h.api.statusCalls;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    });
    expect(h.api.statusCalls).toBe(before + 1);
  });

  it("shows the header icon as a spinner (aria-busy) while a manual refresh is in flight and returns to the refresh icon on completion", async () => {
    const resolvers: ((r: GitStatusResponse) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((resolve) => resolvers.push(resolve)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    render(
      <GitPanel
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    // Settle the initial fetch -> header is idle (↻).
    await act(async () => {
      resolvers[0]?.({ repos: twoRepoFixture() });
    });
    const btn = screen.getByRole("button", { name: "refresh" });
    expect(btn.getAttribute("aria-busy")).toBeNull();
    // Manual refresh -> spinner while in-flight.
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.querySelector(".panel-refresh-spinner")).not.toBeNull();
    // Settle -> cleared.
    await act(async () => {
      resolvers[1]?.({ repos: twoRepoFixture() });
    });
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(btn.textContent).toBe("refresh");
  });

  it("shows the warning icon in the header with the error in the title on an initial fetch error (alongside the red body text)", async () => {
    const rejecters: ((e: unknown) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((_resolve, reject) => rejecters.push(reject)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    render(
      <GitPanel
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    await act(async () => {
      rejecters[0]?.(new Error("boom"));
    });
    const btn = screen.getByRole("button", { name: "refresh" });
    expect(btn.textContent).toContain("warning");
    expect(btn.getAttribute("title")).toContain("boom");
    // The red text block in the body is also shown alongside, as before.
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
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    const dirty = new Set<() => void>();
    render(
      <GitPanel
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
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    render(
      <GitPanel
        api={api}
        onGitDirty={() => () => {}}
        copyText={() => Promise.resolve()}
      />,
    );
    // Before fetch completes: the loading UI shows and there is no panel-tree.
    expect(screen.getByRole("status")).toBeTruthy();
    expect(document.querySelector(".panel-tree")).toBeNull();
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
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    render(
      <GitPanel
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

  it("clears loading and shows only the error on an initial fetch error (no double display)", async () => {
    const rejecters: ((e: unknown) => void)[] = [];
    const api: GitApi = {
      status: () => new Promise((_resolve, reject) => rejecters.push(reject)),
      stage: () => Promise.resolve(),
      unstage: () => Promise.resolve(),
      stageAll: () => Promise.resolve(),
      unstageAll: () => Promise.resolve(),
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    render(
      <GitPanel
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
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    const dirty = new Set<() => void>();
    render(
      <GitPanel
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
      open: () => Promise.resolve(),
      commit: () => Promise.resolve(),
    };
    const dirty = new Set<() => void>();
    render(
      <GitPanel
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
    renderPanel([
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
