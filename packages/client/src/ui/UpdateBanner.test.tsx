// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { ZASHIKI_RELEASES_URL } from "@zashiki/shared";
import { afterEach, describe, expect, it } from "vitest";

import { UpdateBanner } from "./UpdateBanner.js";

afterEach(cleanup);

describe("UpdateBanner", () => {
  it("renders nothing when no update is available", () => {
    const { container } = render(<UpdateBanner version={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("links to the releases page and names the version in the tooltip", () => {
    render(<UpdateBanner version="0.2.0" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(ZASHIKI_RELEASES_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("title")).toContain("0.2.0");
  });
});
