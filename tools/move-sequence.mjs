/* Deterministic movement audit and flipbook.
 *
 * A controller can look convincing in one frame while still accelerating too
 * quickly, losing momentum in the air, or reporting a gait speed that the
 * player did not actually travel. This harness records both the controller's
 * numbers and measured displacement at a fixed 120 Hz, then captures the same
 * start, jog transition and stop on every run. Keeping the audit beside the
 * existing capture tools makes movement tuning reproducible instead of a
 * memory of how one keyboard pass felt.
 *
 *   node tools/move-sequence.mjs before
 *   node tools/move-sequence.mjs after
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv.slice(2).find(a => !a.startsWith('--')) || 'run';
const OUT = path.join(ROOT, 'shots', 'move1', tag);
const FRAME_DT = 1 / 120;

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

await run({ width: 1280, height: 720, hash: 'manual&tier=high' }, async ({ page, errs, gl }) => {
  await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    g.setSun(38, 152);
  });

  const measurements = await page.evaluate((frameDt) => {
    const g = window.__game;
    const w = g.walker;
    const eyeHeight = w.pos.y - g.terrain.height(w.pos.x, w.pos.z);
    const collisionEnabled = g.collision?.enabled;
    /* This block replaces the terrain with controlled planes to isolate gait
     * response. Generated colliders retain their original elevations, so
     * leaving them active after flattening the ground turns an unrelated trunk
     * into a false downhill-speed failure. The collision-specific audit drives
     * those proxies separately; this one keeps measuring locomotion constants. */
    if (g.collision) g.collision.enabled = false;
    const round = (v, n = 4) => +v.toFixed(n);
    const clearKeys = () => {
      for (const code of Object.keys(w.keys)) w.keys[code] = false;
    };
    const reset = (t = 0.90) => {
      clearKeys();
      g.goTo(t);
      w.bobPhase = 0;
      w.dist = 0;
      w.runBlend = 0;
      if ('_paceBlend' in w) w._paceBlend = 0;
      g.step(0);
    };
    const step = (seconds, collect = null) => {
      let distance = 0;
      let rise = 0;
      let elapsed = 0;
      let samples = 0;
      let reported = 0;
      let velocity = 0;
      let slopeFactor = 0;
      for (let t = 0; t < seconds - 1e-8; t += frameDt) {
        const dt = Math.min(frameDt, seconds - t);
        const x = w.pos.x, y = w.pos.y, z = w.pos.z;
        g.step(dt);
        const travelled = Math.hypot(w.pos.x - x, w.pos.z - z);
        distance += travelled;
        rise += g.terrain.height(w.pos.x, w.pos.z)
              - g.terrain.height(x, z);
        elapsed += dt;
        reported += w.speed;
        velocity += Math.hypot(w.vel.x, w.vel.z);
        slopeFactor += w.slopeFactor ?? 1;
        samples++;
        if (collect) collect(t + dt, travelled / dt);
      }
      return {
        seconds: round(elapsed),
        distance: round(distance),
        rise: round(rise),
        planarSpeed: round(distance / Math.max(1e-8, elapsed)),
        reportedSpeed: round(reported / Math.max(1, samples)),
        velocity: round(velocity / Math.max(1, samples)),
        slopeFactor: round(slopeFactor / Math.max(1, samples)),
      };
    };
    const settleDirection = (codes) => {
      reset();
      for (const code of codes) w.keys[code] = true;
      step(2.5);
      return step(0.75);
    };
    const curve = (seconds, spacing = 0.05) => {
      const out = [];
      let next = spacing;
      let intervalDistance = 0;
      let intervalTime = 0;
      step(seconds, (t, actual) => {
        intervalDistance += actual * frameDt;
        intervalTime += frameDt;
        if (t + 1e-8 < next) return;
        out.push({
          t: round(next, 2),
          speed: round(w.speed),
          velocity: round(Math.hypot(w.vel.x, w.vel.z)),
          actual: round(intervalDistance / Math.max(frameDt, intervalTime)),
          runBlend: round(w.runBlend),
          fov: round(g.camera.fov, 3),
        });
        next += spacing;
        intervalDistance = 0;
        intervalTime = 0;
      });
      return out;
    };

    /* Direction ratios need one controlled surface. Measuring W and D on
     * different sides of a real bank folds the new grade response into the
     * keyboard-normalisation result, so the terrain is flattened only for
     * this laboratory pass and restored before the slope test below. */
    const terrainHeight = g.terrain.height.bind(g.terrain);
    const terrainNormal = g.terrain.normal.bind(g.terrain);
    const flatY = terrainHeight(w.pos.x, w.pos.z);
    g.terrain.height = () => flatY;
    g.terrain.normal = (x, z, out = new window.THREE.Vector3()) => out.set(0, 1, 0);

    const directional = {
      surface: 'controlled-flat',
      forward: settleDirection(['KeyW']),
      diagonal: settleDirection(['KeyW', 'KeyD']),
      strafe: settleDirection(['KeyD']),
      backward: settleDirection(['KeyS']),
    };
    directional.diagonalToForward = round(
      directional.diagonal.planarSpeed / directional.forward.planarSpeed,
    );
    directional.strafeToForward = round(
      directional.strafe.planarSpeed / directional.forward.planarSpeed,
    );
    directional.backwardToForward = round(
      directional.backward.planarSpeed / directional.forward.planarSpeed,
    );

    reset();
    w.keys.KeyW = true;
    const acceleration = curve(1.2);
    w.keys.KeyW = false;
    const braking = curve(0.8);

    reset();
    w.keys.KeyW = true;
    step(1.2);
    w.keys.ShiftLeft = true;
    const jogIn = curve(1.2, 0.1);
    w.keys.ShiftLeft = false;
    const jogOut = curve(1.2, 0.1);

    reset();
    w.keys.KeyW = true;
    step(1.0);
    w.jump();
    let guard = 0;
    while (w.jumpState !== 'airborne' && guard++ < 120) g.step(frameDt);
    const takeoffSpeed = Math.hypot(w.vel.x, w.vel.z);
    w.keys.KeyW = false;
    let airDistance = 0;
    const air = [];
    let airTime = 0;
    let nextAir = 0.1;
    while (w.jumpState === 'airborne' && airTime < 1.5) {
      const x = w.pos.x, z = w.pos.z;
      g.step(frameDt);
      airTime += frameDt;
      airDistance += Math.hypot(w.pos.x - x, w.pos.z - z);
      if (airTime + 1e-8 >= nextAir) {
        air.push({
          t: round(nextAir, 2),
          speed: round(w.speed),
          velocity: round(Math.hypot(w.vel.x, w.vel.z)),
          height: round(w.jumpHeight),
        });
        nextAir += 0.1;
      }
    }
    const jump = {
      takeoffSpeed: round(takeoffSpeed),
      landingSpeed: round(Math.hypot(w.vel.x, w.vel.z)),
      retained: round(Math.hypot(w.vel.x, w.vel.z) / Math.max(1e-8, takeoffSpeed)),
      airTime: round(airTime),
      airDistance: round(airDistance),
      samples: air,
    };

    g.terrain.height = terrainHeight;
    g.terrain.normal = terrainNormal;

    /* Find a repeatable moderate bank near the playable corridor. Testing the
     * same point uphill and downhill separates grade response from a change in
     * terrain seed or a hand-picked flat patch. */
    let slopeSite = null;
    for (let i = 10; i <= 140; i++) {
      const t = i / 180;
      const p = g.trail.pointAt(t, new window.THREE.Vector3());
      const tan = g.trail.tangentAt(t, new window.THREE.Vector3());
      for (const side of [-5, -3.5, -2.2, 2.2, 3.5, 5]) {
        const x = p.x + tan.z * side;
        const z = p.z - tan.x * side;
        const n = g.terrain.normal(x, z, new window.THREE.Vector3());
        const grade = Math.hypot(n.x, n.z) / Math.max(0.01, n.y);
        const score = Math.abs(grade - 0.27);
        if (n.y > 0.82 && (!slopeSite || score < slopeSite.score)) {
          slopeSite = { x, z, nx: n.x, ny: n.y, nz: n.z, grade, score };
        }
      }
    }
    const gx = -slopeSite.nx / slopeSite.ny;
    const gz = -slopeSite.nz / slopeSite.ny;
    const gradInv = 1 / Math.hypot(gx, gz);
    const ux = gx * gradInv, uz = gz * gradInv;
    const slopeY = terrainHeight(slopeSite.x, slopeSite.z);
    const slopeGrade = 0.27;
    const slopeNormal = new window.THREE.Vector3(
      -ux * slopeGrade,
      1,
      -uz * slopeGrade,
    ).normalize();
    /* The sampled bank establishes a real position, bearing and grade, while
     * extending its local tangent into a plane lets both directions reach
     * steady state without the downhill pass leaving the bank first. */
    g.terrain.height = (x, z) => slopeY
      + ((x - slopeSite.x) * ux + (z - slopeSite.z) * uz) * slopeGrade;
    g.terrain.normal = (x, z, out = new window.THREE.Vector3()) => out.copy(slopeNormal);

    const slopeRun = (sign) => {
      clearKeys();
      w.setAuto(null);
      w.pos.set(
        slopeSite.x,
        g.terrain.height(slopeSite.x, slopeSite.z) + eyeHeight,
        slopeSite.z,
      );
      const dx = ux * sign, dz = uz * sign;
      w.yaw = Math.atan2(dx, -dz);
      w.vel.set(0, 0, 0);
      w.speed = 0;
      w.runBlend = 0;
      if ('_paceBlend' in w) w._paceBlend = 0;
      w.keys.KeyW = true;
      step(2.5);
      return step(0.75);
    };
    const slope = {
      surface: 'controlled-plane-from-real-bank',
      site: {
        x: round(slopeSite.x),
        z: round(slopeSite.z),
        normalY: round(slopeNormal.y),
        grade: slopeGrade,
        degrees: round(Math.atan(slopeGrade) * 180 / Math.PI, 2),
      },
      uphill: slopeRun(1),
      downhill: slopeRun(-1),
    };

    /* A rejected bank must also reject the locomotion signal. Otherwise the
     * view bobs and the procedural body keeps walking while its world position
     * is pinned, which is more conspicuous than the collision itself. */
    const blockedGrade = 1.15;
    const blockedNormal = new window.THREE.Vector3(
      -ux * blockedGrade,
      1,
      -uz * blockedGrade,
    ).normalize();
    g.terrain.height = (x, z) => slopeY
      + ((x - slopeSite.x) * ux + (z - slopeSite.z) * uz) * blockedGrade;
    g.terrain.normal = (x, z, out = new window.THREE.Vector3()) => out.copy(blockedNormal);
    clearKeys();
    w.pos.set(
      slopeSite.x,
      g.terrain.height(slopeSite.x, slopeSite.z) + eyeHeight,
      slopeSite.z,
    );
    w.yaw = Math.atan2(ux, -uz);
    w.vel.set(0, 0, 0);
    w.speed = 0;
    w.bobPhase = 0;
    w.keys.KeyW = true;
    slope.blocked = {
      grade: blockedGrade,
      degrees: round(Math.atan(blockedGrade) * 180 / Math.PI, 2),
      normalY: round(blockedNormal.y),
      ...step(0.6),
      gaitAdvance: round(w.bobPhase),
    };
    g.terrain.height = terrainHeight;
    g.terrain.normal = terrainNormal;

    reset(0.34);
    w.setAuto(0.34, 'walk');
    const autoStart = w.auto.t;
    step(0.8);
    const auto = {
      startT: round(autoStart),
      endT: round(w.auto.t),
      advanced: w.auto.t > autoStart,
      speed: round(w.speed),
    };
    w.setAuto(null);

    w.enabled = true;
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    const beforeBlur = !!w.keys.KeyW;
    dispatchEvent(new Event('blur'));
    const inputRelease = { beforeBlur, afterBlur: !!w.keys.KeyW };

    w.enabled = true;
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    const beforeUnlock = !!w.keys.KeyW;
    document.dispatchEvent(new Event('pointerlockchange'));
    const pointerUnlock = {
      beforeUnlock,
      afterUnlock: !!w.keys.KeyW,
      enabled: w.enabled,
    };
    clearKeys();

    if (g.collision) g.collision.enabled = collisionEnabled;
    return {
      directional,
      acceleration,
      braking,
      jogIn,
      jogOut,
      jump,
      slope,
      auto,
      inputRelease,
      pointerUnlock,
    };
  }, FRAME_DT);

  await page.evaluate(() => {
    const g = window.__game;
    const w = g.walker;
    for (const code of Object.keys(w.keys)) w.keys[code] = false;
    g.goTo(0.34);
    w.pitch = -0.78;
    w.bobPhase = 0;
    w.runBlend = 0;
    if ('_paceBlend' in w) w._paceBlend = 0;
    w.keys.KeyW = true;
    g.step(0);
  });

  const frames = [];
  for (let i = 0; i <= 20; i++) {
    const t = i * 0.1;
    if (i) {
      await page.evaluate((dt) => {
        const g = window.__game;
        const w = g.walker;
        for (let elapsed = 0; elapsed < dt - 1e-8; elapsed += 1 / 120) {
          g.step(Math.min(1 / 120, dt - elapsed));
        }
      }, 0.1);
    }
    await page.evaluate((time) => {
      const w = window.__game.walker;
      w.keys.ShiftLeft = time >= 0.7 && time < 1.4;
      w.keys.KeyW = time < 1.4;
    }, t);
    const state = await page.evaluate(() => {
      const g = window.__game;
      return {
        speed: +g.walker.speed.toFixed(4),
        velocity: +Math.hypot(g.walker.vel.x, g.walker.vel.z).toFixed(4),
        runBlend: +g.walker.runBlend.toFixed(4),
        fov: +g.camera.fov.toFixed(3),
      };
    });
    const file = await snap(page, `sequence/frame-${String(i).padStart(2, '0')}.png`);
    frames.push({ t: +t.toFixed(1), file, ...state });
  }

  const report = {
    tag,
    backend: 'gpu',
    gl,
    errors: errs,
    measurements,
    frames,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`  diagonal/forward: ${measurements.directional.diagonalToForward}`);
  console.log(`  strafe/forward:   ${measurements.directional.strafeToForward}`);
  console.log(`  backward/forward: ${measurements.directional.backwardToForward}`);
  console.log(`  jump retention:   ${measurements.jump.retained}`);
  console.log(`  uphill/downhill:  ${measurements.slope.uphill.planarSpeed}/${measurements.slope.downhill.planarSpeed} m/s`);
  console.log(`  ${frames.length} frames → ${path.relative(ROOT, OUT)}`);
});

finish(process.exitCode || 0);
