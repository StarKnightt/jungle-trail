/* Evidence for the post chain, in controlled pairs.
 *
 * shoot.mjs covers the five trail stops and is the right tool for "did the
 * palette move". It cannot show three of the effects at all: depth of field is
 * a claim about a leaf a metre from the lens and none of the stops has one in
 * frame at a size worth looking at, motion blur is by construction invisible
 * in a still, and bloom is a two per cent addition that has to be differenced
 * out of the frame to be seen.
 *
 * The thing this file exists to get right is the *control*. Its predecessor set
 * each shot up from scratch, which meant running `goTo(); warp(2.0)` again for
 * the second half of every pair — so the two frames were two seconds of falling
 * water apart, and differencing them measured the waterfall rather than the
 * effect. On its own files that was a per-pixel range of +-139 code values with
 * eleven per cent of the frame moving more than eight, against a bloom whose
 * real contribution is a tenth of a code value on the mean. An uncontrolled
 * pair is not weak evidence, it is evidence of something else.
 *
 * So: one world state per shot, and every variant of it rendered from that same
 * state inside a single evaluate. Nothing is stepped between the variants,
 * nothing is re-posed, and the shutter's previous view matrix is restored
 * before each one so that even the history is identical. The only difference
 * between the two files is the pass.
 *
 *   node tools/fx.mjs [tag] [--tier medium]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, dv) => { const i = args.indexOf('--' + k); return i < 0 ? dv : args[i + 1]; };
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'p2-fx';
const tier = flag('tier', 'high');
const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

const P = 'const p = g.atmos.grade;';
const ALL = P + 'p.want = {motion:true,dof:true,bloom:true,grade:true,grain:true}; p.debug = 0;';

/**
 * One world state, several renders of it.
 *
 * @param base   posing and warping, run once
 * @param steps  simulation frames to advance after posing, for the shutter
 * @param each   run before every stepped frame — this is where a pan lives
 * @param shots  [name, js] pairs, each rendered from the frozen end state
 */
async function pairs(page, base, steps, each, shots) {
  const urls = await page.evaluate(([base, steps, each, shots]) => {
    const g = window.__game;
    const G = g.atmos.grade;
    g.setPaused(true);
    new Function('g', base)(g);
    /* Two settling frames. The shutter carries the previous frame's view
     * matrix and the previous frame may have been a different shot entirely,
     * and the pool's reflection refreshes on alternate frames. */
    g.render(); g.render();

    const tick = each ? new Function('g', each) : null;
    for (let i = 0; i < steps; i++) {
      if (tick) tick(g);
      g.step(1 / 60);
      /* Deliberately not rendering the last step. Rendering it would leave the
       * shutter's previous view matrix equal to the current one, so the first
       * variant below would integrate no motion at all — the frame that is
       * supposed to be moving would be the one frame in the sequence that
       * isn't. The variants render it instead, each from the same history. */
      if (i < steps - 1) g.render();
    }

    const prevVP = G._prevVP.clone();
    const prevPos = G._prevPos.clone();
    const frame = G._frame;
    const out = [];
    for (const [, js] of shots) {
      new Function('g', js)(g);
      G._prevVP.copy(prevVP);
      G._prevPos.copy(prevPos);
      /* And the grain's frame counter, or the two halves of a pair get different
       * noise fields. Grain is zero-mean so it does not move a mean, but it has
       * a standard deviation of about one and a half code values and the
       * difference of two independent fields has two — which is larger than
       * several of the effects being measured here over most of the frame, and
       * unlike a desynchronised waterfall it lands in every percentile of the
       * delta rather than in one region of it. Half of a differenced pair
       * reading as noise is how a real measurement gets mistaken for one. */
      G._frame = frame;
      g.render();
      out.push(g.renderer.domElement.toDataURL('image/png'));
    }
    return out;
  }, [base, steps, each, shots]);

  shots.forEach(([name], i) => {
    fs.writeFileSync(path.join(outDir, name + '.png'),
                     Buffer.from(urls[i].split(',')[1], 'base64'));
    console.log('  ' + name + '.png');
  });
}

