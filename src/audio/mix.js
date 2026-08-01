/* Offline scene renderer.
 *
 * This is the engine's twin: the same bank, the same score, the same
 * gesture functions and the same schedulers, but writing into Float32Arrays
 * instead of a Web Audio graph. It exists so the soundscape can be rendered
 * to WAV in Node, listened to, and measured — the entire verification story
 * for this system runs through here.
 *
 * The spatial model is deliberately the *same maths* the engine feeds its
 * PannerNodes (inverse distance, equal-power pan, one-pole air absorption),
 * so a balance judged correct in a WAV stays correct in the game. What it
 * does not model is head rotation — the offline listener always faces down
 * the trail, which is also how the walk is actually experienced.
 */
import {
  makeRng, makeGesture, onePoleLP, panGains,
} from './dsp.js';
import { bakeBank, stepKey, DEFAULT_SEED } from './bank.js';
import {
  levelGain, TRAIL_LEN, distToFalls, brookOffset, brookGain, insectTrailGain,
  distGain, airCutoff, stepWetness,
} from './score.js';
import { cicadaSwell, cricketGate, makeInsectEvents, CICADA_LOOPS, CRICKET_LOOPS } from './insects.js';
import { makeBirdScheduler } from './birds.js';
import { fallsBalance } from './water.js';
import { gustEnvelope, washGain, rustleGain, RUSTLE_LAG } from './wind.js';
import { WALK_SPEED, WALK_STEP_LENGTH } from '../player/gait.js';

/* One phase is a two-step gait cycle. Importing the actual step length keeps
 * an offline soundscape honest when locomotion is tuned; duplicated literals
 * were how the old trot-rate cadence survived unnoticed. */
const STEP_INTERVAL = WALK_STEP_LENGTH / WALK_SPEED;

/** Mix one event buffer into stereo at `time`, resampled by `rate`. */
function addEvent(L, R, sr, buf, time, gain, pan, rate = 1, lpCut = 0) {
  const i0 = Math.round(time * sr);
  const lp = lpCut ? onePoleLP(sr, lpCut) : null;
  const [pl, pr] = panGains(pan);
  const nOut = Math.floor((buf.length - 1) / rate);
  for (let j = 0; j < nOut; j++) {
    const idx = i0 + j;
    if (idx < 0) continue;
    if (idx >= L.length) break;
    const sp = j * rate;
    const k = sp | 0;
    let x = buf[k] + (buf[k + 1] - buf[k]) * (sp - k);
    if (lp) x = lp.step(x);
    x *= gain;
    L[idx] += x * pl;
    R[idx] += x * pr;
  }
}

/**
 * Render `seconds` of the scene.
 *
 * opts:
 *   t0           starting trail position (normalised arc length)
 *   walk         advance t at walking speed and emit footsteps
 *   layers       any of 'insects','birds','brook','falls','wind','steps'
 *   birdDensity  scales the quiet gaps; < 1 makes demo WAVs less patient
 *   wetnessFn    override footstep wetness as a function of time (demos)
 *
 * @returns {{L: Float32Array, R: Float32Array}}
 */
