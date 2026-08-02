/* Render and measure the soundscape without a browser.
 *
 * Ears are the final judge of audio, but they are slow, uncalibrated and
 * unavailable in CI — so like the screenshot pipeline, the first pass of
 * judgement here is numbers. Every render is followed by band statistics,
 * because the failure modes of ambience are spectral: a cicada bed leaking
 * energy below 1 kHz, a "distant" waterfall that still has treble in it, a
 * mix whose 4–6 kHz band never changes along the trail.
 *
 *   node tools/audio.mjs all                       # every demo + smoke test
 *   node tools/audio.mjs layers                    # each layer in isolation
 *   node tools/audio.mjs mix --t 0.55 [--secs 20] [--scenario forest]
 *                                                   # full mix at a trail point
 *   node tools/audio.mjs demo layer-falls-near     # a single named demo
 *   node tools/audio.mjs stats shots/audio/x.wav   # re-analyse an existing file
 *   node tools/audio.mjs smoke                     # engine.js on a mock graph
 *   node tools/audio.mjs jobs                      # bake cost, job by job
 *
 * Output goes to shots/audio/, next to the frame captures, and is 16-bit
 * stereo PCM — the boring format everything can open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderScene, renderDemo, DEMOS } from '../src/audio/mix.js';
import { Ambience } from '../src/audio/engine.js';
import { bakeBank, bankJobs, bankBytes, DEFAULT_SEED } from '../src/audio/bank.js';
import { SCENARIOS } from '../src/scenario.js';
import { resetLevelOverrides, setLevelOverrides } from '../src/audio/score.js';
import {
  WALK_SPEED, JOG_SPEED, JUMP_SPEED, gaitCycleRate, stepRate,
} from '../src/player/gait.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'shots', 'audio');
const SR = 48000;
let ACTIVE_SCENARIO = 'jungle';
const outputSuffix = () => ACTIVE_SCENARIO === 'jungle' ? '' : `-${ACTIVE_SCENARIO}`;

/* ------------------------------------------------------------------ WAV */

export function writeWav(file, sr, L, R) {
  const n = L.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    // Clamped, not wrapped: an over-range float must clip audibly rather
    // than fold into full-scale garbage.
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

export function readWav(file) {
  const b = fs.readFileSync(file);
  const channels = b.readUInt16LE(22), sr = b.readUInt32LE(24);
  let p = 12;
  while (b.toString('ascii', p, p + 4) !== 'data') p += 8 + b.readUInt32LE(p + 4);
  const len = b.readUInt32LE(p + 4);
  const n = len / 2 / channels;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = b.readInt16LE(p + 8 + i * channels * 2) / 32768;
    R[i] = channels > 1 ? b.readInt16LE(p + 8 + i * channels * 2 + 2) / 32768 : L[i];
  }
  return { sr, L, R };
}

/* ---------------------------------------------------------------- stats */

/* In-place radix-2 FFT — the smallest thing that can answer "where is the
 * energy". No window sums or bit-twiddling cleverness; 8k points a few
 * hundred times is milliseconds. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/* Band edges chosen for what lives there: falls rumble, water body, voice
 * fundamentals, bird/cascade presence, cicada band, spray/katydid air. */
const BANDS = [[0, 100], [100, 400], [400, 1600], [1600, 4000], [4000, 8000], [8000, 24000]];

