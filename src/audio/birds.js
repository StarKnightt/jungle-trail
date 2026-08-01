/* Birds — sparse, individual, placed in space.
 *
 * Bird calls are the one layer where the ear grants no statistical mercy: a
 * bed can be texture, but a call is a *gesture*, and a gesture repeated
 * identically is instantly a sample on a timer. Three defences here:
 *
 *  - Every call is synthesized from a seed, so the engine holds several
 *    variants per species and no two renders of the bank are alike.
 *  - Playback adds a small rate jitter on top, so even the same variant
 *    never lands at the same pitch twice.
 *  - The scheduler thinks in *bouts*, not calls: a bird calls a few times
 *    from one position with irregular gaps, then goes quiet for an
 *    exponentially long time. Real birds repeat locally and are silent
 *    globally; a per-call uniform timer gets both of those wrong.
 *
 * The species are invented, but each is built on a real syrinx trick:
 * near-pure whistles, low hoots with a couple of harmonics, fast FM trills,
 * and one harsh harmonic-stack screech kept far away.
 */
import {
  makeRng, rrange, expRand, biquad, smoothstep, normalize, TAU,
} from './dsp.js';

/* Envelope with smooth attack and release as fractions of the note. All the
 * species use it because a bird's syrinx cannot start or stop a tone
 * instantly, and a tone that does reads as a beep, not a call. */
const env = (u, atk, rel) => smoothstep(0, atk, u) * smoothstep(1, 1 - rel, u);

/** Add a partial stack with a frequency trajectory into `out`. */
function addTone(out, sr, t0, dur, fFn, aFn, partials) {
  const i0 = Math.round(t0 * sr), n = Math.round(dur * sr);
  let ph = 0;
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const u = i / n;
    ph += TAU * fFn(u) / sr;
    let s = 0;
    for (let k = 0; k < partials.length; k++) s += partials[k][1] * Math.sin(ph * partials[k][0]);
    out[i0 + i] += s * aFn(u);
  }
}

/* Each renderer plans its notes first, then allocates, so a call is exactly
 * as long as its content — one-shot buffers with seconds of trailing silence
 * are pure wasted memory once multiplied across a bank. */

function whistler(sr, rng) {
  // Two to four clear descending whistles — the "someone whistling in the
  // canopy" voice that carries a rainforest's middle distance.
  const notes = 2 + ((rng() * 2.4) | 0);
  const plan = [];
  let t = 0.03, f0 = 2350 * rrange(rng, 0.94, 1.06);
  for (let k = 0; k < notes; k++) {
    const dur = rrange(rng, 0.34, 0.5);
    plan.push({ t, dur, f: f0 * Math.pow(0.955, k) });
    t += dur + rrange(rng, 0.24, 0.45);
  }
  const out = new Float32Array(Math.round((t + 0.1) * sr));
  for (const nt of plan) {
    const vr = rrange(rng, 5.4, 7.2);
    addTone(out, sr, nt.t, nt.dur,
      (u) => nt.f * (1 - 0.2 * u) * (1 + 0.007 * Math.sin(TAU * vr * u * nt.dur)),
      (u) => env(u, 0.18, 0.3),
      [[1, 1], [2, 0.05]]);
  }
  return out;
}

function hooter(sr, rng) {
  // Low double hoot, motmot-like. Almost sinusoidal; the faint 2nd and 3rd
  // harmonics are what make it a chest voice instead of a test tone.
  const f0 = rrange(rng, 520, 600);
  const dur = rrange(rng, 0.26, 0.32), gap = rrange(rng, 0.18, 0.26);
  const out = new Float32Array(Math.round((2 * dur + gap + 0.12) * sr));
  for (let k = 0; k < 2; k++) {
    addTone(out, sr, 0.02 + k * (dur + gap), dur,
      (u) => f0 * (1 - 0.13 * u) * (k ? 0.97 : 1),
      (u) => env(u, 0.28, 0.35),
      [[1, 1], [2, 0.13], [3, 0.03]]);
  }
  return out;
}

function chirper(sr, rng) {
  // Sharp rising chirps in a doublet or triplet — a manakin-like understory
  // voice, close and bright. The exponential rise matters: a linear sweep of
  // the same width sounds like a slide whistle, because pitch is log.
  const chirps = 2 + (rng() < 0.4 ? 1 : 0);
  const dur = rrange(rng, 0.055, 0.075), gap = rrange(rng, 0.08, 0.13);
  const f0 = rrange(rng, 1700, 2000);
  const out = new Float32Array(Math.round((chirps * (dur + gap) + 0.08) * sr));
  for (let k = 0; k < chirps; k++) {
    addTone(out, sr, 0.01 + k * (dur + gap), dur,
      (u) => f0 * Math.pow(2, u * rrange(rng, 0.85, 1.05)),
      (u) => env(u, 0.1, 0.25),
      [[1, 1], [2, 0.22]]);
  }
  return out;
}

function trill(sr, rng) {
  // Wren-like rattle: fast FM with the AM locked to it. Syncing the two is
  // the realism trick — a syrinx modulates airflow and pitch with the same
  // muscle, so amplitude dips exactly when pitch dips. Unsynced they sound
  // like two effects on one tone.
  const dur = rrange(rng, 0.7, 1.1);
  const fc = rrange(rng, 2700, 3100), fr = rrange(rng, 20, 27), depth = rrange(rng, 320, 420);
  const out = new Float32Array(Math.round((dur + 0.1) * sr));
  addTone(out, sr, 0.02, dur,
    (u) => fc + depth * Math.sin(TAU * fr * u * dur),
    (u) => env(u, 0.12, 0.3) * (0.62 + 0.38 * Math.sin(TAU * fr * u * dur - Math.PI / 2)),
    [[1, 1], [2, 0.08]]);
  return out;
}

