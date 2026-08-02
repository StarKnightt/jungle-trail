/* The evidence shots for the grading system.
 *
 * shoot.mjs covers the five trail stops and is the right tool for "did the
 * palette move". It cannot show two of the five effects at all. Depth of field
 * is a claim about a leaf a metre from the lens and none of the stops has one
 * in frame at a size worth looking at; motion blur is by construction invisible
 * in a paused capture, because the harness renders a still frame and a still
 * camera has no velocity to integrate.
 *
 * So this file does two things shoot.mjs deliberately does not. It poses the
 * camera at foliage, and it *steps the simulation between the previous frame
 * and the captured one*, which is what gives the shutter something to
 * reconstruct. Everything comes in pairs with the effect off and on, from the
 * same viewpoint and the same simulation state, because a single frame with an
 * effect in it is not evidence of anything.
 *
 *   node tools/p1shots.mjs [tag]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'p1-evidence';
const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

/** Run `setup`, step `steps` frames (running `each` before every one), grab. */
async function grab(page, file, setup, steps = 0, each = '') {
  const url = await page.evaluate(([setup, steps, each]) => {
    const g = window.__game;
    const tick = each ? new Function('g', each) : null;
    g.setPaused(true);
    new Function('g', setup)(g);
    /* Two settling frames before anything is measured, because the shutter
     * carries the previous frame's view matrix and the previous frame might
     * have been a different shot entirely. */
    g.render(); g.render();
    for (let i = 0; i < steps; i++) { if (tick) tick(g); g.step(1 / 60); g.render(); }
    if (!steps) g.render();
    /* Left paused for the whole run. Unpausing between two shots of a pair
     * hands the animation frame loop a few milliseconds in which to step the
     * walker, which is exactly the thing the pair is holding still. */
    return g.renderer.domElement.toDataURL('image/png');
  }, [setup, steps, each]);
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log('  ' + path.basename(file));
}

await run({ width: 1600, height: 900, hash: 'manual&tier=high' }, async ({ page, errs }) => {
  await page.evaluate(() => window.__game.setSun(38, 152));

  const P = 'const p = g.atmos.grade;';
  const ALL = P + 'p.want = {motion:true,dof:true,bloom:true,grade:true,grain:true}; p.debug = 0;';
  /* Down the trail and pitched at the floor a metre or so ahead: the framing
   * a walker's eye actually gives the near understory, and the one place the
   * near field is unambiguous. */
  const FOLIAGE = "g.goTo(0.34); g.walker.pitch -= 0.42; g.warp(2.0);";
  const FALLS = "g.goTo(0.96); g.warp(2.0);";

  const shot = (name, js, steps) => grab(page, path.join(outDir, name + '.png'), js, steps);

  await shot('foliage-dof-off', ALL + FOLIAGE + 'p.want.dof = false;');
  await shot('foliage-dof-on', ALL + FOLIAGE);
  await shot('foliage-coc', ALL + FOLIAGE + 'p.debug = 2;');
  await shot('foliage-nearcover', ALL + FOLIAGE + 'p.debug = 3;');

  await shot('falls-bloom-off', ALL + FALLS + 'p.want.bloom = false;');
  await shot('falls-bloom-on', ALL + FALLS);
  await shot('falls-bloom-only', ALL + FALLS + 'p.debug = 1;');

  /* Jogging into the clearing, and the pair is taken from one pose rather
   * than from two runs of the same script.
   *
   * The obvious way — set the shot up twice, once with the effect off — does
   * not give a comparable pair here, because the walker's pace blend and gait
   * clock survive between shots, so the second run is already at a jog where
   * the first spent a third of a second getting there and ends up half a metre
   * further down the trail. Two frames of a moving camera at different points
   * on the trail say nothing about motion blur.
   *
   * Instead the run is stepped once, the blurred frame is captured, and then
   * the shutter is switched off and the *same* frame is rendered again from
   * the same pose with nothing else touched. The only difference between the
   * two images is the pass.
   */
  const RUN = "g.goTo(0.95); g.walker.setAuto(0.995, 'jog'); g.walker._paceBlend = 1; g.warp(0.8);";
  await grab(page, path.join(outDir, 'motion-jog-on.png'), ALL + RUN, 10);
  await grab(page, path.join(outDir, 'motion-jog-off.png'), P + 'p.want.motion = false;');

  /* And the case that actually shows it: a pan.
   *
   * Walking straight at something is the weakest possible test of camera
   * blur and the jog pair above is nearly identical for a good reason —
   * forward motion produces screen velocity proportional to distance from the
   * centre of the frame and to the reciprocal of depth, so a waterfall
   * fifteen metres away in the middle of the picture is very nearly
   * stationary on the sensor. That is correct and it is also why the pair
   * proves nothing on its own.
   *
   * A head turn is the motion documentary footage is full of and the one a
   * viewer has seen blurred ten thousand times. Thirty-three degrees a second
   * is an unhurried look around the clearing; at this field of view that is
   * nine pixels of travel per frame, and at the shutter set in
   * render/grade.js nine pixels of smear.
   */
  const PAN = 'g.walker.yaw += 0.0097;';
  await grab(page, path.join(outDir, 'motion-pan-on.png'),
             ALL + "g.goTo(0.96); g.warp(2.0);", 10, PAN);
  await grab(page, path.join(outDir, 'motion-pan-off.png'), P + 'p.want.motion = false;');

  if (errs.length) console.log('  (page errors present)');
  console.log(`\n  → ${path.relative(ROOT, outDir)}`);
});

finish(process.exitCode || 0);