export function analyse(sr, L, R) {
  const n = L.length;
  let peak = 0, sum = 0, nan = 0, dc = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (Number.isNaN(L[i]) || Number.isNaN(R[i])) nan++;
    if (m > peak) peak = m;
    sum += (L[i] * L[i] + R[i] * R[i]) / 2;
    dc += (L[i] + R[i]) / 2;
  }
  const rms = Math.sqrt(sum / n);

  const N = 8192, hop = N * 2;
  const bandPow = new Array(BANDS.length).fill(0);
  let frames = 0;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let s = 0; s + N <= n; s += hop, frames++) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
      re[i] = (L[s + i] + R[s + i]) * 0.5 * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N;
      const p = re[k] * re[k] + im[k] * im[k];
      for (let b = 0; b < BANDS.length; b++) {
        if (f >= BANDS[b][0] && f < BANDS[b][1]) { bandPow[b] += p; break; }
      }
    }
  }
  const total = bandPow.reduce((a, b) => a + b, 0) || 1;
  return {
    secs: +(n / sr).toFixed(1),
    peakDb: +(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1),
    rmsDb: +(20 * Math.log10(Math.max(rms, 1e-9))).toFixed(1),
    dc: +(dc / n).toFixed(5),
    nan,
    bands: bandPow.map((p, b) => ({
      hz: `${BANDS[b][0]}-${BANDS[b][1]}`,
      pct: +(100 * p / total).toFixed(1),
    })),
  };
}

function printStats(name, st) {
  const bands = st.bands.map((b) => `${b.hz}:${b.pct}%`).join('  ');
  console.log(`  ${name}: ${st.secs}s  peak ${st.peakDb} dBFS  rms ${st.rmsDb} dBFS` +
    (st.nan ? `  !! ${st.nan} NaNs` : '') + (Math.abs(st.dc) > 0.001 ? `  !! dc ${st.dc}` : ''));
  console.log(`    ${bands}`);
}

/* ---------------------------------------------------------------- smoke */

/* A mock of the slice of Web Audio the engine uses. It computes nothing —
 * it only records that the graph was built, sources were started and every
 * value written into a param stayed finite. That is exactly the class of
 * bug (misused API, NaN reaching a gain) that otherwise only surfaces in a
 * live browser, which this project is trying hard not to launch. */
function makeMockContext() {
  const started = [];
  let bad = 0;
  const param = (v = 0) => ({
    value: v,
    setValueAtTime(x) { if (!Number.isFinite(x)) bad++; this.value = x; },
    setTargetAtTime(x) { if (!Number.isFinite(x)) bad++; this.value = x; },
    linearRampToValueAtTime(x) { if (!Number.isFinite(x)) bad++; this.value = x; },
    cancelScheduledValues() {},
  });
  const node = (extra = {}) => ({ connect(n) { return n; }, disconnect() {}, ...extra });
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    resume: async () => { ctx.state = 'running'; },
    suspend: async () => { ctx.state = 'suspended'; },
    close: async () => { ctx.state = 'closed'; },
    destination: node(),
    listener: {
      positionX: param(), positionY: param(), positionZ: param(),
      forwardX: param(), forwardY: param(), forwardZ: param(),
      upX: param(), upY: param(), upZ: param(),
    },
    createBuffer(ch, len, sr) {
      const chans = Array.from({ length: ch }, () => new Float32Array(len));
      return {
        length: len, sampleRate: sr, duration: len / sr, numberOfChannels: ch,
        copyToChannel(src, c) { chans[c].set(src); },
        getChannelData(c) { return chans[c]; },
      };
    },
    createGain: () => node({ gain: param(1) }),
    createStereoPanner: () => node({ pan: param(0) }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(350), Q: param(1) }),
    createDynamicsCompressor: () => node({
      threshold: param(-24), knee: param(30), ratio: param(12),
      attack: param(0.003), release: param(0.25),
    }),
    createPanner: () => node({
      panningModel: '', distanceModel: '', refDistance: 1, rolloffFactor: 1, maxDistance: 1e4,
      positionX: param(), positionY: param(), positionZ: param(),
    }),
    createBufferSource: () => {
      const s = node({
        buffer: null, loop: false, playbackRate: param(1), onended: null,
        start(when = 0) { started.push(when); if (!Number.isFinite(when)) bad++; },
        stop() {},
      });
      return s;
    },
    _started: started,
    _badWrites: () => bad,
  };
  return ctx;
}

