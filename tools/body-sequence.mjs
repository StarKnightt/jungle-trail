/* Deterministic first-person locomotion flipbooks.
 *
 * Still screenshots can hide a sliding planted foot or a hard state switch.
 * These short, fixed-step sequences expose one complete walk and jog cycle,
 * then the anticipation, flight and absorption of one jump. The game remains
 * paused between samples so browser scheduling cannot change the pose chosen
 * for a numbered frame.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';
import {
  WALK_SPEED,
  JOG_SPEED,
  WALK_STEP_LENGTH,
  JOG_STEP_LENGTH,
} from '../src/player/gait.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots', 'body2');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

async function snap(page, relative) {
  const data = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    g.renderOnce();
    return g.renderer.domElement.toDataURL('image/png');
  });
  const file = path.join(OUT, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  return relative.replaceAll('\\', '/');
}

async function advance(page, seconds) {
  await page.evaluate((duration) => {
    const g = window.__game;
    for (let t = 0; t < duration - 1e-7; t += 1 / 120) {
      g.step(Math.min(1 / 120, duration - t));
    }
  }, seconds);
}

await run({ width: 1280, height: 720, hash: 'manual&tier=high' }, async ({ page, errs, gl }) => {
  await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    g.setSun(38, 152);
  });

  const frames = [];
  const gaitSequence = async (name, pace, warm, cycleSeconds) => {
    await page.evaluate(({ pace, warm }) => {
      const g = window.__game;
      g.goTo(0.34);
      g.walker.pitch = -1.05;
      g.walker.setAuto(0.34, pace);
      g.warp(warm, 1 / 120);
      g.walker.bobPhase = 0;
      g.body._feet.L.planted = false;
      g.body._feet.R.planted = false;
      g.step(0);
    }, { pace, warm });

    for (let i = 0; i <= 8; i++) {
      if (i) await advance(page, cycleSeconds / 8);
      const file = await snap(page, `${name}/${name}-${String(i).padStart(2, '0')}.png`);
      const state = await page.evaluate(() => ({
        phase: window.__game.walker.bobPhase % 1,
        speed: window.__game.walker.speed,
        stepLength: window.__game.walker.stepLength,
        runBlend: window.__game.walker.runBlend,
      }));
      frames.push({ state: name, file, ...state });
    }
  };

  await gaitSequence('walk', 'walk', 0.8, (WALK_STEP_LENGTH * 2) / WALK_SPEED);
  await gaitSequence('run', 'jog', 1.2, (JOG_STEP_LENGTH * 2) / JOG_SPEED);

  await page.evaluate(() => {
    const g = window.__game;
    g.goTo(0.34);
    g.walker.pitch = -0.92;
    g.walker.setAuto(null);
    g.walker.jump();
  });
  const jumpTimes = [0.02, 0.09, 0.17, 0.26, 0.47, 0.64, 0.79, 0.84, 0.94, 1.08];
  let previous = 0;
  for (let i = 0; i < jumpTimes.length; i++) {
    await advance(page, jumpTimes[i] - previous);
    previous = jumpTimes[i];
    const state = await page.evaluate(() => {
      const w = window.__game.walker;
      return {
        jumpState: w.jumpState,
        height: w.jumpHeight,
        crouch: w.jumpCrouch,
        verticalVelocity: w.verticalVelocity,
      };
    });
    const label = state.jumpState === 'grounded' ? 'settled' : state.jumpState;
    const file = await snap(
      page,
      `jump/jump-${String(i).padStart(2, '0')}-${label}.png`,
    );
    frames.push({ state: 'jump', file, time: jumpTimes[i], ...state });
  }

  await page.evaluate(() => {
    const g = window.__game;
    g.goTo(0.16);
    g.walker.pitch = -0.12;
    g.walker.setAuto(0.16, 'walk');
    g.warp(1.1, 1 / 120);
  });
  frames.push({ state: 'context', file: await snap(page, 'context/context-walk.png') });

  await page.evaluate(() => {
    const g = window.__game;
    g.goTo(0.68);
    g.walker.pitch = -0.10;
    g.walker.setAuto(0.68, 'jog');
    g.warp(1.2, 1 / 120);
  });
  frames.push({ state: 'context', file: await snap(page, 'context/context-run.png') });

  await page.evaluate(() => window.__game.setPaused(false));
  await page.waitForTimeout(2200);
  const summary = await page.evaluate(() => {
    const g = window.__game;
    return {
      body: g.body.stats(),
      fov: g.camera.fov,
      fps: g.fps,
    };
  });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
    gl,
    errors: errs,
    summary,
    frames,
  }, null, 2));
  console.log(`  ${frames.length} frames → ${path.relative(ROOT, OUT)}`);
});

finish(process.exitCode || 0);
