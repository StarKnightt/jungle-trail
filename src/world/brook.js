/* The brook: the channel, the water in it, and where the basin drains to.
 *
 * This file exists because of a class of bug that is invisible in the code and
 * fatal in the render. The stream used to be authored twice — terrain.js cut a
 * groove of a fixed depth *below the surrounding ground*, and water.js laid a
 * surface at a fixed depth *below the trail's tread* — and the two references
 * are not the same surface. The trail is the lowest line across the corridor
 * by construction; the channel runs eight to sixteen metres out on the
 * shoulder, which is one to two and a half metres higher. So the water sat
 * that much below its own bed for nearly the whole of its length, was clipped
 * away by the depth test in the surface shader, and the level shipped with two
 * hundred metres of river that was submitted every frame and never drew a
 * pixel. The dry gully was still there, which is what made it look intentional.
 *
 * The fix is not a constant: it is to have one authority for the *water
 * surface* and derive both the bed and the mesh from it. Three properties are
 * enforced here and nowhere else:
 *
 *  1. It descends. A water surface that runs uphill is the one thing a stream
 *     may never do, and the ground it is lying on rolls by ±1.7 m at a
 *     wavelength of about fifty metres — far more than the 2 cm/m the valley
 *     itself falls. Taking a running minimum of the trail profile is what
 *     turns that roll into hydrology instead of into an error: where the
 *     ground rises the surface holds level and the channel simply cuts deeper,
 *     which is exactly what an incised stream does to a hump in its path.
 *
 *  2. It descends in *steps*. Quantising the profile to 22 cm and spending
 *     each drop over a short run gives a step-pool sequence — flat glides with
 *     a small fall between them — which is the form every small stream on a
 *     moderate grade takes. It is also the only cheap way to get white water:
 *     foam needs somewhere to be made, and a uniformly sloping ribbon has no
 *     such place.
 *
 *  3. It stays below the tread. The channel comes within four and a half
 *     metres of the path at its closest, and the walk to the falls must not
 *     ford anything.
 *
 * The bed is then the surface minus a depth, and terrain.js cuts *to* that bed
 * rather than subtracting from whatever was there. The channel is therefore
 * guaranteed to be a channel: the water cannot be above its banks and cannot
 * be under its floor, in either case regardless of what the height noise does.
 *
 * Nothing here imports three or the terrain. It is fed the trail geometry as
 * plain numbers so that the audio's offline renderer, which runs in Node, can
 * read the same centreline the render does.
 */

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Where the ground has dropped enough to collect water, and where it ends. */
export const BROOK_T0 = 0.40;
/* Where the channel is given up to the basin. Beyond about 0.93 the trail has
 * run past the pool and the offset curve carries the centreline back out onto
 * the apron south of it — so a channel authored any further downstream ends on
 * high ground with the water still in it, which is the same class of error as
 * the one this file exists to fix, only at the other end. */
export const BROOK_T1 = 0.930;

/* The lateral offset of the channel from the trail centre, negative being the
 * walker's left — which after the tangent rotation puts the water on the east
 * side of the path for the whole of the second half of the walk.
 *
 * The amplitudes are smaller than they were and the mean is larger, for one
 * reason: the old curve closed to 1.5 m at t = 0.78, which is inside the
 * trail's own tread. That was survivable while the water was a decorative
 * ribbon and is not survivable now that the channel is genuinely cut to a bed
 * a metre below the path — the near bank would have taken the footpath with
 * it. The closest approach is now 4.45 m, which still brings the stream within
 * arm's reach of the walk at one point without undercutting it.
 *
 * audio/score.js imports this rather than keeping a copy: the babble's panner
 * slides along this curve, and a sound coming from the wrong side of the path
 * is more noticeable than almost anything in the mix.
 */
export function brookOffset(t) {
  return -(9.6 + 3.6 * Math.sin(t * 13.0 + 1.0) + 2.4 * Math.sin(t * 5.0));
}

