/* Stone ruins.
 *
 * COMPOSITION, which is what this system is actually for.
 *
 * The brief for the level is a walk that opens into a clearing with crumbling
 * ruins and a fall behind them, and the one thing that can go wrong with that
 * is putting the ruins where they can be seen from everywhere. A temple that
 * is simply present in the middle distance for the last eighty metres is
 * scenery; a temple that arrives is an event. So the whole complex is laid out
 * against the trail's own sightlines rather than on a plan drawn from above,
 * and it is built in four beats:
 *
 *   outliers   t 0.30-0.78, and they are the point of the first half. Single
 *              worked blocks lying in the litter, a pair of kerbstones, a
 *              toppled stela — each one a long way from the next, each one
 *              mostly swallowed. They say somebody built here long before
 *              anything is visible, which is what makes the clearing read as
 *              arrival rather than as a set change.
 *   the gate   t 0.81-0.83. The trail passes a standing jamb four metres high
 *              with its lintel down across the verge. It is close enough to
 *              the tread to be a near-field silhouette, which is what gives
 *              the frame behind it a foreground to be behind.
 *   the reveal t 0.84-0.89. Through the gate: the terrace on the left, the
 *              broken stair, the cella and its doorway square to the trail.
 *              Fifteen to twenty-five metres, which is where this scene's fog
 *              leaves an object legible and atmospheric at the same time.
 *   the pool   t 0.90-0.98. Standing at the water, the terrace to the left and
 *              the revetment wings ahead, with sixteen metres of open gap
 *              between the wings on the axis of the cliff's spillway notch.
 *              That gap is deliberately empty: it is where the falls go.
 *
 * The complex is on the west side because the stream that runs into the pool
 * is on the east — it comes down at about x = +5 through this whole stretch
 * and cuts nearly two metres — and because leaving the east open leaves the
 * sightline to the cliff open.
 *
 * EMBEDDING. A ruin that sits on the ground is a prop. Three separate things
 * put these in the ground instead:
 *
 *   - The terrain knows about the complex. RuinPlan is built before the
 *     heightfield and the heightfield asks it for a mound, a levelled terrace
 *     and rubble berms along the wall lines, so the ground is *built up* where
 *     the building is. Everything else follows from that.
 *   - Every block is placed against a terrain height sampled at its own
 *     position and then pushed further down by a settle, so the bottom course
 *     of every wall is a third to two thirds under the litter.
 *   - Each vertex carries how far below the ground surface it sits, and the
 *     material stains and darkens the last twenty centimetres before the soil
 *     so the transition is a gradient rather than an intersection.
 *
 * COST. The complex is one place rather than a scatter, so it is merged into a
 * handful of chunked meshes instead of instanced: unique erosion on every
 * block for the price of about a dozen draw calls, where instancing would have
 * meant a variant count per tile and identical blocks besides.
 */
import * as THREE from 'three';
import { Noise2D, clamp, smoothstep, lerp } from './noise.js';
import { makeRng } from './plants.js';
import { CLEARING_Y } from './terrain.js';
import { bakeSurface, bakeImage } from '../gfx/bake.js';
import { STONE, STONE_MASK, STONE_MACRO } from './stoneTex.js';
import { SSTEP } from '../gfx/glsl.js';
/* Where System 5's sheet lands. Imported rather than repeated, because a
 * second copy of that number is a second thing to forget when the fall moves
 * — and it did move: this module had guessed the plunge was in the middle of
 * the gap between the revetment wings, and the water that actually got built
 * clears the wings entirely and lands in an alcove at the cliff foot twenty
 * metres further on. Reading their constant is how that error surfaced at all.
 * water.js does not import this module, so the dependency is one-way. */
import { IMPACT } from './water.js';
import { POOL_Y } from './spillway.js';

/* The plunge pool, restated. terrain.js owns this shape and keeps it private;
 * the plan needs it to know where not to raise the ground and where the
 * revetment's steps should stop. If it moves there it has to move here. */
const POOL = { x: 0, z: -356, r: 12.5 };

/* Nominal course height — the mean a wall's courses are drawn around, not the
 * height of any particular one.
 *
 * The first build made this a single constant for the whole complex, on the
 * reasoning that consistent courses are what separate masonry from a rubble
 * heap. That is true and it was still the wrong call, because the value was
 * 0.46 and at that size the argument stops applying: forty-six centimetres by
 * about a metre long, laid in perfectly even courses with a joint you can see
 * from twenty metres, is the proportion of a *brick*. The whole complex read
 * as a modern garden wall — the one verdict that disqualifies a temple.
 *
 * Ashlar at Angkor, Tikal or Palenque is nothing like that. The stones are
 * large enough that one is a day's work to move, they are individually
 * distinct, and the courses themselves vary in height because they were cut
 * to whatever the quarry bed gave. So this is now 0.80, each wall draws its
 * own course heights around it, and the stones within a course vary in length
 * by nearly three to one. Fewer, heavier, less regular — and cheaper, because
 * a wall of a given size is now about half as many blocks.
 */
const COURSE = 0.80;

/* Column drums keep their own scale. A pier is not a wall and the argument
 * above does not apply to it: drums are roughly as tall as they are wide, and
 * scaling them with the course would have turned six drums into a five-metre
 * column standing on a terrace that is only two and a third metres proud. */
const DRUM = 0.52;

const TERRACE_TOP = CLEARING_Y + 2.35;

/* ── plan ─────────────────────────────────────────────────────────────────
 * Everything here is a function of position alone. It exists separately from
 * the geometry because the terrain has to be able to ask about it, and the
 * terrain is built first — the blocks are then placed against a ground that
 * already has the terrace in it, which is the only ordering in which a
 * retaining wall can be half-buried in its own bank.
 */
export class RuinPlan {
  constructor(trail, seed = 51707) {
    this.trail = trail;
    this.n = new Noise2D(seed);

    /* The levelled terrace. Rotated a little off the trail's axis so its front
     * face is seen three-quarter rather than square-on — a plane exactly
     * perpendicular to the view reads as a flat, and the whole reveal depends
     * on the eye getting depth off this one surface. */
    /* Where this ended up, and why it moved.
     *
     * The first build put the terrace at x = -18.5, which is a perfectly good
     * plan drawing and completely wrong on the ground: the trail runs down
     * x ~ 0.5 through this whole stretch, so a mass centred nineteen metres
     * west of it and only fifteen metres further along sits at fifty degrees
     * off the walking direction. The camera's half angle is twenty-nine. The
     * entire complex was therefore *behind the player's shoulder* at the exact
     * moment it was supposed to arrive, and the reveal shot was a photograph
     * of ferns.
     *
     * The fix is to trade lateral offset for distance. Pushing the centre six
     * metres south and four east puts the near corner twenty-five metres
     * ahead at twenty degrees off the tangent — inside the frame, still well
     * clear of the tread, and far enough that the aerial perspective does the
     * work of separating it from the wall of leaves behind. */
    this.terraces = [
      { x: -15.0, z: -341.0, rx: 10.5, rz: 9.0, rot: 0.36, top: TERRACE_TOP },
    ];

    /* Rubble berms. Centuries of a wall shedding its upper courses leaves a
     * bank of soil and stone along both its faces, and that bank is the reason
     * you never see the bottom of an old wall. The blocks are placed on top of
     * this, so the berm is doing the burying rather than the placement code. */
    this.berms = [
      { a: [2.4, -313.0], b: [-9.0, -316.5], w: 3.2, amp: 0.50 },
      { a: [-9.0, -316.5], b: [-20.0, -323.0], w: 3.4, amp: 0.55 },
      { a: [-20.0, -323.0], b: [-28.0, -332.0], w: 3.4, amp: 0.50 },
      { a: [6.6, -314.0], b: [14.0, -311.5], w: 2.8, amp: 0.40 },
      { a: [14.0, -311.5], b: [23.0, -316.0], w: 2.8, amp: 0.38 },
      { a: [-25.0, -367.0], b: [-8.5, -366.0], w: 3.4, amp: 0.55 },
      { a: [8.5, -366.0], b: [25.0, -366.5], w: 3.4, amp: 0.55 },
    ];

    /* The earthwork under the whole thing, and the gate pad that fills the
     * stream's channel where the causeway crossed it. Neither is large; both
     * are the difference between a building standing on the forest floor and
     * one standing on its own ground. */
    this.mound = { x: -11, z: -340, r: 38, amp: 0.85 };
    this.pad = { x: 5.6, z: -313.2, r: 4.6, amp: 0.95 };

    this.bb = { x0: -58, x1: 44, z0: -296, z1: -388 };
  }

  /**
   * Reshape the natural ground where the complex stands.
   *
   * Called from the terrain's height function, so it must be cheap and it must
   * be a pure function of position — it runs a quarter of a million times and
   * the answer is cached in the heightfield forever afterwards.
   *
   * @param {number} h  the natural height, after the trail has been cut into it
   * @param {number} hw the trail's half width here
   */
  shapeGround(x, z, h, hw, q) {
    if (z > this.bb.z0 || z < this.bb.z1 || x < this.bb.x0 || x > this.bb.x1) return h;

    /* The tread is left alone. The terrace edge comes within seven metres of
     * the centre line and the walk has to stay a walk — a two-metre step in
     * the middle of the path is not a ruin, it is a bug you fall off. */
    const guard = smoothstep(hw + 0.4, hw + 2.6, q.dist);
    // And the pool keeps its own shape; the revetment stands on its outer lip.
    const pd = Math.hypot(x - POOL.x, z - POOL.z);
    const poolGuard = smoothstep(POOL.r * 0.70, POOL.r * 1.05, pd);

    let add = 0;

    const md = Math.hypot(x - this.mound.x, z - this.mound.z);
    add += smoothstep(this.mound.r, this.mound.r * 0.30, md) * this.mound.amp;

    for (const b of this.berms) {
      const d = segDist(x, z, b.a[0], b.a[1], b.b[0], b.b[1]);
      if (d.d < b.w) {
        // Squared falloff: a spoil bank is steep against the wall and feathers
        // out, which a linear ramp gets exactly backwards.
        const k = smoothstep(b.w, 0, d.d);
        add += k * k * b.amp;
      }
    }

    /* The pad is guarded much more loosely than everything else, because the
     * thing it is fixing is on the path: the stream's channel runs two metres
     * off the tread here and the gate would otherwise have one jamb hanging
     * over a gully. A causeway is what was actually there. */
    const gd = Math.hypot(x - this.pad.x, z - this.pad.z);
    add += smoothstep(this.pad.r, this.pad.r * 0.35, gd) * this.pad.amp
         * smoothstep(0.2, 1.6, q.dist);

    let y = h + add * guard * poolGuard;

    for (const p of this.terraces) {
      const k = this.terraceMask(x, z, p);
      if (k > 0) y = lerp(y, p.top, k * guard * poolGuard);
    }
    return y;
  }

  /** 1 on the terrace, 0 off it, with a metre or so of steep bank between. */
  terraceMask(x, z, p) {
    const c = Math.cos(-p.rot), s = Math.sin(-p.rot);
    const dx = x - p.x, dz = z - p.z;
    const u = (dx * c - dz * s) / p.rx;
    const v = (dx * s + dz * c) / p.rz;
    /* A superellipse rather than a rectangle. The corners of a real terrace
     * are the first thing to go, and an exponent of six leaves them square
     * enough to read as built while rounding them enough that the retaining
     * courses can turn without a mitre. */
    let d = Math.pow(Math.pow(Math.abs(u), 6) + Math.pow(Math.abs(v), 6), 1 / 6);
    // Ragged, because the edge is where it has collapsed.
    d += this.n.fbm(x * 0.13, z * 0.13, 3, 0.5) * 0.085;
    return smoothstep(1.02, 0.90, d);
  }

  /**
   * How hostile the ground here is to anything that needs real soil, 0..1.
   *
   * This exists because the first build put the complex into an understory at
   * full forest density and the architecture simply disappeared: from the
   * trail the reveal was a wall of two-metre broadleaves with a few courses of
   * masonry showing above it. The fix is not to carve an artificial hole
   * around the ruins — it is to notice that the reason is already in the
   * model. A paved terrace, a rubble berm and a causeway fill are a few
   * centimetres of leaf mould over stone. Ferns, moss and seedlings colonise
   * that happily; a palm or a big-leaved shrub cannot get a root down into it
   * at all, and the difference between those two lists is exactly what makes a
   * ruin look like a ruin rather than like scenery in a hedge.
   */
  hardGround(x, z) {
    if (z > this.bb.z0 || z < this.bb.z1 || x < this.bb.x0 || x > this.bb.x1) return 0;
    let k = 0;
    for (const p of this.terraces) k = Math.max(k, this.terraceMask(x, z, p));
    for (const b of this.berms) {
      const d = segDist(x, z, b.a[0], b.a[1], b.b[0], b.b[1]);
      if (d.d < b.w * 1.4) k = Math.max(k, smoothstep(b.w * 1.4, b.w * 0.4, d.d) * 0.8);
    }
    const gd = Math.hypot(x - this.pad.x, z - this.pad.z);
    k = Math.max(k, smoothstep(this.pad.r, this.pad.r * 0.4, gd) * 0.75);
    return k;
  }

  /** Height of the terrace surface at a point, or null if there is none. */
  terraceTop(x, z) {
    for (const p of this.terraces) {
      if (this.terraceMask(x, z, p) > 0.75) return p.top;
    }
    return null;
  }
}

function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const L2 = vx * vx + vz * vz;
  let t = L2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { d: Math.hypot(px - ax - vx * t, pz - az - vz * t), t };
}

