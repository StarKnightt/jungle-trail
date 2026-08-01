/* Lateral collision for the walker.
 *
 * The rendered world is the wrong data structure for this job. Vegetation is
 * split across thousands of instanced draw buckets and the ruins are merged
 * into room-sized meshes, so asking either scene graph for nearby triangles
 * would first throw away the spatial knowledge their generators already had.
 * This registry keeps only the solid facts at placement time: circles for
 * boles, short capsules for buttresses and deadfall, and boxes for stone.
 *
 * A uniform grid is enough because all of those facts are static and the game
 * is a long, narrow corridor. Movement queries visit the cells crossed by one
 * step, then sweep the player's plan-space circle against only those entries.
 * Sweeping rather than checking the destination is what prevents a dropped
 * frame from putting the player through a wall; projecting the unused part of
 * the step onto the contact plane is what turns the same hit into a slide.
 */

const EPS = 1e-9;
const MOVE_EPSILON = 1e-4;
const DEFAULT_SKIN = 0.018;
const DEFAULT_STEP_HEIGHT = 0.48;
const MAX_SLIDES = 4;
const MAX_DEPENETRATIONS = 4;

const CIRCLE = 0;
const CAPSULE = 1;
const BOX = 2;

const finiteOr = (v, fallback) => Number.isFinite(v) ? v : fallback;

export class CollisionWorld {
  constructor({ cellSize = 4, skin = DEFAULT_SKIN, stepHeight = DEFAULT_STEP_HEIGHT } = {}) {
    this.cellSize = cellSize;
    this.skin = skin;
    this.stepHeight = stepHeight;
    this.enabled = true;

    this.colliders = [];
    this.grid = new Map();
    this.byKind = Object.create(null);

    this._stamp = 0;
    this._candidates = [];
    this._normalX = new Float64Array(MAX_SLIDES + MAX_DEPENETRATIONS);
    this._normalZ = new Float64Array(MAX_SLIDES + MAX_DEPENETRATIONS);
    this._normalCount = 0;

    this._depth = 0;
    this._nx = 0;
    this._nz = 0;
    this._sweepT = Infinity;
    this._sweepNx = 0;
    this._sweepNz = 0;

    this._result = {
      x: 0, z: 0, dx: 0, dz: 0,
      collided: false, contacts: 0, candidates: 0, tests: 0,
    };
    this.resetStats();
  }

  addCircle({
    x, z, radius, minY = -Infinity, maxY = Infinity,
    kind = 'solid', stepable = false,
  }) {
    const r = Math.max(0.01, radius);
    return this._add({
      type: CIRCLE, x, z, radius: r, minY, maxY, kind, stepable,
      minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r,
    });
  }

  addCapsule({
    ax, az, bx, bz, radius, minY = -Infinity, maxY = Infinity,
    kind = 'solid', stepable = false,
  }) {
    const r = Math.max(0.01, radius);
    return this._add({
      type: CAPSULE, ax, az, bx, bz, radius: r, minY, maxY, kind, stepable,
      minX: Math.min(ax, bx) - r, maxX: Math.max(ax, bx) + r,
      minZ: Math.min(az, bz) - r, maxZ: Math.max(az, bz) + r,
    });
  }

  addBox({
    x, z, halfX, halfZ, angle = 0, minY = -Infinity, maxY = Infinity,
    kind = 'solid', stepable = false,
  }) {
    const hx = Math.max(0.01, halfX), hz = Math.max(0.01, halfZ);
    const ux = Math.cos(angle), uz = Math.sin(angle);
    const vx = -uz, vz = ux;
    const ex = Math.abs(ux) * hx + Math.abs(vx) * hz;
    const ez = Math.abs(uz) * hx + Math.abs(vz) * hz;
    return this._add({
      type: BOX, x, z, halfX: hx, halfZ: hz,
      ux, uz, vx, vz, minY, maxY, kind, stepable,
      minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez,
    });
  }