/* One step of the step-pool sequence. Chosen at the top of the range where a
 * drop still reads as a riffle rather than as a waterfall: much under 15 cm
 * and the white water is a texture rather than an event, much over 30 and the
 * pools between them have to be deep enough to look like ponds. */
const STEP_Q = 0.22;

/* Clearance from the water surface to the tread, and from the surface to the
 * bed in a glide. The first is what keeps the walk dry; the second is what
 * makes the stream read as water rather than as a wet stain, because the
 * depth-driven alpha in the surface material needs something to work with. */
const FREEBOARD = 1.05;
const MIN_TREAD_GAP = 0.70;
const GLIDE_DEPTH = 0.30;

/* Height of the cut bank above the bed, and how far out it takes to get
 * there. 1.8 m over 2.1 m is a little steeper than the material would stand
 * unvegetated, which is right for a bank a stream is actively cutting. */
const BANK_H = 1.80;
const BANK_RUN = 2.10;
const BANK_FEATHER = 3.40;

export class Brook {
  /**
   * @param {(t:number) => {py:number, px:number, pz:number, tx:number,
   *                        tz:number, hw:number}} sample
   *   The trail at t: its elevation, its position, its unit tangent and its
   *   half-width. Supplied by the caller because the trail owns all four and
   *   this file is deliberately dependency-free.
   * @param {number} poolY surface of the plunge basin, which the last of the
   *   channel is drowned by.
   */
  constructor(sample, poolY) {
    const N = 240;
    this.N = N;
    this.poolY = poolY;
    const st = new Array(N + 1);

    for (let i = 0; i <= N; i++) {
      const t = BROOK_T0 + (BROOK_T1 - BROOK_T0) * i / N;
      const s = sample(t);
      const off = brookOffset(t);
      /* Half-width of the wetted channel. Two incommensurate sines so the
       * stream pinches and opens the way a real one does between its bars;
       * the mean is deliberately small, because the first build ran a
       * fourteen-metre-wide sheet down a jungle hillside and called it a
       * brook. */
      let half = 1.02 + 0.40 * Math.sin(t * 23.0 + 0.7) + 0.26 * Math.sin(t * 8.0);
      // Opening into a delta where it meets the basin.
      half += 1.7 * smoothstep(0.895, BROOK_T1, t);
      st[i] = {
        t, off, half,
        cx: s.px + s.tz * off,
        cz: s.pz - s.tx * off,
        tx: s.tx, tz: s.tz, py: s.py, hw: s.hw,
      };
    }

    /* The monotone envelope, then the steps.
     *
     * The running minimum is the whole of property 1: it can only ever fall,
     * so the profile derived from it can only ever fall, whatever the ground
     * does. The quantisation is property 2, and it is applied to the envelope
     * rather than to the raw profile so that the steps land where the valley
     * genuinely loses height and the flat reaches land on the humps.
     */
    let m = Infinity;
    for (const s of st) {
      m = Math.min(m, s.py - FREEBOARD);
      s.mono = m;
    }
    for (const s of st) {
      const u = s.mono / STEP_Q;
      const k = Math.floor(u);
      const f = u - k;
      // Flat for the first third of each interval, then the drop.
      s.y = STEP_Q * (k + smoothstep(0.30, 0.82, f));
      // The clamp can only ever push it further down, but it can break the
      // monotonicity the envelope guaranteed, so that is restored below.
      s.y = Math.min(s.y, s.py - MIN_TREAD_GAP);
    }
    for (let i = 1; i <= N; i++) st[i].y = Math.min(st[i].y, st[i - 1].y);

    /* Grade, and everything that reads off it. Speed and foam are both
     * functions of how fast the surface is losing height, which after the
     * quantisation above means the glides are slow and green and every step
     * is a short white one. */
    for (let i = 0; i <= N; i++) {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(N, i + 1)];
      const run = Math.max(0.5, Math.hypot(b.cx - a.cx, b.cz - a.cz));
      const grade = Math.max(0, (a.y - b.y) / run);
      st[i].grade = grade;
      st[i].speed = Math.max(0.35, Math.min(3.2, 0.45 + 20.0 * grade));
      st[i].agit = Math.min(0.9, 0.05 + 0.85 * smoothstep(0.025, 0.115, grade));
      /* Deeper directly below a step, because that is where the falling water
       * digs. A plunge pool at this scale is 20 cm across and the reason to
       * have it is that it is the only dark water in the stream, and a
       * riffle with no dark water in it is a white rope. */
      st[i].bed = st[i].y - (GLIDE_DEPTH + 1.1 * grade);
    }

