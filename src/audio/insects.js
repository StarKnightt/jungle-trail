/* Insects — the continuous bed of the soundscape.
 *
 * In any real rainforest recording the insects are the floor the rest sits
 * on: broadband, dense, and never silent. The design splits them by what can
 * loop and what cannot:
 *
 *  - Statistically stationary sound (a cicada chorus, continuous cricket
 *    trills) is baked into loops. A loop of stationary texture has no seam
 *    the ear can find, provided the *gestures* — the swells and lulls — are
 *    applied at runtime on top and therefore never repeat.
 *  - Anything with an identifiable shape (a katydid rasp burst, a discrete
 *    cricket chirp) is a one-shot, scheduled with exponential waits and
 *    played at a random position and rate. A shaped event inside a loop is
 *    the single fastest way to make ambience read as a recording on repeat.
 *
 * Loop lengths are deliberately awkward numbers, different per buffer, so
 * even the residual correlations between beds never line up twice.
 */
import {
  makeRng, rrange, expRand, biquad, clamp, smoothstep, normalize, loopify, TAU,
} from './dsp.js';

export const CICADA_LOOPS = [13.37, 11.73, 14.91];
export const CRICKET_LOOPS = [16.41, 13.93];

/**
 * One cicada "colony": a band of noise around 4–7 kHz with roughness.
 *
 * A single cicada is a pulse train, but a chorus of hundreds smears the
 * pulses into coloured noise — so the chorus is synthesized as the smear
 * directly, not as N oscillators. What stops it sounding like plain filtered
 * noise is the roughness modulator: real choruses beat against each other at
 * wing-muscle rates, ~150–220 Hz. An early version used a sine LFO there and
 * sounded like a fax machine; modulating with *narrowband noise* at the same
 * rate keeps the roughness without giving it a pitch.
 */
export function renderCicadaBed(sr, seed, seconds, colony = 0) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  // Each colony sits on its own centre so the three together fill the band
  // instead of stacking on one resonance and turning into a whistle.
  const fc = [5600, 4300, 6600][colony % 3] * rrange(rng, 0.96, 1.04);
  const bp1 = biquad('bandpass', sr, fc, 1.3);
  const bp2 = biquad('bandpass', sr, fc * 0.72, 2.0);
  const rough = biquad('bandpass', sr, rrange(rng, 155, 215), 2.4);
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    const m = clamp(rough.step(rng() * 2 - 1) * 3.2, -1, 1);
    out[i] = (bp1.step(w) + 0.45 * bp2.step(w)) * (0.65 + 0.35 * m);
  }
  return loopify(normalize(out), sr);
}

/**
 * A bed of continuous cricket trills: a few virtual insects, each a pure
 * tone gated by its own raised-cosine pulse train.
 *
 * The pulse rates and carriers are all slightly different on purpose — the
 * beating between four not-quite-equal trills is what makes the bed shimmer.
 * With identical rates it collapsed into one loud synthetic tone. Slow
 * per-triller vibrato keeps any single tone from sitting still long enough
 * to read as a test oscillator.
 */
export function renderCricketBed(sr, seed, seconds) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const trillers = [];
  for (let k = 0; k < 4; k++) {
    trillers.push({
      f: rrange(rng, 3900, 4900),
      pr: rrange(rng, 22, 38),           // pulses per second
      duty: rrange(rng, 0.45, 0.65),
      ph: rng() * TAU, pp: rng(),
      vibR: rrange(rng, 0.13, 0.37), vibD: rrange(rng, 8, 26),
      amp: rrange(rng, 0.4, 1.0),
    });
  }
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (const tr of trillers) {
      tr.pp += tr.pr / sr;
      const x = tr.pp % 1;
      const gate = x < tr.duty ? 0.5 - 0.5 * Math.cos(TAU * x / tr.duty) : 0;
      tr.ph += TAU * (tr.f + tr.vibD * Math.sin(TAU * tr.vibR * t)) / sr;
      s += Math.sin(tr.ph) * gate * tr.amp;
    }
    out[i] = s;
  }
  return loopify(normalize(out), sr);
}

