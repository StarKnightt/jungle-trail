/* Audio DSP primitives.
 *
 * Everything in this file — and in the layer files built on it — is pure
 * sample arithmetic: parameters in, Float32Arrays out. No Web Audio, no DOM,
 * no three. The split is load-bearing: the browser's audio graph cannot run
 * in Node, so synthesis welded to it could only ever be judged by ear in a
 * live session. Kept pure, the exact code the game plays is rendered to WAV
 * by tools/audio.mjs and measured there, which is how this system is
 * verified without launching a browser.
 *
 * The PRNG and the gesture noise both come from world/noise.js so that audio
 * randomness follows the same conventions as terrain randomness: seeded,
 * reproducible, and never Math.random — a render that cannot be reproduced
 * cannot be compared against the previous one.
 */
import { makeRng, Noise2D, clamp, lerp, smoothstep } from '../world/noise.js';

export { makeRng, clamp, lerp, smoothstep };

export const TAU = Math.PI * 2;

export const dbToGain = (db) => Math.pow(10, db / 20);

/** Uniform in [a, b). */
export const rrange = (rng, a, b) => a + rng() * (b - a);

/* Exponentially distributed waits are what make event timing sound natural.
 * A uniform jitter around a mean still has a mean the ear finds within a
 * minute; the exponential's memorylessness means the next call is never
 * "due", which is exactly how real birds fail to be predictable. */
export const expRand = (rng, mean) => -Math.log(1 - rng()) * mean;

/**
 * RBJ cookbook biquad. Returned as a closure with per-instance state rather
 * than a class because every layer wants several of them chained, and the
 * call site reads better as `bp.step(x)` than as method dispatch on a struct
 * of coefficients.
 */
export function biquad(kind, sr, f0, Q = 0.707, dbGain = 0) {
  const A = Math.pow(10, dbGain / 40);
  // Clamped below Nyquist: a bandpass asked for 9 kHz at a 16 kHz test rate
  // must degrade to "as high as representable", not to a filter that blows up.
  const w0 = TAU * Math.min(f0, sr * 0.47) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  switch (kind) {
    case 'lowpass':  b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    // The constant-0dB-peak variant, so moving a band's centre never moves
    // its level — centre frequency and loudness stay independent knobs.
    case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'peaking':  b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
    default: throw new Error('biquad: unknown kind ' + kind);
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const step = (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
  return {
    step,
    process(buf) { for (let i = 0; i < buf.length; i++) buf[i] = step(buf[i]); return buf; },
  };
}

/**
 * One-pole lowpass with a settable cutoff. The biquad above is for shaping a
 * spectrum; this one is for *moving* a cutoff at control rate (air absorption
 * that changes with distance), where a biquad's coefficients would need
 * recomputing per block anyway and its resonance is unwanted.
 */
export function onePoleLP(sr, fc) {
  let a = 1 - Math.exp(-TAU * fc / sr);
  let y = 0;
  return {
    step(x) { y += a * (x - y); return y; },
    set(f) { a = 1 - Math.exp(-TAU * Math.max(10, f) / sr); },
  };
}

/* Paul Kellet's economy pink filter. Water and wind are both closer to pink
 * than white — equal energy per octave is what broadband natural sources
 * actually do — and starting from white and equalising down by hand always
 * left an audible fizz above 8 kHz that no real river has. */
export function makePink(rng) {
  let b0 = 0, b1 = 0, b2 = 0;
  return () => {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    return (b0 + b1 + b2 + w * 0.1848) * 0.18;
  };
}

/** Scale in place so the largest magnitude sits at `peak`. */
export function normalize(buf, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  if (m > 1e-9) { const k = peak / m; for (let i = 0; i < buf.length; i++) buf[i] *= k; }
  return buf;
}

/**
 * Make a buffer loop seamlessly by folding its tail into its head with an
 * equal-power crossfade, returning a buffer shorter by the fade. Equal-power
 * rather than linear because everything looped here is noise-like: the two
 * ends are uncorrelated, so a linear fade dips ~3 dB at the midpoint and the
 * seam becomes audible as a periodic breath — which is precisely the
 * "obvious loop" failure this whole system is built to avoid.
 */
export function loopify(buf, sr, fadeSec = 0.08) {
  const F = Math.min(buf.length >> 1, Math.round(fadeSec * sr));
  const N = buf.length - F;
  const out = new Float32Array(N);
  out.set(buf.subarray(0, N));
  for (let i = 0; i < F; i++) {
    const w = (i + 1) / (F + 1);
    out[i] = buf[i] * Math.sin(w * Math.PI / 2) + buf[N + i] * Math.cos(w * Math.PI / 2);
  }
  return out;
}

/**
 * 1-D control-rate noise for gestures (swells, gusts, lulls), built on the
 * project's Perlin so it is smooth and seeded. Smoothness matters: gain
 * curves driven by white noise sound like a faulty cable, not like weather.
 */
export function makeGesture(seed) {
  const n = new Noise2D(seed);
  // The second axis picks the "channel": callers pass a small integer k and
  // get statistically independent curves without needing k separate tables.
  return (t, k = 0) => n.n(t, k * 17.31 + 5.7);
}

/** Equal-power stereo pan gains for p in [-1, 1]. */
export function panGains(p) {
  const a = (clamp(p, -1, 1) + 1) * Math.PI / 4;
  return [Math.cos(a), Math.sin(a)];
}