/* ── the block primitive ──────────────────────────────────────────────────
 *
 * A subdivided cube whose edge vertices are *shared* between the three faces
 * that meet there, so that pulling them inward chamfers the arris instead of
 * opening a crack between two faces. That sharing is the whole construction:
 * with it, one displacement field gives a bevelled, dented, spalled stone with
 * flat faces and rounded edges, and the normals come out of the deformed mesh
 * rather than having to be authored. Without it there is no way to round an
 * edge at all.
 *
 * A dressed block is nearly flat over most of its face, so the subdivision is
 * spent almost entirely on the chamfer band at the rim; three segments per
 * edge puts a ring of vertices exactly where the bevel needs to be and leaves
 * the middle alone. The fine relief is the normal map's job.
 */
const _grids = new Map();
function cubeGrid(seg) {
  const hit = _grids.get(seg);
  if (hit) return hit;

  /* The rows are pushed out toward the rim rather than spread evenly, and this
   * is the difference between masonry and a stack of bread rolls.
   *
   * With evenly spaced rows the only vertices available to carry the bevel are
   * the rim itself and the row a third of the way in, so pulling the rim
   * inward tilts a third of the face and the interpolated normals turn that
   * third into a smooth roll. Every block came out looking inflated. Moving
   * the second row to within a seventh of the rim confines the whole bevel to
   * a narrow band, and everything inboard of it stays a genuinely flat, hard
   * plane — which is what a quarried face is, and what the eye is reading when
   * it decides a surface was cut rather than tumbled.
   *
   * The classification below therefore has to use the *lattice* coordinate and
   * not the displaced one: after the remap a near-rim vertex is at 0.86, which
   * any threshold meant to find the rim would also catch. */
  const inner = seg > 2 ? 0.86 / ((seg - 2) / seg) : 1;

  const map = new Map();
  const u = [], w = [];
  const vid = (a, b, c) => {
    const k = (a + 8) * 289 + (b + 8) * 17 + (c + 8);
    let i = map.get(k);
    if (i === undefined) {
      i = u.length / 3;
      map.set(k, i);
      const g = (v) => {
        const t = v / seg;
        return Math.abs(t) > 0.999 ? t : t * inner;
      };
      u.push(g(a), g(b), g(c));
      w.push(a / seg, b / seg, c / seg);
    }
    return i;
  };

  /* Each triple is right-handed, so on the +axis face the first of the two
   * varying axes runs right and the second runs up as seen from outside, and
   * the winding below is counter-clockwise. Getting this wrong culls the near
   * wall of every block and draws the inside of the far one, which is exactly
   * the failure addTube had for four passes in plants.js. */
  const AX = [[1, 2], [2, 0], [0, 1]];
  const idx = [];
  for (let ax = 0; ax < 3; ax++) {
    const a1 = AX[ax][0], a2 = AX[ax][1];
    for (let sgn = 1; sgn >= -1; sgn -= 2) {
      for (let i = 0; i < seg; i++) {
        for (let j = 0; j < seg; j++) {
          const at = (di, dj) => {
            const c = [0, 0, 0];
            c[ax] = sgn * seg;
            c[a1] = 2 * (i + di) - seg;
            c[a2] = 2 * (j + dj) - seg;
            return vid(c[0], c[1], c[2]);
          };
          const v00 = at(0, 0), v10 = at(1, 0), v11 = at(1, 1), v01 = at(0, 1);
          if (sgn > 0) idx.push(v00, v10, v11, v00, v11, v01);
          else idx.push(v00, v11, v10, v00, v01, v11);
        }
      }
    }
  }
  const out = { u: new Float32Array(u), w: new Float32Array(w), idx };
  _grids.set(seg, out);
  return out;
}

const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

class StoneBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.st = [];      // occ, fresh, drip, burial
    this.meta = [];    // per-block random, wetness
    this.idx = [];
    this.vBlock = [];  // which block each vertex belongs to, for the bakes
    this.blocks = [];
  }
  get count() { return this.pos.length / 3; }
}

const _qt = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _vp = new THREE.Vector3();

/**
 * One weathered block.
 *
 * @param {StoneBuilder} B
 * @param {THREE.Vector3} c   centre, world
 * @param {THREE.Vector3} half half extents before erosion, metres
 * @param {THREE.Quaternion} q orientation
 */
function addBlock(B, c, half, q, o = {}) {
  const {
    seg = 3, chamfer = 0.075, erode = 0.055, spalls = 0, rng = Math.random,
    expo = 0.35,
  } = o;
  const g = cubeGrid(seg);
  const base = B.count;
  const iBase = B.idx.length;
  const bi = B.blocks.length;
  const rand = rng();
  const wear = rng();
  const minHalf = Math.min(half.x, half.y, half.z);

  /* Erosion as a handful of hashed sinusoidal lobes rather than a noise
   * lookup. Three of them at incommensurate rates over a body this small are
   * indistinguishable from noise, they are analytic so the surface stays
   * smooth and the normals stay clean, and they cost four multiplies. */
  const lobes = [];
  for (let k = 0; k < 3; k++) {
    const th = rng() * 6.283, ph = Math.acos(rng() * 2 - 1);
    lobes.push({
      dx: Math.sin(ph) * Math.cos(th), dy: Math.cos(ph), dz: Math.sin(ph) * Math.sin(th),
      f: 1.3 + rng() * 2.4, p: rng() * 6.283, a: 0.45 + rng() * 0.55,
    });
  }

  /* Spalls: a corner knocked off, a face flaked away. The exposed surface is
   * marked as fresh, because that is the one place on an old stone where the
   * unweathered interior shows — and the colour difference between the two is
   * a large part of how the eye dates a ruin. */
  const chips = [];
  for (let k = 0; k < spalls; k++) {
    const ax = (rng() * 3) | 0;
    const cc = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
    cc[ax] = rng() < 0.5 ? 1 : -1;
    /* Shallow, and shallower than they were. Once the faces went flat and the
     * arrises went hard, a bite forty per cent into the stone stopped reading
     * as a flake off the corner and started reading as a rebate someone had
     * cut — a square-shouldered notch, because the surface it was cut out of
     * is now genuinely square. A spall takes a slice, not a bite. */
    chips.push({ x: cc[0], y: cc[1], z: cc[2], r: 0.30 + rng() * 0.42, d: 0.12 + rng() * 0.26 });
  }

  const nv = g.u.length / 3;
  for (let i = 0; i < nv; i++) {
    const ux = g.u[i * 3], uy = g.u[i * 3 + 1], uz = g.u[i * 3 + 2];
    const inv = 1 / Math.max(1e-6, Math.hypot(ux, uy, uz));
    const nx = ux * inv, ny = uy * inv, nz = uz * inv;

    // Second and third largest of |u| say how close this vertex is to an edge
    // and to a corner, which is all a chamfer needs to know.
    let a = Math.abs(g.w[i * 3]), b = Math.abs(g.w[i * 3 + 1]), cq = Math.abs(g.w[i * 3 + 2]);
    let s1 = a, s2 = b, s3 = cq;
    if (s1 < s2) { const t = s1; s1 = s2; s2 = t; }
    if (s2 < s3) { const t = s2; s2 = s3; s3 = t; }
    if (s1 < s2) { const t = s1; s1 = s2; s2 = t; }
    /* The arris pull is a *fraction of the block* rather than a distance in
     * metres, and getting that wrong is what turned the first build into a
     * wall of pillows: five centimetres taken off the edge of a two-metre
     * lintel is a worn arris, and the same five centimetres taken off a
     * forty-centimetre course stone is a quarter of it. The corner term is
     * deliberately small on top of the edge term — a corner is knocked off
     * more than an edge, but not by much, and a cube whose corners are pulled
     * hard stops having corners at all. */
    const edge = smooth01((s2 - 0.42) / 0.58);
    const cham = minHalf * chamfer * (edge + 0.45 * smooth01((s3 - 0.42) / 0.58));

    /* Erosion applied to the arris only, and this is what separates a dressed
     * block from a boulder.
     *
     * The first version displaced every vertex, including the four in the
     * middle of each face. With three segments to an edge there is no
     * subdivision left over to describe a *flat* surface once its interior
     * moves, so the face picked up a smooth curvature, the interpolated
     * normals gave it a soft shading gradient, and forty of them stacked in
     * courses came out looking like a wall of sandbags. A quarried face stays
     * planar; what four centuries take off is the corners and the edges. */
    let e = 0;
    for (const L of lobes) e += L.a * Math.sin(L.f * (ux * L.dx + uy * L.dy + uz * L.dz) * 2.4 + L.p);
    e = (e / 1.5) * edge;

    let bite = 0, fresh = 0;
    for (const ch of chips) {
      const d = Math.hypot(ux - ch.x, uy - ch.y, uz - ch.z);
      const k = smooth01((ch.r - d) / ch.r);
      bite = Math.max(bite, k * ch.d * minHalf);
      fresh = Math.max(fresh, smooth01((ch.r * 0.92 - d) / (ch.r * 0.5)));
    }

    const push = e * erode * minHalf - cham - bite;
    _vp.set(ux * half.x + nx * push, uy * half.y + ny * push, uz * half.z + nz * push);
    _vp.applyQuaternion(q).add(c);

    B.pos.push(_vp.x, _vp.y, _vp.z);
    B.nor.push(0, 0, 0);
    B.st.push(0, fresh, 0, 0);
    /* Four per-block channels now rather than two. The critic's word for the
     * old material was "foam" — every stone the same substance with the same
     * surface — and the cause was that a single random scalar was driving a
     * single tone multiply while everything else about a block's weathering
     * came from its position alone. Two blocks side by side in the same wall
     * therefore differed by a tint and by nothing else. `wear` is a second,
     * independent draw so that tone and damage are not the same die roll, and
     * `expo` is where the stone sits in its wall, which is what decides
     * whether it gets silt and moss or sun and rain. */
    B.meta.push(rand, 0, expo, wear);
    B.vBlock.push(bi);
  }

  for (let i = 0; i < g.idx.length; i++) B.idx.push(base + g.idx[i]);

  // The OBB, kept for the occlusion bake and for the plant-placement grid.
  const rx = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const ry = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const rz = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const ext = new THREE.Vector3(
    Math.abs(rx.x) * half.x + Math.abs(ry.x) * half.y + Math.abs(rz.x) * half.z,
    Math.abs(rx.y) * half.x + Math.abs(ry.y) * half.y + Math.abs(rz.y) * half.z,
    Math.abs(rx.z) * half.x + Math.abs(ry.z) * half.y + Math.abs(rz.z) * half.z,
  );
  B.blocks.push({
    c: c.clone(), half: half.clone(), rx, ry, rz, ext,
    vStart: base, vCount: nv, iStart: iBase, iCount: g.idx.length,
    topY: c.y + ext.y,
  });
  return bi;
}

/* ── the kit ──────────────────────────────────────────────────────────────
 * Six constructions cover the whole complex. Each is written so that its
 * failure mode is a *smaller* ruin rather than a broken one: a course that
 * cannot be placed is simply absent, which is what a ruin is.
 */

/**
 * A coursed wall between two plan points.
 *
 * The height is a function of position along the wall rather than a constant,
 * and that function is the single most important argument here. A wall of
 * even height with a ragged top is a wall someone knocked the top off; a wall
 * whose height swings between four courses and none over its length has
 * *collapsed*, in places, for reasons, and the eye reads the difference
 * immediately even at forty metres.
 */
