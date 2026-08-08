/* Capture a moving sequence, frame by frame, off the wall clock.
 *
 *   node tools/reel.mjs [tag] [--w 960] [--h 540] [--fps 24] [--sun 38,152]
 *                       [--shot "name|t|seconds|pitch0,pitch1|pace"] ...
 *
 * shoot.mjs stops and looks; this one walks. The difference that matters is
 * that nothing here waits for real time: the loop is paused and the simulation
 * is stepped by exactly one output frame between reads, so a capture that takes
 * four minutes produces the same motion as one that takes forty seconds, and
 * the shutter -- which reconstructs screen velocity from the previous frame's
 * view-projection -- integrates over the interval the file will actually be
 * played back at rather than over whatever the encoder happened to manage.
 *
 * Travel is the walker's own scripted path (setAuto), not a dolly, so the
 * frames carry the gait: the head rises and falls twice a stride, rolls once,
 * and never stops drifting. A lerped camera looks like a camera and this looks
 * like a person, and at this length that is most of the difference.
 *
 * Pitch is the one thing driven from outside, because the auto path steers yaw
 * toward the trail and leaves pitch alone. Ramping it is how a shot lifts into
 * the canopy and settles back onto the path.
 *
 * Frames land in shots/, which is gitignored; encoding them into something
 * small enough to commit is a separate step and deliberately not this file's
 * job.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'reel';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const W = +flag('w', 960), H = +flag('h', 540);
const FPS = +flag('fps', 24);
const [SUN_EL, SUN_AZ] = flag('sun', '38,152').split(',').map(Number);
const QUALITY = +flag('q', 0.95);
/* Simulated before the first captured frame of each shot. Wind, spray, ripple
 * and the gait clock all have several seconds of settling in them, and a shot
 * that starts from a standing teleport starts with the plume half built. */
const SETTLE = +flag('settle', 2.2);

/* The sequence. Authored here rather than passed in, for the same reason
 * shoot.mjs's stops are: the point of a fixed route is that two builds can be
 * put side by side. Every one of these is a moving shot along the trail with
 * near-field material in it -- the known weak view in this project is a long
 * flat look down the corridor, where everything past eight metres collapses
 * into haze, and none of these hold that for long. */
const DEFAULT_SHOTS = [
  { name: 'corridor', t: 0.225, seconds: 3.0, pitch: [0.10, -0.10], pace: 'walk' },
  { name: 'ruins', t: 0.775, seconds: 2.6, pitch: [-0.02, 0.06], pace: 'walk' },
  { name: 'falls', t: 0.925, seconds: 3.4, pitch: [-0.06, 0.10], pace: 'walk' },
];

const shots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--shot') continue;
  const [name, t, seconds, pitch, pace] = args[i + 1].split('|');
  shots.push({
    name,
    t: +t,
    seconds: +seconds,
    pitch: (pitch || '0,0').split(',').map(Number),
    pace: pace || 'walk',
  });
}
const SHOTS = shots.length ? shots : DEFAULT_SHOTS;

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const lerp = (a, b, u) => a + (b - a) * u;

await run({ width: W, height: H, hash: 'manual&tier=high' }, async ({ page, errs, gl }) => {
  await page.evaluate(([el, az]) => {
    const g = window.__game;
    g.setSun(el, az);
    // The rAF loop must not also be stepping: every frame below is advanced by
    // hand, and a second clock underneath would double some of them.
    g.setPaused(true);
  }, [SUN_EL, SUN_AZ]);

  let index = 0;
  const cuts = [];
  for (const shot of SHOTS) {
    const frames = Math.round(shot.seconds * FPS);
    await page.evaluate(([t, pace, pitch0, settle]) => {
      const g = window.__game;
      g.goTo(t);
      g.walker.setAuto(t, pace);
      g.walker.pitch = pitch0;
      g.warp(settle);
      /* Two rendered frames before anything is kept. The shutter needs a
       * previous view-projection to difference against, and the first frame
       * after a teleport has one belonging to wherever the camera used to be
       * -- which smears the whole picture exactly once, at the cut. */
      g.render();
      g.render();
    }, [shot.t, shot.pace, shot.pitch[0], SETTLE]);

    const first = index;
    for (let f = 0; f < frames; f++) {
      const pitch = lerp(shot.pitch[0], shot.pitch[1], frames < 2 ? 0 : f / (frames - 1));
      const data = await page.evaluate(([dt, p, q]) => {
        const g = window.__game;
        g.walker.pitch = p;
        g.step(dt);
        g.render();
        /* One evaluate, because the drawing buffer is not preserved and is
         * gone by the next task. */
        return g.renderer.domElement.toDataURL('image/jpeg', q);
      }, [1 / FPS, pitch, QUALITY]);
      fs.writeFileSync(
        path.join(outDir, `${String(index).padStart(4, '0')}.jpg`),
        Buffer.from(data.split(',')[1], 'base64'),
      );
      index++;
    }

    const at = await page.evaluate(() => {
      const g = window.__game;
      return { t: +g.walker.auto.t.toFixed(3), ...g.info() };
    });
    cuts.push({ ...shot, frames, from: first, to: index - 1, endT: at.t });
    console.log(`  ${shot.name.padEnd(10)} ${String(frames).padStart(3)} frames  `
      + `t ${shot.t} -> ${at.t}  calls=${at.calls} tris=${(at.triangles / 1000).toFixed(0)}k`);
  }

  fs.writeFileSync(path.join(outDir, 'reel.json'), JSON.stringify({
    tag, gl, sun: [SUN_EL, SUN_AZ], size: [W, H], fps: FPS, cuts, errors: errs,
  }, null, 2));
  console.log(`\n  ${index} frames at ${FPS} fps = ${(index / FPS).toFixed(1)} s`);
  console.log(`  → ${path.relative(ROOT, outDir)}   ${gl.renderer}`);
});

finish(process.exitCode || 0);