async function smoke() {
  const ctx = makeMockContext();
  const walker = {
    trailT: 0.5,
    onStep: null,
    onLand: null,
    pos: { x: 10, y: 1.66, z: -200 },
  };
  const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 1.66, -200, 1] } };
  const mkTarget = () => ({ x: 0, y: 0, z: 0 });
  const trail = {
    nearest: (x, z, out = {}) => { out.dist = 2; out.t = walker.trailT; out.side = 1; return out; },
    pointAt: (t, tgt = mkTarget()) => tgt.set(10, 0, -200),
    tangentAt: (t, tgt = mkTarget()) => tgt.set(0, 0, -1),
  };
  const terrain = { height: () => 0.4, evalWet: () => 0.45 };

  const amb = new Ambience({ camera, trail, terrain, walker, contextFactory: () => ctx, doc: null });
  const t0 = performance.now();
  await amb.unlock();
  const bakeMs = performance.now() - t0;

  /* Two simulated minutes at the control rate, checking that scheduling
   * advances and stays finite. Footfalls are emitted from the same gait
   * arithmetic the controller runs rather than from a convenient divisor of
   * the control rate, and the first minute walks while the second jogs — so
   * the step count below is a real assertion that this layer's cadence is
   * player/gait.js's cadence. A duplicated literal drifting out of sync with
   * the visible head-bob is the specific regression it exists to catch. */
  const t1 = performance.now();
  const TICKS = 2400, DT = 1 / 20;
  let steps = 0, landings = 0, phase = 0;
  for (let i = 0; i < TICKS; i++) {
    ctx.currentTime += DT;
    walker.trailT = Math.min(1, 0.5 + i / 24000);
    const speed = i < TICKS / 2 ? WALK_SPEED : JOG_SPEED;
    amb.update(DT);
    const before = Math.floor(phase * 2);
    phase += gaitCycleRate(speed) * DT;
    if (Math.floor(phase * 2) !== before) { walker.onStep(walker.pos, speed); steps++; }
    // A jump a minute, arriving at the speed a jump on flat ground lands at.
    if (i % 1200 === 600) { walker.onLand(walker.pos, JUMP_SPEED, speed); landings++; }
  }
  const tickMs = performance.now() - t1;

  const secs = TICKS * DT / 2;
  const wantSteps = Math.round((stepRate(WALK_SPEED) + stepRate(JOG_SPEED)) * secs);
  const cadenceOk = Math.abs(steps - wantSteps) <= 2;

  amb.setWaterfallPosition({ x: 1, y: 3, z: -388 }, { x: 1, y: 15, z: -391 });
  amb.setPaused(true); amb.setPaused(false);
  const st = amb.stats();
  amb.dispose();

  const sources = ctx._started.length;
  const ok = sources > 20 && ctx._badWrites() === 0 && st.bankBytes > 1e6
    && cadenceOk && landings > 0;
  console.log(`smoke: ${ok ? '✓' : '✗'} bake ${bakeMs.toFixed(0)}ms, ` +
    `${sources} sources started (${steps} footsteps, ${landings} landings), ` +
    `${ctx._badWrites()} non-finite param writes, ` +
    `bank ${st.buffers} buffers / ${(st.bankBytes / 1048576).toFixed(1)} MiB, ` +
    `2 sim-min of control ticks in ${tickMs.toFixed(0)}ms ` +
    `(${(tickMs / TICKS).toFixed(3)}ms/tick)`);
  console.log(`  cadence: ${cadenceOk ? '✓' : '✗'} ${steps} footfalls over ` +
    `${secs}s walk + ${secs}s jog, gait.js predicts ${wantSteps} ` +
    `(${stepRate(WALK_SPEED).toFixed(2)} then ${stepRate(JOG_SPEED).toFixed(2)} steps/s)`);
  if (!ok) process.exit(1);
}

/* ------------------------------------------------------------------ jobs */

/* What the bake costs, job by job.
 *
 * The engine yields to the event loop between jobs, so the bake's effect on
 * the frame loop is not its total but its *worst single job* — one job is
 * indivisible and runs to completion inside whatever frame it lands in. A
 * 1.5 s bake made of forty even jobs is invisible; the same 1.5 s with one
 * 200 ms job in it drops twelve frames at the exact moment the player first
 * clicks. Only this breakdown distinguishes them.
 */
