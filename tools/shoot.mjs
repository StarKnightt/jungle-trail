/* Capture the walk.
 *
 * Renders the same set of viewpoints along the trail every run, so shots from
 * two different builds can be put side by side and actually compared. The
 * positions are the ones that matter narratively: the trailhead under closed
 * canopy, the narrowing, the first sight of light, the clearing, the falls.
 *
 *   node tools/shoot.mjs [tag] [--t 0.03,0.5] [--w 1600] [--h 900]
 *                        [--sun 38,152] [--cpu] [--yaw 0] [--tier high]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'run';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const STOPS = flag('t', '0.02,0.16,0.34,0.52,0.68,0.84,0.96').split(',').map(Number);
const W = +flag('w', 1600), H = +flag('h', 900);
const [SUN_EL, SUN_AZ] = flag('sun', '38,152').split(',').map(Number);
const YAW = +flag('yaw', 0);
const PITCH = +flag('pitch', 0);
/* A long lens on the same viewpoint. Nothing here changes the scene — it is
 * purely a way to inspect texture and geometry at the size a viewer's eye
 * gives them when they stop and look at one plant, which a 58-degree frame at
 * 1280 wide cannot show. Detail that only exists below this magnification is
 * detail nobody will ever see. */
const FOV = +flag('fov', 0);
/* The quality tier, which used to be nailed to `high` here. Half of what the
 * ladder ships is not `high`, and a requirement written "at every stop and every
 * tier" cannot be checked by a tool that can only visit one of them. */
const TIER = flag('tier', 'high');

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* Arbitrary setup, run once against `g` before the first stop. This is for
 * isolating a suspect layer — hiding the vegetation to see the bare ground,
 * or switching the terrain's debug output to a single mask — without editing
 * the scene and having to remember to edit it back. */
const JS = flag('js', '');

await run({ width: W, height: H, hash: 'manual&tier=' + TIER }, async ({ page, errs, gl }) => {
  await page.evaluate(([el, az, fov, js]) => {
    window.__game.setSun(el, az);
    if (fov) {
      window.__game.camera.fov = fov;
      window.__game.camera.updateProjectionMatrix();
    }
    if (js) new Function('g', js)(window.__game);
  }, [SUN_EL, SUN_AZ, FOV, JS]);

  const results = [];
  for (const t of STOPS) {
    await page.evaluate(([t, yaw, pitch]) => {
      const g = window.__game;
      g.goTo(t);
      if (yaw) g.walker.yaw += yaw;
      if (pitch) g.walker.pitch += pitch;
      // Let the camera height spring settle and any streaming/adaptive state
      // reach the value it would have if you had actually walked here.
      g.warp(2.0);
    }, [t, YAW, PITCH]);
    await page.waitForTimeout(220);

    const st = await page.evaluate(() => {
      const g = window.__game;
      const p = g.camera.position;
      return {
        fps: +g.fps.toFixed(1), tier: g.tier,
        pos: [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)],
        ...g.info(),
        hist: g.probe(),
      };
    });

    const file = path.join(outDir, `${String(Math.round(t * 100)).padStart(2, '0')}.png`);
    await capture(page, file);
    results.push({ t, file: path.basename(file), ...st });
    const hi = st.hist;
    console.log(`  t=${t.toFixed(2)}  pos=${st.pos.join(',')}  ` +
                `calls=${String(st.calls).padStart(4)} tris=${(st.triangles / 1000).toFixed(0)}k`);
    console.log(`        lum med=${hi.median} p10=${hi.p10} p90=${hi.p90} mean=${hi.mean} ` +
                `contrast=${hi.contrast} black=${hi.blackPct}% blown=${hi.blownPct}% ` +
                `up=${hi.upper} low=${hi.lower}`);
  }

  // Frame time on the real adapter, measured after everything is warm. On the
  // software backend this number is meaningless and is labelled as such.
  const perf = await page.evaluate(async () => {
    const g = window.__game;
    g.setPaused(false);
    await new Promise(r => setTimeout(r, 2500));
    return { fps: +g.fps.toFixed(1), tier: g.tier };
  });
  console.log(`\n  steady: ${perf.fps} fps @ tier=${perf.tier}  (${gl.renderer})`);

  fs.writeFileSync(path.join(outDir, 'report.json'),
    JSON.stringify({ tag, gl, sun: [SUN_EL, SUN_AZ], perf, results, errors: errs }, null, 2));
  console.log(`\n  → ${path.relative(ROOT, outDir)}`);
});

finish(process.exitCode || 0);