function wall(B, ctx, o) {
  const {
    a, b, height, thick = 0.72, len = 0.95, rng,
    baseY = null, settle = 0.24, seg = 3, splits = [], gaps = [],
    chamfer = 0.13, spallChance = 0.45, loosen = 1,
  } = o;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
  const px = -dz, pz = dx;
  const theta = Math.atan2(-dz, dx);

  let maxH = 0;
  for (let i = 0; i <= 24; i++) maxH = Math.max(maxH, height(i / 24));

  /* The courses of this wall, drawn once and then shared by every stone in
   * each of them. Drawing per course rather than per stone is the whole
   * point: within a course the bed joints have to line up or the wall is
   * rubble, but between courses they should not, because the mason laid
   * whatever depth of stone the quarry bed gave him that season. A run of
   * beds at 0.56, 1.05, 0.72, 0.91 is the signature of ashlar and a run of
   * identical beds is the signature of a brick. */
  const beds = [];
  for (let acc = 0; acc < maxH + COURSE * 0.5;) {
    const ch = COURSE * (0.70 + rng() * 0.72);
    beds.push({ y0: acc, h: ch });
    acc += ch;
  }
  const nC = beds.length;
  const tops = [];

  /* What the course below actually ended up containing, as spans along the
   * wall — and this is load-bearing in both senses.
   *
   * A stone is only laid here if the height function reaches it and a die
   * roll does not delete it, so a course can and does come out with holes in
   * it. With the old brick-sized blocks a stone that happened to sit over one
   * of those holes read as a small gap and nobody looked twice. At ashlar
   * size the same stone is a metre and a half of rock hanging in mid-air, and
   * that is the single fastest way to destroy a ruin: the eye accepts almost
   * any amount of collapse but it will not accept a block that is not resting
   * on anything, because gravity is the one physical law every viewer checks.
   * So each course records where its stones went, and the course above may
   * only place a stone where it has something to stand on. */
  let below = null;

  for (let c = 0; c < nC; c++) {
    const cy = beds[c].y0, chh = beds[c].h;
    const spans = [];
    let s = (c % 2 ? 0.44 : 0) * len;
    while (s < L - 0.12) {
      const s0 = s;
      /* Length skewed toward the long end rather than drawn flat, and tied to
       * how deep the course is, because a quarry that yielded a thick bed
       * yielded a long stone out of it too. The exponent puts most of the
       * mass of the distribution high, so a typical course is two or three
       * big stones and a short closer rather than five even ones. */
      const draw = 0.62 + Math.pow(rng(), 0.7) * 1.9;
      const bl = Math.min(L - s, len * draw * (0.75 + 0.45 * (chh / COURSE)));
      const u = (s + bl * 0.5) / L;
      /* A tight joint. This was 2-4 cm and, with the chamfer taken off both
       * arrises either side of it, opened into a groove close to eight
       * centimetres wide — which at any viewing distance is a mortar line,
       * and mortar lines are most of why the first build read as brickwork.
       * Dry-fitted ashlar is laid stone against stone and the joint is a
       * seam, not a channel. */
      s += bl + 0.012 + rng() * 0.022;
      if (bl < 0.34) continue;

      let inGap = false;
      for (const g of gaps) if (u > g[0] && u < g[1] && cy + chh * 0.5 < g[2]) inGap = true;
      if (inGap) continue;

      const h = height(u);
      if (h < cy + chh * 0.34) continue;

      /* Bearing. Just over half the stone's length has to be over stone that
       * is actually there, which is roughly where a real block stops being a
       * corbel and starts being a thing that fell off. Failing this is not an
       * error — it is the wall having lost that stone at some point in four
       * hundred years, which is what the rubble at the foot is made of. */
      if (below) {
        let over = 0;
        for (const p of below) over += Math.max(0, Math.min(s0 + bl, p[1]) - Math.max(s0, p[0]));
        if (over < bl * 0.55) continue;
      }

      /* How loose this stone is. The top two courses of a standing fragment
       * are held by nothing but their own weight and a few centuries of root
       * pressure, so they lean, they slip out of line, and about a third of
       * them are not there any more. */
      const head = clamp((h - cy) / (COURSE * 2.2), 0, 1);
      const loose = (1 - head) * loosen;
      /* Fewer stones are lost than before, because each one is now worth two
       * of the old ones. The rate was tuned when a block was a brick and
       * losing one left a nick in the coursing; at ashlar size the same rate
       * opened metre-wide holes, and with the bearing rule above refusing to
       * bridge them the walls came out as a line of disconnected piers rather
       * than as walls with damage. */
      if (rng() < 0.05 + 0.26 * loose) continue;

      let lat = (rng() - 0.5) * (0.03 + 0.22 * loose);
      let tilt = (rng() - 0.5) * (0.02 + 0.16 * loose);
      let roll = (rng() - 0.5) * (0.015 + 0.10 * loose);
      /* Root split. A tree gets into a joint and then spends fifty years
       * levering it open, so the wall does not fall over — it bulges, and the
       * courses above the root ride out over the ones below. That bulge is the
       * most legible single sign that a wall is being taken by the forest. */
      for (const sp of splits) {
        const k = Math.exp(-Math.pow((u - sp.u) / sp.w, 2));
        lat += k * sp.amp * (0.35 + (cy / COURSE) * 0.30);
        roll += k * sp.amp * 0.30;
      }
      /* Nothing may hang out further than a third of the wall's thickness.
       *
       * Every displacement above is drawn independently per stone, so two
       * adjacent courses could and did draw offsets in opposite directions —
       * and a block sitting three quarters off the one beneath it is a block
       * standing on air. A collapsing wall does slump, lean and ride out over
       * itself, but each stone in it is still resting on something; the
       * moment one is not, the eye stops reading collapse and starts reading
       * authored geometry, which is the fastest way to lose a ruin. Capping
       * the offset here rather than shrinking the terms that produce it keeps
       * the lean and the root-split bulge at full strength and only removes
       * the physically impossible tail. */
      lat = clamp(lat, -thick * 0.32, thick * 0.32);

      const wx = a[0] + dx * (u * L) + px * lat;
      const wz = a[1] + dz * (u * L) + pz * lat;
      /* Seated on the *lowest* ground the stone spans, not on the ground under
       * its midpoint. A course stone is a metre long and the berm it stands on
       * is a rounded bank, so a mid-point sample leaves both ends of the block
       * proud of the soil — and once the bottom course is floating by four
       * centimetres at each end you can see daylight under a wall, which is
       * the single most damning thing a piece of architecture can do. */
      let gnd = Infinity;
      if (!baseY) {
        for (let e = -1; e <= 1; e++) {
          const s2 = u * L + e * bl * 0.5;
          const gx = a[0] + dx * s2 + px * lat, gz = a[1] + dz * s2 + pz * lat;
          gnd = Math.min(gnd, ctx.terrain.height(gx, gz));
        }
      }
      const y0 = baseY ? baseY(u) : gnd - settle;
      const y = y0 + cy + chh * 0.5;

      _eu.set(tilt, theta + (rng() - 0.5) * (0.02 + 0.22 * loose), roll, 'YXZ');
      addBlock(B, new THREE.Vector3(wx, y, wz),
        new THREE.Vector3(bl * 0.5, chh * 0.46, thick * 0.5),
        _qt.setFromEuler(_eu),
        {
          seg, chamfer, erode: 0.05 + 0.03 * loose, rng,
          spalls: rng() < spallChance ? 1 : 0,
          /* How far up its own wall this stone sits, which the material needs
           * and cannot work out for itself. A block in the bottom course is
           * wet, silted and mossy; one in the head course has four hundred
           * years of sun and rain on it and almost nothing growing. Passing
           * the ratio rather than the world height keeps a low wall's head
           * course reading as a head course. */
          expo: clamp(cy / Math.max(0.9, maxH), 0, 1),
        });

      spans.push([s0, s0 + bl]);
      if (cy + chh * 1.5 >= h && h > 1.5) tops.push({ x: wx, y: y + chh * 0.5, z: wz });
    }
    below = spans;
  }
  return tops;
}

/** A square pier, standing or toppled. */
function pier(B, ctx, o) {
  const { x, z, w = 0.82, drums = 6, rng, fallen = false, dir = 0, baseY = null } = o;
  const gy = baseY !== null ? baseY : ctx.terrain.height(x, z);
  const tops = [];
  if (!fallen) {
    const lean = (rng() - 0.5) * 0.05;
    for (let i = 0; i < drums; i++) {
      const hd = DRUM * (0.9 + rng() * 0.3);
      const y = gy - 0.12 + (i + 0.5) * DRUM * 1.05;
      _eu.set(lean * (i / drums), rng() * 0.14 - 0.07, lean * 0.6 * (i / drums), 'YXZ');
      addBlock(B, new THREE.Vector3(x + lean * y * 0.3, y, z),
        new THREE.Vector3(w * 0.5, hd * 0.5, w * 0.5),
        _qt.setFromEuler(_eu),
        { rng, chamfer: 0.12, spalls: rng() < 0.4 ? 1 : 0 });
    }
    tops.push({ x, y: gy + drums * DRUM, z });
  } else {
    /* Fallen, and the drums stay in order. A column that comes down does not
     * scatter — it lies along its own axis with the pieces still in sequence
     * and a gap opening between them where the ground is uneven, and that line
     * of stones is one of the most legible objects in any ruin. */
    const cd = Math.cos(dir), sd = Math.sin(dir);
    for (let i = 0; i < drums; i++) {
      const t = 0.7 + i * DRUM * 1.16 * (1 + i * 0.05);
      const bx = x + cd * t, bz = z + sd * t;
      const g2 = (baseY !== null ? baseY : ctx.terrain.height(bx, bz));
      _eu.set((rng() - 0.5) * 0.24, dir + (rng() - 0.5) * 0.34, (rng() - 0.5) * 0.5, 'YXZ');
      addBlock(B, new THREE.Vector3(bx, g2 + w * 0.30 - rng() * 0.10, bz),
        new THREE.Vector3(w * 0.5, DRUM * 0.5, w * 0.5),
        _qt.setFromEuler(_eu),
        { rng, chamfer: 0.15, spalls: rng() < 0.7 ? 1 : 0, expo: 0.15 });
    }
  }
  return tops;
}

/** One large stone: a lintel, a paving slab, a threshold, a stela. */
function slab(B, ctx, x, y, z, sx, sy, sz, eu, rng, o = {}) {
  _eu.set(eu[0], eu[1], eu[2], 'YXZ');
  return addBlock(B, new THREE.Vector3(x, y, z),
    new THREE.Vector3(sx * 0.5, sy * 0.5, sz * 0.5),
    _qt.setFromEuler(_eu),
    { rng, chamfer: 0.11, spalls: 1, ...o });
}

/**
 * Fallen stone.
 *
 * Sunk on purpose and sunk hard: a block that has been lying in leaf mould for
 * four hundred years is *in* the mould, not on it, and the single most common
 * way procedural rubble gives itself away is that every piece is tangent to
 * the ground. The size distribution is skewed the same way real collapse
 * debris is — mostly fragments, occasionally a whole course stone that came
 * down in one piece.
 */
function rubble(B, ctx, o) {
  const { x, z, r, n, rng, size = 1, sink = 0.55, near = null, seg = 2 } = o;
  for (let i = 0; i < n; i++) {
    const ang = rng() * 6.283;
    const rr = r * Math.sqrt(rng());
    const bx = x + Math.cos(ang) * rr, bz = z + Math.sin(ang) * rr;
    if (near && !near(bx, bz)) continue;
    const s = size * (0.22 + Math.pow(rng(), 2.4) * 1.05);
    const gy = ctx.terrain.height(bx, bz);
    const hy = s * (0.30 + rng() * 0.22);
    _eu.set((rng() - 0.5) * 0.9, rng() * 6.283, (rng() - 0.5) * 0.9, 'YXZ');
    addBlock(B, new THREE.Vector3(bx, gy + hy * (1 - sink * (0.6 + rng() * 0.7)), bz),
      new THREE.Vector3(s * (0.40 + rng() * 0.30), hy, s * (0.34 + rng() * 0.28)),
      _qt.setFromEuler(_eu),
      { seg, rng, chamfer: 0.22, erode: 0.11, spalls: rng() < 0.8 ? 2 : 1 });
  }
}

/** A flight of steps, with treads missing. */
function stair(B, ctx, o) {
  const { x, z, dir, width, steps, rise = 0.42, run = 0.62, topY, rng } = o;
  const cd = Math.cos(dir), sd = Math.sin(dir);
  const px = -sd, pz = cd;
  for (let i = 0; i < steps; i++) {
    const y = topY - (i + 0.5) * rise;
    const t = (i + 0.5) * run;
    const nb = Math.max(1, Math.round(width / 1.0));
    for (let k = 0; k < nb; k++) {
      if (rng() < 0.20 + 0.25 * (i / steps)) continue;   // a tread gone
      const off = (k - (nb - 1) * 0.5) * (width / nb);
      const bx = x + cd * t + px * off;
      const bz = z + sd * t + pz * off;
      _eu.set((rng() - 0.5) * 0.10, Math.atan2(-sd, cd) + (rng() - 0.5) * 0.10,
        (rng() - 0.5) * 0.09, 'YXZ');
      addBlock(B, new THREE.Vector3(bx, y, bz),
        new THREE.Vector3((width / nb) * 0.48, rise * 0.5, run * 0.62),
        _qt.setFromEuler(_eu),
        { rng, chamfer: 0.15, spalls: rng() < 0.7 ? 1 : 0 });
    }
  }
}

/* ── the complex ──────────────────────────────────────────────────────────*/

export class Ruins {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./terrain.js').Terrain} terrain
   * @param {import('./path.js').Trail} trail
   * @param {RuinPlan} plan
   * @param {number} seed
   * @param {import('../player/collision.js').CollisionWorld} [collision]
   */
  constructor(renderer, terrain, trail, plan, seed = 8823, collision = null) {
    this.terrain = terrain;
    this.trail = trail;
    this.plan = plan;
    this.collision = collision;
    this.root = new THREE.Group();
    this.root.name = 'ruins';
    this.vineAnchors = [];
    this.cells = [];

    this.material = makeStoneMaterial(renderer);

    const B = new StoneBuilder();
    const ctx = { terrain, trail, plan };
    this._compose(B, ctx, seed);
    if (collision) this._registerColliders(B);
    this._bakeSurfaceData(B);
    this._buildGrid(B);
    this._emit(B);
  }

  _registerColliders(B) {
    for (const b of B.blocks) {
      const minY = b.c.y - b.ext.y;
      const maxY = b.c.y + b.ext.y;
      /* Fully buried stones still matter to the material bake but cannot meet
       * a foot. Leaving them out keeps the registry about visible obstruction,
       * not about the archaeological volume under the terrain. */
      if (maxY <= this.terrain.height(b.c.x, b.c.z) + 0.08) continue;

      const rxLen = Math.hypot(b.rx.x, b.rx.z);
      const rzLen = Math.hypot(b.rz.x, b.rz.z);
      const axis = rxLen >= rzLen ? b.rx : b.rz;
      const axisLen = Math.max(1e-6, Math.hypot(axis.x, axis.z));
      const ux = axis.x / axisLen, uz = axis.z / axisLen;
      const vx = -uz, vz = ux;
      const extent = (x, z) =>
        Math.abs(b.rx.x * x + b.rx.z * z) * b.half.x
        + Math.abs(b.ry.x * x + b.ry.z * z) * b.half.y
        + Math.abs(b.rz.x * x + b.rz.z * z) * b.half.z;

      /* These remain per-block proxies rather than one box per wall. The
       * broadphase makes their count cheap, while a coarse wall would bridge
       * the gate, collapsed runs and deliberate gaps — exactly the places the
       * walker is meant to discover they can pass through. Projecting the
       * tilted OBB into one yawed rectangle is conservative at eroded corners
       * and still preserves those openings. */
      this.collision.addBox({
        x: b.c.x, z: b.c.z,
        halfX: extent(ux, uz),
        halfZ: extent(vx, vz),
        angle: Math.atan2(uz, ux),
        minY, maxY,
        kind: 'stone',
        stepable: true,
      });
    }
  }

  /* ------------------------------------------------------------- layout */

