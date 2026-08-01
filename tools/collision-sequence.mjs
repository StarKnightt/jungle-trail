/* Deterministic lateral-collision audit and flipbook.
 *
 * The rendered forest cannot be used as the assertion: an instanced trunk can
 * look solid in one frame while the controller has already crossed its centre.
 * This run chooses repeatable generated proxies, drives the real Walker into
 * them at a fixed 120 Hz, and records signed clearance, contact stability and
 * tangential travel beside each frame sequence.
 *
 * It uses the already-running development server when JUNGLE_URL is set, so a
 * collision pass can share the build with another capture without starting a
 * second listener:
 *
 *   JUNGLE_URL=http://localhost:8099/#manual&tier=high \
 *     node tools/collision-sequence.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots', 'move2');
const URL = process.env.JUNGLE_URL || 'http://localhost:8099/#manual&tier=high';
const DT = 1 / 120;

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
    for (let t = 0; t < duration - 1e-8; t += 1 / 120) {
      g.step(Math.min(1 / 120, duration - t));
    }
  }, seconds);
}

await run({
  width: 1280,
  height: 720,
  hash: 'manual&tier=high',
  url: URL,
  timeout: 180_000,
}, async ({ page, errs, gl }) => {
  await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    g.setSun(38, 152);
  });

  const sites = await page.evaluate(() => {
    const g = window.__game;
    const w = g.walker;
    const world = g.collision;
    const colliders = world.colliders;
    const eye = w.pos.y - g.terrain.height(w.pos.x, w.pos.z);
    const skin = world.skin;
    const q = {};

    const clearKeys = () => {
      for (const code of Object.keys(w.keys)) w.keys[code] = false;
    };
    const corridorDistance = (x, z) => {
      g.terrain.sampleField(x, z, q);
      return q.dist;
    };
    const signed = (c, x, z) => {
      const pad = w.radius + skin;
      if (c.type === 0) return Math.hypot(x - c.x, z - c.z) - c.radius - pad;
      if (c.type === 1) {
        const sx = c.bx - c.ax, sz = c.bz - c.az;
        const ll = sx * sx + sz * sz;
        const u = ll > 1e-9
          ? Math.max(0, Math.min(1, ((x - c.ax) * sx + (z - c.az) * sz) / ll))
          : 0;
        return Math.hypot(x - c.ax - sx * u, z - c.az - sz * u) - c.radius - pad;
      }
      const ox = x - c.x, oz = z - c.z;
      const lx = ox * c.ux + oz * c.uz;
      const lz = ox * c.vx + oz * c.vz;
      const dx = Math.abs(lx) - c.halfX - pad;
      const dz = Math.abs(lz) - c.halfZ - pad;
      if (dx > 0 && dz > 0) return Math.hypot(dx, dz);
      return Math.max(dx, dz);
    };
    const activeAt = (c, x, z) => {
      const feet = g.terrain.height(x, z);
      return c.maxY > feet + (c.stepable ? world.stepHeight : 0.035)
          && c.minY < feet + w.height - 0.025;
    };
    const makeSite = (name, c, nx, nz, face, priority = 0) => {
      const inv = 1 / Math.max(1e-9, Math.hypot(nx, nz));
      nx *= inv; nz *= inv;
      return {
        name,
        id: c.id,
        kind: c.kind,
        nx,
        nz,
        tx: -nz,
        tz: nx,
        contactX: face.x,
        contactZ: face.z,
        pitch: name === 'log' ? -0.62 : -0.08,
        priority,
      };
    };

    const options = { tree: [], log: [], stone: [] };
    for (const c of colliders) {
      if (c.kind === 'tree' && c.type === 0 && c.z < -60 && c.z > -260) {
        const dist = corridorDistance(c.x, c.z);
        if (dist > 3.2 && dist < 18 && activeAt(c, c.x, c.z)) {
          for (let i = 0; i < 32; i++) {
            const a = i * Math.PI * 2 / 32;
            const nx = Math.cos(a), nz = Math.sin(a);
            const reach = c.radius + w.radius + skin;
            const face = { x: c.x + nx * reach, z: c.z + nz * reach };
            const sx = face.x + nx * 1.6, sz = face.z + nz * 1.6;
            const n = g.terrain.normal(sx, sz, new window.THREE.Vector3());
            if (corridorDistance(sx, sz) < 44 && n.y > 0.80) {
              const priority = dist - c.radius * 2 + Math.abs(c.z + 140) * 0.005;
              options.tree.push(makeSite('tree', c, nx, nz, face, priority));
            }
          }
        }
      } else if (c.kind === 'log' && c.type === 1) {
        const mx = (c.ax + c.bx) * 0.5, mz = (c.az + c.bz) * 0.5;
        const dx = c.bx - c.ax, dz = c.bz - c.az;
        const inv = 1 / Math.max(1e-9, Math.hypot(dx, dz));
        const nx = -dz * inv, nz = dx * inv;
        const dist = corridorDistance(mx, mz);
        const length = Math.hypot(dx, dz);
        if (mz < -40 && mz > -280 && dist < 15 && c.radius > 0.20
            && activeAt(c, mx, mz)) {
          for (const sign of [-1, 1]) {
            const reach = c.radius + w.radius + skin;
            const face = { x: mx + nx * sign * reach, z: mz + nz * sign * reach };
            const sx = face.x + nx * sign * 1.6, sz = face.z + nz * sign * 1.6;
            const n = g.terrain.normal(sx, sz, new window.THREE.Vector3());
            if (corridorDistance(sx, sz) < 44 && n.y > 0.78) {
              const priority = dist - c.radius * 5 - length * 0.2
                             + Math.abs(mz + 140) * 0.003;
              options.log.push(makeSite('log', c, nx * sign, nz * sign, face, priority));
            }
          }
        }
      } else if (c.kind === 'stone' && c.type === 2) {
        const ground = g.terrain.height(c.x, c.z);
        if (c.maxY - ground < 0.85 || corridorDistance(c.x, c.z) > 26) continue;
        const faces = [
          [c.ux, c.uz, c.halfX],
          [-c.ux, -c.uz, c.halfX],
          [c.vx, c.vz, c.halfZ],
          [-c.vx, -c.vz, c.halfZ],
        ];
        for (const [nx, nz, half] of faces) {
          const reach = half + w.radius + skin;
          const face = { x: c.x + nx * reach, z: c.z + nz * reach };
          const sx = face.x + nx * 1.6, sz = face.z + nz * 1.6;
          const n = g.terrain.normal(sx, sz, new window.THREE.Vector3());
          if (corridorDistance(sx, sz) < 44 && n.y > 0.76 && activeAt(c, face.x, face.z)) {
            options.stone.push(makeSite('stone', c, nx, nz, face));
          }
        }
      }
    }

    /* Score against the real controller rather than trusting geometric
     * isolation. A tree's own buttresses and a wall's adjacent blocks are
     * legitimate earlier contacts; choosing the cleanest face keeps the
     * stopping-distance assertion about the named proxy instead of its
     * neighbour. */
    const score = (site) => {
      const c = colliders[site.id];
      clearKeys();
      w.setAuto(null);
      w.pos.set(
        site.contactX + site.nx * 1.6,
        g.terrain.height(site.contactX + site.nx * 1.6,
                         site.contactZ + site.nz * 1.6) + eye,
        site.contactZ + site.nz * 1.6,
      );
      w.vel.set(-site.nx * 8, 0, -site.nz * 8);
      w.grounded = false;
      world.resetStats();
      w._move(-site.nx * 5.0, -site.nz * 5.0);
      const st = world.stats();
      const normalGap = (w.pos.x - site.contactX) * site.nx
                      + (w.pos.z - site.contactZ) * site.nz;
      const tangent = Math.abs((w.pos.x - site.contactX) * site.tx
                             + (w.pos.z - site.contactZ) * site.tz);
      const targetClearance = signed(c, w.pos.x, w.pos.z);
      if (!st.contacts || normalGap < -0.025) return 1e4 + Math.abs(normalGap);
      return Math.abs(normalGap) + tangent * 0.08 + Math.abs(targetClearance) * 0.2;
    };

    const chosen = {};
    for (const name of ['tree', 'log', 'stone']) {
      let best = null;
      options[name].sort((a, b) => a.priority - b.priority);
      for (const site of options[name]) {
        const s = score(site);
        if (!best || s < best.score) best = { ...site, score: s };
        if (s < 0.002) break;
      }
      if (!best || best.score > 0.08) {
        throw new Error(`no isolated ${name} collision site (best ${best?.score})`);
      }
      chosen[name] = best;
    }

    const setup = (name, mode = 'block') => {
      const site = chosen[name];
      const normalGap = mode === 'slide' ? 1.15 : 1.55;
      const tangentGap = mode === 'slide' ? -0.72 : 0;
      const x = site.contactX + site.nx * normalGap + site.tx * tangentGap;
      const z = site.contactZ + site.nz * normalGap + site.tz * tangentGap;
      clearKeys();
      w.setAuto(null);
      w.pos.set(x, g.terrain.height(x, z) + eye, z);
      w.vel.set(0, 0, 0);
      w.speed = 0;
      w.grounded = true;
      w.jumpState = 'grounded';
      w.verticalVelocity = 0;
      w.jumpHeight = 0;
      let dx = -site.nx, dz = -site.nz;
      if (mode === 'slide') {
        dx = -site.nx * 0.74 + site.tx * 0.67;
        dz = -site.nz * 0.74 + site.tz * 0.67;
        const d = 1 / Math.hypot(dx, dz);
        dx *= d; dz *= d;
      }
      w.yaw = Math.atan2(dx, -dz);
      w.pitch = site.pitch;
      w.keys.KeyW = true;
      g.step(0);
      return state(name);
    };
    const state = (name) => {
      const site = chosen[name];
      const c = colliders[site.id];
      return {
        x: w.pos.x,
        z: w.pos.z,
        speed: w.speed,
        velocity: Math.hypot(w.vel.x, w.vel.z),
        clearance: signed(c, w.pos.x, w.pos.z),
        tangent: (w.pos.x - site.contactX) * site.tx
               + (w.pos.z - site.contactZ) * site.tz,
      };
    };

    clearKeys();
    g.goTo(0.02);
    window.__move2 = { chosen, signed, setup, state, clearKeys, eye };
    return chosen;
  });

  const measurements = await page.evaluate(() => {
    const g = window.__game;
    const w = g.walker;
    const world = g.collision;
    const test = window.__move2;
    const colliders = world.colliders;
    const round = (v, n = 5) => +v.toFixed(n);

    const directStop = (name) => {
      const s = test.chosen[name];
      const c = colliders[s.id];
      test.clearKeys();
      w.setAuto(null);
      const startX = s.contactX + s.nx * 1.6;
      const startZ = s.contactZ + s.nz * 1.6;
      w.pos.set(startX, g.terrain.height(startX, startZ) + test.eye, startZ);
      w.vel.set(-s.nx * 120, 0, -s.nz * 120);
      w.grounded = false;
      world.resetStats();
      w._move(-s.nx * 8, -s.nz * 8);
      const along = (startX - w.pos.x) * s.nx + (startZ - w.pos.z) * s.nz;
      return {
        collider: s.id,
        requested: 8,
        travelledTowardSurface: round(along),
        expected: 1.6,
        stoppingError: round(along - 1.6),
        clearance: round(test.signed(c, w.pos.x, w.pos.z)),
        contacts: world.stats().contacts,
        final: [round(w.pos.x), round(w.pos.z)],
      };
    };

    const press = (name, mode, seconds) => {
      const start = test.setup(name, mode);
      const clearances = [];
      const tangents = [];
      world.resetStats();
      for (let t = 0; t < seconds - 1e-8; t += 1 / 120) {
        g.step(Math.min(1 / 120, seconds - t));
        const s = test.state(name);
        if (t > seconds - 0.55) clearances.push(s.clearance);
        tangents.push(s.tangent);
      }
      const end = test.state(name);
      test.clearKeys();
      return {
        clearance: round(end.clearance),
        minimumClearance: round(Math.min(...clearances)),
        settledRange: round(Math.max(...clearances) - Math.min(...clearances)),
        tangentTravel: round(end.tangent - start.tangent),
        speed: round(end.speed),
        velocity: round(end.velocity),
        stats: world.stats(),
      };
    };

    const stopping = {
      tree: directStop('tree'),
      log: directStop('log'),
      stone: directStop('stone'),
    };

    world.resetStats();
    const held = {
      tree: press('tree', 'block', 2.8),
      log: press('log', 'block', 2.8),
      stone: press('stone', 'block', 2.8),
    };
    const sliding = {
      tree: press('tree', 'slide', 2.0),
      stone: press('stone', 'slide', 2.0),
    };
    const broadphase = world.stats();

    test.clearKeys();
    g.goTo(0.34);
    w.setAuto(0.34, 'walk');
    const autoStart = w.auto.t;
    const beforeQueries = world.stats().queries;
    g.warp(0.8, 1 / 120);
    const auto = {
      start: round(autoStart),
      end: round(w.auto.t),
      advanced: w.auto.t > autoStart,
      collisionQueries: world.stats().queries - beforeQueries,
    };
    w.setAuto(null);

    /* A synthetic L is used only in this headless page. It gives the corner
     * assertion two simultaneous, known normals without pretending that one
     * arbitrary broken ruin joint is representative of every generated seed. */
    let cornerOrigin = null;
    for (let i = 8; i <= 70 && !cornerOrigin; i++) {
      const p = g.trail.pointAt(i / 100, new window.THREE.Vector3());
      let nearest = Infinity;
      for (const c of colliders) {
        if (c.kind === 'stone' && c.z < -290) continue;
        const cx = c.x ?? (c.ax + c.bx) * 0.5;
        const cz = c.z ?? (c.az + c.bz) * 0.5;
        nearest = Math.min(nearest, Math.hypot(cx - p.x, cz - p.z));
      }
      if (nearest > 4.2) cornerOrigin = p.clone();
    }
    if (!cornerOrigin) cornerOrigin = g.trail.pointAt(0.08, new window.THREE.Vector3());
    const oy = g.terrain.height(cornerOrigin.x, cornerOrigin.z);
    world.addBox({
      x: cornerOrigin.x, z: cornerOrigin.z + 1.2,
      halfX: 1.6, halfZ: 0.2, minY: oy - 1, maxY: oy + 3,
      kind: 'test-corner',
    });
    world.addBox({
      x: cornerOrigin.x + 1.2, z: cornerOrigin.z,
      halfX: 0.2, halfZ: 1.6, minY: oy - 1, maxY: oy + 3,
      kind: 'test-corner',
    });
    test.clearKeys();
    w.pos.set(cornerOrigin.x - 1.5, oy + test.eye, cornerOrigin.z - 1.5);
    w.vel.set(80, 0, 80);
    w.grounded = false;
    world.resetStats();
    w._move(6, 6);
    const insideEdge = 1.2 - 0.2 - w.radius - world.skin;
    const corner = {
      requested: [6, 6],
      finalLocal: [
        round(w.pos.x - cornerOrigin.x),
        round(w.pos.z - cornerOrigin.z),
      ],
      limits: [round(insideEdge), round(insideEdge)],
      penetratedX: w.pos.x - cornerOrigin.x > insideEdge + 0.001,
      penetratedZ: w.pos.z - cornerOrigin.z > insideEdge + 0.001,
      contacts: world.stats().contacts,
    };

    const kinds = Object.keys(world.byKind);
    const foliage = {
      blockingKinds: kinds.filter(k => k !== 'test-corner'),
      foliageRegistered: ['fern', 'broadleaf', 'sprig', 'tussock', 'sapling',
        'vine', 'canopy', 'litterMat', 'rootRun'].some(k => world.byKind[k]),
    };

    test.clearKeys();
    g.goTo(0.02);
    return {
      registry: {
        colliders: broadphase.colliders,
        cells: broadphase.cells,
        byKind: Object.fromEntries(
          Object.entries(broadphase.byKind).filter(([k]) => k !== 'test-corner'),
        ),
      },
      stopping,
      held,
      sliding,
      broadphase,
      auto,
      corner,
      foliage,
    };
  });

  const frames = [];
  for (const [name, mode] of [['tree', 'block'], ['log', 'block'], ['stone', 'slide']]) {
    await page.evaluate(([n, m]) => window.__move2.setup(n, m), [name, mode]);
    for (let i = 0; i < 6; i++) {
      if (i) await advance(page, 0.38);
      const state = await page.evaluate((n) => {
        const s = window.__move2.state(n);
        return Object.fromEntries(Object.entries(s).map(([k, v]) =>
          [k, typeof v === 'number' ? +v.toFixed(5) : v]));
      }, name);
      const file = await snap(page, `${name}/${name}-${String(i).padStart(2, '0')}.png`);
      frames.push({ obstacle: name, mode, time: +(i * 0.38).toFixed(2), file, ...state });
    }
    await page.evaluate(() => window.__move2.clearKeys());
  }

  const report = {
    backend: 'gpu',
    gl,
    errors: errs,
    sites,
    measurements,
    frames,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  const b = measurements.broadphase;
  console.log(`  registry: ${measurements.registry.colliders} colliders in ${measurements.registry.cells} cells`);
  console.log(`  broadphase: ${b.averageCandidates} candidates, ${b.averageTests} tests, ${b.averageMs} ms/query`);
  console.log(`  stops: tree ${measurements.stopping.tree.clearance} m, log ${measurements.stopping.log.clearance} m, stone ${measurements.stopping.stone.clearance} m`);
  console.log(`  slides: tree ${measurements.sliding.tree.tangentTravel} m, stone ${measurements.sliding.stone.tangentTravel} m`);
  console.log(`  ${frames.length} frames → ${path.relative(ROOT, OUT)}`);
});

finish(process.exitCode || 0);