function screech(sr, rng) {
  // Parrot-ish screech: a harmonic stack roughened by ~100 Hz AM, with a
  // band of noise mixed in. Kept for distance only — the scheduler never
  // places it close, because up close it is grating in exactly the way a
  // real macaw is, and this walk is supposed to be pleasant.
  const calls = 2 + (rng() < 0.3 ? 1 : 0);
  const dur = rrange(rng, 0.2, 0.26), gap = rrange(rng, 0.12, 0.2);
  const f0 = rrange(rng, 980, 1180);
  const out = new Float32Array(Math.round((calls * (dur + gap) + 0.1) * sr));
  const partials = [];
  for (let h = 1; h <= 6; h++) partials.push([h, 1 / Math.pow(h, 0.8)]);
  const bp = biquad('bandpass', sr, 2800, 1.0);
  for (let k = 0; k < calls; k++) {
    const t0 = 0.02 + k * (dur + gap);
    addTone(out, sr, t0, dur,
      (u) => f0 * (1 - 0.08 * u),
      (u) => env(u, 0.07, 0.2) * (0.7 + 0.3 * Math.sin(TAU * 105 * u * dur)) * 0.55,
      partials);
    const i0 = Math.round(t0 * sr), nn = Math.round(dur * sr);
    for (let i = 0; i < nn && i0 + i < out.length; i++) {
      out[i0 + i] += bp.step(rng() * 2 - 1) * env(i / nn, 0.07, 0.2) * 0.5;
    }
  }
  return out;
}

const RENDER = { whistler, hooter, chirper, trill, screech };

/**
 * Behavioural table. `weight(t)` shifts the cast along the trail: the
 * screech and the bright chirper belong to the broken canopy near the
 * clearing, the low hooter to deep forest — so the birdlife changes as the
 * light does, which is one of the ways the walk avoids feeling like one
 * looped biome.
 */
export const SPECIES = {
  whistler: { meanQuiet: 42, bout: [2, 4], callGap: [2.2, 5.5], dist: [10, 32], elev: [4, 12], gain: 0.85, weight: () => 1 },
  hooter:   { meanQuiet: 55, bout: [3, 6], callGap: [1.6, 3.4], dist: [12, 38], elev: [2, 8],  gain: 0.95, weight: (t) => 1 - 0.6 * smoothstep(0.7, 0.95, t) },
  chirper:  { meanQuiet: 26, bout: [2, 5], callGap: [1.2, 3.0], dist: [5, 18],  elev: [1, 5],  gain: 0.6,  weight: (t) => 0.55 + 0.45 * smoothstep(0.3, 0.8, t) },
  trill:    { meanQuiet: 34, bout: [1, 3], callGap: [3.0, 6.0], dist: [8, 26],  elev: [2, 9],  gain: 0.7,  weight: () => 1 },
  screech:  { meanQuiet: 95, bout: [2, 3], callGap: [1.0, 2.2], dist: [35, 75], elev: [10, 25], gain: 1.0, weight: (t) => 0.35 + 0.65 * smoothstep(0.55, 0.9, t) },
};

export function renderBirdCall(sr, species, seed) {
  return normalize(RENDER[species](sr, makeRng(seed)));
}

/**
 * Bout-based scheduler. `next(trailT)` returns the chronologically next call
 * across all species. `densityScale` < 1 compresses the quiet gaps; the demo
 * renders use it so a 30-second WAV shows several species without waiting
 * out real-forest silences.
 */
export function makeBirdScheduler(seed, densityScale = 1) {
  const rng = makeRng(seed);
  const names = Object.keys(SPECIES);
  let boutSeq = 0;
  const state = names.map((name) => ({
    name,
    tNext: expRand(rng, SPECIES[name].meanQuiet * densityScale * 0.5),
    boutLeft: 0, bout: -1, az: 0, dist: 0, elev: 0,
  }));

  return {
    next(trailT = 0) {
      // Earliest species wins; ties are impossible in practice with
      // continuous exponential draws.
      let s = state[0];
      for (const c of state) if (c.tNext < s.tNext) s = c;
      const sp = SPECIES[s.name];

      if (s.boutLeft <= 0) {
        // Starting a new bout. Rejection by habitat weight: an unsuitable
        // species does not call *here*, so its next chance is pushed out
        // rather than the call being forced somewhere it does not belong.
        if (rng() > sp.weight(trailT)) {
          s.tNext += expRand(rng, sp.meanQuiet * densityScale * 0.6);
          return this.next(trailT);
        }
        s.boutLeft = sp.bout[0] + Math.floor(rng() * (sp.bout[1] - sp.bout[0] + 1));
        s.bout = boutSeq++;
        // One position for the whole bout: a bird that teleports between
        // its own calls is more jarring than any synthesis flaw.
        s.az = rng() * TAU;
        s.dist = rrange(rng, sp.dist[0], sp.dist[1]);
        s.elev = rrange(rng, sp.elev[0], sp.elev[1]);
      }

      const ev = {
        time: s.tNext,
        species: s.name,
        bout: s.bout,
        variant: (rng() * 3) | 0,
        az: s.az, dist: s.dist, elev: s.elev,
        gain: sp.gain * rrange(rng, 0.85, 1.0),
        rate: rrange(rng, 0.96, 1.04),
      };
      s.boutLeft--;
      s.tNext += s.boutLeft > 0
        ? rrange(rng, sp.callGap[0], sp.callGap[1])
        : expRand(rng, sp.meanQuiet * densityScale);
      return ev;
    },
  };
}
