/* What each post effect costs and what it does to the histogram.
 *
 * The grading system is five effects sharing two passes and a pyramid, and the
 * only way to say anything honest about either their price or their side
 * effects is to turn them on one at a time against a fixed viewpoint. Both
 * halves of that matter. A millisecond is a millisecond, but "the frame is
 * hazed" is a claim about the tenth percentile of the luminance histogram, and
 * a bloom that lifts p10 by four hundredths has hazed the frame whatever it
 * looks like on the machine it was tuned on.
 *
 * Timing follows tools/perf.mjs: interleaved blocks, median of seven, glFinish
 * on both sides, because the driver's clocks ramp during a run and a
 * sequential comparison charges the whole ramp to whichever effect went first.
 * What it does *not* do is time the whole frame. The scene pass at the falls
 * costs ten milliseconds and varies by one between blocks, and looking for a
 * two-hundred-microsecond effect underneath a one-millisecond variance is how
 * a measurement comes back saying that bloom made the frame faster. The scene
 * is rendered once into the atmosphere's HDR buffer and only the post chain is
 * driven repeatedly over it, which is legitimate because that is exactly the
 * work the effects add.
 *
 * The histograms are taken at a single frozen simulation state with nothing
 * but the flags changing between them. Re-placing the camera between cases
 * looks harmless and is not: the wind, the spray and the ripple clocks keep
 * running, so every case would be sampling a slightly different arrangement of
 * leaves, and the resulting hundredth-of-a-unit differences are the same size
 * as the effects being looked for.
 *
 * Motion blur is the exception and needs saying. Its shader early-outs on any
 * pixel whose reconstructed velocity is under half a pixel, so timing it on a
 * still camera measures the early-out and reports about zero. The camera is
 * therefore yawed a little between the frames of its block, which is what it
 * would be doing in play.
 *
 *   node tools/p1cost.mjs [--t 0.96] [--tier high]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const STOP = +flag('t', 0.96);
const TIER = flag('tier', 'high');

await run({ width: 1600, height: 900, hash: 'manual&tier=' + TIER }, async ({ page, gl }) => {
  const rows = await page.evaluate(async ([stop, tier]) => {
    const g = window.__game;
    g.setSun(38, 152);
    g.setPaused(true);
    g.setTier(tier);
    g.goTo(stop); g.warp(2.0);

    const grade = g.atmos.grade;
    const glc = g.renderer.getContext();
    const set = (o) => Object.assign(grade.want, o);
    const OFF = { motion: false, dof: false, bloom: false, grade: false, grain: false };

    /* glFinish is not a fence here.
     *
     * Chromium runs WebGL over a command buffer into the GPU process, and
     * finish() in the page returns once that queue has been handed over rather
     * than once the hardware has drained it. Timing a set of full-screen
     * passes against it measures how fast JavaScript can submit ten draw
     * calls, which on this machine is forty microseconds and is the same
     * answer whatever the shaders do — the first run of this tool duly
     * reported that bloom cost fifty microseconds and that the entire
     * volumetric stack cost forty.
     *
     * Reading a single pixel back is a real synchronisation, because the value
     * cannot be produced without the frame being finished. One pixel is enough
     * and costs nothing beyond the wait itself. */
    const px = new Uint8Array(4);
    const sync = () => glc.readPixels(0, 0, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, px);
    const time = (fn, n) => {
      for (let i = 0; i < 6; i++) fn();
      sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      sync();
      return (performance.now() - t0) / n;
    };

    /* The scene is already in the atmosphere's HDR target from the render
     * above; finish() is everything downstream of it. */
    const post = () => g.atmos.finish(g.camera, g.sun.color, g.sun.intensity);
    const still = post;
    /* A still frame for everything except the shutter, whose whole subject is
     * a camera that is not still. Half a degree per rendered frame is a slow
     * pan; the matrices are updated by hand because nothing else in this loop
     * is stepping the game. */
    const panning = () => {
      g.camera.rotation.y += 0.009;
      g.camera.updateMatrixWorld(true);
      g.camera.matrixWorldInverse.copy(g.camera.matrixWorld).invert();
      post();
    };

    const cases = [
      ['none', OFF, still],
      ['grade only', { ...OFF, grade: true }, still],
      ['grain only', { ...OFF, grain: true }, still],
      ['bloom only', { ...OFF, bloom: true }, still],
      ['dof only', { ...OFF, dof: true }, still],
      ['motion only', { ...OFF, motion: true }, panning],
      ['all', { motion: true, dof: true, bloom: true, grade: true, grain: true }, still],
      ['all + motion', { motion: true, dof: true, bloom: true, grade: true, grain: true }, panning],
      /* And the whole frame, scene pass included, so the isolated post numbers
       * above can be read against something. These two are the before and
       * after of the entire system. */
      ['frame, post off', OFF, () => g.render()],
      ['frame, post on', { motion: true, dof: true, bloom: true, grade: true, grain: true },
        () => g.render()],
    ];

    // One scene pass, whose output every timed block then re-processes.
    g.render();
    // Warm every shader in the set before any of it is timed.
    for (const [, want, fn] of cases) { set(want); time(fn, 4); }

    const samples = cases.map(() => []);
    for (let k = 0; k < 7; k++) {
      for (let i = 0; i < cases.length; i++) {
        set(cases[i][1]);
        samples[i].push(time(cases[i][2], 30));
      }
    }
    const med = (a) => +a.sort((x, y) => x - y)[a.length >> 1].toFixed(3);

    // Back to a known camera after the panning blocks, then frozen: from here
    // the only thing that changes between probes is the flags.
    g.goTo(stop); g.warp(2.0);
    const out = [];
    for (let i = 0; i < cases.length; i++) {
      set(cases[i][1]);
      /* Two throwaway frames first. Motion blur carries the previous frame's
       * view matrix, and the previous frame here was the last of a panning
       * timing block, so without these the still probe of the shutter case
       * would be a frame smeared by a pan that is not happening. */
      g.render(); g.render();
      out.push({ name: cases[i][0], ms: med(samples[i]), hist: g.probe() });
    }
    set({ motion: true, dof: true, bloom: true, grade: true, grain: true });
    g.setPaused(false);
    return out;
  }, [STOP, TIER]);

  /* Deltas are against the first row for the isolated post cases and against
   * the post-off frame for the two whole-frame ones, since those are measuring
   * a different thing. */
  const base = rows[0].ms;
  const frameBase = rows.find(r => r.name === 'frame, post off').ms;
  console.log(`  t=${STOP}  tier=${TIER}`);
  console.log('  case               ms    delta     p01    p10    med    p90    p99   contr  black  blown');
  for (const r of rows) {
    const h = r.hist;
    const b = r.name.startsWith('frame') ? frameBase : base;
    console.log(`  ${r.name.padEnd(16)} ${r.ms.toFixed(2).padStart(5)} ` +
      `${(r.ms - b >= 0 ? '+' : '') + (r.ms - b).toFixed(2).padStart(6)}  ` +
      `${String(h.p01).padStart(6)} ${String(h.p10).padStart(6)} ${String(h.median).padStart(6)} ` +
      `${String(h.p90).padStart(6)} ${String(h.p99).padStart(6)} ${String(h.contrast).padStart(6)} ` +
      `${String(h.blackPct).padStart(6)} ${String(h.blownPct).padStart(6)}`);
  }
  console.log('  ' + gl.renderer);
});

finish(process.exitCode || 0);