    /* Drowned at the tail. Everything below the basin's surface is backwater —
     * still, deep and dark — and it has to be at exactly the basin's level or
     * there is a step in the water where the two meet. Taking the max cannot
     * break the monotonicity because the pool level is a constant. */
    for (const s of st) {
      if (s.y < poolY) { s.y = poolY; s.speed = Math.min(s.speed, 0.5); s.agit *= 0.3; }
    }

    this.st = st;
    /* The stretch the mesh is allowed to cover. The carve fades in and out at
     * the two ends so that it does not leave a scarp where it stops, which
     * means the first and last few stations have a channel that is only
     * partly cut and a water surface that is therefore partly above the
     * ground. Drawing them is the same "river inside a hillside" artefact
     * this file was written to remove, at 1/20 of the length. */
    this.i0 = Math.ceil(0.055 / (BROOK_T1 - BROOK_T0) * N);
    this.i1 = N;
  }

  /** Interpolated station at trail parameter t. */
  at(t, out = {}) {
    const f = Math.max(0, Math.min(1, (t - BROOK_T0) / (BROOK_T1 - BROOK_T0))) * this.N;
    const i = Math.min(this.N - 1, Math.floor(f));
    const k = f - i;
    const a = this.st[i], b = this.st[i + 1];
    out.off = a.off + (b.off - a.off) * k;
    out.half = a.half + (b.half - a.half) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.bed = a.bed + (b.bed - a.bed) * k;
    return out;
  }

  /**
   * Cut the channel into a raw terrain height.
   *
   * Expressed as a move *toward* an authored bed rather than as a subtraction,
   * for the same reason spillwayCut is: a relative cut inherits every bump of
   * the noise it is cutting into, and a bed that inherits bumps is a bed the
   * water surface intersects. Only ever lowers ground.
   */
  cut(h, q, hw) {
    const t = q.t;
    if (t <= BROOK_T0 || t >= BROOK_T1 + 0.012) return h;
    const a = this.at(t, this._tmp || (this._tmp = {}));
    const d = Math.abs(q.side - a.off);
    /* The floor is flat out past the wetted edge, so the waterline lands on
     * level ground rather than on the toe of the bank. A shoreline that sits
     * on a slope is a shoreline whose position moves by a metre for every
     * centimetre the terrain's bilinear sample is out. */
    const inner = a.half + 0.55;
    if (d > inner + BANK_FEATHER) return h;
    const f = a.bed + BANK_H * smoothstep(inner, inner + BANK_RUN, d);
    if (f >= h) return h;
    let m = smoothstep(inner + BANK_FEATHER, inner + BANK_RUN * 0.9, d);
    m *= smoothstep(BROOK_T0, BROOK_T0 + 0.05, t)
       * smoothstep(BROOK_T1 + 0.012, BROOK_T1 - 0.035, t);
    // The path is never cut into, however close the channel swings to it.
    m *= smoothstep(hw * 0.9, hw + 1.7, q.dist);
    return h + (f - h) * m;
  }

  /** Depth of water over a point of ground, 0 if it is dry. */
  depthAt(h, q) {
    const t = q.t;
    if (t <= BROOK_T0 || t >= BROOK_T1) return 0;
    const a = this.at(t, this._tmp2 || (this._tmp2 = {}));
    if (Math.abs(q.side - a.off) > a.half) return 0;
    return Math.max(0, a.y - h);
  }

  /** 0..1 wetted-margin field, for the terrain's wetness channel. */
  wetAt(q) {
    const t = q.t;
    if (t <= BROOK_T0 - 0.02 || t >= BROOK_T1 + 0.02) return 0;
    const a = this.at(t, this._tmp3 || (this._tmp3 = {}));
    return smoothstep(a.half + 2.6, a.half + 0.2, Math.abs(q.side - a.off))
         * smoothstep(BROOK_T0, BROOK_T0 + 0.06, t);
  }
}