  _add(collider) {
    collider.id = this.colliders.length;
    collider._queryStamp = 0;
    this.colliders.push(collider);
    this.byKind[collider.kind] = (this.byKind[collider.kind] || 0) + 1;

    const s = this.cellSize;
    const x0 = Math.floor(collider.minX / s), x1 = Math.floor(collider.maxX / s);
    const z0 = Math.floor(collider.minZ / s), z1 = Math.floor(collider.maxZ / s);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${x},${z}`;
        let bucket = this.grid.get(key);
        if (!bucket) this.grid.set(key, bucket = []);
        bucket.push(collider);
      }
    }
    return collider;
  }

  /*
   * Move a plan-space player circle and return one reused result object.
   *
   * Stone below stepHeight is ignored, which lets thresholds, paving and the
   * authored stair remain traversable without making decorative rubble into a
   * second heightfield. Logs and trees opt out of that rule: stepping through
   * a trunk because its visible base is partly buried is much worse than
   * asking the player to walk around it.
   */
  move(x, z, dx, dz, feetY, headY, radius, velocity = null) {
    const out = this._result;
    out.x = x; out.z = z; out.dx = 0; out.dz = 0;
    out.collided = false; out.contacts = 0; out.candidates = 0; out.tests = 0;
    this._normalCount = 0;
    if (!this.enabled || (Math.abs(dx) + Math.abs(dz) < EPS)) {
      out.x += dx; out.z += dz; out.dx = dx; out.dz = dz;
      return out;
    }

    const t0 = performance.now();
    const pad = radius + this.skin;
    const candidates = this._collect(
      Math.min(x, x + dx) - pad, Math.max(x, x + dx) + pad,
      Math.min(z, z + dz) - pad, Math.max(z, z + dz) + pad,
    );
    out.candidates = candidates.length;

    let px = x, pz = z;
    /* Placement proxies can overlap each other at coursed joints. Resolving
     * the deepest overlap first converges without adding every correction at
     * once, which is the version that makes a corner throw the player out. */
    for (let pass = 0; pass < MAX_DEPENETRATIONS; pass++) {
      let bestDepth = 0, bestX = 0, bestZ = 0;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!this._active(c, feetY, headY)) continue;
        out.tests++;
        if (this._overlap(c, px, pz, pad, dx, dz) && this._depth > bestDepth) {
          bestDepth = this._depth;
          bestX = this._nx;
          bestZ = this._nz;
        }
      }
      if (bestDepth <= MOVE_EPSILON) break;
      px += bestX * (bestDepth + MOVE_EPSILON);
      pz += bestZ * (bestDepth + MOVE_EPSILON);
      this._rememberNormal(bestX, bestZ);
      out.collided = true;
    }

    let mx = dx, mz = dz;
    for (let pass = 0; pass < MAX_SLIDES; pass++) {
      const moveLength = Math.hypot(mx, mz);
      if (moveLength < MOVE_EPSILON) break;

      let bestT = Infinity, bestX = 0, bestZ = 0;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!this._active(c, feetY, headY)) continue;
        out.tests++;
        if (this._sweep(c, px, pz, mx, mz, pad) && this._sweepT < bestT) {
          bestT = this._sweepT;
          bestX = this._sweepNx;
          bestZ = this._sweepNz;
        }
      }

      if (bestT === Infinity) {
        px += mx;
        pz += mz;
        break;
      }

      /* Stop a hair before the expanded proxy. The gap is below a pixel at
       * arm's length, but it keeps floating-point noise from alternating one
       * frame just inside and the next frame just outside the same surface. */
      const before = Math.max(0, bestT - MOVE_EPSILON / moveLength);
      px += mx * before;
      pz += mz * before;

      const remain = Math.max(0, 1 - bestT);
      mx *= remain;
      mz *= remain;
      const into = mx * bestX + mz * bestZ;
      if (into < 0) {
        mx -= bestX * into;
        mz -= bestZ * into;
      }
      this._rememberNormal(bestX, bestZ);
      out.collided = true;
    }

    if (velocity && this._normalCount) {
      for (let i = 0; i < this._normalCount; i++) {
        const nx = this._normalX[i], nz = this._normalZ[i];
        const into = velocity.x * nx + velocity.z * nz;
        if (into < 0) {
          velocity.x -= nx * into;
          velocity.z -= nz * into;
        }
      }
    }

    out.x = px; out.z = pz;
    out.dx = px - x; out.dz = pz - z;
    out.contacts = this._normalCount;
    this._recordStats(out, performance.now() - t0);
    return out;
  }

  _active(c, feetY, headY) {
    const floor = feetY + (c.stepable ? this.stepHeight : 0.035);
    return c.maxY > floor && c.minY < headY - 0.025;
  }

  _collect(minX, maxX, minZ, maxZ) {
    const out = this._candidates;
    out.length = 0;
    this._stamp++;
    if (this._stamp >= 0x7fffffff) {
      this._stamp = 1;
      for (const c of this.colliders) c._queryStamp = 0;
    }

    const s = this.cellSize;
    const x0 = Math.floor(minX / s), x1 = Math.floor(maxX / s);
    const z0 = Math.floor(minZ / s), z1 = Math.floor(maxZ / s);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this.grid.get(`${x},${z}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const c = bucket[i];
          if (c._queryStamp === this._stamp) continue;
          c._queryStamp = this._stamp;
          out.push(c);
        }
      }
    }
    return out;
  }

  _rememberNormal(nx, nz) {
    for (let i = 0; i < this._normalCount; i++) {
      if (this._normalX[i] * nx + this._normalZ[i] * nz > 0.999) return;
    }
    if (this._normalCount >= this._normalX.length) return;
    this._normalX[this._normalCount] = nx;
    this._normalZ[this._normalCount] = nz;
    this._normalCount++;
  }

  _overlap(c, px, pz, playerRadius, moveX, moveZ) {
    if (c.type === CIRCLE) {
      return this._overlapCircle(c.x, c.z, c.radius + playerRadius,
        px, pz, moveX, moveZ);
    }
    if (c.type === CAPSULE) {
      const sx = c.bx - c.ax, sz = c.bz - c.az;
      const ll = sx * sx + sz * sz;
      let q = ll > EPS ? ((px - c.ax) * sx + (pz - c.az) * sz) / ll : 0;
      q = Math.max(0, Math.min(1, q));
      return this._overlapCircle(
        c.ax + sx * q, c.az + sz * q, c.radius + playerRadius,
        px, pz, moveX, moveZ,
      );
    }

    const ox = px - c.x, oz = pz - c.z;
    const lx = ox * c.ux + oz * c.uz;
    const lz = ox * c.vx + oz * c.vz;
    const hx = c.halfX + playerRadius, hz = c.halfZ + playerRadius;
    if (Math.abs(lx) >= hx || Math.abs(lz) >= hz) return false;

    const dx = hx - Math.abs(lx), dz = hz - Math.abs(lz);
    if (dx < dz) {
      const sign = lx < 0 ? -1 : 1;
      this._nx = c.ux * sign; this._nz = c.uz * sign; this._depth = dx;
    } else {
      const sign = lz < 0 ? -1 : 1;
      this._nx = c.vx * sign; this._nz = c.vz * sign; this._depth = dz;
    }
    return true;
  }

  _overlapCircle(cx, cz, radius, px, pz, moveX, moveZ) {
    const ox = px - cx, oz = pz - cz;
    const d2 = ox * ox + oz * oz;
    if (d2 >= radius * radius) return false;
    const d = Math.sqrt(d2);
    if (d > EPS) {
      this._nx = ox / d; this._nz = oz / d;
    } else {
      const ml = Math.hypot(moveX, moveZ);
      this._nx = ml > EPS ? -moveX / ml : 1;
      this._nz = ml > EPS ? -moveZ / ml : 0;
    }
    this._depth = radius - d;
    return true;
  }

  _sweep(c, px, pz, dx, dz, playerRadius) {
    if (c.type === CIRCLE) {
      return this._sweepCircle(c.x, c.z, c.radius + playerRadius, px, pz, dx, dz);
    }
    if (c.type === CAPSULE) {
      return this._sweepCapsule(c, px, pz, dx, dz, c.radius + playerRadius);
    }
    return this._sweepBox(c, px, pz, dx, dz, playerRadius);
  }

  _circleHit(cx, cz, radius, px, pz, dx, dz) {
    const ox = px - cx, oz = pz - cz;
    const a = dx * dx + dz * dz;
    const b = ox * dx + oz * dz;
    if (a < EPS || b >= 0) return false;
    const cc = ox * ox + oz * oz - radius * radius;
    const disc = b * b - a * cc;
    if (disc < 0) return false;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t < -EPS || t > 1 + EPS) return false;
    const hx = ox + dx * t, hz = oz + dz * t;
    const hl = Math.hypot(hx, hz);
    if (hl < EPS) return false;
    this._sweepT = Math.max(0, t);
    this._sweepNx = hx / hl;
    this._sweepNz = hz / hl;
    return true;
  }

  _sweepCircle(cx, cz, radius, px, pz, dx, dz) {
    return this._circleHit(cx, cz, radius, px, pz, dx, dz);
  }

  _sweepCapsule(c, px, pz, dx, dz, radius) {
    const sx = c.bx - c.ax, sz = c.bz - c.az;
    const length = Math.hypot(sx, sz);
    if (length < EPS) return this._circleHit(c.ax, c.az, radius, px, pz, dx, dz);

    const ux = sx / length, uz = sz / length;
    const vx = -uz, vz = ux;
    const ox = px - c.ax, oz = pz - c.az;
    const qx = ox * ux + oz * uz, qz = ox * vx + oz * vz;
    const mdx = dx * ux + dz * uz, mdz = dx * vx + dz * vz;
    let bestT = Infinity, bestX = 0, bestZ = 0;

    for (const sign of [-1, 1]) {
      if (mdz * sign >= -EPS) continue;
      const t = (sign * radius - qz) / mdz;
      const along = qx + mdx * t;
      if (t >= -EPS && t <= 1 + EPS && along >= 0 && along <= length && t < bestT) {
        bestT = Math.max(0, t);
        bestX = vx * sign;
        bestZ = vz * sign;
      }
    }

    if (this._circleHit(c.ax, c.az, radius, px, pz, dx, dz) && this._sweepT < bestT) {
      bestT = this._sweepT; bestX = this._sweepNx; bestZ = this._sweepNz;
    }
    if (this._circleHit(c.bx, c.bz, radius, px, pz, dx, dz) && this._sweepT < bestT) {
      bestT = this._sweepT; bestX = this._sweepNx; bestZ = this._sweepNz;
    }
    if (bestT === Infinity) return false;
    this._sweepT = bestT; this._sweepNx = bestX; this._sweepNz = bestZ;
    return true;
  }

  _sweepBox(c, px, pz, dx, dz, playerRadius) {
    const ox = px - c.x, oz = pz - c.z;
    const p0 = ox * c.ux + oz * c.uz;
    const p1 = ox * c.vx + oz * c.vz;
    const d0 = dx * c.ux + dz * c.uz;
    const d1 = dx * c.vx + dz * c.vz;
    const h0 = c.halfX + playerRadius, h1 = c.halfZ + playerRadius;
    let enter = -Infinity, exit = Infinity, axis = -1, sign = 0;

    const slab = (p, d, h, which) => {
      if (Math.abs(d) < EPS) return Math.abs(p) <= h;
      let a = (-h - p) / d, b = (h - p) / d;
      let n = -1;
      if (a > b) { const q = a; a = b; b = q; n = 1; }
      if (a > enter) { enter = a; axis = which; sign = n; }
      exit = Math.min(exit, b);
      return enter <= exit;
    };

    if (!slab(p0, d0, h0, 0) || !slab(p1, d1, h1, 1)) return false;
    if (enter < -EPS || enter > 1 + EPS || exit < 0) return false;
    this._sweepT = Math.max(0, enter);
    if (axis === 0) {
      this._sweepNx = c.ux * sign; this._sweepNz = c.uz * sign;
    } else {
      this._sweepNx = c.vx * sign; this._sweepNz = c.vz * sign;
    }
    return dx * this._sweepNx + dz * this._sweepNz < -EPS;
  }

  resetStats() {
    this._stats = {
      queries: 0, candidates: 0, tests: 0, contacts: 0,
      timeMs: 0, maxMs: 0, maxCandidates: 0, maxTests: 0,
    };
  }

  _recordStats(result, elapsed) {
    const s = this._stats;
    s.queries++;
    s.candidates += result.candidates;
    s.tests += result.tests;
    s.contacts += result.contacts;
    s.timeMs += elapsed;
    s.maxMs = Math.max(s.maxMs, elapsed);
    s.maxCandidates = Math.max(s.maxCandidates, result.candidates);
    s.maxTests = Math.max(s.maxTests, result.tests);
  }

  stats() {
    const s = this._stats;
    const q = Math.max(1, s.queries);
    return {
      colliders: this.colliders.length,
      cells: this.grid.size,
      byKind: { ...this.byKind },
      queries: s.queries,
      averageCandidates: +finiteOr(s.candidates / q, 0).toFixed(2),
      maxCandidates: s.maxCandidates,
      averageTests: +finiteOr(s.tests / q, 0).toFixed(2),
      maxTests: s.maxTests,
      averageMs: +finiteOr(s.timeMs / q, 0).toFixed(4),
      maxMs: +finiteOr(s.maxMs, 0).toFixed(4),
      contacts: s.contacts,
    };
  }
}
