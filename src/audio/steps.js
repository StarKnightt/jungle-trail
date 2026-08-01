/* Footsteps and landings — the player's own weight on the trail.
 *
 * A footfall on forest floor is three overlapping things: a low heel thump
 * into damp ground, a scatter of leaf-litter crackles as the sole settles,
 * and — when the ground is wet — a suction squelch as it lifts. The dry and
 * wet versions are not one sound filtered two ways; the wet step *replaces*
 * crackle with squelch, so the synth takes wetness as a parameter and the
 * bank bakes discrete wetness levels for the engine to choose between.
 *
 * Timing is deliberately not handled here at all. The walker already owns a
 * gait clock (bobPhase) and fires onStep at each footfall, and fires onLand
 * when a jump's descent contacts the ground; synthesizing our own cadence
 * would drift against the visible head-bob within seconds, and a footstep
 * that lands off the bob is worse than no footstep.
 */
import {
  makeRng, rrange, biquad, clamp, lerp, normalize, TAU,
} from './dsp.js';

export const WET_LEVELS = [0, 0.5, 1];
export const STEP_VARIANTS = 6;
/* Fewer variants than footsteps because landings are rare and never
 * consecutive: repetition is audible in a sound you hear twice a second and
 * inaudible in one you hear every twenty. */
export const LAND_VARIANTS = 3;

/**
 * One footfall, ~0.30 s. `wetness` 0..1 crossfades the components and also
 * darkens everything: wet litter is heavier and moves less, so the whole
 * event loses top end, not just the crackles.
 */
export function renderFootstep(sr, seed, wetness) {
  const rng = makeRng(seed);
  const w = clamp(wetness, 0, 1);
  const n = Math.round(0.32 * sr);
  const out = new Float32Array(n);

  /* Heel thump. Pitch falls through the hit — soil compresses, the resonant
   * cavity shrinks — which the ear needs to read "mass landing"; a fixed
   * 60 Hz sine there sounded like a kick drum bleeding in from somewhere. */
  const f0 = rrange(rng, 58, 72) * (1 - 0.2 * w);
  let ph = 0;
  const thumpN = Math.round(0.09 * sr);
  for (let i = 0; i < thumpN; i++) {
    const u = i / thumpN;
    ph += TAU * f0 * (1 - 0.35 * u) / sr;
    out[i] += Math.sin(ph) * Math.exp(-u * 5.5) * 0.85;
  }

  /* Litter crackle: dozens of tiny bandpassed bursts in two clusters — the
   * heel strike and the toe roll ~90 ms later, which is the actual double
   * contact of a walking step. One evenly-spread cluster read as a single
   * "crunch" with no anatomy to it. */
  const crackles = Math.round(lerp(26, 9, w));
  const lpWet = biquad('lowpass', sr, lerp(9000, 1400, w), 0.707);
  for (let c = 0; c < crackles; c++) {
    const cluster = rng() < 0.62 ? 0 : 0.09;
    const t0 = cluster + Math.pow(rng(), 1.6) * 0.06;
    const i0 = Math.round(t0 * sr);
    const nn = Math.round(rrange(rng, 0.0015, 0.005) * sr);
    const bp = biquad('bandpass', sr, rrange(rng, 900, 4200), 2.2);
    const a = Math.pow(rng(), 2) * lerp(1, 0.5, w);
    for (let i = 0; i < nn && i0 + i < n; i++) {
      out[i0 + i] += bp.step(rng() * 2 - 1) * a * (1 - i / nn);
    }
  }

  /* Squelch: downward-chirping resonances plus a wet noise slap. The chirps
   * are the bubble model run in reverse — suction pulls air *into* mud, so
   * the cavities grow and the pitch drops, the opposite of the brook. */
  if (w > 0.05) {
    const chirps = 2 + ((rng() * 3) | 0);
    for (let c = 0; c < chirps; c++) {
      const t0 = rrange(rng, 0.05, 0.16);
      const i0 = Math.round(t0 * sr);
      const fS = rrange(rng, 380, 560);
      const tau = rrange(rng, 0.03, 0.07);
      const nn = Math.round(tau * 4 * sr);
      let p2 = TAU * rng();
      for (let i = 0; i < nn && i0 + i < n; i++) {
        const tt = i / sr;
        p2 += TAU * fS * (1 - 0.6 * (tt / (tau * 4))) / sr;
        out[i0 + i] += Math.sin(p2) * Math.exp(-tt / tau) * 0.5 * w;
      }
    }
    const slap = biquad('bandpass', sr, 550, 0.9);
    const slapN = Math.round(0.12 * sr);
    for (let i = 0; i < slapN; i++) {
      const u = i / slapN;
      out[i] += slap.step(rng() * 2 - 1) * Math.exp(-u * 4) * 0.4 * w;
    }
  }

  // The wet lowpass runs over the whole event last, so the thump's own
  // harmonics and the crackle tails darken together. The highpass after it
  // is DC hygiene: a decaying sine whose pitch falls through the hit has a
  // nonzero integral, and four steps a second of that adds up to a
  // measurable offset in the mix.
  lpWet.process(out);
  biquad('highpass', sr, 26, 0.707).process(out);
  return normalize(out);
}