function jobs() {
  const list = bankJobs(SR, DEFAULT_SEED);
  const timed = list.map((job) => {
    const t0 = performance.now();
    const { key, buf } = job();
    return { key, ms: performance.now() - t0, secs: buf.length / SR };
  });
  const total = timed.reduce((a, b) => a + b.ms, 0);
  timed.sort((a, b) => b.ms - a.ms);
  console.log(`${list.length} jobs, ${total.toFixed(0)} ms total, ` +
    `worst ${timed[0].ms.toFixed(0)} ms — a frame at 60 Hz is 16.7 ms\n`);
  for (const j of timed.slice(0, 12)) {
    console.log(`  ${j.key.padEnd(18)} ${j.ms.toFixed(1).padStart(7)} ms   ` +
      `${j.secs.toFixed(2)}s of audio`);
  }
  const over = timed.filter((j) => j.ms > 16.7).length;
  console.log(`\n  ${over} of ${list.length} jobs exceed one frame at 60 Hz`);
}

/* ------------------------------------------------------------------ CLI */

function saveDemo(name) {
  const t0 = performance.now();
  const { L, R } = renderDemo(name, SR);
  const ms = performance.now() - t0;
  const file = path.join(OUT_DIR, `${name}${outputSuffix()}.wav`);
  writeWav(file, SR, L, R);
  console.log(`${path.basename(file)}  (rendered in ${(ms / 1000).toFixed(1)}s, ` +
    `${(L.length / SR / (ms / 1000)).toFixed(1)}x realtime)`);
  printStats(path.basename(file), analyse(SR, L, R));
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'all';
  const flag = (k, dv) => { const i = args.indexOf('--' + k); return i < 0 ? dv : args[i + 1]; };
  const scenarioName = flag('scenario', 'jungle') || 'jungle';
  if (!Object.hasOwn(SCENARIOS, scenarioName)) {
    throw new Error(`unknown scenario '${scenarioName}' — one of: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  ACTIVE_SCENARIO = scenarioName;
  resetLevelOverrides();
  if (SCENARIOS[scenarioName].audio) setLevelOverrides(SCENARIOS[scenarioName].audio);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (cmd === 'stats') {
    const { sr, L, R } = readWav(args[1]);
    printStats(path.basename(args[1]), analyse(sr, L, R));
  } else if (cmd === 'smoke') {
    await smoke();
  } else if (cmd === 'jobs') {
    jobs();
  } else if (cmd === 'demo') {
    saveDemo(args[1]);
  } else if (cmd === 'mix') {
    const t = +flag('t', 0.15), secs = +flag('secs', 20);
    const { L, R } = renderScene(SR, secs, { t0: t, walk: !args.includes('--static'), birdDensity: 0.25 });
    const file = path.join(OUT_DIR, `mix-t${String(t).replace('.', '')}${outputSuffix()}.wav`);
    writeWav(file, SR, L, R);
    printStats(path.basename(file), analyse(SR, L, R));
  } else if (cmd === 'layers') {
    for (const name of Object.keys(DEMOS)) if (name.startsWith('layer-')) saveDemo(name);
  } else if (cmd === 'all') {
    const t0 = performance.now();
    const bank = bakeBank(SR, DEFAULT_SEED);
    console.log(`bank: ${Object.keys(bank).length} buffers, ` +
      `${(bankBytes(bank) / 1048576).toFixed(1)} MiB, ` +
      `baked in ${((performance.now() - t0) / 1000).toFixed(2)}s\n`);
    for (const name of Object.keys(DEMOS)) saveDemo(name);
    console.log('');
    await smoke();
  } else {
    console.error('usage: node tools/audio.mjs [all|layers|mix|demo|stats|smoke|jobs] [--scenario jungle|forest]');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
