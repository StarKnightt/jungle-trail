/* The bank: everything that gets synthesized up front.
 *
 * Per-sample synthesis in JS is far too slow to run live inside the audio
 * thread — the cicada bed alone is several filter evaluations per sample —
 * so all of it is precomputed into buffers here and the runtime only ever
 * plays, gains and pans them. The cost of that trade is memory (reported by
 * bankBytes) and a one-time bake at startup; the engine spreads the bake
 * across frames using the job list, which is why this file exposes jobs
 * rather than just one big bake function.
 *
 * Node and the browser call exactly the same jobs, so a WAV rendered
 * offline is made of the same samples the game plays.
 */
import { renderCicadaBed, renderCricketBed, renderKatydid, renderCricketChirp, CICADA_LOOPS, CRICKET_LOOPS } from './insects.js';
import { renderBirdCall, SPECIES } from './birds.js';
import { renderRumble, renderCascade, renderSpray, renderBabble } from './water.js';
import { renderRustle, renderWash, RUSTLE_LOOPS } from './wind.js';
import { renderFootstep, renderLanding, WET_LEVELS, STEP_VARIANTS, LAND_VARIANTS } from './steps.js';

export const DEFAULT_SEED = 7311;

/**
 * The bake, described as a flat list of independent jobs. Each job returns
 * `{ key, buf }`; keys are stable strings the mixer and the engine both
 * address buffers by. Kept as data so the engine can yield to the frame
 * loop between jobs instead of freezing the first second of the walk.
 */
export function bankJobs(sr, seed = DEFAULT_SEED) {
  const jobs = [];

  CICADA_LOOPS.forEach((secs, k) => jobs.push(() =>
    ({ key: `cicada${k}`, buf: renderCicadaBed(sr, seed + 11 + k, secs, k) })));
  CRICKET_LOOPS.forEach((secs, k) => jobs.push(() =>
    ({ key: `cricket${k}`, buf: renderCricketBed(sr, seed + 31 + k, secs) })));

  jobs.push(() => ({ key: 'rumble', buf: renderRumble(sr, seed + 41) }));
  jobs.push(() => ({ key: 'cascade', buf: renderCascade(sr, seed + 42) }));
  jobs.push(() => ({ key: 'spray', buf: renderSpray(sr, seed + 43) }));
  jobs.push(() => ({ key: 'babble', buf: renderBabble(sr, seed + 44) }));

  RUSTLE_LOOPS.forEach((secs, k) => jobs.push(() =>
    ({ key: `rustle${k}`, buf: renderRustle(sr, seed + 51 + k, secs) })));
  jobs.push(() => ({ key: 'wash', buf: renderWash(sr, seed + 53) }));

  // Three seeded variants per bird species; playback-rate jitter multiplies
  // the effective variety, so three is enough that no repetition survives.
  for (const name of Object.keys(SPECIES)) {
    for (let v = 0; v < 3; v++) {
      jobs.push(() => ({ key: `bird:${name}:${v}`, buf: renderBirdCall(sr, name, seed + 100 + v * 7 + name.length * 131) }));
    }
  }

  for (let v = 0; v < 3; v++) {
    jobs.push(() => ({ key: `katydid:${v}`, buf: renderKatydid(sr, seed + 200 + v) }));
    jobs.push(() => ({ key: `chirp:${v}`, buf: renderCricketChirp(sr, seed + 210 + v) }));
  }

  WET_LEVELS.forEach((w, wi) => {
    for (let v = 0; v < STEP_VARIANTS; v++) {
      jobs.push(() => ({ key: `step:${wi}:${v}`, buf: renderFootstep(sr, seed + 300 + wi * 31 + v, w) }));
    }
    for (let v = 0; v < LAND_VARIANTS; v++) {
      jobs.push(() => ({ key: `land:${wi}:${v}`, buf: renderLanding(sr, seed + 400 + wi * 37 + v, w) }));
    }
  });

  return jobs;
}

/** Run every job now. This is what Node does; the engine paces itself. */
export function bakeBank(sr, seed = DEFAULT_SEED) {
  const bank = {};
  for (const job of bankJobs(sr, seed)) {
    const { key, buf } = job();
    bank[key] = buf;
  }
  return bank;
}

/** Total Float32 payload of a baked bank, for the memory report. */
export function bankBytes(bank) {
  let b = 0;
  for (const k of Object.keys(bank)) b += bank[k].byteLength;
  return b;
}

/** Nearest baked wetness level for a continuous wetness value. */
function wetIndex(wetness) {
  let wi = 0, best = Infinity;
  WET_LEVELS.forEach((w, i) => {
    const d = Math.abs(w - wetness);
    if (d < best) { best = d; wi = i; }
  });
  return wi;
}

export function stepKey(wetness, variant) {
  return `step:${wetIndex(wetness)}:${variant % STEP_VARIANTS}`;
}

export function landKey(wetness, variant) {
  return `land:${wetIndex(wetness)}:${variant % LAND_VARIANTS}`;
}
