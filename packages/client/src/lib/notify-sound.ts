import { DEFAULT_SOUND_PRESET, type SoundPreset } from "@zashiki/shared";

export type { SoundPreset } from "@zashiki/shared";

interface PresetVoice {
  wave: OscillatorType;
  /** [frequency (Hz), start offset (seconds)] pairs, played in order. */
  tones: ReadonlyArray<readonly [number, number]>;
}

/**
 * The synthesized voice of each selectable preset. chime / descend / ping / pong / tick / tock
 * reproduce the historical per-category chirps; marimba (triangle) and bell (bright sine) add
 * audibly distinct choices.
 */
const PRESET_VOICES: Record<SoundPreset, PresetVoice> = {
  chime: {
    wave: "sine",
    tones: [
      [523.25, 0],
      [783.99, 0.16],
    ],
  },
  descend: {
    wave: "sine",
    tones: [
      [740, 0],
      [587, 0.16],
    ],
  },
  ping: {
    wave: "sine",
    tones: [
      [659.25, 0],
      [880, 0.12],
    ],
  },
  pong: {
    wave: "sine",
    tones: [
      [880, 0],
      [659.25, 0.12],
    ],
  },
  tick: {
    wave: "sine",
    tones: [
      [523.25, 0],
      [659.25, 0.12],
    ],
  },
  tock: {
    wave: "sine",
    tones: [
      [659.25, 0],
      [523.25, 0.12],
    ],
  },
  marimba: {
    wave: "triangle",
    tones: [
      [587.33, 0],
      [880, 0.1],
    ],
  },
  bell: {
    wave: "sine",
    tones: [
      [880, 0],
      [1318.51, 0.09],
    ],
  },
};

const TONE_SEC = 0.14;

/**
 * Plays a notification preset with a Web Audio synthesized tone (akin to Funk/Glass).
 * Silently gives up in environments without AudioContext, on autoplay blocking, etc.
 */
export function playNotifySound(preset: SoundPreset): void {
  try {
    const Ctor = globalThis.AudioContext;
    if (typeof Ctor !== "function") return;
    const voice = PRESET_VOICES[preset] ?? PRESET_VOICES[DEFAULT_SOUND_PRESET];
    const ctx = new Ctor();
    const now = ctx.currentTime;
    let end = now;
    for (const [freq, at] of voice.tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = voice.wave;
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