  _compose(B, ctx, seed) {
    const rng = makeRng(seed);
    const T = this.terrain;

    /* ---- the gate, t 0.81-0.83 -------------------------------------------
     * Asymmetric, and deliberately so. The stream comes down at about x = +5
     * through this whole stretch and has cut a channel two metres deep two
     * metres off the tread, so a symmetric pair of jambs would put one of them
     * in a gully. What is here instead is one tall standing jamb on the west
     * with its lintel down across the verge, which frames the view through it
     * from one side — and a foreground frame that closes on one side only is
     * more like documentary footage than a proscenium arch anyway. */
    /* Four metres west of the centre line, and that distance was measured
     * rather than chosen. At the first attempt the jamb stood a metre and a
     * half off the tread, which put a solid wall across the left half of the
     * frame from six metres out to the moment you passed it — a foreground
     * element so large it stopped being a frame and became the subject. Four
     * metres puts its inner face at the edge of the ninth of the image the eye
     * treats as border, which is where a repoussoir belongs. */
    const gy = T.height(0.4, -313.0);
    wall(B, ctx, {
      a: [-0.4, -311.4], b: [1.2, -314.2],
      height: () => 3.55, thick: 1.05, len: 0.80, rng,
      settle: 0.22, loosen: 0.35, spallChance: 0.5,
    });
    // Two corbel courses stepping out over the opening, most of them gone.
    for (let i = 0; i < 2; i++) {
      if (i === 1 && rng() < 0.5) break;
      slab(B, ctx, 0.4 + 0.22 * (i + 1), gy + 3.55 + 0.26 + i * 0.44, -313.0,
        1.5, 0.42, 1.24 + i * 0.3, [0.03, 0.42, -0.02], rng);
    }
    // The east jamb, reduced to a stump on the far bank of the channel.
    wall(B, ctx, {
      a: [6.0, -312.3], b: [7.3, -314.9],
      height: (u) => 1.55 - 0.5 * u, thick: 1.0, len: 0.78, rng,
      settle: 0.26, loosen: 1.3,
    });
    /* The lintel, down. One end still caught on the jamb it was seated on and
     * the other in the litter, which is how a span actually fails — it drops
     * at the weak end and hinges, it does not fall flat. */
    slab(B, ctx, 2.6, T.height(2.6, -316.0) + 0.75, -316.0,
      3.7, 0.62, 0.95, [0.06, 0.52, 0.40], rng);
    slab(B, ctx, 0.8, T.height(0.8, -317.0) + 0.28, -317.0,
      1.5, 0.55, 0.9, [0.20, 0.9, 0.14], rng);
    // The worn threshold the path still runs over.
    slab(B, ctx, 3.4, T.height(3.4, -313.4) - 0.16, -313.4,
      2.4, 0.34, 1.5, [0.03, 0.42, -0.02], rng, { spalls: 2, erode: 0.08 });

    /* ---- the enclosure wall ---------------------------------------------
     * Runs away from the gate to both sides and dies out in the thicket. It
     * exists to say the clearing is an *enclosure* rather than a gap in the
     * trees, and it is low enough everywhere that it never blocks the reveal.
     */
    const encW = [];
    encW.push(...wall(B, ctx, {
      a: [2.4, -313.6], b: [-9.0, -316.5],
      height: (u) => 2.30 - 1.5 * smooth01((u - 0.35) / 0.5)
        + 0.5 * Math.sin(u * 9.0), thick: 0.80, len: 1.0, rng,
      splits: [{ u: 0.62, w: 0.10, amp: 0.30 }],
    }));
    encW.push(...wall(B, ctx, {
      a: [-9.0, -316.5], b: [-20.0, -323.0],
      height: (u) => 1.05 + 1.5 * smooth01((u - 0.2) / 0.55) + 0.35 * Math.sin(u * 13.0),
      thick: 0.80, len: 1.0, rng,
      splits: [{ u: 0.30, w: 0.09, amp: 0.34 }],
    }));
    encW.push(...wall(B, ctx, {
      a: [-20.0, -323.0], b: [-28.5, -332.5],
      height: (u) => 2.20 - 1.7 * u + 0.4 * Math.sin(u * 8.0), thick: 0.78, len: 1.0, rng,
    }));
    encW.push(...wall(B, ctx, {
      a: [6.6, -313.3], b: [14.5, -311.0],
      height: (u) => 1.35 - 0.9 * u, thick: 0.76, len: 0.95, rng, loosen: 1.5,
    }));
    encW.push(...wall(B, ctx, {
      a: [14.5, -311.0], b: [23.5, -316.5],
      height: (u) => 0.55 + 0.9 * Math.max(0, Math.sin(u * 5.0)), thick: 0.76, len: 0.95, rng,
      loosen: 1.6,
    }));

    /* ---- the terrace ----------------------------------------------------
     * The retaining courses are built *down* from the terrace surface rather
     * than up from the ground, because that is the order they were laid in and
     * because it is the only way the bottom of the wall ends up inside its own
     * bank. Four courses are cut; two or three of them show.
     */
    const P = this.plan.terraces[0];
    const per = [];
    const N = 30;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 6.283;
      // Walk the superellipse the terrain was shaped with, so the wall stands
      // exactly on the lip of its own bank rather than near it.
      const cs = Math.cos(a), sn = Math.sin(a);
      const k = 1 / Math.pow(Math.pow(Math.abs(cs), 6) + Math.pow(Math.abs(sn), 6), 1 / 6);
      const lx = cs * k * P.rx, lz = sn * k * P.rz;
      const c = Math.cos(P.rot), s = Math.sin(P.rot);
      per.push([P.x + lx * c - lz * s, P.z + lx * s + lz * c]);
    }
    for (let i = 0; i < N; i++) {
      const a = per[i], b = per[(i + 1) % N];
      /* The north-east corner has gone: the corner of a terrace is where the
       * water comes off and it is the piece with the least holding it, so it
       * is always the first to go — and it is the corner nearest the trail,
       * which is what spills a rubble slope across the approach and lets the
       * eye read the terrace's *height* from the pieces rather than from the
       * intact face. */
      const mx = (a[0] + b[0]) * 0.5, mz = (a[1] + b[1]) * 0.5;
      const broken = smooth01((mx + 13.5) / 5.5) * smooth01((mz + 332.5) / 4.5);
      const nc = 4;
      wall(B, ctx, {
        a, b,
        height: () => (nc - 0.2) * COURSE * (1 - broken * 0.75),
        thick: 0.85, len: 1.05, rng, seg: 3,
        baseY: () => P.top - nc * COURSE,
        loosen: 0.4 + broken * 1.6,
        splits: i === 6 ? [{ u: 0.5, w: 0.25, amp: 0.30 }] : [],
      });
    }
    // And the debris the broken corner shed onto the clearing floor.
    rubble(B, ctx, { x: -6.5, z: -328.5, r: 5.5, n: 34, rng, size: 1.25, sink: 0.45 });
    rubble(B, ctx, { x: -3.6, z: -333.5, r: 4.5, n: 22, rng, size: 1.1, sink: 0.5 });

    /* Paving, over the front of the terrace only. Behind the cella it has long
     * since gone to soil and forest, which is both true of every terrace of
     * this age and two hundred slabs the frame never sees. */
    const pavRng = makeRng(seed + 31);
    for (let i = 0; i < 64; i++) {
      const px = -8.0 - (i % 8) * 1.55 - pavRng() * 0.2;
      const pz = -333.5 - ((i / 8) | 0) * 1.6 - pavRng() * 0.2;
      if (this.plan.terraceMask(px, pz, P) < 0.85) continue;
      if (pavRng() < 0.22) continue;
      slab(B, ctx, px, P.top - 0.10 + (pavRng() - 0.5) * 0.06, pz,
        1.42 + pavRng() * 0.2, 0.30, 1.42 + pavRng() * 0.2,
        [(pavRng() - 0.5) * 0.09, P.rot + (pavRng() - 0.5) * 0.12, (pavRng() - 0.5) * 0.09],
        pavRng, { seg: 2, spalls: pavRng() < 0.5 ? 1 : 0 });
    }

    /* The stair up the terrace's east face, straight at the trail. It is the
     * one element in the complex that tells the viewer the terrace is a floor
     * they could stand on, and without it the retaining wall reads as a cliff. */
    stair(B, ctx, {
      // Descending eastward, off the terrace and toward the trail: the flight
      // has to run *away* from the platform or it climbs into it, which is
      // how the first version buried its own steps under the paving.
      x: -5.4, z: -337.6, dir: 0.28, width: 3.6, steps: 5,
      rise: 0.46, run: 0.66, topY: P.top - 0.14, rng,
    });

    /* ---- the cella ------------------------------------------------------
     * A single chamber with its roof down, doorway facing the trail. This is
     * the focal object of the whole level and it is the only fully enclosed
     * form in the complex, which is what makes it read as a building rather
     * than as more wall.
     */
    /* Sited at the *near* end of the terrace rather than the far one. It is
     * the tallest thing in the complex by three metres, and the only object
     * whose top clears the understory at thirty metres, so it is the one that
     * has to be closest to the approach — a cella hidden behind its own
     * platform is a building nobody is ever told about. */
    const cx = -11.8, cz = -339.5, cw = 4.0, cd = 3.3, crot = P.rot;
    const cc = Math.cos(crot), cs = Math.sin(crot);
    const corner = (sx, sz) => [
      cx + (sx * cw) * cc - (sz * cd) * cs,
      cz + (sx * cw) * cs + (sz * cd) * cc,
    ];
    const c00 = corner(1, -1), c01 = corner(1, 1), c11 = corner(-1, 1), c10 = corner(-1, -1);
    const cellaBase = () => P.top - 0.20;
    const cellaTops = [];
    // East wall, with the doorway. The lintel over it is still up.
    cellaTops.push(...wall(B, ctx, {
      /* Ragged, and by more than a course. A wall whose head runs level for
       * eight metres with a few stones missing is a wall that was demolished
       * tidily; one whose head rises and falls by a metre and a half has lost
       * different parts of itself at different times, which is the only story
       * that fits a building nobody has touched in four hundred years. */
      a: c00, b: c01,
      height: (u) => 4.25 - 1.5 * Math.abs(u - 0.42)
        + 0.55 * Math.sin(u * 11.0 + 0.7) - 0.35 * Math.sin(u * 23.0),
      thick: 0.92, len: 0.9, rng, baseY: cellaBase, loosen: 0.7,
      gaps: [[0.34, 0.66, 2.45]],
    }));
    const dm = [(c00[0] + c01[0]) * 0.5, (c00[1] + c01[1]) * 0.5];
    const dTheta = Math.atan2(c01[0] - c00[0], c01[1] - c00[1]);
    slab(B, ctx, dm[0], P.top - 0.20 + 2.66, dm[1], 2.5, 0.48, 1.05,
      [0.0, -dTheta + Math.PI / 2, 0.035], rng);
    // North wall, standing; south wall, down to two courses; back wall, gone
    // at one end so the chamber is open to the light from behind.
    cellaTops.push(...wall(B, ctx, {
      a: c01, b: c11,
      height: (u) => 4.0 - 2.5 * smooth01((u - 0.42) / 0.55) + 0.6 * Math.sin(u * 14.0),
      thick: 0.92, len: 0.9, rng, baseY: cellaBase, loosen: 0.95,
      splits: [{ u: 0.22, w: 0.12, amp: 0.26 }],
    }));
    cellaTops.push(...wall(B, ctx, {
      a: c11, b: c10, height: (u) => 1.1 + 2.4 * smooth01((u - 0.15) / 0.5),
      thick: 0.92, len: 0.9, rng, baseY: cellaBase, loosen: 1.0,
    }));
    cellaTops.push(...wall(B, ctx, {
      a: c10, b: c00,
      height: (u) => 3.7 - 2.6 * smooth01((0.82 - u) / 0.62) + 0.5 * Math.sin(u * 12.0 + 2.0),
      thick: 0.92, len: 0.9, rng, baseY: cellaBase, loosen: 1.0,
      splits: [{ u: 0.70, w: 0.12, amp: 0.32 }],
    }));
    // The roof, inside the chamber where it landed.
    rubble(B, ctx, { x: cx, z: cz, r: 2.6, n: 20, rng, size: 1.3, sink: 0.2 });

    /* Two piers in front of the doorway, one of which came down eastward and
     * lies across the terrace pointing at the viewer. A line of drums running
     * away from the eye is worth more than the pier standing was. */
    pier(B, ctx, { x: -6.9, z: -337.2, drums: 6, rng, baseY: P.top - 0.18 });
    pier(B, ctx, {
      x: -7.6, z: -342.6, drums: 6, rng, fallen: true, dir: 1.9,
      baseY: P.top - 0.12,
    });
    rubble(B, ctx, { x: -6.9, z: -337.2, r: 2.2, n: 10, rng, size: 0.8, sink: 0.35 });

    /* ---- the revetment wings, and the gap between them -------------------
     * Two walls flanking the head of the pool with seventeen metres of
     * nothing between them, on the axis of the spillway notch in the cliff.
     * That emptiness is the deliverable: System 5 puts the fall through it,
     * and anything built there now would have to come out again.
     *
     * Their size and station are both the second attempt, and the first was
     * wrong in a way that only a measurement caught. Screen-coverage of stone,
     * differenced frame against frame with the complex hidden, runs 24% at the
     * gate and then collapses to 0.8% by t=0.90 and 0.2% by t=0.94 — the
     * player crests into the clearing, walks past the terrace on their left,
     * and spends the entire arrival looking at an empty basin. The wings were
     * supposed to be what holds those frames and they could not: at a metre
     * to two they finished below the scrub on the pool's far bank, twenty-odd
     * metres out, and the fog had them at the same value as the bank behind.
     *
     * So they are taller and they are nearer. Heaviest at the inner ends,
     * which is both what carries the frames looking down the axis and what a
     * spillway revetment actually looks like — the flanks of the notch take
     * the scour and get the mass, and the walls run down and out from there
     * into the bank. Pulling the inner ends from z=-370 to -366 is as close as
     * they can come without standing in the water: the pool is r=12.5 about
     * (0,-356), so at x=8.5 its lip is already at z=-365.2.
     */
    wall(B, ctx, {
      a: [-25.0, -367.0], b: [-8.5, -366.0],
      height: (u) => 1.6 + 2.7 * smooth01((u - 0.12) / 0.68)
        + 0.55 * Math.sin(u * 9.0 + 1.1) - 0.40 * Math.sin(u * 19.0),
      thick: 0.95, len: 1.05, rng, loosen: 1.2,
      splits: [{ u: 0.62, w: 0.10, amp: 0.28 }],
    });
    /* The east wing is the ruined one. Two walls of equal stature either side
     * of the gap would read as a gateway and pull the eye to the centre line
     * before the water is there to justify it; one standing and one reduced to
     * its lower courses reads as a ruin and leaves the axis to the cliff. */
    wall(B, ctx, {
      a: [8.5, -366.0], b: [25.0, -366.5],
      height: (u) => 2.9 - 1.9 * smooth01((u - 0.08) / 0.55)
        + 0.5 * Math.sin(u * 10.0 + 0.4) + 0.35 * Math.sin(u * 21.0),
      thick: 0.95, len: 1.05, rng, loosen: 1.6,
    });
    // Steps down into the water at the west wing's inner end, and the blocks
    // that have already fallen off them into the shallows.
    stair(B, ctx, {
      x: -7.6, z: -364.2, dir: 1.35, width: 3.0, steps: 4,
      rise: 0.42, run: 0.7, topY: T.height(-7.6, -364.2) + 0.5, rng,
    });
    rubble(B, ctx, { x: -6.0, z: -362.0, r: 4.5, n: 14, rng, size: 1.0, sink: 0.4 });
    rubble(B, ctx, { x: 7.5, z: -362.5, r: 5.0, n: 12, rng, size: 0.9, sink: 0.45 });

