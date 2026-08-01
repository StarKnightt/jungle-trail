/* Free-camera capture.
 *
 *   node tools/look.mjs <tag> --at x,y,z --to x,y,z [--fov 50] [--sun 38,152]
 *                       [--w 1600] [--h 900] [--js "..."]
 *
 * shoot.mjs is the right tool for the walk and the wrong one for an object.
 * It puts the camera where the player's eye would be at a stop on the trail,
 * which is exactly what a comparison between builds needs and exactly what is
 * useless for "is the lip of the waterfall the right shape" — that question
 * needs the camera four metres from the lip, and no point on the trail is.
 *
 * Several shots per run, comma-separated, because booting the page costs
 * twenty seconds and rendering costs about a tenth of one.
 *
 *   --shot "name|ax,ay,az|tx,ty,tz|fov"      repeatable
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'look';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const shots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shot') {
    // name | eye | target | fov | js-run-before-this-shot
    const [name, at, to, fov, js] = args[i + 1].split('|');
    shots.push({
      name,
      at: at.split(',').map(Number),
      to: to.split(',').map(Number),
      fov: fov ? +fov : 50,
      js: js || '',
    });
  }
}
if (!shots.length && flag('at')) {
  shots.push({
    name: 'view',
    at: flag('at').split(',').map(Number),
    to: flag('to', '0,0,0').split(',').map(Number),
    fov: +flag('fov', 50),
  });
}

const W = +flag('w', 1600), H = +flag('h', 900);
const [SUN_EL, SUN_AZ] = flag('sun', '38,152').split(',').map(Number);
const JS = flag('js', '');
const WARP = +flag('warp', 2.5);

const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

await run({ width: W, height: H, hash: 'manual&tier=' + flag('tier', 'high') },
  async ({ page, errs, gl }) => {
    await page.evaluate(([el, az, js]) => {
      window.__game.setSun(el, az);
      if (js) new Function('g', js)(window.__game);
    }, [SUN_EL, SUN_AZ, JS]);

    for (const s of shots) {
      await page.evaluate(([at, to, fov, warp, js]) => {
        const g = window.__game;
        if (js) new Function('g', js)(g);
        /* Only the walker is silenced, not the whole step. The walker is what
         * would drag the camera back onto the trail, but everything else in
         * the frame is keyed to where the camera *is* — the vegetation picks
         * its instance LODs from it, the ruins do the same, the shadow
         * frustum tracks it and the water's plume fades on distance to it.
         * Stubbing `step` wholesale was the first attempt and it produced
         * shots of a clearing with almost no plants in them, because the
         * instance lists were still the ones chosen for wherever the walker
         * had last stood. */
        if (!g.walker.__posed) {
          g.walker.__posed = true;
          g.walker.update = () => {};
        }
        g.camera.fov = fov;
        g.camera.position.set(at[0], at[1], at[2]);
        g.camera.lookAt(to[0], to[1], to[2]);
        g.camera.updateProjectionMatrix();
        // Posed first and warped second, so the warp's updates see the final
        // camera and the ripple, wind and spray clocks all settle against it.
        g.warp(warp);
      }, [s.at, s.to, s.fov, WARP, s.js]);
      await page.waitForTimeout(120);

      const st = await page.evaluate(() => ({
        ...window.__game.info(), hist: window.__game.probe(),
      }));
      await capture(page, path.join(outDir, `${s.name}.png`));
      console.log(`  ${s.name.padEnd(16)} calls=${String(st.calls).padStart(4)} ` +
                  `tris=${(st.triangles / 1000).toFixed(0)}k  ` +
                  `med=${st.hist.median} blown=${st.hist.blownPct}%`);
    }
    if (errs.length) console.log('  (page errors present)');
    console.log(`\n  → ${path.relative(ROOT, outDir)}   ${gl.renderer}`);
  });

finish(process.exitCode || 0);