/**
 * A landing from a jump, ~0.46 s. `wetness` behaves as it does for a step.
 *
 * This is not a footstep with the gain turned up, and the difference is
 * structural rather than a matter of level. A walking step is one foot
 * rolling heel-to-toe, which is why renderFootstep puts its litter crackle
 * in two clusters ~90 ms apart; a landing is both feet arriving flat and
 * fast, absorbing a downward velocity a walk never has. Playing a louder
 * step for it reads as someone stamping mid-stride, because the double
 * contact is still audible in it and two feet landing together cannot
 * produce one.
 */
export function renderLanding(sr, seed, wetness) {
  const rng = makeRng(seed);
  const w = clamp(wetness, 0, 1);
  const n = Math.round(0.46 * sr);
  const out = new Float32Array(n);

  const foot = (i0, f0, amp) => {
    /* Deeper than a step's thump and it falls further through the hit: the
     * ground is compressed harder, so the resonant cavity under the sole
     * collapses further and faster. */
    let ph = 0;
    const nn = Math.round(0.22 * sr);
    for (let i = 0; i < nn && i0 + i < n; i++) {
      const u = i / nn;
      ph += TAU * f0 * (1 - 0.45 * u) / sr;
      out[i0 + i] += Math.sin(ph) * Math.exp(-u * 4.2) * amp;
    }
    /* The compaction transient. Without a broadband edge at the moment of
     * contact the thump fades up out of silence and reads as a tom hit
     * rather than as something striking the ground. */
    const cl = biquad('lowpass', sr, rrange(rng, 1400, 2400), 0.8);
    const cn = Math.round(0.03 * sr);
    for (let i = 0; i < cn && i0 + i < n; i++) {
      out[i0 + i] += cl.step(rng() * 2 - 1) * Math.exp(-(i / cn) * 7) * amp * 0.5;
    }
  };

  /* Two feet, and never quite together. The offset is only a couple of dozen
   * milliseconds, but a single doubled thump has nothing in it that says
   * there are two legs taking the load, and it reads as a dropped object. */
  const lead = rrange(rng, 40, 52) * (1 - 0.18 * w);
  foot(0, lead, 0.9);
  foot(Math.round(rrange(rng, 0.014, 0.036) * sr), lead * rrange(rng, 1.04, 1.16), 0.72);

  /* Litter displaced rather than crackled: one cluster instead of the walk's
   * two, spread over a longer tail as what was thrown up settles back. */
  const scatter = Math.round(lerp(44, 16, w));
  const lpWet = biquad('lowpass', sr, lerp(8000, 1300, w), 0.707);
  for (let c = 0; c < scatter; c++) {
    const t0 = Math.pow(rng(), 1.9) * 0.28;
    const i0 = Math.round(t0 * sr);
    const nn = Math.round(rrange(rng, 0.0015, 0.006) * sr);
    const bp = biquad('bandpass', sr, rrange(rng, 800, 4600), 2.2);
    const a = Math.pow(rng(), 2) * lerp(1, 0.45, w) * (1 - t0 / 0.34);
    for (let i = 0; i < nn && i0 + i < n; i++) {
      out[i0 + i] += bp.step(rng() * 2 - 1) * a * (1 - i / nn);
    }
  }

  /* Wet ground takes the impact as one splat rather than the walk's several
   * suction chirps. The sole arrives flat and stays put, so water is thrown
   * outward in a single event instead of being drawn after a peeling foot;
   * the one slow chirp that remains is the ground closing again. */
  if (w > 0.05) {
    const slap = biquad('bandpass', sr, rrange(rng, 420, 620), 0.8);
    const slapN = Math.round(0.20 * sr);
    for (let i = 0; i < slapN && i < n; i++) {
      const u = i / slapN;
      out[i] += slap.step(rng() * 2 - 1) * Math.exp(-u * 3.2) * 0.62 * w;
    }
    const i0 = Math.round(rrange(rng, 0.03, 0.08) * sr);
    const fS = rrange(rng, 300, 430);
    const tau = rrange(rng, 0.05, 0.09);
    const nn = Math.round(tau * 4 * sr);
    let p2 = TAU * rng();
    for (let i = 0; i < nn && i0 + i < n; i++) {
      const tt = i / sr;
      p2 += TAU * fS * (1 - 0.6 * (tt / (tau * 4))) / sr;
      out[i0 + i] += Math.sin(p2) * Math.exp(-tt / tau) * 0.45 * w;
    }
  }

  // Same DC hygiene as the footstep, one octave lower: this thump's pitch
  // falls further, so its nonzero integral is correspondingly larger.
  lpWet.process(out);
  biquad('highpass', sr, 24, 0.707).process(out);
  return normalize(out);
}