    /* ---- loose stone through the clearing --------------------------------
     * Between the gate and the pool, and specifically *on* the trail in two
     * places. A block you have to step around is worth ten in the middle
     * distance, because it is the only one the viewer gets to judge at arm's
     * length. */
    rubble(B, ctx, { x: 1.0, z: -324.0, r: 7.0, n: 22, rng, size: 0.95, sink: 0.55 });
    rubble(B, ctx, { x: -2.0, z: -344.0, r: 8.0, n: 20, rng, size: 0.9, sink: 0.6 });
    rubble(B, ctx, { x: 10.0, z: -336.0, r: 8.0, n: 16, rng, size: 0.85, sink: 0.6 });
    slab(B, ctx, 2.6, T.height(2.6, -327.4) + 0.26, -327.4, 1.7, 0.72, 1.1,
      [0.16, 1.1, 0.09], rng);
    slab(B, ctx, -0.9, T.height(-0.9, -350.2) + 0.20, -350.2, 1.9, 0.58, 1.2,
      [0.10, 0.35, 0.22], rng);

    /* ---- outliers along the trail ----------------------------------------
     * The first half of the walk gets a handful of worked stones and nothing
     * else, at a density that roughly doubles every twenty metres of trail.
     * One pair is placed by hand at the 0.34 vista, because that frame is the
     * longest sightline in the forest half of the level and it is the one
     * place a single square-cut block reads as evidence rather than as a rock.
     */
    this._outliers(B, ctx, makeRng(seed + 77));

    /* Vine anchors: the top of anything still standing high enough for a
     * liana to have found it. Handed to the vegetation system rather than
     * hung here, so the growth on the ruins is the same species, the same
     * material and the same wind as the growth on the trees. */
    const anchors = [...encW, ...cellaTops];
    for (const a of anchors) if (rng() < 0.55) this.vineAnchors.push({ ...a, s: 0.7 + rng() * 0.7 });
  }

  _outliers(B, ctx, rng) {
    const T = this.terrain;
    const p = new THREE.Vector3();
    for (let t = 0.30; t < 0.80; t += 0.006) {
      const chance = 0.020 + 0.085 * smooth01((t - 0.30) / 0.48);
      if (rng() > chance) continue;
      this.trail.pointAt(t, p);
      const tan = this.trail.tangentAt(t, new THREE.Vector3());
      const side = rng() < 0.5 ? 1 : -1;
      const off = (1.9 + rng() * 4.0) * side;
      const x = p.x + (-tan.z) * off, z = p.z + tan.x * off;
      const n = 1 + ((rng() * 2.4) | 0);
      rubble(B, ctx, {
        x, z, r: 0.9 + rng() * 1.4, n, rng, size: 1.35,
        // Deeper than anything in the clearing. These have had nobody to
        // disturb them and four centuries of leaf fall on top.
        sink: 0.72, seg: 3,
      });
    }
    /* The 0.34 vista. The trail there runs out to the north-east across a
     * bend, so a stone on the inside of the curve sits in the left third of
     * the frame at about seven metres — near enough to read as cut, far enough
     * that it is not the subject. */
    /* A kerb, not a boulder. Squared stones either side of the tread six
     * metres ahead of the 0.34 stop, offset from the *tangent* rather than
     * from a guessed world position, because the trail is on a bend there and
     * a fixed offset in x lands one of them in the middle of the path.
     *
     * They stand three quarters proud. An earlier version sank them by more
     * than their own half-height — the arithmetic was checked against a
     * plausible-sounding burial depth instead of against the block, and the
     * result was two entirely subterranean stones and a vista with no evidence
     * in it at all. Anything meant to be seen gets its depth expressed as a
     * fraction of its own extent from now on.
     *
     * The second thing that went wrong here is subtler and cost more to find,
     * because the stones were plainly *present* in the frame the whole time.
     * Differencing the render against one with the complex hidden gives the
     * mean colour of the pixels the masonry actually owns: (34, 42, 29) at
     * this stop, against (50, 50, 31) for the litter it was covering. The
     * stones were darker than the forest floor and their strongest channel was
     * green — under a closed canopy the light is green, and a mid-grey lit by
     * it and then taken down by burial, cavity occlusion and a moss term lands
     * in the same place as a leaf. No amount of surface detail rescues that;
     * at seven metres through this fog the silhouette is all there is.
     *
     * So the group leads with shape instead of tone. One stone is set on end.
     * A block standing upright with parallel vertical sides and a square top
     * is not a thing weather produces, and it stays not-a-thing-weather-
     * produces when it is dark, wet, half green and seen against leaves —
     * which is exactly the condition every frame here is shot in. Its vertical
     * faces also carry far less moss than the flat tops the group had before,
     * because the habitat term is driven by how far the face points at the
     * sky, so the fix for the silhouette improves the colour as a side effect
     * rather than by fighting it. */
    const tn = new THREE.Vector3();
    for (const [tt, off, len, hgt, yaw, up] of [
      [0.352, -2.6, 1.9, 0.66, 0.62, false],   // kerb, lying, nearest the eye
      [0.356, 2.9, 0.62, 1.45, 2.28, true],    // the stub, set on end
      [0.372, -3.1, 1.25, 0.58, 1.50, false],  // a second kerb further out
    ]) {
      this.trail.pointAt(tt, p);
      this.trail.tangentAt(tt, tn);
      const sx = p.x + (-tn.z) * off, sz = p.z + tn.x * off;
      /* The upright is barely tilted and barely sunk. A post that leans is
       * reading as a fallen thing again, and the whole point of it is that it
       * is the one object in the first half of the walk that is still where
       * somebody put it. */
      const tilt = up ? 0.045 : 0.14;
      slab(B, ctx, sx, T.height(sx, sz) + (up ? hgt * 0.36 : 0.20), sz,
        len, hgt, up ? 0.50 : 1.02,
        [tilt, yaw, up ? -0.03 : 0.11], rng,
        { spalls: up ? 1 : 2, erode: up ? 0.05 : 0.08 });
    }
  }

  /* --------------------------------------------------------------- bakes */

  /**
   * Fill in the four surface channels that need the whole complex to exist
   * before they can be answered.
   *
   * Occlusion is the expensive one and it is worth the cost: it is what draws
   * a dark line down every joint. The alternative — an ambient occlusion term
   * from the screen-space pass — cannot see a six centimetre gap between two
   * chamfered blocks at half resolution, and that gap is the single feature
   * that says "masonry" rather than "lumpy grey mass".
   */
  _bakeSurfaceData(B) {
    const n = B.count;
    const pos = B.pos, nor = B.nor, idx = B.idx;

    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ax = pos[b] - pos[a], ay = pos[b + 1] - pos[a + 1], az = pos[b + 2] - pos[a + 2];
      const bx = pos[c] - pos[a], by = pos[c + 1] - pos[a + 1], bz = pos[c + 2] - pos[a + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
      nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
      nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
    }
    for (let v = 0; v < n; v++) {
      const k = v * 3;
      const l = Math.hypot(nor[k], nor[k + 1], nor[k + 2]) || 1;
      nor[k] /= l; nor[k + 1] /= l; nor[k + 2] /= l;
    }

    // Uniform grid over the block centres, so the occlusion probe only ever
    // tests the handful of stones that could possibly be in the way.
    const CELL = 3.0;
    const grid = new Map();
    B.blocks.forEach((b, i) => {
      const x0 = Math.floor((b.c.x - b.ext.x) / CELL), x1 = Math.floor((b.c.x + b.ext.x) / CELL);
      const y0 = Math.floor((b.c.y - b.ext.y) / CELL), y1 = Math.floor((b.c.y + b.ext.y) / CELL);
      const z0 = Math.floor((b.c.z - b.ext.z) / CELL), z1 = Math.floor((b.c.z + b.ext.z) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const key = `${x},${y},${z}`;
            let a = grid.get(key);
            if (!a) grid.set(key, a = []);
            a.push(i);
          }
        }
      }
    });

    const inside = (bx, by, bz, b, pad) => {
      const dx = bx - b.c.x, dy = by - b.c.y, dz = bz - b.c.z;
      return Math.abs(dx * b.rx.x + dy * b.rx.y + dz * b.rx.z) < b.half.x + pad
        && Math.abs(dx * b.ry.x + dy * b.ry.y + dz * b.ry.z) < b.half.y + pad
        && Math.abs(dx * b.rz.x + dy * b.rz.y + dz * b.rz.z) < b.half.z + pad;
    };

    const REACH = [0.20, 0.52, 1.00];
    const WEIGHT = [0.50, 0.32, 0.18];
    const T = this.terrain;

    for (let v = 0; v < n; v++) {
      const k = v * 3, s = v * 4;
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      const nx = nor[k], ny = nor[k + 1], nz = nor[k + 2];
      const me = B.vBlock[v];

      let occl = 0;
      for (let r = 0; r < REACH.length; r++) {
        const px = x + nx * REACH[r], py = y + ny * REACH[r], pz = z + nz * REACH[r];
        const key = `${Math.floor(px / CELL)},${Math.floor(py / CELL)},${Math.floor(pz / CELL)}`;
        const cand = grid.get(key);
        if (!cand) continue;
        for (let ci = 0; ci < cand.length; ci++) {
          if (cand[ci] === me) continue;
          if (inside(px, py, pz, B.blocks[cand[ci]], 0.02)) { occl += WEIGHT[r]; break; }
        }
      }

      const gy = T.height(x, z);
      /* Burial runs a little above the soil as well as below it. The last
       * hand's width of a standing stone is splashed, silted and permanently
       * damp whatever the weather, and treating the ground plane as a hard
       * boundary is what makes a block look like it was pushed into a
       * photograph of a forest floor. */
      const burial = clamp((gy + 0.20 - y) / 0.55, 0, 1);
      // Runoff: how far below the top of this stone, on a face steep enough
      // for water to run down rather than stand on.
      /* Runoff, measured from the top of *this* block rather than the top of
       * the wall, which is what a coursed surface actually does: every bed
       * joint is a drip line, so the staining restarts at each course instead
       * of washing evenly down four metres. Half a metre of reach, because a
       * streak that ran the full height of the stone covered every vertical
       * face in the complex and read as a wash rather than as weathering. */
      const top = B.blocks[me].topY;
      const drip = Math.pow(clamp(1 - (top - y) / 0.55, 0, 1), 1.8) * (1 - Math.abs(ny));

      B.st[s] = clamp(1 - occl, 0, 1);
      B.st[s + 2] = drip;
      B.st[s + 3] = burial;
      B.meta[v * 4 + 1] = T.wetAt(x, z);
    }
  }

  /* A coarse plan-space record of where the stone is and how high its top
   * sits, so the vegetation system can grow things on the ruins instead of
   * through them. Half a metre is finer than any plant it will be asked
   * about and the whole grid is under a hundred kilobytes. */
  _buildGrid(B) {
    const S = 0.5, PAD = 2;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of B.blocks) {
      x0 = Math.min(x0, b.c.x - b.ext.x); x1 = Math.max(x1, b.c.x + b.ext.x);
      z0 = Math.min(z0, b.c.z - b.ext.z); z1 = Math.max(z1, b.c.z + b.ext.z);
    }
    this.gx0 = Math.floor(x0) - PAD; this.gz0 = Math.floor(z0) - PAD;
    this.gw = Math.ceil(x1 - this.gx0) + PAD * 2;
    this.gh = Math.ceil(z1 - this.gz0) + PAD * 2;
    this.gw = Math.ceil(this.gw / S); this.gh = Math.ceil(this.gh / S);
    this.gs = S;
    const top = new Float32Array(this.gw * this.gh).fill(-1e9);
    const near = new Uint8Array(this.gw * this.gh);

    for (const b of B.blocks) {
      const i0 = Math.max(0, Math.floor((b.c.x - b.ext.x - this.gx0) / S));
      const i1 = Math.min(this.gw - 1, Math.ceil((b.c.x + b.ext.x - this.gx0) / S));
      const j0 = Math.max(0, Math.floor((b.c.z - b.ext.z - this.gz0) / S));
      const j1 = Math.min(this.gh - 1, Math.ceil((b.c.z + b.ext.z - this.gz0) / S));
      const t = b.c.y + b.ext.y;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * this.gw + i;
          if (t > top[k]) top[k] = t;
        }
      }
    }
    /* Dilated by three cells, which is the band in which a plant is growing
     * *against* the stone rather than on it. Everything in this scene that
     * looks planted rather than grown is missing exactly this: a wall foot
     * with the same fern density as open floor twenty metres away. */
    for (let j = 0; j < this.gh; j++) {
      for (let i = 0; i < this.gw; i++) {
        if (top[j * this.gw + i] < -1e8) continue;
        for (let dj = -3; dj <= 3; dj++) {
          for (let di = -3; di <= 3; di++) {
            const jj = j + dj, ii = i + di;
            if (ii < 0 || jj < 0 || ii >= this.gw || jj >= this.gh) continue;
            near[jj * this.gw + ii] = 1;
          }
        }
      }
    }
    /* Which of those tops a plant could actually be growing on.
     *
     * `top` answers "is there stone here and how high", which is not the same
     * question and using it as though it were produced the fault the critic
     * called a floating vegetation band. Every candidate whose plan position
     * landed anywhere in a wall's footprint was lifted to the top of the
     * masonry above it — including the ones standing where the wall is four
     * courses high. From the front those plants are not on anything: they are
     * a row of ferns at mid-wall height with a stone face behind them and
     * open air below, and because a wall's head is roughly level along its
     * length they line up into a band, which is what gives the whole thing
     * away at a glance.
     *
     * A perch is a top with nothing much taller immediately beside it — the
     * head of a wall, the upper face of a fallen block, the tread of a stair.
     * Anywhere else the stone is a *face*, and a face is not a foothold.
     */
    const perch = new Float32Array(this.gw * this.gh).fill(-1e9);
    const R = 3;                       // a metre and a half, either side
    for (let j = 0; j < this.gh; j++) {
      for (let i = 0; i < this.gw; i++) {
        const k = j * this.gw + i;
        const t = top[k];
        if (t < -1e8) continue;
        let tallest = t;
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            const jj = j + dj, ii = i + di;
            if (ii < 0 || jj < 0 || ii >= this.gw || jj >= this.gh) continue;
            const n = top[jj * this.gw + ii];
            if (n > tallest) tallest = n;
          }
        }
        if (tallest - t < 0.38) perch[k] = t;
      }
    }

    this._top = top;
    this._near = near;
    this._perch = perch;
  }

  /** Top of the stone at a plan position, or -Infinity where there is none. */
  topAt(x, z) {
    const i = Math.floor((x - this.gx0) / this.gs), j = Math.floor((z - this.gz0) / this.gs);
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return -Infinity;
    return this._top[j * this.gw + i];
  }

  /**
   * Top of the stone here if a plant could be growing on it, else -Infinity.
   *
   * The difference from topAt is the whole fix for the floating band: a
   * candidate that is over stone but not over a perch is standing against a
   * wall face and must be refused, not lifted.
   */
  perchAt(x, z) {
    const i = Math.floor((x - this.gx0) / this.gs), j = Math.floor((z - this.gz0) / this.gs);
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return -Infinity;
    return this._perch[j * this.gw + i];
  }

  /** True within about a metre and a half of any stone. */
  nearAt(x, z) {
    const i = Math.floor((x - this.gx0) / this.gs), j = Math.floor((z - this.gz0) / this.gs);
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return false;
    return this._near[j * this.gw + i] === 1;
  }

  /* ------------------------------------------------------------- meshing */

  /**
   * Merge the blocks into a mesh per ground tile.
   *
   * One mesh for the whole complex would never be frustum-culled and would put
   * the far revetment into the depth pass from the trailhead; one mesh per
   * block would be a thousand draw calls. A twenty-metre tile is about the
   * size of a room, which is the granularity the culler can actually use.
   */
  _emit(B) {
    const TILE = 20;
    const buckets = new Map();
    for (const b of B.blocks) {
      const key = `${Math.floor(b.c.x / TILE)},${Math.floor(b.c.z / TILE)}`;
      let a = buckets.get(key);
      if (!a) buckets.set(key, a = []);
      a.push(b);
    }

    let tris = 0;
    for (const list of buckets.values()) {
      let nv = 0, ni = 0;
      for (const b of list) { nv += b.vCount; ni += b.iCount; }
      const pos = new Float32Array(nv * 3);
      const nor = new Float32Array(nv * 3);
      const st = new Float32Array(nv * 4);
      const meta = new Float32Array(nv * 4);
      const idx = new Uint32Array(ni);
      let vo = 0, io = 0;
      let cx = 0, cz = 0;
      for (const b of list) {
        for (let i = 0; i < b.vCount; i++) {
          const s = b.vStart + i;
          pos[(vo + i) * 3] = B.pos[s * 3];
          pos[(vo + i) * 3 + 1] = B.pos[s * 3 + 1];
          pos[(vo + i) * 3 + 2] = B.pos[s * 3 + 2];
          nor[(vo + i) * 3] = B.nor[s * 3];
          nor[(vo + i) * 3 + 1] = B.nor[s * 3 + 1];
          nor[(vo + i) * 3 + 2] = B.nor[s * 3 + 2];
          st[(vo + i) * 4] = B.st[s * 4];
          st[(vo + i) * 4 + 1] = B.st[s * 4 + 1];
          st[(vo + i) * 4 + 2] = B.st[s * 4 + 2];
          st[(vo + i) * 4 + 3] = B.st[s * 4 + 3];
          meta[(vo + i) * 4] = B.meta[s * 4];
          meta[(vo + i) * 4 + 1] = B.meta[s * 4 + 1];
          meta[(vo + i) * 4 + 2] = B.meta[s * 4 + 2];
          meta[(vo + i) * 4 + 3] = B.meta[s * 4 + 3];
        }
        for (let i = 0; i < b.iCount; i++) idx[io + i] = B.idx[b.iStart + i] - b.vStart + vo;
        vo += b.vCount; io += b.iCount;
        cx += b.c.x; cz += b.c.z;
      }

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('aStone', new THREE.BufferAttribute(st, 4));
      g.setAttribute('aMeta', new THREE.BufferAttribute(meta, 4));
      /* three only compiles the map, normal-map and roughness paths when the
       * material has those slots bound, and it only declares the uv attribute
       * when the geometry has one. Every fetch is replaced by the injection in
       * makeStoneMaterial, so this is never read — but without it the chunk
       * the injection hooks into is not in the shader at all. */
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();

      const m = new THREE.Mesh(g, this.material);
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.root.add(m);
      this.cells.push({ mesh: m, x: cx / list.length, z: cz / list.length });
      tris += ni / 3;
    }
    this.triangles = tris;
    this.blockCount = B.blocks.length;
  }

  /* Distance culling on top of the frustum test, for the same reason the
   * vegetation does it: the fog closes at about forty metres and a tile past
   * that contributes nothing but is still submitted, and still casts. */
  update(dt, camera) {
    const cx = camera.position.x, cz = camera.position.z;
    for (const c of this.cells) {
      const dx = c.x - cx, dz = c.z - cz;
      c.mesh.visible = dx * dx + dz * dz < 110 * 110;
    }
  }

  stats() {
    return { blocks: this.blockCount, meshes: this.cells.length, tris: this.triangles };
  }
}

