export type NotifyKind = "waiting" | "done";

/** Two tones per kind (Hz and start second). waiting descends (a question); done ascends (completion). */
const TONES: Record<NotifyKind, ReadonlyArray<readonly [number, number]>> = {
  waiting: [
    [740, 0],
    [587, 0.16],
  ],
  done: [
    [523.25, 0],
    [783.99, 0.16],
  ],
};

const TONE_SEC = 0.14;

/**
 * Plays the notification sound with a Web Audio synthesized tone (akin to Funk/Glass).
 * Silently gives up in environments without AudioContext, on autoplay blocking, etc.
 */
export function playNotifySound(kind: NotifyKind): void {
  try {
    const Ctor = globalThis.AudioContext;
    if (typeof Ctor !== "function") return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    let end = now;
    for (const [freq, at] of TONES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // A mini envelope to prevent click noise
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.2, now + at + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + at + TONE_SEC);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + TONE_SEC);
      end = now + at + TONE_SEC;
    }
    setTimeout(
      () => {
        void ctx.close().catch(() => undefined);
      },
      (end - now) * 1000 + 100,
    );
  } catch {
    // Sound is best-effort (does not block the notification itself)
  }
}
