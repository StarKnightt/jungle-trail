/* The score: every number that decides how the layers sit against each
 * other, in one place, shared verbatim by the offline renderer and the
 * live engine.
 *
 * This file exists because mix balance is the thing that gets verified by
 * rendering WAVs in Node — and that verification is worthless if the engine
 * then applies different levels. Neither mix.js nor engine.js is allowed a
 * private gain constant; they both read this table.
 */
import { clamp, smoothstep, dbToGain } from './dsp.js';

/* Per-layer trim in dB, applied after each texture/one-shot is normalized
 * to peak 1. Working in dB against normalized sources means a level here
 * survives any change to a layer's synthesis recipe.
 *
 * The shape of the table is the shape of a rainforest recording: insects
 * loudest and constant, birds clearly above the bed but intermittent, wind
 * mostly subliminal, and the falls given enough headroom to genuinely
 * dominate the last fifty metres — the brief's one explicit crescendo. */
export const LEVELS = {
  cicada: -25,
  crickets: -30,
  insectEvent: -30,
  birds: -20,
  wash: -31,
  rustle: -23,
  falls: -11,
  brook: -24,
  steps: -19,
  /* Six dB over a footstep. Both banks are normalized to peak 1, so this is
   * the whole of what makes a landing land: it is a rare, deliberate event
   * arriving after a moment of near-silence in the foreground, and levelling
   * it with a walking step would waste the only punctuation the player's own
   * movement has. Much more than this and it starts to duck the bed. */
  land: -13,
  /* The first render sat around -37 dBFS RMS in deep forest, which is a
   * whisper on any consumer output chain; +4 here puts the quiet end near
   * -31 and the falls finale near -24 with peaks around -8 — loud enough to
   * live at normal volume, with the compressor never touched except by a
   * close call landing on the crescendo. */
  master: 4,
};

export const levelGain = (name) => dbToGain(LEVELS[name]);

/* Trail geometry the audio needs, without importing path.js — path.js pulls
 * in three, which Node (and therefore the WAV tool) does not have. The
 * polyline length of the control points is ~422 m and the Catmull-Rom adds
 * a little curvature, so 430 is used everywhere t is converted to metres.
 * If the trail is re-authored these must be re-checked against Trail.length. */
export const TRAIL_LEN = 430;

/* Where the falls will live once System 5 builds it, derived from the
 * terrain constants: pool centre (0, -356), cliff plane z = -392, spillway
 * notch at x ≈ 1. The audible centre of a waterfall is the impact at its
 * base, so the main source sits at the plunge pool's rim; the lip source is
 * only there so that standing at the pool and looking up moves some hiss
 * with your head. System 5 should overwrite these via setWaterfallPosition. */
export const FALLS_BASE = { x: 1, y: 2.5, z: -388 };
export const FALLS_LIP = { x: 1, y: 15, z: -391 };

/** Straight-line-ish metres from trail position t to the falls' base. */
export function distToFalls(t) {
  return Math.max(5, (1 - clamp(t, 0, 1)) * TRAIL_LEN + 12);
}

/* The brook's lateral offset from the trail centre, in metres (negative is
 * the walker's left). Imported rather than copied: world/brook.js is the one
 * authority on where the channel is, and it deliberately imports nothing, so
 * the offline WAV renderer can read it in Node without pulling in three. A
 * private copy here drifted once already and put the babble on the far side
 * of the path from the water. */
export { brookOffset } from '../world/brook.js';

/** The brook fades in where the terrain starts carrying water (t ≈ 0.40+). */
export function brookGain(t) {
  return smoothstep(0.40, 0.54, t) * (1 - 0.6 * smoothstep(0.88, 0.97, t));
}

/* The insect bed thins slightly toward the clearing: partly the biome
 * (cicadas sit in closed canopy), mostly mix hygiene — the falls needs the
 * 4–6 kHz band it shares with the cicadas, and both at full level turned
 * the finale into undifferentiated hiss. */
export function insectTrailGain(t) {
  return 1 - 0.45 * smoothstep(0.72, 0.95, t);
}

/**
 * Inverse distance gain, matched exactly to a Web Audio PannerNode with
 * distanceModel 'inverse' and rolloffFactor 1: gain = ref / max(ref, d).
 * Matching the browser's own model is why the offline mix can be trusted
 * as a preview of what the PannerNode will do.
 */
export function distGain(d, ref = 8) {
  return ref / Math.max(ref, d);
}

/**
 * Air-absorption cutoff in Hz for a source d metres away. PannerNode
 * attenuates all frequencies equally, which is the main reason distant
 * sources sound "small" instead of "far" — real air eats treble first.
 * Both renderers put a one-pole lowpass with this cutoff on every
 * positional source. The constant is tuned steep because this forest is
 * dense: foliage scatters high frequencies far harder than open air.
 */
export function airCutoff(d) {
  return 18000 / (1 + d / 22);
}

/**
 * Footstep wetness from trail position, used only by the offline renderer
 * (the engine asks the real terrain via evalWet). Approximates: damp once
 * the brook appears, soaked in the spray zone by the pool.
 */
export function stepWetness(t) {
  return clamp(0.65 * smoothstep(0.40, 0.55, t) + smoothstep(0.86, 0.95, t), 0, 1);
}