/* ── material ─────────────────────────────────────────────────────────────
 *
 * One MeshStandardMaterial with every surface fetch replaced, on the same
 * argument as the terrain: going through the stock material keeps three's
 * lighting, shadows, fog and the canopy patch working, which is a great deal
 * of correct code not to have to write again in order to sample a texture
 * three ways.
 *
 * The blocks carry no UVs. A block is an arbitrary box at an arbitrary
 * orientation and there is no unwrap that both tiles consistently and keeps
 * the same texel density on a two-metre lintel and a fist-sized fragment, so
 * the stone is projected from world space instead — which has the second,
 * larger benefit that the *weathering* then lines up with gravity rather than
 * with the block. Water runs down in world space; so should the streaks.
 *
 * The cost of a world projection is that two blocks side by side sample the
 * same texture continuously across their joint, which erases the one thing the
 * geometry is there to say. Each block therefore offsets the projection by its
 * own random, which decorrelates neighbours while leaving the world scale and
 * the world orientation intact.
 */
export function makeStoneMaterial(renderer) {
  const stone = bakeSurface(renderer, STONE, { size: 1024, normalStrength: 2.2 });
  const mask = bakeImage(renderer, STONE_MASK, {
    size: 512, colorSpace: THREE.NoColorSpace,
    wrap: THREE.RepeatWrapping, transparent: false,
  });
  const macro = bakeImage(renderer, STONE_MACRO, {
    size: 256, colorSpace: THREE.NoColorSpace,
    wrap: THREE.RepeatWrapping, transparent: false,
  });

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0,
    map: stone.map, normalMap: stone.normalMap, roughnessMap: stone.ormMap,
    normalScale: new THREE.Vector2(1, 1),
    /* A vertical stone face under a closed canopy sees a few degrees of broken
     * sky, the same as a tree bole does, and it is a dielectric with a real
     * specular lobe — so this dial is what decides how cold the ruins go. The
     * same measurement that took the bark down to a tenth applies here and for
     * the same reason. */
    envMapIntensity: 0.11,
  });

  const U = {
    tStoneA: { value: stone.map },
    tStoneN: { value: stone.normalMap },
    tStoneO: { value: stone.ormMap },
    tStoneK: { value: mask },
    tStoneM: { value: macro },
    /* Live moss, and the value is the one the wood material had to learn: it
     * is a *lighter* patch than what it grows on, not a dark green coat. Under
     * this canopy a mossed ledge is one of the brighter things in the frame. */
    uMoss: { value: new THREE.Color(0x3c5322) },
    // Crustose lichen: a pale mineral crust, faintly green, quite matte.
    uLichen: { value: new THREE.Color(0x8f9179) },
    // Runoff. Manganese and organic wash, so nearly black and slightly warm.
    uStain: { value: new THREE.Color(0x2a2620) },
    /* Freshly fractured interior: paler, cooler, and with no rind on it — but
     * only a little paler. The first value here was nearly white, and since a
     * spall covers most of a fist-sized fragment, every piece of rubble in the
     * clearing came out looking like a lump of chalk. The interior of a dark
     * volcanic stone is still a dark stone. */
    uFresh: { value: new THREE.Color(0x6d6f66) },
    /* Spray wetness, and these four exist so that System 5 can drive them.
     *
     * The revetment wings flank a seventeen-metre gap that the falls are being
     * built into right now, and dry masonry standing beside falling water is
     * one of the strongest artificial tells there is — the stone within a few
     * metres of a plunge is permanently dark, glossy and algae-stained, and
     * the falloff from it is most of what sells the scale of the fall. The
     * geometry of that is a distance from the plunge point, so it is computed
     * in the shader from uniforms rather than baked into an attribute: the
     * water agent can move the plunge, widen the throw or raise the strength
     * without this module rebuilding anything.
     *
     * The radius is large — twenty-six metres — and that is not a fudge to
     * get the wings wet. The plunge is at the cliff and the wings stand on the
     * pool's far lip about twenty metres out, so a tight falloff would leave
     * them bone dry beside a waterfall, which is the exact tell the critic
     * warned about. A fall of this size throws mist a long way and the gorge
     * downwind of it never dries; what matters for the read is not that the
     * wings are soaked but that there is a visible *gradient* across them,
     * their inner ends darker than their outer, because that gradient is what
     * tells the viewer how far away the water is and therefore how big it is.
     */
    uSprayC: { value: IMPACT.clone() },
    uSprayR: { value: 26.0 },
    uSprayK: { value: 0.85 },
    /* The waterline: where it is, and how far from the basin the stone still
     * knows about it. Masonry standing in a plunge pool is not simply "wetter"
     * masonry — it is banded, and the bands are the record of a water level
     * that has sat in one place for four hundred years. Below the line there
     * is algal film; at it, a stain; above it, a zone that is wetted by the
     * spray and dried by the air often enough to leave carbonate behind. A
     * single spherical wetness term cannot express any of that, which is why
     * the lower courses came out the same tan as the blocks three hundred
     * metres up the trail. */
    uWaterY: { value: POOL_Y },
    uWaterC: { value: new THREE.Vector2(POOL.x, POOL.z) },
    /* Twenty-two metres, and flat rather than tapered inside it — see `near`.
     *
     * The basin's nominal radius is 12.5 m about (0, -356) and the masonry that
     * actually stands at the water is the west revetment and the causeway head,
     * 14 to 17 m from that centre. Against the original falloff — 18.5 m
     * outside, already half gone by 14 — every band arrived at a third of its
     * authored strength before any of the albedo weights ran, and the product
     * was a couple of per cent. The critique's "one uniform grey-green tone
     * through the waterline" was literally correct: the bands were computed and
     * then multiplied away.
     *
     * This radius is only the coarse gate. What separates stone standing in
     * water from stone standing beside it is the block's own wetness, not its
     * distance from a point, and widening this alone was a mistake that cost
     * the trail's best frame: at 26.5 m the disc reached the terrace steps
     * thirty metres up the approach, which are dry, and painted a calcite
     * course across all of them. */
    uWaterR: { value: POOL.r + 9.5 },
    uAlgae: { value: new THREE.Color(0x1a2410) },
    uCalcite: { value: new THREE.Color(0xb9b7a4) },
    uDebug: { value: 0 },
  };

  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    mat.userData.shader = sh;

    sh.vertexShader = `
      attribute vec4 aStone;
      attribute vec4 aMeta;
      varying vec4 vStone;
      varying vec4 vMeta;
      varying vec3 vWPosS;
      varying vec3 vWNrmS;
    ` + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vStone = aStone;
       vMeta = aMeta;
       vWPosS = (modelMatrix * vec4(position, 1.0)).xyz;
       vWNrmS = normalize(mat3(modelMatrix) * normal);`
    );

    sh.fragmentShader = SSTEP + `
      uniform sampler2D tStoneA, tStoneN, tStoneO, tStoneK, tStoneM;
      uniform vec3 uMoss, uLichen, uStain, uFresh;
      uniform vec3 uSprayC;
      uniform float uSprayR, uSprayK, uDebug;
      uniform float uWaterY, uWaterR;
      uniform vec2 uWaterC;
      uniform vec3 uAlgae, uCalcite;
      float gSub, gLine, gSplash;
      varying vec4 vStone;     // occlusion, fresh fracture, runoff, burial
      varying vec4 vMeta;      // per-block random, wetness, exposure, wear
      varying vec3 vWPosS;
      varying vec3 vWNrmS;

      vec2 gUvF, gUvW, gUvMF, gUvMW;
      float gWall, gMoss, gLichen, gStain, gAO, gRough, gCush, gWet, gExpo;
      vec3 gMacro, gMask, gDbg;

      /* One point six metres of stone to the tile. Small enough that the
       * aggregate and the pitting land at three to six centimetres, which is
       * the size they are; large enough that the whole feature set is not
       * averaged away by the mip chain at the ten to twenty metres most of
       * this complex is seen from. */
      const float S_STONE = 0.62;

      /* A second, much coarser projection, used only by the moss.
       *
       * A moss cushion is three to eight centimetres of growth, which is five
       * to ten times the scale of the aggregate and the pitting, and sampling
       * it off the same tiling as the stone was most of why it read as paint:
       * the colony boundary followed features far too fine to see, so from any
       * real distance the mip chain averaged it to an even green film. At this
       * tiling one lump is about the size of a fist, which is large enough to
       * survive filtering and to break the line of an arris it grows over. */
      const float S_MOSS = 3.1;

      vec3 biStone(sampler2D t){
        return mix(texture2D(t, gUvF).rgb, texture2D(t, gUvW).rgb, gWall);
      }
      vec3 biMoss(sampler2D t){
        return mix(texture2D(t, gUvMF).rgb, texture2D(t, gUvMW).rgb, gWall);
      }

      void stoneWeights(){
        /* Per-block offset. Without it the projection runs straight across
         * every joint and forty blocks read as one carved mass — which is the
         * exact failure the joints exist to prevent, arriving through the
         * texture instead of through the geometry. */
        float r = vMeta.x;
        vec2 off = vec2(fract(r * 37.13), fract(r * 91.71)) * 9.0;

        gUvF = vWPosS.xz * S_STONE + off;
        gUvW = ((abs(vWNrmS.x) > abs(vWNrmS.z))
                ? vec2(vWPosS.z, vWPosS.y)
                : vec2(vWPosS.x, vWPosS.y)) * S_STONE + off.yx;
        // Two projections rather than three: the third would only ever serve
        // faces this geometry does not have enough of to pay for a fetch.
        gWall = sstep(0.72, 0.34, abs(vWNrmS.y));

        /* The moss projection gets no per-block offset, and that omission is
         * the entire point of it. The stone's own texture is offset per block
         * so that the aggregate does not run continuously across a joint —
         * correct, because two stones were cut from different parts of the
         * bed. Moss is the opposite case: it grew after the wall did, it does
         * not know where the joints are, and a colony that stops at every
         * arris is the single clearest sign that green was applied per block
         * rather than grown over the wall. Sampling it in continuous world
         * space lets one cushion straddle a joint and spill over an edge. */
        gUvMF = vWPosS.xz * S_MOSS;
        gUvMW = ((abs(vWNrmS.x) > abs(vWNrmS.z))
                 ? vec2(vWPosS.z, vWPosS.y)
                 : vec2(vWPosS.x, vWPosS.y)) * S_MOSS;
        gCush = biMoss(tStoneK).r;

        gMask = biStone(tStoneK);
        /* The macro field is sampled with a little of the height folded into
         * the plan position. A pure xz lookup gives a whole wall one value
         * from footing to coping, which reads as a vertical stripe of moss
         * rather than as moss. */
        gMacro = texture2D(tStoneM,
          vec2(vWPosS.x + vWPosS.y * 0.38, vWPosS.z + vWPosS.y * 0.31) * 0.036).rgb;

        float up = clamp(vWNrmS.y, 0.0, 1.0);

        /* Spray. Falls off with plan distance from the plunge and, separately,
         * with height above it — a fall throws mist outward and upward for a
         * few metres and then not at all, so a single spherical falloff would
         * have wetted the tops of the wings as much as their feet. */
        vec3 sd = vWPosS - uSprayC;
        float spray = uSprayK
          * sstep(uSprayR, uSprayR * 0.22, length(sd.xz))
          * sstep(uSprayR * 0.55, 0.0, max(0.0, sd.y));
        /* The three bands, gated on proximity to the basin so that identical
         * blocks elsewhere in the complex are untouched. dy is height above
         * the still-water surface, and every band is a function of it alone —
         * which is the point, because a waterline is horizontal and reads as
         * one across a dozen separate blocks at different depths only if it is
         * computed from the world's y and not from anything per-block. */
        /* Two gates, and the second is the one that matters.
         *
         * The disc is flat over the stonework that is genuinely at the water
         * and falls off only outside it, rather than being a ramp that has
         * already decayed by half at the pool's own edge — that shape is what
         * made the bands invisible. But a disc cannot tell a block standing in
         * the basin from one standing on dry ground twenty metres away at the
         * same height, and the bands are keyed to an absolute world y, so on
         * the second kind they are simply wrong. The block's own baked wetness
         * answers exactly that question and it costs nothing: it is already an
         * attribute, and it is the same field the terrain shades itself from,
         * so a course cannot be banded unless the ground it stands in is
         * wet. */
        /* The wetness gate opened up. At 0.30-to-0.75 it was asking for stone
         * that is already most of the way to saturated, which the courses
         * standing at the pool's own rim are not — they are at the top of the
         * damp zone, not in it — so the gate was closing over exactly the
         * blocks the bands exist for. It still has to be here, because it is
         * the only thing that tells a block in the basin from a block at the
         * same absolute height thirty metres up the dry approach. */
        float near = sstep(uWaterR, uWaterR - 4.5, length(vWPosS.xz - uWaterC))
                   * sstep(0.14, 0.48, vMeta.y);
        float dy = vWPosS.y - uWaterY;
        // Submerged and just-awash: continuously wet, so algae holds.
        gSub    = near * sstep(0.10, -0.15, dy);
        /* The stain: a hand's breadth of dark mineral deposit at the line
         * itself, which is the single most legible thing about old stonework
         * standing in water.
         *
         * Widened from 16 cm to 26 cm, because 16 cm of band on a block seen
         * from the far side of a thirty-metre basin is under two pixels and the
         * mip chain averages it out of existence before it is ever shaded. A
         * feature that only exists at one distance is a feature the critic is
         * right to call absent. Also raised off the surface a little: the line a
         * long-standing water level leaves is at the *top* of the capillary
         * rise, not at the water. */
        gLine   = near * exp(-pow((dy - 0.10) / 0.26, 2.0));
        // And the splash band above it, where the spray wets the stone and the
        // air dries it again and the carbonate stays behind.
        gSplash = near * sstep(-0.02, 0.22, dy) * sstep(1.60, 0.35, dy);

        gWet = clamp(max(max(vMeta.y, spray), max(gSub, gLine) * 0.95), 0.0, 1.0);
        float wet = gWet;

        /* Where the stone sits in its own wall. A footing course is silted,
         * shaded and permanently damp; a head course has had four centuries of
         * sun on it and rain running off it, and almost nothing grows there.
         * Without this every course of a wall weathered identically, which is
         * a large part of what made the fabric read as one extruded substance
         * rather than as a stack of separate stones. */
        gExpo = clamp(vMeta.z, 0.0, 1.0);

        /* Moss goes where the water stays, and the terms are *added* rather
         * than multiplied.
         *
         * The first version multiplied them, and multiplying a chain of
         * factors that each sit around a half gives a product around a tenth:
         * with a threshold placed for a half, nothing anywhere in the complex
         * ever crossed it and the ruins shipped bare. Worse, the failure is
         * invisible in the code — every individual line looks reasonable. A
         * sum of weighted habitat terms is both legible and bounded: the
         * weights below are how many tenths of the threshold each condition is
         * worth, and they can be read off against each other.
         *
         * It does not go on a freshly fractured face. That surface is
         * centuries younger than the rest of the stone and it is the one place
         * on a ruin that is still bare, which is what makes the fracture read
         * as recent damage rather than as a differently coloured block. */
        float hab = 0.22                           // the air here is saturated
        /* Lowered, because at 0.85 this one term saturated the habitat on its
         * own: any up-facing surface went to full moss regardless of what the
         * cushion field said, and a fallen slab came out as a flat green
         * rectangle — the clearest possible instance of the paint problem,
         * on the one surface where there is no relief to hide it. Weakening
         * it hands the decision back to the cushions, so a slab top is now a
         * scatter of colonies with bare stone between them. */
                  + 0.62 * up                      // rain and dust settle here
                  + 0.55 * vStone.w                // the foot never dries out
        /* The crevice and shelter weights carry more than they look like they
         * should, and the reason is the mip chain. Moss spread evenly over a
         * face averages to a green tint by fifteen metres and the wall reads
         * as painted; moss concentrated in the joints and the pitting keeps a
         * pattern at the scale of the masonry itself, which survives being
         * filtered and is what tells the eye at distance that the surface is
         * old rather than merely coloured. */
                  + 0.58 * gMask.g                 // crevices hold both
                  + 0.40 * (1.0 - vStone.x)        // and so do sheltered corners
                  + 0.22 * wet                     // the clearing's own damp
        /* Two per-stone terms. The first says a head course is a bad place to
         * be a moss: it dries out between showers and it is the only part of
         * a ruin that still gets direct sun. The second is simply that some
         * stones are mossier than their neighbours for reasons nobody can see
         * — a slightly more porous bed, a crack behind them feeding water —
         * and without it every block in a course carries the same amount of
         * green, which is exactly what "applied rather than grown" looks
         * like. It is a signed term so it does not inflate the mean. */
                  - 0.32 * gExpo
                  + 0.34 * (vMeta.w - 0.5);
        /* The macro field decides *which end of which wall*; the habitat above
         * decides where on a given stone. Keeping those two questions in
         * separate factors is what stops the complex having one uniform amount
         * of moss on every surface that faces the same way. */
        /* Two scales of placement, and the finer one is what stops this
         * looking like green paint. The macro field alone varies over three or
         * four metres, which is larger than a block — so a wall came out with
         * whole stones uniformly green and their neighbours uniformly bare,
         * with the boundary falling on the joints. Folding in the mask's slow
         * channel, which runs at forty centimetres, gives the colony an edge
         * that wanders across the face instead of stopping at it. */
        /* Three scales now, and the coarsest one is the cushion field. The
         * threshold is crossed lump by lump rather than smoothly, so the
         * colony gains a broken, wandering edge at the size of the growth
         * itself instead of a soft gradient at the size of the wall — which
         * is what gives it a silhouette that can interrupt an arris. */
        float mossField = gMacro.x * 0.62 + gMask.b * 0.40 + gCush * 0.66;
        gMoss = sstep(0.58, 1.30, hab * (0.35 + 1.45 * mossField))
              * (1.0 - vStone.y * 0.90);

        /* Lichen is the other tenant and it wants the opposite conditions:
         * exposed, drier, better lit. Where the two overlap the moss wins,
         * because it does — a moss cushion smothers a crust in one season. */
        gLichen = gMask.r
          * sstep(0.34, 0.62, gMacro.y + 0.22 * (1.0 - wet))
          * (0.30 + 0.70 * vStone.x)
          * (1.0 - gMoss) * (1.0 - vStone.y * 0.75);

        /* Runoff staining. The streak texture is stretched twenty to one in
         * world Y, so on any face steep enough to shed water it reads as
         * vertical wash — and because the sample is in world space it stays
         * vertical on a block that has fallen and landed on its side, which is
         * where a per-block projection would have got it wrong. */
        float streak = texture2D(tStoneM,
          vec2((vWPosS.x + vWPosS.z * 0.6) * 0.40, vWPosS.y * 0.055)).b;
        /* Per-stone, and by a lot. Runoff is the most visible weathering on a
         * standing wall and making every block carry the same amount of it
         * was the other half of the "same substance" reading — one stone
         * should be black with four centuries of drip while the one beside it
         * is nearly clean, because that is what a bed joint above them being
         * a millimetre out of true does. The exposure term adds the vertical
         * story: water sheds off the head course and arrives at the foot. */
        gStain = sstep(0.52, 0.94, streak * 0.88 + gMacro.z * 0.34)
               * vStone.z * (1.0 - up) * (1.0 - gMoss * 0.8)
               * (0.34 + 1.15 * vMeta.w)
               * (0.70 + 0.75 * (1.0 - gExpo)) * 0.8;
      }
      `
      // The trailing newline matters: three's shader opens with `#define
      // STANDARD`, and a directive that does not begin a line will not compile.
      + sh.fragmentShader
        .replace(
          '#include <map_fragment>',
          `stoneWeights();

           vec3 alb = biStone(tStoneA);
           vec3 orm = biStone(tStoneO);
           gAO = orm.r; gRough = orm.g;

           float lum = dot(alb, vec3(0.34, 0.50, 0.16));

           /* Fracture. The interior of the stone never had a weathering rind
            * on it, so it is paler and a good deal cooler than the face beside
            * it, and that difference is what makes a broken block read as
            * broken rather than as a block of a different colour. */
           alb = mix(alb, uFresh * (0.55 + 1.2 * lum), vStone.y * 0.55);

           // Large-scale tone, and then a per-block draw on top of it, because
           // a wall is built from stones cut on different days.
           /* Wide, because it has to survive the mip chain. Block-to-block
            * tone is the only feature of this material that is still legible
            * at thirty metres — the aggregate, the pitting and the cracks are
            * all centimetre-scale and have averaged to one grey by then — so
            * it is what carries the "wall of separate stones" reading across
            * the whole reveal, and a ten per cent spread does not survive
            * being seen through forty metres of aerial perspective. */
           alb *= 0.74 + 0.52 * gMacro.z;
           /* Per-block tone, widened — but widened upward.
            *
            * This had to be done carefully. The measured problem under closed
            * canopy is that the stone already renders *darker* than the leaf
            * litter beside it with green as its strongest channel, so simply
            * opening the spread symmetrically would have dropped the bottom
            * of the distribution straight into foliage colour and made some
            * blocks disappear. The floor therefore comes up and the ceiling
            * goes further up: the range widens from 0.76-1.24 to 0.84-1.46. */
           alb *= 0.84 + 0.62 * fract(vMeta.x * 13.71);

           /* Warm the whole fabric, and this is a hue correction rather than
            * a brightness one.
            *
            * Measured under closed canopy the stone's strongest channel was
            * green — the litter beside it read (46, 48, 30) and the masonry
            * read (35, 42, 30), so it was not merely darker, it was the same
            * colour as a leaf. The albedo itself was not the problem: it
            * sampled as (0.49, 0.49, 0.42), a perfectly reasonable neutral
            * grey. That is the trap. The light under this canopy is strongly
            * green, and a neutral surface lit by a green source is a green
            * surface; only a material that is already biased away from green
            * comes back neutral. Weathered stone in a wet tropical forest is
            * buff and ochre anyway, never neutral, so this is what it should
            * always have been.
            *
            * Weighted to cost almost nothing in luminance — red up an eighth,
            * blue down a tenth, which is about two per cent of luma — because
            * the one thing that must not happen is the stone getting brighter
            * to escape the foliage. That was tried and it blows out in the
            * clearing, where the stone is already at litter luminance. */
           alb *= vec3(1.23, 1.00, 0.85);
           /* Hue as well as value, and this is the part that stops the fabric
            * reading as one substance. A spread that only moves lightness is
            * a spread the eye attributes to *lighting* — it reads as one
            * material unevenly lit, which is precisely the "foam" verdict.
            * Two stones cut from different beds of the same quarry differ in
            * iron and therefore in hue, one buff and one grey, and a viewer
            * reads that difference as two stones. Kept narrow, because the
            * failure at the other end is a wall of coloured bricks. */
           /* Both ends of this run warm-of-neutral. An earlier version put the
            * cool bed at (0.94, 0.985, 1.06), which is a bluish grey — and a
            * bluish grey under green light is the worst case of the problem
            * the correction above exists to fix, so a third of the blocks
            * were being pushed back into foliage colour by the very term
            * meant to distinguish them. The spread is now buff against
            * cool-buff, which still reads as two different beds. */
           alb *= mix(vec3(1.09, 0.99, 0.88), vec3(0.97, 1.00, 1.00),
                      fract(vMeta.x * 5.37));
           /* Rain wear and sun on whatever has been on top longest. A head
            * course loses its rind and bleaches; a footing keeps it. */
           alb = mix(alb, alb * vec3(1.10, 1.075, 1.02), gExpo * 0.55);

           alb = mix(alb, uStain * (0.45 + 1.7 * lum), gStain * 0.68);
           /* Lichen sits *on* the stone and hides it, the same way moss does
            * on bark: a tinted multiply leaves the aggregate reading straight
            * through the thallus, which is the giveaway. It is thin, though,
            * so it keeps more of the surface underneath than moss does. */
           alb = mix(alb, uLichen * (0.50 + 1.1 * lum), gLichen * 0.72);
           /* Not a flat colour. A moss cushion is lit by whatever the stone
            * under it is doing — it is thin, it is translucent, and its own
            * tone varies with how much of the surface relief it has managed to
            * bridge — so it carries the aggregate's luminance through rather
            * than replacing it, and it never fully hides the stone. */
           /* Moss with a thickness gradient of its own. A cushion is deepest
            * in the middle and thins to nothing at its margin, and the deep
            * part is markedly darker because it is shading itself — so the
            * colony carries internal value structure rather than being one
            * flat green. Reusing the cushion field for this means the shading
            * agrees with the relief added to the normal below, which is what
            * makes it read as a solid growth with a lit top and a dark base
            * instead of a stain in the shape of one. */
           /* The luminance follow is damped as well. Tying moss brightness to
            * the stone under it keeps a colony sitting in shadow from glowing,
            * but at 1.55 the multiplier ran the other way on anything sunlit
            * and turned the moss into a saturated green far brighter than any
            * plant in the scene. Moss is a dark, matt olive; it is one of the
            * least luminous things in a forest. */
           alb = mix(alb, uMoss * (0.58 + 0.98 * lum) * (0.66 + 0.72 * gCush),
                     gMoss * 0.86);

           /* The last hand's width before the soil. Splash, silt and algae,
            * and it is the term that stops the meeting of stone and litter
            * being a line where two materials abut. */
           alb = mix(alb, alb * vec3(0.52, 0.50, 0.42), vStone.w * 0.62);

           /* Wet stone is darker stone, and it has to be, because roughness
            * alone only produces a highlight where a light happens to reflect
            * — under this canopy that is almost nowhere, and the wings would
            * have gone glossy without going wet. Held to a modest factor and
            * gated on gWet, so it costs the dry two thirds of the complex
            * nothing and does not compound with the burial multiply above
            * anywhere except at a wall foot that is genuinely in the spray. */
           alb *= mix(1.0, 0.74, gWet * 0.80);

           /* The waterline, painted in the order the stone acquired it.
            *
            * Algae first, because it is under everything else and it is the
            * darkest: a green-black film on any surface that never dries.
            * Then the stain at the line, which is not green but a saturated
            * dark mineral band — the residue of everything the water has
            * carried past this stone. Then the calcite above it, pale and
            * chalky and *lighter* than the block, deposited where spray
            * evaporates rather than runs off. The three together are the
            * reason a real ruin standing in water reads as having been there
            * for centuries instead of having been placed this morning. */
           /* The weights, raised. Every one of these was a fraction of a
            * fraction: near had already taken a third out before they ran (see
            * uWaterR), and then the stain — the band that carries the whole
            * read — asked for 85 per cent of a 70 per cent darkening, on a
            * Gaussian whose peak is one and whose useful width is a few
            * centimetres. Integrated over the band that is a couple of per cent
            * of luminance, which is below the noise the stone's own macro
            * variation already has in it. The instruction was to raise the
            * contrast substantially or drop the feature; this is the raise.
            *
            * The stain goes to a quarter of the block's value rather than a
            * third and takes the full weight, and the calcite above it goes to
            * two thirds with the macro gate relaxed — that band is what puts a
            * *pale* course above a *dark* one, and a light-over-dark pair is
            * legible at four times the distance either is alone. */
           /* Second raise, and this one removes a gate rather than turning a
            * number up.
            *
            * The calcite band is the only one of the three with real coverage —
            * a metre and a bit of stone above the line, against a stain a hand
            * deep and an algal film that is almost entirely under water and so
            * almost never drawn. It was multiplied by a threshold on the
            * block's own macro variation, which cut the one legible band into
            * patches at the scale of the noise and left the average unchanged.
            * That is why raising the weights the first time did not show: the
            * contrast was going into a field that already had that much
            * contrast in it. The macro term stays as a modulation, so the band
            * is not a flat decal, but it can no longer erase it. */
           alb = mix(alb, uAlgae * (0.7 + 0.9 * gMacro.y), gSub * 0.95);
           alb = mix(alb, alb * 0.12, gLine);
           alb = mix(alb, uCalcite,
                     gSplash * 0.88 * (0.55 + 0.45 * gMacro.x) * (1.0 - gMoss));
           // Moss takes the joints on the side that gets the spray, and only
           // there: it is the wettest stone in the complex.
           alb = mix(alb, uMoss * 0.9, gSplash * gMask.r * 0.55);

           /* Cavity occlusion from the bake, applied to albedo. The gap
            * between two chamfered blocks is a few centimetres deep and sees
            * almost no sky, and without this the joints disappear entirely
            * under an ambient-dominated light. Kept off full strength: under a
            * closed canopy this is nearly all the light a vertical face gets,
            * and there is a second occlusion multiply below. */
           alb *= mix(1.0, pow(clamp(vStone.x, 0.0, 1.0), 1.2), 0.48);
           alb *= pow(clamp(gAO, 0.0, 1.0), 1.0);

           diffuseColor.rgb *= alb;

           gDbg = uDebug < 1.5 ? vec3(gMoss, gLichen, gStain)
                : uDebug < 2.5 ? alb
                : uDebug < 3.5 ? vec3(vStone.x)
                : uDebug < 4.5 ? vec3(vStone.y, vStone.z, vStone.w)
                : uDebug < 5.5 ? gMacro
                : uDebug < 6.5 ? vec3(gMask.rg, gWall)
                // The three waterline bands, which were raised without ever
                // being measured. "The banding is not readable" has two causes
                // — the bands are weak, or they are not being computed on the
                // stone the camera can see — and only an image of the masks
                // separates them.
                : uDebug < 7.5 ? vec3(gWet, gExpo, gCush)
                : vec3(gSub, gLine, gSplash);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* Built by hand rather than through three's derivative tangent
           * frame, which needs a uv that means something and this geometry has
           * none. Both projections get an explicit world-space basis whose two
           * axes are the axes the sample was taken along, so the green channel
           * points the same way on a face looking east and one looking west —
           * cross products alone flip it on half of them, and a normal map
           * whose relief inverts across a corner is worse than no normal map. */
          `vec3 mapN = biStone(tStoneN) * 2.0 - 1.0;
           mapN.xy *= normalScale;
           /* Moss relief, and the previous version of these two lines had the
            * sign of the whole idea wrong.
            *
            * It damped the stone's normal under moss, on the reasoning that a
            * few millimetres of pile fills the aggregate it grows over. That
            * much is true, but damping and replacing nothing leaves the
            * mossed area *smoother than the stone around it* — so the one
            * part of the surface that should be the most broken became the
            * flattest, took light like a painted panel, and earned exactly
            * the verdict it got. This is the bark lesson restated: a term
            * that only changes colour reads as pigment, and what sells
            * organic growth is that it breaks the structure underneath.
            *
            * So the aggregate is still suppressed — the cushion does bury it
            * — but a coarser relief is substituted at the cushion's own
            * scale and at greater amplitude than the stone ever had. Under
            * full moss the surface is lumpier than bare stone, not smoother,
            * and because the lumps come from the same field that shades the
            * colony the lit tops and shaded bases line up. */
           vec3 mossN = biMoss(tStoneN) * 2.0 - 1.0;
           mapN.xy = mix(mapN.xy, mapN.xy * 0.40 + mossN.xy * 1.45, gMoss);
           {
             vec3 nW = normalize(vWNrmS);
             vec3 tF = vec3(1.0, 0.0, 0.0) - nW * nW.x;
             tF = tF / max(1e-4, length(tF));
             vec3 bF = vec3(0.0, 0.0, 1.0) - nW * nW.z - tF * dot(vec3(0.0, 0.0, 1.0), tF);
             bF = bF / max(1e-4, length(bF));
             vec3 aW = (abs(nW.x) > abs(nW.z)) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
             vec3 tW = aW - nW * dot(aW, nW);
             tW = tW / max(1e-4, length(tW));
             vec3 bW = vec3(0.0, 1.0, 0.0) - nW * nW.y;
             bW = bW - tW * dot(bW, tW);
             bW = bW / max(1e-4, length(bW));
             vec3 nA = normalize(tF * mapN.x + bF * mapN.y + nW * mapN.z);
             vec3 nB = normalize(tW * mapN.x + bW * mapN.y + nW * mapN.z);
             normal = normalize(mat3(viewMatrix) * normalize(mix(nA, nB, gWall)));
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness * gRough;
           roughnessFactor = mix(roughnessFactor, 0.98, gMoss * 0.85);
           roughnessFactor = mix(roughnessFactor, 0.93, gLichen * 0.55);
           /* Wet stone is the smoothest surface in this scene and it is the
            * only place the ruins get a highlight, which is most of what says
            * the air here is saturated. Not a mirror, though: what a wet block
            * in a clearing reflects is a wall of leaves. */
           /* Driven by gWet, which is the terrain's baked wetness or the spray
            * from the falls, whichever is greater. Near the plunge this takes
            * the wings well down the roughness range, which is the point:
            * masonry a few metres from falling water is glossy and the fact
            * that the gloss fades out with distance is most of what tells the
            * viewer how big the fall is. */
           roughnessFactor = mix(roughnessFactor, 0.42, gWet * 0.62 * (1.0 - gMoss));
           roughnessFactor = mix(roughnessFactor, 0.55, gStain * 0.35);
           // Algal film is a wet skin and the glossiest thing on the ruin;
           // calcite is chalk and is the flattest. Both have to be able to
           // pass the floor below or neither reads.
           roughnessFactor = mix(roughnessFactor, 0.18, gSub * 0.85);
           roughnessFactor = mix(roughnessFactor, 0.88, gSplash * 0.30);
           roughnessFactor = max(roughnessFactor, mix(0.34, 0.15, gSub));`
        )
        .replace(
          '#include <aomap_fragment>',
          `/* Specular occlusion, which three only performs when an aoMap is
            * bound and this material's occlusion arrives per vertex instead. A
            * joint two blocks deep cannot return a sky reflection, and letting
            * it do so puts a sheen into the darkest place in the frame. */
           float sao = pow(clamp(vStone.x, 0.0, 1.0), 1.2) * pow(clamp(gAO, 0.0, 1.0), 0.8);
           reflectedLight.indirectSpecular *= sao;
           reflectedLight.directSpecular *= mix(0.55, 1.0, sao);`
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
           if (uDebug > 0.5) gl_FragColor = vec4(gDbg, 1.0);`
        );
  };
  mat.customProgramCacheKey = () => 'ruin-stone-v1';
  mat.userData.maps = { stone, mask, macro };
  /* The uniform block, reachable before the first compile. `userData.shader`
   * only exists once three has actually built a program for this material, and
   * the material's chunks are distance-culled, so from the capture harness —
   * which sets a uniform, then poses the camera, then renders — it is reliably
   * undefined at the moment it is needed. Half an hour went into "the debug
   * view does nothing" before that was the answer. */
  mat.userData.uniforms = U;
  return mat;
}
