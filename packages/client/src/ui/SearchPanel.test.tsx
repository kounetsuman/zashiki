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
  SearchFile,
  SearchRequest,
  SearchResponse,
} from "@zashiki/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { SearchApi } from "../api/search.js";
import { SearchPanel } from "./SearchPanel.js";

afterEach(cleanup);

interface FakeSearchApi extends SearchApi {
  readonly calls: SearchRequest[];
  response: SearchResponse;
}

function file(partial: Partial<SearchFile>): SearchFile {
  return {
    org: "org1",
    repo: "repo-a",
    path: "/ws/org1/repo-a/src/a.ts",
    relPath: "src/a.ts",
    matches: [{ line: 3, text: "const foo = 1;", start: 6, end: 9 }],
    ...partial,
  };
}

function createFakeApi(response: SearchResponse): FakeSearchApi {
  const api: FakeSearchApi = {
    calls: [],
    response,
    search(req) {
      api.calls.push(req);
      return Promise.resolve(api.response);
    },
  };
  return api;
}

function typeAndEnter(text: string): void {
  const input = screen.getByLabelText("検索");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("SearchPanel", () => {
  it("searches on Enter and displays the result tree", async () => {
    const api = createFakeApi({
      truncated: false,
      files: [
        file({}),
        file({
          relPath: "b.ts",
          path: "/ws/org1/repo-a/b.ts",
          matches: [{ line: 1, text: "let bar = 2;", start: 4, end: 7 }],
        }),
      ],
    });
    render(<SearchPanel api={api} />);
    await act(async () => {
      typeAndEnter("foo");
    });
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]?.query).toBe("foo");
    expect(await screen.findByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("const foo = 1;")).toBeTruthy();
  });

  it("does not call the API on an empty query", async () => {
    const api = createFakeApi({ truncated: false, files: [] });
    render(<SearchPanel api={api} />);
    await act(async () => {
      typeAndEnter("   ");
    });
    expect(api.calls).toHaveLength(0);
  });

  it("reflects the option toggles in the search request", async () => {
    const api = createFakeApi({ truncated: false, files: [] });
    render(<SearchPanel api={api} />);
    fireEvent.click(screen.getByLabelText("大文字と小文字を区別"));
    fireEvent.click(screen.getByLabelText("単語単位で一致"));
    fireEvent.click(screen.getByLabelText("正規表現を使用"));
    await act(async () => {
      typeAndEnter("Foo");
    });
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]).toMatchObject({
      query: "Foo",
      matchCase: true,
      wholeWord: true,
      regex: true,
    });
  });

  it("exposes the toggle pressed state via aria-pressed", () => {
    const api = createFakeApi({ truncated: false, files: [] });
    render(<SearchPanel api={api} />);
    const btn = screen.getByLabelText("正規表現を使用");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("displays 'No results' when there are 0 results", async () => {
    const api = createFakeApi({ truncated: false, files: [] });
    render(<SearchPanel api={api} />);
    await act(async () => {
      typeAndEnter("nope");
    });
    expect(await screen.findByText("結果なし")).toBeTruthy();
  });

  it("appends 'or more' to the count when truncated", async () => {
    const api = createFakeApi({ truncated: true, files: [file({})] });
    render(<SearchPanel api={api} />);
    await act(async () => {
      typeAndEnter("foo");
    });
    expect(await screen.findByText(/以上/)).toBeTruthy();
  });

  it("disables match rows when onOpen is not provided (display only)", async () => {
    const api = createFakeApi({ truncated: false, files: [file({})] });
    render(<SearchPanel api={api} />);
    await act(async () => {
      typeAndEnter("foo");
    });
    const row = await screen.findByText("const foo = 1;");
    const button = row.closest("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("passes file and line on clicking a match row when onOpen is provided", async () => {
    const api = createFakeApi({ truncated: false, files: [file({})] });
    const opened: { relPath: string; line: number }[] = [];
    render(
      <SearchPanel
        api={api}
        onOpen={(f, line) => opened.push({ relPath: f.relPath, line })}
      />,
    );
    await act(async () => {
      typeAndEnter("foo");
    });
    const row = await screen.findByText("const foo = 1;");
    fireEvent.click(row.closest("button") as HTMLElement);
    expect(opened).toEqual([{ relPath: "src/a.ts", line: 3 }]);
  });

  it("labels the header SEARCH (uppercase, shared panel-title)", () => {
    const api = createFakeApi({ truncated: false, files: [] });
    render(<SearchPanel api={api} />);
    const title = screen.getByText("SEARCH");
    expect(title).toBeTruthy();
    expect(title.className).toContain("panel-title");
  });
});
