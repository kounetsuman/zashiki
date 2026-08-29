import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal Web Audio graph that records node construction and connections, so the tests can assert
// the routing (shared context, limiter before destination) rather than any audible output.

class FakeNode {
  readonly connections: FakeNode[] = [];
  connect(target: FakeNode): void {
    this.connections.push(target);
  }
}

class FakeParam {
  value = 0;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
}

class FakeOscillator extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

const constructed: FakeAudioContext[] = [];

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  destination = new FakeNode();
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly compressors: FakeCompressor[] = [];
  resumed = 0;

  constructor() {
    constructed.push(this);
  }
  createOscillator(): FakeOscillator {
    const o = new FakeOscillator();
    this.oscillators.push(o);
    return o;
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor(): FakeCompressor {
    const c = new FakeCompressor();
    this.compressors.push(c);
    return c;
  }
  resume(): Promise<void> {
    this.resumed += 1;
    this.state = "running";
    return Promise.resolve();
  }
}

function installFakeAudio(): void {
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
}

function req<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

async function loadModule() {
  vi.resetModules();
  return import("./notify-sound.js");
}

beforeEach(() => {
  constructed.length = 0;
});

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

describe("playNotifySound", () => {
  it("reuses a single AudioContext across successive calls", async () => {
    installFakeAudio();
    const { playNotifySound } = await loadModule();

    playNotifySound("chime");
    playNotifySound("ping");

    expect(constructed).toHaveLength(1);
  });

  it("routes every tone through a limiter before the destination", async () => {
    installFakeAudio();
    const { playNotifySound } = await loadModule();

    playNotifySound("chime");

    const ctx = req(constructed[0]);
    const limiter = req(ctx.compressors[0]);
    // master gain -> limiter -> destination; nothing reaches the destination directly.
    const master = req(ctx.gains[0]);
    expect(master.connections).toContain(limiter);
    expect(limiter.connections).toContain(ctx.destination);
    for (const gain of ctx.gains.slice(1)) {
      expect(gain.connections).toContain(master);
      expect(gain.connections).not.toContain(ctx.destination);
    }
    for (const osc of ctx.oscillators) {
      expect(osc.connections).not.toContain(ctx.destination);
    }
  });

  it("resumes a context suspended by the autoplay policy", async () => {
    installFakeAudio();
    const { playNotifySound } = await loadModule();

    playNotifySound("chime");
    req(constructed[0]).state = "suspended";
    playNotifySound("chime");

    expect(req(constructed[0]).resumed).toBe(1);
  });

  it("is a no-op when AudioContext is unavailable", async () => {
    const { playNotifySound } = await loadModule();

    expect(() => playNotifySound("chime")).not.toThrow();
    expect(constructed).toHaveLength(0);
  });
});