await run({ width: 1600, height: 900, hash: 'manual&tier=' + tier }, async ({ page, errs }) => {
  await page.evaluate(() => window.__game.setSun(38, 152));

  /* Down the trail and pitched at the floor a metre or so ahead: the framing a
   * walker's eye actually gives the near understory, and the one place the near
   * field is unambiguous. */
  await pairs(page, "g.goTo(0.34); g.walker.pitch -= 0.42; g.warp(2.0);", 0, '', [
    ['foliage-dof-on', ALL],
    ['foliage-dof-off', 'g.atmos.grade.want.dof = false;'],
    ['foliage-coc', ALL + 'p.debug = 2;'],
    ['foliage-nearcover', ALL + 'p.debug = 3;'],
  ]);

  await pairs(page, "g.goTo(0.96); g.warp(2.0);", 0, '', [
    ['falls-bloom-on', ALL],
    ['falls-bloom-off', 'g.atmos.grade.want.bloom = false;'],
    ['falls-bloom-only', ALL + 'p.debug = 1;'],
  ]);

  /* The clearing, which is the brightest stop on the walk and therefore the one
   * that decides whether the veil costs any highlight headroom. The falls are
   * the subject but they are water in shade with sun on them; this is a canopy
   * gap with the sky itself in it, and the sky is the only surface in the scene
   * with no upper bound of its own. If a stronger bloom is going to push
   * anything into the clip it will be here rather than at the curtain, and the
   * standing requirement is written about the curtain. */
  await pairs(page, "g.goTo(0.68); g.warp(2.0);", 0, '', [
    ['clearing-bloom-on', ALL],
    ['clearing-bloom-off', 'g.atmos.grade.want.bloom = false;'],
  ]);

  /* Grain, differenced out of a pair that is identical in every other respect.
   * Its amplitude is a claim in code values and there is no way to read one off
   * a frame that has a forest in it — but the difference of these two files *is*
   * the noise field, so its standard deviation and its shape against level are
   * then simply measurable rather than asserted. The README carried 1.1 for a
   * long time on no better basis than the number the shader had been written
   * against; measured, that build was making 0.72. */
  await pairs(page, "g.goTo(0.34); g.warp(2.0);", 0, '', [
    ['grain-on', ALL],
    ['grain-off', 'g.atmos.grade.want.grain = false;'],
  ]);

  /* A head turn, which is the motion documentary footage is full of and the
   * one a viewer has seen blurred ten thousand times. Walking straight at
   * something is the weakest possible test of camera blur — forward motion
   * produces screen velocity proportional to the reciprocal of depth and to
   * the distance from the centre of the frame, so a waterfall fifteen metres
   * away in the middle of the picture is very nearly stationary on the sensor.
   *
   * Two rates. Thirty-three degrees a second is an unhurried look around the
   * clearing, which at this field of view is ten pixels of travel per frame.
   * A hundred and twenty is a genuine whip, and it is there because that is
   * where the tap count and the velocity clamp are load bearing.
   */
  const at = (t, deg) => [`g.goTo(${t}); g.warp(2.0);`, 8,
                          `g.walker.yaw += ${(deg / 60 * Math.PI / 180).toFixed(6)};`];

  await pairs(page, ...at(0.96, 33), [
    ['pan-falls-on', ALL],
    ['pan-falls-off', 'g.atmos.grade.want.motion = false;'],
  ]);

  await pairs(page, ...at(0.96, 120), [
    ['pan-fast-on', ALL],
    ['pan-fast-off', 'g.atmos.grade.want.motion = false;'],
    ['pan-fast-vel', ALL + 'p.debug = 5;'],
  ]);

  /* A rate ladder, because "the blur clamps" is a claim about a curve and not
   * about a frame. Six rates from a standstill to a whip, each posed from the
   * same mark and each panning for the same number of frames, so sharpness
   * against rate is measurable and the point at which it stops falling — if it
   * stops falling — shows up in the numbers instead of being argued about.
   *
   * The velocity debug view goes out alongside each one. It has to, because a
   * laplacian has a floor: past about twenty pixels of travel there is no detail
   * left at the pixel scale to destroy, so sharpness flattens whether or not the
   * blur is still growing, and the two cases are indistinguishable from the
   * frame alone. Read the green channel of the debug view for the answer — it is
   * the clamp binding, it is binary, and it is the only readout here that
   * survives the tone curve intact. */
  for (const deg of [0, 7, 17, 34, 69, 137]) {
    const n = String(deg).padStart(3, '0');
    await pairs(page, ...at(0.34, deg), [
      [`rate${n}-on`, ALL],
      [`rate${n}-off`, 'g.atmos.grade.want.motion = false;'],
      [`rate${n}-vel`, ALL + 'p.debug = 5;'],
    ]);
  }

  /* The sky, panned. A canopy gap is the brightest thing in the frame and the
   * one element with no depth, so it is where a velocity reconstructed from the
   * depth buffer has nothing to reconstruct from. Pitched up to put a large
   * area of it in shot. */
  await pairs(page, "g.goTo(0.34); g.walker.pitch += 0.55; g.warp(2.0);", 8,
              'g.walker.yaw += 0.034907;', [
    ['sky-pan-on', ALL],
    ['sky-pan-off', 'g.atmos.grade.want.motion = false;'],
    ['sky-pan-vel', ALL + 'p.debug = 5;'],
  ]);

  if (errs.length) console.log('  (page errors present)');
  console.log(`\n  → ${path.relative(ROOT, outDir)}  tier=${tier}`);
});

finish(process.exitCode || 0);
