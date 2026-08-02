/* Does the ambience actually run in the game?
 *
 * tools/audio.mjs smoke answers "is the engine's logic sound" against a mock
 * graph, and it is fast enough to run constantly — but a mock context cannot
 * fail the way a real one does. Every interesting failure of this system is a
 * failure of integration rather than of synthesis: an AudioContext that never
 * unlocks because no gesture reached it, a bake that blocks the render loop, a
 * graph that builds cleanly and outputs digital silence. None of those is
 * visible in a WAV and none of them throws.
 *
 * So this is the browser-side twin. It boots the real page, unlocks with a
 * real trusted click rather than by calling unlock() (the gesture path is the
 * part most likely to break), samples requestAnimationFrame deltas straight
 * through the bake, and taps an AnalyserNode onto the master bus to prove the
 * graph is producing signal rather than merely existing.
 *
 *   node tools/audio-live.mjs
 *   node tools/audio-live.mjs --no-worker   # exercise the inline bake fallback
 *
 * `--no-worker` stops the engine from getting a bake worker, which is the only
 * way to reach the paced main-thread fallback in a browser. It is expected to
 * drop frames — that is why the worker exists — so the frame-stall check is
 * reported rather than enforced under that flag; what is being tested is that
 * the fallback still produces a working graph.
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';
import { WALK_SPEED, JOG_SPEED, stepRate } from '../src/player/gait.js';

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const f2 = (v) => (v === undefined ? 'n/a' : v.toFixed(2));

const NO_WORKER = process.argv.includes('--no-worker');

const fails = [];
function expect(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fails.push(label);
}
/** Reported, not enforced — for the cases a flag deliberately makes worse. */
function note(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '·'} ${label}${detail ? '  — ' + detail : ''}`);
}

const liveRun = await run({ width: 960, height: 540, hash: 'manual&tier=high' }, async ({ page }) => {
  /* Installed before anything is asked of the audio system. An unhandled
   * rejection is the exact shape a failed unlock takes — unlock() is async and
   * is called from an event listener that cannot await it — so catching them
   * is not incidental to this test, it is one of the things being tested. */
  await page.evaluate(() => {
    window.__rejects = [];
    addEventListener('unhandledrejection', (e) => {
      window.__rejects.push(String((e.reason && e.reason.stack) || e.reason));
    });
    window.__fr = [];
    let last = performance.now();
    const tick = (t) => { window.__fr.push([t, t - last]); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  if (NO_WORKER) {
    await page.evaluate(() => { window.__ambience._makeBakeWorker = () => null; });
    console.log('  (--no-worker: engine forced onto the inline paced bake)');
  }

  const before = await page.evaluate(() => {
    const a = window.__ambience;
    return { present: !!a, stats: a ? a.stats() : null, chained: typeof window.__game.walker.onStep === 'function' };
  });
  console.log('\n─── before any gesture ───');
  expect(before.present, 'engine self-registered as window.__ambience');
  expect(before.stats && before.stats.state === 'no-context',
    'no AudioContext created before a gesture', JSON.stringify(before.stats));
  expect(before.chained, "walker.onStep chained at construction");

  /* Wait for the loop to actually settle before taking a baseline. The first
   * second after begin() is shader compilation and texture upload and
   * contains frames of several hundred milliseconds; measuring the bake
   * against that would let anything pass. */
  await page.waitForFunction(() => {
    const a = window.__fr;
    if (a.length < 40) return false;
    return a.slice(-30).every(([, d]) => d < 25);
  }, null, { timeout: 60_000 });
  const baseFrom = await page.evaluate(() => performance.now());
  await page.waitForTimeout(1500);

  /* A real trusted click, not page.evaluate(() => __ambience.unlock()). The
   * whole question here is whether the gesture the game already has reaches
   * the engine; calling unlock() by hand would answer a question nobody has. */
  const clickAt = await page.evaluate(() => performance.now());
  await page.mouse.click(480, 270);
  await page.waitForFunction(() => window.__ambience && window.__ambience.ready, null, { timeout: 60_000 })
    .catch(() => {});
  const readyAt = await page.evaluate(() => performance.now());

  const st = await page.evaluate(() => window.__ambience.stats());
  console.log('\n─── unlock ───');
  expect(st.ready, 'unlocked by a trusted pointerdown, no code-driven unlock', JSON.stringify(st));
  expect(st.state === 'running', `AudioContext state is running (${st.state})`);
  expect(st.buffers >= 55 && st.bankBytes > 25e6,
    `bank baked: ${st.buffers} buffers, ${(st.bankBytes / 1048576).toFixed(1)} MiB in ${st.bakeMs} ms`);

  /* Frame deltas, split at the click. The bake is deliberately one synthesis
   * job per macrotask so that the loop keeps running through it; if that is
   * working, the two distributions are the same distribution. */
  const fr = await page.evaluate(() => window.__fr);
  const win = (a, b) => fr.filter(([t]) => t >= a && t < b).map(([, d]) => d).slice(1);
  const idle = win(baseFrom, clickAt);
  const bake = win(clickAt, readyAt);
  const show = (name, a) => a.length
    ? console.log(`    ${name.padEnd(6)} n=${String(a.length).padStart(4)}  ` +
        `median ${f2(pct(a, 0.5))}  p95 ${f2(pct(a, 0.95))}  max ${f2(Math.max(...a))} ms`)
    : console.log(`    ${name.padEnd(6)} (no frames)`);
  console.log('  frame intervals:');
  show('idle', idle);
  show('bake', bake);
  const idleMax = Math.max(...idle), bakeMax = Math.max(...bake);
  const dropped = bake.filter((d) => d > 25).length;
  /* Where a hitch falls says what caused it. Within a few tens of
   * milliseconds of the click is the AudioContext being constructed and the
   * device opening; spread through the window is the bake or the GC behind
   * it; at the far end is the graph build. */
  const late = fr.filter(([t, d]) => t >= clickAt && t < readyAt && d > 25)
    .map(([t, d]) => `${(t - clickAt).toFixed(0)}ms in: ${d.toFixed(1)}ms`);
  if (late.length) console.log(`    slow frames — ${late.join(', ')}` +
    `  (ready at ${(readyAt - clickAt).toFixed(0)}ms)`);
  expect(idle.length > 40 && idleMax < 40,
    `baseline loop is steady before the click (${idle.length} frames, worst ${f2(idleMax)} ms)`);
  /* The unlock is allowed exactly one dropped frame and only at the front of
   * the window, because constructing an AudioContext opens the output device
   * and that is a synchronous ~30 ms in Chromium that no amount of pacing can
   * remove. Everything after it — the bake, the buffer copies, the graph —
   * has to stay inside vsync. Before the bake moved to a worker this window
   * held a dozen dropped frames with a worst of 233 ms, so the distinction
   * between "one, at the device open" and "some, during the bake" is the
   * whole point of the check. */
  const bakeHitches = fr.filter(([t, d]) => t >= clickAt + 200 && t < readyAt && d > 25).length;
  (NO_WORKER ? note : expect)(bakeHitches === 0 && dropped <= 1,
    'bake does not stall the frame loop',
    `${dropped} dropped frame(s), ${bakeHitches} of them during the bake; ` +
    `worst ${f2(bakeMax)} ms vs ${f2(idleMax)} ms idle`);
  expect(st.bakedOffThread === !NO_WORKER,
    `bake ran ${st.bakedOffThread ? 'in a worker' : 'inline on the main thread'} as expected`,
    `opening the audio device cost ${st.deviceMs} ms`);

  console.log('\n─── output ───');
  /* Tapped off master rather than the compressor so this measures what the
   * layers produced, not what survived limiting. Silence here with a healthy
   * stats() is the failure this whole script exists for. */
  const rms = await page.evaluate(async () => {
    const a = window.__ambience;
    const an = a.ctx.createAnalyser();
    an.fftSize = 2048;
    a.master.connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0, best = 0;
    const t0 = a.ctx.currentTime;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let j = 0; j < buf.length; j++) { s += buf[j] * buf[j]; peak = Math.max(peak, Math.abs(buf[j])); }
      best = Math.max(best, Math.sqrt(s / buf.length));
    }
    a.master.disconnect(an);
    return { rmsDb: 20 * Math.log10(Math.max(best, 1e-9)), peak, clockRan: a.ctx.currentTime - t0 };
  });
  expect(rms.clockRan > 1, `audio clock advanced ${rms.clockRan.toFixed(2)} s`);
  expect(rms.rmsDb > -60, `master bus carries signal: ${rms.rmsDb.toFixed(1)} dBFS rms, peak ${rms.peak.toFixed(3)}`);

  console.log('\n─── control cost ───');
  const ctl = await page.evaluate(async () => {
    const a = window.__ambience;
    const orig = a._controlTick.bind(a);
    let n = 0, tot = 0, worst = 0;
    a._controlTick = () => {
      const t = performance.now();
      orig();
      const d = performance.now() - t;
      tot += d; worst = Math.max(worst, d); n++;
    };
    await new Promise((r) => setTimeout(r, 3000));
    a._controlTick = orig;
    return { n, mean: tot / Math.max(1, n), worst };
  });
  expect(ctl.n > 40, `control ticks fired from the frame loop: ${ctl.n} in 3 s (~20 Hz)`);
  expect(ctl.mean < 0.1,
    `per-tick cost ${(ctl.mean * 1000).toFixed(0)} µs mean, ${(ctl.worst * 1000).toFixed(0)} µs worst`);

  console.log('\n─── cadence and wetness ───');
  const gait = await page.evaluate(({ walkSpeed, jogSpeed }) => {
    const g = window.__game, w = g.walker, a = window.__ambience;
    let steps = 0, lands = 0, lastSpeed = 0, impact = 0;
    const chainStep = w.onStep, chainLand = w.onLand;
    w.onStep = (p, s) => { chainStep(p, s); steps++; lastSpeed = s; };
    w.onLand = (p, i, s) => { chainLand(p, i, s); lands++; impact = i; };

    const count = (pace, secs) => {
      steps = 0;
      w.setAuto(w.trailT, pace);
      g.warp(2.0);            // let runBlend reach the pace before counting
      steps = 0;
      g.warp(secs);
      return steps / secs;
    };
    const walk = count('walk', 30);
    const jog = count('jog', 30);

    // Wetness has to come from the terrain field the ground texture uses, or
    // the squelch arrives somewhere other than where the trail looks soaked.
    const wetAt = (t) => { w.setAuto(null).placeAt(t); return a._wetnessAt(w.pos); };
    const dry = wetAt(0.15), soaked = wetAt(0.97);

    w.setAuto(null).placeAt(0.30);
    g.warp(0.5);
    w.jump();
    g.warp(2.0);

    return {
      walk, jog, lastSpeed, lands, impact, dry, soaked,
      hasLandBuffers: !!a.bank['land:0:0'] && !!a.bank['land:2:0'],
    };
  }, { walkSpeed: WALK_SPEED, jogSpeed: JOG_SPEED });

  const wantWalk = stepRate(WALK_SPEED), wantJog = stepRate(JOG_SPEED);
  expect(Math.abs(gait.walk - wantWalk) < 0.06,
    `walk cadence ${gait.walk.toFixed(2)} steps/s, gait.js says ${wantWalk.toFixed(2)}`);
  expect(Math.abs(gait.jog - wantJog) < 0.08,
    `jog cadence ${gait.jog.toFixed(2)} steps/s, gait.js says ${wantJog.toFixed(2)}`);
  expect(gait.dry < 0.05 && gait.soaked > 0.5,
    `terrain.evalWet resolves: ${gait.dry.toFixed(2)} at t=0.15, ${gait.soaked.toFixed(2)} at t=0.97`);
  expect(gait.hasLandBuffers, 'landing buffers baked at every wetness level');
  expect(gait.lands === 1, `one jump produced ${gait.lands} landing at ${gait.impact.toFixed(2)} m/s`);

  console.log('\n─── pause and dispose ───');
  const life = await page.evaluate(async () => {
    const g = window.__game, a = window.__ambience;
    g.setPaused(true);
    await new Promise((r) => setTimeout(r, 250));
    const t = a.ctx.currentTime;
    await new Promise((r) => setTimeout(r, 250));
    const paused = { state: a.ctx.state, drift: a.ctx.currentTime - t };
    g.setPaused(false);
    await new Promise((r) => setTimeout(r, 250));
    const resumed = a.ctx.state;

    /* What harness.capture() does: pause, render, unpause, all inside one
     * task. suspend() and resume() are both asynchronous, so a context left
     * suspended by that ordering would silence everything after the first
     * screenshot in any tool that captures once the audio is running. */
    g.setPaused(true); g.renderOnce(); g.setPaused(false);
    await new Promise((r) => setTimeout(r, 300));
    const afterCapture = a.ctx.state;

    g.dispose();
    await new Promise((r) => setTimeout(r, 250));
    return {
      paused, resumed, afterCapture, closed: a.ctx.state, handle: window.__ambience,
      restored: g.walker.onStep === null && g.walker.onLand === null,
    };
  });
  expect(life.paused.state === 'suspended' && life.paused.drift < 0.02,
    `pause suspends the context (${life.paused.state}, clock moved ${life.paused.drift.toFixed(3)} s)`);
  expect(life.resumed === 'running', `unpause resumes it (${life.resumed})`);
  expect(life.afterCapture === 'running',
    `a harness screenshot's pause/unpause leaves it running (${life.afterCapture})`);
  expect(life.closed === 'closed', `dispose closes the context (${life.closed})`);
  expect(life.handle === null, 'dispose clears window.__ambience');
  expect(life.restored, 'dispose restores the walker callbacks it chained');

  const rejects = await page.evaluate(() => window.__rejects);
  expect(rejects.length === 0, 'no unhandled promise rejections', rejects.join(' | ').slice(0, 200));
});

if (!liveRun.ok) fails.push('browser probe');

console.log(fails.length ? `\n✗ ${fails.length} failed: ${fails.join('; ')}` : '\n✓ all live audio checks passed');
finish(fails.length ? 1 : (process.exitCode || 0));
