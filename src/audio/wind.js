/* Wind — the canopy overhead.
 *
 * Under a closed canopy you barely feel wind; you *hear* it arrive in the
 * leaves above and pass over. Two textures carry that:
 *
 *  - a low "wash" (pink noise, lowpassed) that is the air itself and is
 *    always faintly present, and
 *  - a "rustle" (broadband granular noise) that is the leaves, and only
 *    exists when a gust is actually pushing them.
 *
 * The gust envelope is the part that must never repeat, so it is not baked:
 * it is a pure function of time built from two incommensurate Perlin rates,
 * evaluated at control rate by both the engine and the offline renderer.
 * The rustle follows a *thresholded* copy of it — leaves need real wind
 * before they move at all — which is what gives gusts a beginning and an
 * end instead of the whole layer just breathing louder and softer.
 */
import {
  makeRng, rrange, biquad, makePink, clamp, smoothstep, normalize, loopify,
} from './dsp.js';

export const RUSTLE_LOOPS = [9.31, 10.69];
export const WASH_LOOP = 12.07;

/**
 * Leaf rustle texture. Broadband noise alone sounds like tape hiss; the
 * micro-AM at ~40 Hz chops it into the small dry collisions actual foliage
 * makes. The modulator is half-wave shaped so the grains have silence
 * between them — symmetric AM just sounded like slower hiss.
 */
export function renderRustle(sr, seed, seconds) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const bp = biquad('bandpass', sr, rrange(rng, 2600, 3400), 0.35);
  const gateLp = biquad('lowpass', sr, rrange(rng, 32, 48), 0.707);
  for (let i = 0; i < n; i++) {
    const g = Math.max(0, gateLp.step((rng() * 2 - 1) * 8));
    out[i] = bp.step(rng() * 2 - 1) * (0.25 + 0.75 * Math.min(1, g * g * 3));
  }
  return loopify(normalize(out), sr);
}

/** The air component: felt more than heard, it fills the floor of the mix. */
export function renderWash(sr, seed, seconds = WASH_LOOP) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const pink = makePink(rng);
  const lp = biquad('lowpass', sr, 350, 0.707);
  for (let i = 0; i < n; i++) out[i] = lp.step(pink());
  return loopify(normalize(out), sr, 0.15);
}

/**
 * Gust strength at time t, 0..1. Two rates: the slow one is weather (does
 * the next half-minute have wind in it), the fast one is the individual
 * gust. Either alone was wrong — only-slow never surprises, only-fast
 * flutters like a flag.
 */
export function gustEnvelope(gesture, t) {
  const v = 0.55 * gesture(t * 0.045, 51) + 0.45 * gesture(t * 0.21, 52);
  return clamp(0.5 + 0.62 * v, 0, 1);
}

/** Wash gain from gust strength: present at rest, filled out in gusts. */
export function washGain(g) { return 0.35 + 0.65 * g; }

/**
 * Rustle gain from gust strength: thresholded, then curved so the loudest
 * gusts open up disproportionately. The left/right channels of the canopy
 * evaluate this at slightly offset times, which makes a gust cross the
 * canopy overhead instead of switching on in both ears at once.
 */
export function rustleGain(g) { return Math.pow(smoothstep(0.36, 0.92, g), 1.5); }

/** Seconds the right channel lags the left: the gust's travel time. */
export const RUSTLE_LAG = 0.35;
