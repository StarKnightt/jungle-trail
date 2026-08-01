/* Water — the brook beside the trail and the falls at the end of it.
 *
 * The brief's one explicit sound cue is "birds and water getting louder as
 * you approach the falls", so the water layer is built to change *character*
 * with distance, not just level. A waterfall at 300 m is a low grey rumble
 * with no top end at all; at 30 m the cascade's mid-band arrives; only in
 * the last dozen metres does the spray hiss exist. Level alone cannot say
 * that — a quiet full-spectrum waterfall sounds like a small one nearby,
 * never a big one far away.
 *
 * So the falls is baked as three stationary textures (rumble / cascade /
 * spray) whose balance is a pure function of distance, shared verbatim by
 * the offline renderer and the engine. The brook is a fourth texture built
 * from an actual physical model, because filtered noise alone never babbles.
 */
import {
  makeRng, rrange, expRand, biquad, makePink, clamp, normalize, loopify, TAU,
} from './dsp.js';

export const RUMBLE_LOOP = 12.71;
export const CASCADE_LOOP = 9.83;
export const SPRAY_LOOP = 7.87;
export const BABBLE_LOOP = 11.13;

/* Every water texture gets a slow "churn" AM baked in: water is stationary
 * in spectrum but not in envelope — the mass falling past any point
 * fluctuates at a few hertz, and without that unevenness the texture reads
 * as a broken TV, which is exactly what an early all-static version did. */
function churn(sr, rng, rate, depth) {
  const lp = biquad('lowpass', sr, rate, 0.707);
  return () => 1 - depth + depth * clamp(0.5 + lp.step((rng() * 2 - 1) * 6), 0, 1);
}

/** The falls' body: what carries hundreds of metres through forest. */
export function renderRumble(sr, seed, seconds = RUMBLE_LOOP) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  // Two lowpass passes give a 24 dB/oct shoulder; one pass left enough
  // mid-band that the "distant" falls already contained its own arrival.
  const lp1 = biquad('lowpass', sr, 110, 0.707);
  const lp2 = biquad('lowpass', sr, 160, 0.707);
  const pk = biquad('peaking', sr, 45, 1.0, 6);
  // The lowpasses pass DC along with the 40 Hz, and at the plunge pool this
  // texture plays near full level — enough for the offset to show up as a
  // measurable DC term in the mix. Sub-audible highpass takes it out.
  const hp = biquad('highpass', sr, 20, 0.707);
  const am = churn(sr, rng, 0.9, 0.3);
  for (let i = 0; i < n; i++) {
    out[i] = hp.step(pk.step(lp2.step(lp1.step(rng() * 2 - 1)))) * am();
  }
  return loopify(normalize(out), sr, 0.15);
}

/** The mid-band of falling water, audible from a few tens of metres. */
export function renderCascade(sr, seed, seconds = CASCADE_LOOP) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const pink = makePink(rng);
  const hp = biquad('highpass', sr, 240, 0.707);
  const lp = biquad('lowpass', sr, 3200, 0.707);
  const am = churn(sr, rng, 2.6, 0.22);
  for (let i = 0; i < n; i++) out[i] = lp.step(hp.step(pink())) * am();
  return loopify(normalize(out), sr);
}

/** Spray and mist — pure top end, near-field only. */
export function renderSpray(sr, seed, seconds = SPRAY_LOOP) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const hp = biquad('highpass', sr, 3500, 0.707);
  // Shimmer sits faster than the body's churn: droplets, not mass.
  const am = churn(sr, rng, 9, 0.25);
  for (let i = 0; i < n; i++) out[i] = hp.step(rng() * 2 - 1) * am();
  return loopify(normalize(out), sr);
}

/**
 * The brook: van den Doel's bubble model over a pink underlay.
 *
 * Each bubble is a decaying sine whose pitch *rises* as it decays — the
 * Minnaert resonance climbing as the bubble shrinks toward the surface.
 * That upward chirp is the entire difference between "babbling" and "hiss
 * through a bandpass"; the ear identifies running water by those chirps,
 * and no amount of filtered noise produces them. Poisson arrivals at ~90/s,
 * log-uniform pitches so small bright bubbles vastly outnumber the low
 * gloops, amplitude tilted toward the low ones because big bubbles move
 * more water.
 */
export function renderBabble(sr, seed, seconds = BABBLE_LOOP) {
  const rng = makeRng(seed);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);

  let t = 0;
  while (t < seconds) {
    t += expRand(rng, 1 / 90);
    const f0 = 350 * Math.exp(rng() * Math.log(1800 / 350));
    const tau = rrange(rng, 0.008, 0.025);
    const amp = Math.pow(400 / f0, 0.5) * rrange(rng, 0.4, 1.0) * (rng() < 0.5 ? -1 : 1);
    const i0 = Math.round(t * sr);
    const nn = Math.round(tau * 5 * sr);
    let ph = TAU * rng();
    for (let i = 0; i < nn; i++) {
      const tt = i / sr;
      ph += TAU * f0 * (1 + 0.5 * (tt / (tau * 5))) / sr;
      // Wrap tails around the loop end: a Poisson process has no seam as
      // long as no event is truncated by one.
      out[(i0 + i) % n] += Math.sin(ph) * Math.exp(-tt / tau) * amp;
    }
  }

  const pink = makePink(rng);
  const bp = biquad('bandpass', sr, 900, 0.8);
  normalize(out, 0.85);
  for (let i = 0; i < n; i++) out[i] += bp.step(pink()) * 0.18;
  return loopify(normalize(out), sr);
}

/**
 * How the falls' three textures balance against distance, before the shared
 * inverse-distance gain and air-absorption lowpass are applied on top.
 * Returned as multipliers so the same numbers drive offline block gains and
 * online GainNode targets.
 */
export function fallsBalance(d) {
  return {
    rumble: 1,
    cascade: 34 / (34 + d),
    spray: Math.pow(clamp(1 - d / 50, 0, 1), 1.6),
  };
}