/**
 * Katydid one-shot: a short series of harsh rasps. Ring-modulating highpassed
 * noise puts combs through the spectrum, which is what separates "insect
 * scraping a file" from plain hiss — a katydid's stridulation really is a
 * carrier (the tooth rate) multiplied by noise (the resonating wing).
 */
export function renderKatydid(sr, seed) {
  const rng = makeRng(seed);
  const rasps = 2 + Math.floor(rng() * 4);
  const durs = [], gaps = [];
  let total = 0.02;
  for (let k = 0; k < rasps; k++) {
    durs.push(rrange(rng, 0.035, 0.06));
    gaps.push(rrange(rng, 0.055, 0.095));
    total += durs[k] + gaps[k];
  }
  const out = new Float32Array(Math.round((total + 0.05) * sr));
  const hp = biquad('highpass', sr, 4500, 0.8);
  const carrier = rrange(rng, 850, 1250);
  let t0 = 0.02;
  for (let k = 0; k < rasps; k++) {
    const i0 = Math.round(t0 * sr), nn = Math.round(durs[k] * sr);
    for (let i = 0; i < nn; i++) {
      const u = i / nn;
      // Sharp attack, exponential-ish tail: a rasp is struck, not bowed.
      const env = Math.min(1, u * 12) * Math.exp(-u * 3.2);
      const ring = Math.sin(TAU * carrier * (i / sr));
      out[i0 + i] += hp.step(rng() * 2 - 1) * ring * env;
    }
    t0 += durs[k] + gaps[k];
  }
  return normalize(out);
}

/**
 * Field-cricket chirp one-shot: three or four clean tone pulses. This is the
 * classic near-field "chirp... chirp" that punctuates the continuous trill
 * bed and gives the ear individual insects to place in space.
 */
export function renderCricketChirp(sr, seed) {
  const rng = makeRng(seed);
  const pulses = 3 + (rng() < 0.4 ? 1 : 0);
  const f = rrange(rng, 4300, 4900);
  const pd = rrange(rng, 0.02, 0.028), gap = rrange(rng, 0.016, 0.022);
  const out = new Float32Array(Math.round(((pd + gap) * pulses + 0.04) * sr));
  let ph = 0;
  for (let k = 0; k < pulses; k++) {
    const i0 = Math.round(k * (pd + gap) * sr), nn = Math.round(pd * sr);
    for (let i = 0; i < nn; i++) {
      const env = 0.5 - 0.5 * Math.cos(TAU * i / nn);
      ph += TAU * f / sr;
      out[i0 + i] += Math.sin(ph) * env;
    }
  }
  return normalize(out);
}

/**
 * Scheduler for discrete insect events. Returns successive events with
 * monotonic times (seconds from ambience start); the engine consumes them
 * just ahead of the audio clock and the offline renderer consumes them for
 * the whole duration. Identical draws either way, which is the point.
 */
export function makeInsectEvents(seed) {
  const rng = makeRng(seed);
  let t = expRand(rng, 3);
  return {
    next() {
      const ev = {
        time: t,
        kind: rng() < 0.45 ? 'katydid' : 'chirp',
        variant: (rng() * 3) | 0,
        az: rng() * TAU,
        dist: rrange(rng, 4, 22),
        elev: rrange(rng, 0.4, 5),
        gain: rrange(rng, 0.4, 1.0),
        rate: rrange(rng, 0.92, 1.08),
      };
      t += expRand(rng, 5.5);
      return ev;
    },
  };
}

/**
 * Runtime swell for a cicada colony, 0.25..1. Rates are incommensurate per
 * colony so the three swells drift through every possible alignment instead
 * of breathing together; the floor is non-zero because a rainforest cicada
 * bed dips, but it never actually stops.
 */
export function cicadaSwell(gesture, t, colony) {
  const rate = [0.087, 0.061, 0.043][colony % 3];
  const v = clamp(0.5 + 0.5 * gesture(t * rate, 10 + colony), 0, 1);
  return 0.25 + 0.75 * Math.pow(v, 1.4);
}

/** Runtime gate for a cricket sub-bed: long "on" stretches, occasional lulls. */
export function cricketGate(gesture, t, k) {
  return smoothstep(-0.35, 0.05, gesture(t * 0.05 + k * 9.1, 30 + k));
}