export function renderScene(sr, seconds, opts = {}) {
  const {
    seed = DEFAULT_SEED, t0 = 0.15, walk = true,
    layers = ['insects', 'birds', 'brook', 'falls', 'wind', 'steps'],
    birdDensity = 1, wetnessFn = null,
  } = opts;
  const has = (l) => layers.includes(l);
  const bank = bakeBank(sr, seed);
  const rng = makeRng(seed ^ 0x5eed);
  const gesture = makeGesture(seed + 777);

  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const trailAt = (time) => (walk ? Math.min(1, t0 + (WALK_SPEED * time) / TRAIL_LEN) : t0);

  /* Looped beds. Each starts at a random phase for the same reason the
   * engine starts its sources at random offsets: two renders of the same
   * scene should not be sample-identical in their beds, only statistically
   * identical. */
  const loops = [];
  const addLoop = (key, pan, gainFn, lpFn = null) => {
    const buf = bank[key];
    loops.push({
      buf, pan, gainFn, lpFn,
      pos: (rng() * buf.length) | 0,
      lp: lpFn ? onePoleLP(sr, 18000) : null,
      prev: 0,
    });
  };

  if (has('insects')) {
    const pans = [-0.5, 0.12, 0.55];
    CICADA_LOOPS.forEach((_, k) => addLoop(`cicada${k}`, pans[k],
      (time, t) => levelGain('cicada') * cicadaSwell(gesture, time, k) * insectTrailGain(t)));
    const cpans = [-0.3, 0.35];
    CRICKET_LOOPS.forEach((_, k) => addLoop(`cricket${k}`, cpans[k],
      (time, t) => levelGain('crickets') * cricketGate(gesture, time, k) * insectTrailGain(t)));
  }
  if (has('wind')) {
    addLoop('wash', 0, (time) => levelGain('wash') * washGain(gustEnvelope(gesture, time)));
    addLoop('rustle0', -0.6, (time) => levelGain('rustle') * rustleGain(gustEnvelope(gesture, time)));
    addLoop('rustle1', 0.6, (time) => levelGain('rustle') * rustleGain(gustEnvelope(gesture, time - RUSTLE_LAG)));
  }
  if (has('falls')) {
    for (const part of ['rumble', 'cascade', 'spray']) {
      addLoop(part, 0,
        (time, t) => {
          const d = distToFalls(t);
          return levelGain('falls') * fallsBalance(d)[part] * distGain(d, 18);
        },
        (time, t) => airCutoff(distToFalls(t)));
    }
  }
  if (has('brook')) {
    addLoop('babble', -0.65,
      (time, t) => {
        const d = Math.abs(brookOffset(t));
        return levelGain('brook') * brookGain(t) * distGain(d, 6);
      },
      (time, t) => airCutoff(Math.abs(brookOffset(t))));
  }

  const BLOCK = 256;
  for (let i0 = 0; i0 < n; i0 += BLOCK) {
    const bn = Math.min(BLOCK, n - i0);
    const time = (i0 + bn) / sr;
    const t = trailAt(time);
    for (const s of loops) {
      const target = s.gainFn(time, t);
      // Skip silent blocks entirely, but only once the ramp has landed —
      // cutting mid-ramp clicks.
      if (target < 1e-5 && s.prev < 1e-5) { s.pos = (s.pos + bn) % s.buf.length; continue; }
      if (s.lpFn) s.lp.set(s.lpFn(time, t));
      const [pl, pr] = panGains(s.pan);
      for (let j = 0; j < bn; j++) {
        const gj = s.prev + (target - s.prev) * (j / bn);
        let x = s.buf[s.pos];
        s.pos = (s.pos + 1) % s.buf.length;
        if (s.lp) x = s.lp.step(x);
        x *= gj;
        L[i0 + j] += x * pl;
        R[i0 + j] += x * pr;
      }
      s.prev = target;
    }
  }

  if (has('birds')) {
    const sched = makeBirdScheduler(seed + 1000, birdDensity);
    let cursor = 0;
    for (let guard = 0; guard < 4000; guard++) {
      // The habitat weighting sees the trail position the walker will have
      // reached by the time of the previous call — close enough, since t
      // moves by ~0.003/s and bouts are tens of seconds apart.
      const ev = sched.next(trailAt(cursor));
      cursor = ev.time;
      if (ev.time >= seconds) break;
      const buf = bank[`bird:${ev.species}:${ev.variant}`];
      addEvent(L, R, sr, buf, ev.time,
        levelGain('birds') * ev.gain * distGain(ev.dist, 8),
        Math.sin(ev.az) * 0.85, ev.rate, airCutoff(ev.dist));
    }
  }

  if (has('insects')) {
    const sched = makeInsectEvents(seed + 2000);
    for (let guard = 0; guard < 4000; guard++) {
      const ev = sched.next();
      if (ev.time >= seconds) break;
      const buf = bank[`${ev.kind}:${ev.variant}`];
      addEvent(L, R, sr, buf, ev.time,
        levelGain('insectEvent') * ev.gain * distGain(ev.dist, 6),
        Math.sin(ev.az) * 0.85, ev.rate, airCutoff(ev.dist));
    }
  }

  if (has('steps') && walk) {
    let foot = 0;
    for (let time = 0.3; time < seconds; time += STEP_INTERVAL) {
      const t = trailAt(time);
      const w = wetnessFn ? wetnessFn(time) : stepWetness(t);
      const buf = bank[stepKey(w, (rng() * 6) | 0)];
      addEvent(L, R, sr, buf, time,
        levelGain('steps') * (0.85 + rng() * 0.15),
        // Alternate feet: a small, consistent left/right offset. Your own
        // steps are heard through your body as much as the air, so they
        // stay close to centre rather than getting a real panner.
        foot % 2 ? 0.22 : -0.22,
        0.94 + rng() * 0.12);
      foot++;
    }
  }

  /* Soft saturation standing in for the engine's DynamicsCompressor: with
   * the score's levels the mix peaks well below 1 and tanh is transparent,
   * but a bird bout landing on a falls crescendo must fold over gently
   * rather than wrap. */
  const master = levelGain('master');
  for (let i = 0; i < n; i++) {
    L[i] = Math.tanh(L[i] * master);
    R[i] = Math.tanh(R[i] * master);
  }
  return { L, R };
}

/* Canonical demo set for tools/audio.mjs: each layer alone, and the full
 * mix at three points that bracket the walk — deep forest, the brook's
 * arrival, and the pool. The falls demos use trail positions rather than
 * raw distances so they exercise distToFalls the way the game will. */
export const DEMOS = {
  'layer-insects':    { secs: 25, opts: { layers: ['insects'], t0: 0.30, walk: false } },
  'layer-birds':      { secs: 30, opts: { layers: ['birds'], t0: 0.50, walk: false, birdDensity: 0.10 } },
  'layer-brook':      { secs: 20, opts: { layers: ['brook'], t0: 0.62, walk: false } },
  'layer-falls-far':  { secs: 15, opts: { layers: ['falls'], t0: 0.68, walk: false } },
  'layer-falls-near': { secs: 15, opts: { layers: ['falls'], t0: 0.995, walk: false } },
  'layer-wind':       { secs: 30, opts: { layers: ['wind'], t0: 0.30, walk: false } },
  'layer-footsteps':  { secs: 12, opts: { layers: ['steps'], t0: 0.30, walk: true, wetnessFn: (time) => Math.min(1, time / 10) } },
  'mix-t015':         { secs: 20, opts: { t0: 0.15, walk: true, birdDensity: 0.25 } },
  'mix-t055':         { secs: 20, opts: { t0: 0.55, walk: true, birdDensity: 0.25 } },
  'mix-t092':         { secs: 20, opts: { t0: 0.92, walk: true, birdDensity: 0.25 } },
};

export function renderDemo(name, sr, seed = DEFAULT_SEED) {
  const d = DEMOS[name];
  if (!d) throw new Error(`unknown demo '${name}' — one of: ${Object.keys(DEMOS).join(', ')}`);
  return renderScene(sr, d.secs, { ...d.opts, seed });
}
