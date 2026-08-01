/* What a frame costs, per quality tier, in milliseconds that mean something.
 *
 * The obvious way to measure this — watch the frame counter — cannot work
 * here, because the loop is capped and the browser will happily report sixty
 * for anything that fits in sixteen milliseconds. That hides the whole
 * question. So the loop is paused, frames are driven by hand, and each block
 * is bracketed by glFinish so the CPU actually waits for the GPU instead of
 * timing how fast it can queue work.
 *
 * Timings are the median of seven interleaved blocks rather than one long
 * average. Interleaving matters: the driver's clocks ramp during a run, and a
 * sequential "all of A then all of B" comparison charges the ramp entirely to
 * whichever ran first, which is how a post-processing pass gets blamed for a
 * millisecond that belonged to the GPU waking up.
 *
 *   node tools/perf.mjs [--t 0.34]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const T = ['low', 'medium', 'high', 'ultra'];
/* One viewpoint cannot stand for the whole walk any more. The corridor at 0.34
 * is dense canopy and almost no masonry; the clearing is the reverse, and the
 * two load the renderer in different places — one in vertex throughput from a
 * million leaf cards, the other in the stone's rather more expensive fragment
 * shader over a much larger share of the screen. A regression in either is
 * invisible from the other, so the stop is a flag and both get measured. */
const args = process.argv.slice(2);
const ti = args.indexOf('--t');
const STOP = ti < 0 ? 0.34 : +args[ti + 1];

await run({ width: 1600, height: 900, hash: 'manual&tier=high' }, async ({ page, gl }) => {
  await page.evaluate(() => { window.__game.setSun(38, 152); });

  const bench = async (tier) => page.evaluate(async ([tier, stop]) => {
    const g = window.__game;
    g.setPaused(true);
    g.setTier(tier);
    g.goTo(stop); g.warp(2.0);
    const glc = g.renderer.getContext();
    /* Three's own render() resets info at entry when autoReset is on, so a
     * frame built from several passes reports only the last one. Counting the
     * whole frame means driving the reset by hand. */
    const frameCalls = () => {
      const inf = g.renderer.info;
      inf.autoReset = false; inf.reset();
      g.render();
      const c = inf.render.calls;
      inf.autoReset = true;
      return c;
    };
    const time = (fn, n) => {
      for (let i = 0; i < 8; i++) fn();
      glc.finish();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      glc.finish();
      return (performance.now() - t0) / n;
    };
    const full = () => { g.atmos.enabled = true; g.render(); };
    const noVol = () => { g.atmos.enabled = false; g.render(); };
    /* Straight to the canvas with no offscreen target and no passes at all —
     * the cost floor this system is measured against. */
    const raw = () => {
      g.renderer.setRenderTarget(null);
      g.renderer.render(g.scene, g.camera);
    };
    time(full, 20);                        // warm shaders and targets
    const on = [], off = [], base = [];
    for (let k = 0; k < 7; k++) { on.push(time(full, 40)); off.push(time(noVol, 40)); base.push(time(raw, 40)); }
    const med = (a) => +a.sort((x, y) => x - y)[a.length >> 1].toFixed(2);
    g.atmos.enabled = true;
    const info = g.info();
    const fc = frameCalls();
    g.setPaused(false);
    return {
      tier: g.tier, on: med(on), off: med(off), base: med(base),
      calls: info.calls, tris: info.triangles, frameCalls: fc,
    };
  }, [tier, STOP]);

  console.log(`  t=${STOP}`);
  console.log('  tier      frame ms   scene ms   post ms    fps   scene calls   frame calls    tris');
  for (const tier of T) {
    const r = await bench(tier);
    console.log(`  ${tier.padEnd(8)} ${String(r.on).padStart(8)}  ${String(r.base).padStart(9)}  ` +
                `${String(+(r.on - r.base).toFixed(2)).padStart(7)}  ${String(Math.round(1000 / r.on)).padStart(5)}  ` +
                `${String(r.calls).padStart(11)}  ${String(r.frameCalls).padStart(11)}  ${(r.tris / 1e6).toFixed(2)}M`);
  }
  console.log('  ' + gl.renderer);
});
finish(process.exitCode || 0);
