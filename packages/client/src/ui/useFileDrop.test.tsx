// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FILE_MAX_BYTES } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FileDropError, useFileDrop } from "./useFileDrop.js";

afterEach(cleanup);

function Harness(props: {
  onFile: (name: string, content: string) => void;
  onMedia?: (name: string, file: File, kind: "image" | "video") => void;
  onError: (name: string, error: FileDropError) => void;
}) {
  const drop = useFileDrop(
    props.onFile,
    props.onMedia ?? vi.fn(),
    props.onError,
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop receiver under test, not an interactive widget
    <div data-testid="zone" onDragOver={drop.onDragOver} onDrop={drop.onDrop} />
  );
}

function transfer(types: string[], files: File[] = []): DataTransfer {
  return { types, files } as unknown as DataTransfer;
}

describe("useFileDrop", () => {
  it("reads a dropped file and reports its name and content", async () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} onError={vi.fn()} />);
    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: transfer(["Files"], [new File(["hello"], "a.txt")]),
    });
    await waitFor(() => expect(onFile).toHaveBeenCalledWith("a.txt", "hello"));
  });

  it("suppresses the default on dragover so the drop fires (only for file drags)", () => {
    render(<Harness onFile={vi.fn()} onError={vi.fn()} />);
    const zone = screen.getByTestId("zone");
    expect(
      fireEvent.dragOver(zone, { dataTransfer: transfer(["Files"]) }),
    ).toBe(false);
    expect(
      fireEvent.dragOver(zone, { dataTransfer: transfer(["text/plain"]) }),
    ).toBe(true);
  });

  it("ignores drags that carry no OS files (e.g. tab reordering)", () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} onError={vi.fn()} />);
    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: transfer(["text/plain"]),
    });
    expect(onFile).not.toHaveBeenCalled();
  });

  it("routes a dropped image to onMedia without reading it as text", () => {
    const onFile = vi.fn();
    const onMedia = vi.fn();
    render(<Harness onFile={onFile} onMedia={onMedia} onError={vi.fn()} />);
    const img = new File(["PNG"], "logo.png");
    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: transfer(["Files"], [img]),
    });
    expect(onMedia).toHaveBeenCalledWith("logo.png", img, "image");
    expect(onFile).not.toHaveBeenCalled();
  });

  it("routes an oversize video to onMedia (media has no size cap)", () => {
    const onMedia = vi.fn();
    const onError = vi.fn();
    render(<Harness onFile={vi.fn()} onMedia={onMedia} onError={onError} />);
    const big = new File(["x"], "clip.mp4");
    Object.defineProperty(big, "size", { value: FILE_MAX_BYTES + 1 });
    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: transfer(["Files"], [big]),
    });
    expect(onMedia).toHaveBeenCalledWith("clip.mp4", big, "video");
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects a file over the size cap without reading it", () => {
    const onFile = vi.fn();
    const onError = vi.fn();
    render(<Harness onFile={onFile} onError={onError} />);
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: FILE_MAX_BYTES + 1 });
    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: transfer(["Files"], [big]),
    });
    expect(onError).toHaveBeenCalledWith("big.bin", "tooLarge");
    expect(onFile).not.toHaveBeenCalled();
  });
});