/* ── where the basin drains ────────────────────────────────────────────────
 *
 * It does not drain overland, and that is a fact about the terrain rather than
 * a decision. Measured cols out of the clearing, in metres above the pool's
 * surface: 1.3 due north, which is the trail and not available; 2.0
 * north-east, which is the brook's own gully and would have the outflow
 * running up the inflow; 2.5 to 4.2 everywhere else. The west rim, the obvious
 * place for a gutter, is solid masonry from x = -2 to x = -20 — the platform
 * the ruins put there — and trenching a channel under it would leave the
 * blocks standing on air.
 *
 * So the water leaves the way water leaves a closed basin in limestone, which
 * is what this whole cliff is made of: it goes down a swallow hole. A notch
 * cut through the rim at the south-east shoulder, a funnel of bare rock, and a
 * slot running away under an overhang. It costs three metres of terrain
 * instead of forty, it cannot conflict with anything already built, and it
 * puts the answer in the same frame as the question — from the causeway you
 * see the fall arriving on the left and the water going down the drain on the
 * right.
 *
 * The visible mechanics matter more than the hole: a drawdown dimple in the
 * surface, the flow field bending into it from half the basin, and the foam
 * the fall makes being carried round and swallowed. Without those it is a dark
 * patch at the water's edge; with them it is unmistakably where the water is
 * going.
 */
export const SWALLOW = { x: 11.2, z: -361.2, r: 2.7, depth: 2.8 };

/** Bed height inside the swallow, or Infinity outside it. */
export function swallowBed(x, z, poolY) {
  const d = Math.hypot(x - SWALLOW.x, z - SWALLOW.z);
  if (d > SWALLOW.r + 2.2) return Infinity;
  /* A funnel, and then a slot leaving it to the east under the rock. The slot
   * is dry geometry — nothing draws water down there — and its whole job is
   * that the hole is visibly a passage rather than a pit. */
  const f = poolY - SWALLOW.depth * Math.pow(
    Math.max(0, 1 - d / (SWALLOW.r + 0.4)), 0.7);
  const sx = x - SWALLOW.x, sz = z - SWALLOW.z;
  const along = sx * 0.94 + sz * 0.34;
  const across = Math.abs(-sx * 0.34 + sz * 0.94);
  const slot = (along > 0 && across < 0.9)
    ? poolY - SWALLOW.depth - 0.5 * smoothstep(0, 3.0, along)
      + 1.4 * smoothstep(0.55, 0.95, across)
    : Infinity;
  return Math.min(f, slot);
}

/** Cut the swallow. Same contract as Brook.cut: only ever lowers ground. */
export function swallowCut(x, z, h, poolY) {
  const f = swallowBed(x, z, poolY);
  return f < h ? f : h;
}

/** Depth of water over a point of ground inside the swallow, 0 if dry. */
export function sinkDepth(x, z, h, poolY = 0.05) {
  const d = Math.hypot(x - SWALLOW.x, z - SWALLOW.z);
  if (d > SWALLOW.r) return 0;
  return Math.max(0, poolY - h);
}

/** 0..1 wetted margin around the swallow, for the terrain's wetness channel. */
export function sinkWet(x, z) {
  const d = Math.hypot(x - SWALLOW.x, z - SWALLOW.z);
  return smoothstep(SWALLOW.r + 3.4, SWALLOW.r, d);
}

/* The drawdown, in metres of surface lowering. Small — a real drawdown over a
 * swallow this size is a few centimetres — but the surface is otherwise dead
 * flat over the whole basin and the eye needs some evidence that the water is
 * moving toward something. */
export function swallowDip(x, z) {
  const d = Math.hypot(x - SWALLOW.x, z - SWALLOW.z) / (SWALLOW.r * 0.85);
  return 0.34 * Math.exp(-d * d * 1.6);
}
