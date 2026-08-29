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
const MASTER_GAIN = 0.2;

/**
 * One long-lived context (avoids the per-call startup glitch) feeding a limiter, so overlapping
 * notifications sum without clipping past the 0 dBFS ceiling. Lazy so no context is opened until the
 * first sound plays. Held for the page lifetime; the browser reclaims it on unload.
 */
let audio: { ctx: AudioContext; master: GainNode } | null = null;

function sharedAudio(): { ctx: AudioContext; master: GainNode } | null {
  const Ctor = globalThis.AudioContext;
  if (typeof Ctor !== "function") return null;
  if (audio === null) {
    const ctx = new Ctor();
    // Engages only near full scale, so a single tone passes through untouched.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    audio = { ctx, master };
  }
  return audio;
}

/**
 * Plays a notification preset with a Web Audio synthesized tone (akin to Funk/Glass).
 * Silently gives up in environments without AudioContext, on autoplay blocking, etc.
 */
export function playNotifySound(preset: SoundPreset): void {
  try {
    const shared = sharedAudio();
    if (shared === null) return;
    const { ctx, master } = shared;
    // Autoplay policy can leave the context suspended until a user gesture.
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const voice = PRESET_VOICES[preset] ?? PRESET_VOICES[DEFAULT_SOUND_PRESET];
    const now = ctx.currentTime;
    for (const [freq, at] of voice.tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = voice.wave;
      osc.frequency.value = freq;
      // A mini envelope to prevent click noise
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(1, now + at + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + at + TONE_SEC);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + at);
      osc.stop(now + at + TONE_SEC);
    }
  } catch {
    // Sound is best-effort (does not block the notification itself)
  }
}
