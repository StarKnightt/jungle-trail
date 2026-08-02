/* Terrain.
 *
 * A single heightfield covering the whole corridor, chunked into meshes and
 * drawn with one splat material. Three things about the shape are deliberate:
 *
 *  - The trail is cut into the ground, not laid on top of it. Real footpaths
 *    are the lowest line across the terrain because that is where the water and
 *    the feet both go, and the ground rises away from them on both sides. A
 *    path drawn as a stripe on flat ground reads as a texture; a path you are
 *    walking *in* reads as a place.
 *  - The valley walls are ridged noise, not fbm. Erosion makes creases and
 *    spurs; fbm only makes lumps.
 *  - Detail below about 1.5 m is left entirely to the normal maps. Putting it
 *    in the mesh would multiply the vertex count for something that is only
 *    ever seen from standing height, where a normal map is indistinguishable.
 */
import * as THREE from 'three';
import { Noise2D, clamp, smoothstep, lerp } from './noise.js';
import { CLIFF_Z } from './path.js';
import { DIRT, LITTER, ROCK, MACRO } from './groundTex.js';
import { bakeSurface } from '../gfx/bake.js';
import { SSTEP } from '../gfx/glsl.js';
import {
  POOL, POOL_Y, causeway, spillwayCut, spillwayWet, runLevel, poolBed, chuteWet,
  standingWater,
} from './spillway.js';
import { Brook, swallowCut, sinkWet } from './brook.js';

export const BOUNDS = { x0: -84, x1: 96, z0: 40, z1: -452 };
export const STEP = 0.5;
const CHUNK = 48;                 // cells per chunk edge → 24 m

export const CLEARING_Y = 0.6;    // floor of the ruins clearing
/* The plunge pool's surface and plan live in world/spillway.js now, because
 * the water meshes have to agree with them to the centimetre and a second
 * copy that drifts by ten centimetres is a river running inside a rock.
 * Re-exported here so nothing that already knew where to look has to move. */
export { POOL, POOL_Y };

/* Resolution of the precomputed trail distance field, in metres.
 *
 * Asking the trail for its nearest point once per terrain vertex is ~350k
 * queries and takes seconds. A distance field is very close to linear away
 * from its source, so sampling it on a 1 m lattice and interpolating is
 * visually identical for a twentieth of the work — and it is done once at
 * boot, so the error that matters is the one you can see, not the one in the
 * third decimal place.
 */
const FIELD_STEP = 1.0;

// Scratch for the brook's trail sampler, which runs a few hundred times at
// boot and has no business allocating.
const _bp = new THREE.Vector3();
const _bt = new THREE.Vector3();

export class Terrain {
  /**
   * @param {import('./path.js').Trail} trail
   * @param {number} seed
   * @param {import('./ruins.js').RuinPlan} [plan] the ruins, in plan only.
   *   The heightfield has to know about them because a temple is not an object
   *   standing on the ground, it is ground that was rebuilt — a levelled
   *   terrace, an earthwork under it, and a spoil bank along every wall. Doing
   *   it here rather than by sinking the blocks afterwards is the difference
   *   between masonry that is buried in its own bank and masonry that has been
   *   pushed into a hillside.
   */
  constructor(trail, seed = 20260801, plan = null) {
    this.trail = trail;
    this.plan = plan;
    this.n = new Noise2D(seed);
    this.nb = new Noise2D(seed ^ 0x9e3779b9);

    this.step = STEP;
    this.x0 = BOUNDS.x0; this.z0 = BOUNDS.z0;
    this.W = Math.round((BOUNDS.x1 - BOUNDS.x0) / STEP) + 1;
    this.H = Math.round((BOUNDS.z0 - BOUNDS.z1) / STEP) + 1;

    this._buildPathProfile();
    this._buildField();
    /* Before the heights, because the heights are cut to it. The brook owns
     * the one profile that the channel, the water surface and the audio's
     * panner all have to agree on; it is built from the trail's elevation
     * rather than from the ground, because the ground is what it is carving.
     * See world/brook.js for why a stream authored the other way round spent
     * the whole of its length underneath its own bed. */
    this.brook = new Brook((t) => {
      const p = this.trail.pointAt(t, _bp);
      const tan = this.trail.tangentAt(t, _bt);
      return {
        py: this._pathYAt(t), px: p.x, pz: p.z,
        tx: tan.x, tz: tan.z, hw: this.trail.widthAt(t),
      };
    }, POOL_Y);
    this._buildHeights();

    this.group = new THREE.Group();
    this.group.name = 'terrain';
  }

  /* Elevation of the trail itself, per trail sample.
   *
   * Generated then smoothed, rather than authored smooth in the first place:
   * the noise gives it the small rises and dips that make a walk feel like it
   * is going somewhere, and the smoothing passes guarantee no grade steep
   * enough to look like a ramp. A real trail is graded by use — anything too
   * steep gets walked around until it isn't the trail any more.
   */
  _buildPathProfile() {
    const S = this.trail.samples;
    const y = new Float32Array(S.length);
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      // Net descent of ~8 m from trailhead to the pool.
      const grade = lerp(8.4, CLEARING_Y, smoothstep(0.0, 0.88, s.t));
      const roll = 1.7 * this.n.fbm(s.x * 0.02, s.z * 0.02, 3, 0.5);
      const flat = this.trail.clearing(s.t);
      y[i] = lerp(grade + roll, CLEARING_Y, flat);
    }
    for (let pass = 0; pass < 24; pass++) {
      for (let i = 1; i < y.length - 1; i++) y[i] = (y[i - 1] + y[i] * 2 + y[i + 1]) * 0.25;
    }
    this.pathY = y;
  }

  _pathYAt(t) {
    const f = clamp(t, 0, 1) * (this.pathY.length - 1);
    const i = Math.min(this.pathY.length - 2, Math.floor(f));
    return lerp(this.pathY[i], this.pathY[i + 1], f - i);
  }

  /** Precompute distance / arc-length / signed side on a 1 m lattice. */
  _buildField() {
    const fw = Math.ceil((BOUNDS.x1 - BOUNDS.x0) / FIELD_STEP) + 2;
    const fh = Math.ceil((BOUNDS.z0 - BOUNDS.z1) / FIELD_STEP) + 2;
    const dist = new Float32Array(fw * fh);
    const tt = new Float32Array(fw * fh);
    const side = new Float32Array(fw * fh);
    const q = {};
    for (let j = 0; j < fh; j++) {
      const z = BOUNDS.z0 - j * FIELD_STEP;
      for (let i = 0; i < fw; i++) {
        const x = BOUNDS.x0 + i * FIELD_STEP;
        this.trail.nearest(x, z, q);
        const k = j * fw + i;
        dist[k] = q.dist; tt[k] = q.t; side[k] = q.side;
      }
    }
    this.field = { fw, fh, dist, t: tt, side };
  }

  /** Bilinear sample of the trail field. Writes into `out` to avoid garbage. */
  sampleField(x, z, out = {}) {
    const f = this.field;
    let u = (x - BOUNDS.x0) / FIELD_STEP;
    let v = (BOUNDS.z0 - z) / FIELD_STEP;
    u = clamp(u, 0, f.fw - 1.001); v = clamp(v, 0, f.fh - 1.001);
    const i = u | 0, j = v | 0, fx = u - i, fy = v - j;
    const k00 = j * f.fw + i, k10 = k00 + 1, k01 = k00 + f.fw, k11 = k01 + 1;
    const bl = (a) => lerp(lerp(a[k00], a[k10], fx), lerp(a[k01], a[k11], fx), fy);
    out.dist = bl(f.dist); out.t = bl(f.t); out.side = bl(f.side);
    return out;
  }

  /** Height of the raw terrain at a world position, before any mesh exists. */
  evalHeight(x, z, q = {}) {
    this.sampleField(x, z, q);
    const t = q.t, d = q.dist;
    const py = this._pathYAt(t);
    const hw = this.trail.widthAt(t);
    const n = this.n, nb = this.nb;

    /* Ground away from the trail.
     *
     * The shoulders rise fast and then stop. A gully in rainforest is an
     * intimate space — the banks are close enough to touch and only a few
     * metres high, and what you see beyond them is the next tree, not a
     * skyline. An earlier version used a 26 m falloff and 14 m of relief and
     * read as open dune country, because at that scale the eye interprets the
     * valley as landscape rather than as the sides of a ditch.
     */
    const away = smoothstep(hw + 0.4, hw + 9, d);
    const ridge = nb.ridged(x * 0.030, z * 0.030, 5, 0.52) * 0.5 + 0.5;
    const shoulder = away * (0.55 + 1.9 * ridge);
    const macro = smoothstep(hw, hw + 8, d) * 1.9 * n.fbm(x * 0.016, z * 0.016, 4, 0.5);

    /* Two detail bands, and where the third one went.
     *
     * There used to be a band at 0.62 — a 1.6 m period on a 0.5 m grid, so
     * three vertices to a bump. Nothing that fine survives sampling as a
     * shape; what it actually produced was a field of hard little facets,
     * each one flat enough to return a clean highlight, and under a low sun
     * the floor came back covered in pale blobs that no amount of work on the
     * albedo could explain or hide. The tell that it was geometry and not the
     * material was that the blobs vanished entirely under a pure hemisphere
     * light and reappeared with either the sun or the environment: they were
     * never a texture, they were the mesh catching the light.
     *
     * Everything under about two metres is the normal maps' job, which is
     * what the note at the top of this file always said it was.
     */
    const detail = 0.62 * n.fbm(x * 0.075, z * 0.075, 4, 0.5)
                 + 0.26 * nb.fbm(x * 0.19, z * 0.19, 3, 0.5);

    /* Erosion creases.
     *
     * Plain fbm at any number of octaves only ever produces rounded lumps,
     * and rounded lumps at every scale is exactly what makes procedural
     * terrain read as procedural. Ground that water has run over has
     * *creases* — narrow, sharp-bottomed, branching. Squaring the positive
     * lobe of ridged noise and subtracting it cuts channels with steep sides
     * and leaves the ground between them alone, which is the asymmetry
     * between a valley and a hill that erosion actually creates.
     */
    const rill = Math.max(0, nb.ridged(x * 0.105, z * 0.105, 3, 0.55));
    const crease = -0.42 * rill * rill;

    /* Surface roots. Rainforest soil is shallow, so the big trees plate their
     * roots out across the top of it instead of going down, and the ground is
     * corrugated by them for metres around every trunk. Ridged noise again,
     * this time keeping the ridge rather than the channel. */
    /* One band, at a 3.8 m period. The second one sat at 1.4 m, which is the
     * same Nyquist problem as the detail band above and was the larger half
     * of the faceting: a sharpened ridge is worse than fbm at that scale,
     * because the exponent makes its crest narrower than the grid can hold. */
    const rootPlate = 0.44 * Math.pow(Math.max(0, n.ridged(x * 0.26, z * 0.26, 2, 0.5)), 1.6);

    const wild = py + shoulder + macro + detail + crease + rootPlate;

    // The trail surface: worn concave, softened toward the verges. The dish is
    // shallow but it is what makes the path hold the light differently from
    // the ground beside it, which is how you read a trail from a distance.
    const cross = clamp(Math.abs(q.side) / Math.max(0.3, hw), 0, 1);
    const dish = -0.13 * (1 - cross * cross);
    /* Roots do not stop at the edge of the path — they cross it, and getting
     * tripped by them is most of what walking a jungle trail is. They survive
     * at reduced amplitude where the ground is compacted, and they are the
     * main thing breaking up the trail's silhouette. */
    const trailSurf = py + dish + detail * 0.16 + rootPlate * 0.62;

    let h = lerp(trailSurf, wild, smoothstep(hw * 0.75, hw + 2.2, d));

    /* Stream channel. Cut *to* the bed world/brook.js authored rather than
     * subtracted from whatever the noise left here — see that file for why
     * the difference is the whole of the bug where the river rendered
     * nothing. It is the same expression the water mesh and the audio panner
     * read, so the three cannot drift apart. */
    h = this.brook.cut(h, q, hw);

    /* The ruins reshape the ground, and they do it after the stream and before
     * the pool. After the stream because one of the things the plan restores
     * is the causeway that carried the approach over the channel, and a fill
     * that ran before the cut would simply be cut again; before the pool
     * because the pool is the one piece of this clearing that was never built
     * and has to keep its own shape. */
    if (this.plan) h = this.plan.shapeGround(x, z, h, hw, q);

    /* The channel is cut a second time over the last dozen metres before the
     * basin, and only there. The ruins' terrace runs out across the stream's
     * approach and buries it by up to 1.4 m — which is correct where the plan
     * restores the causeway that carried the approach *over* the water, and is
     * simply a dam everywhere else. The window is south of the causeway's
     * masonry (which stands from z = -338 to -341) and north of the basin,
     * which is the stretch where the terrace is bare earthwork and where a
     * stream would have re-incised its channel through it in the centuries
     * since anyone maintained the place. */
    if (z < -342.5 && z > -354 && t > 0.855) h = this.brook.cut(h, q, hw);

    /* The causeway.
     *
     * Every excavation below is multiplied by this, which leaves a bar of
     * untouched ground along the tread wherever the water would otherwise be
     * over it — see world/spillway.js for why that is the only workable
     * answer here. It fades in over the last few metres of trail: south of
     * z = -382 there is no path to protect, and holding the guard on down
     * there would leave a dry hump standing in the middle of the rapids.
     */
    const guard = 1 - (1 - causeway(d)) * smoothstep(-382, -377, z);

    /* Plunge pool. An absolute bed with a steep rim, not a bowl subtracted
     * from the ground: see poolBed() for why the difference is the difference
     * between a basin and a damp patch. */
    const bed = poolBed(x, z);
    if (bed < h) h += (bed - h) * guard;

    /* And the way the water gets out again. The basin is a closed hollow —
     * every col out of it is metres above the surface and the west rim is
     * under the ruins' platform — so it drains the way a closed basin in
     * limestone does, down a swallow hole notched through the south-east
     * shoulder. See world/brook.js. */
    h = swallowCut(x, z, h, POOL_Y);

    // Cliff. Rises out of the clearing floor behind the pool. The spillway
    // notch is a local drop in the *top* edge, so the water has somewhere to
    // come from rather than appearing out of a flat wall.
    const cl = smoothstep(CLIFF_Z + 20, CLIFF_Z - 6, z);
    if (cl > 0) {
      const face = nb.ridged(x * 0.028, z * 0.05, 5, 0.55) * 0.5 + 0.5;
      const notch = smoothstep(9.0, 3.0, Math.abs(x - 1.0));
      const top = 30.0 + 11.0 * face - notch * 9.0;
      h += cl * cl * top;
    }

    /* And the spillway, last, because it is the only thing here that cuts
     * through everything else: the chute crosses the cliff, the alcove
     * crosses its foot, and the outwash channel crosses the clearing floor
     * and the pool's own lip. Anything applied after it would fill in part of
     * the watercourse. */
    h = spillwayCut(x, z, h, guard);

    return h;
  }

  /**
   * How much of the trail's compacted dirt shows at this point, 0..1.
   *
   * The distance is perturbed by noise before the falloff rather than the mask
   * being blurred afterwards. A blurred mask gives a soft but still perfectly
   * parallel edge, which reads as a painted line; perturbing the distance
   * makes the boundary wander in and out the way a real trail edge does, with
   * tongues of litter reaching across it and bare patches beyond it.
   */
  evalMud(x, z, q) {
    const hw = this.trail.widthAt(q.t);
    const ragged = 0.42 * this.nb.fbm(x * 0.42, z * 0.42, 3, 0.5)
                 + 0.16 * this.n.fbm(x * 1.30, z * 1.30, 2, 0.5);
    return 1 - smoothstep(hw * 0.55, hw + 1.1, q.dist + ragged);
  }

  /**
   * Standing/running water proximity, 0..1. Darkens and gloss-ifies the ground.
   *
   * The scale is not linear in "how damp": the top fifth of it is reserved for
   * the splash zone and nothing else can reach it. Everything ordinary — a
   * stream margin, the basin's shore, a shaded hollow — is capped at 0.8, and
   * the material reads `sstep(0.8, 1.0, wet)` as a separate *soak* signal.
   *
   * That split exists because the two states are not the same material. Damp
   * ground is a little darker and a little glossier than dry ground. Rock two
   * metres from eighteen metres of falling water is a different substance: it
   * is running with water, it is close to black, it is a mirror at grazing
   * angles and it is upholstered in moss, and a curve that produces that at
   * full strength would have turned every damp patch on the trail into
   * polished tar. One channel, two regimes, no second attribute.
   */
  evalWet(x, z, h, q) {
    const dPool = Math.hypot(x - POOL.x, z - POOL.z);
    let w = 0.80 * smoothstep(POOL.r + 7, POOL.r - 2, dPool);
    w = Math.max(w, 0.80 * this.brook.wetAt(q));
    w = Math.max(w, 0.80 * sinkWet(x, z));

    /* Every bed the water is actually standing on, soaked.
     *
     * Everything above tops out at 0.8, and the material reads the band above
     * that as a separate *soak* regime — see the note on the split. Damp ground
     * keeps its leaf litter, which is correct for a shaded hollow and wrong for
     * a riverbed. The basin read as a carpet of intact broad leaves seen
     * through a film and the brook read as a dry gully, both for the same
     * reason: what you see through shallow water is the bed, so a litter bed
     * under a dark film is a path and a scoured black one is water.
     *
     * Asked through `standingWater` rather than reimplemented, so the basin,
     * the run down from the alcove, the brook, the swallow's funnel and the
     * feed above the lip are all soaked by one expression, and none of them can
     * ever disagree with the mesh that is drawing the water over it. The ramp
     * is two centimetres deep, which puts the whole of the transition inside
     * the shoreline rather than spread over the bank. */
    const sw = standingWater(x, z, h, this.brook, q);
    if (sw > 0.0) w = Math.max(w, Math.min(1, 0.90 + 4.0 * sw));
    /* And a hand's breadth of bank beyond the waterline, because a stream
     * undercuts its banks and keeps the first foot of them black. Without it
     * the soak stops exactly on the water's edge, which reads as a decal. */
    w = Math.max(w, this.brook.soakAt(q));
    w = Math.max(w, chuteWet(x, z));
    // The channel the water actually runs down, which the pool term above
    // does not reach: it lies outside the basin and along the cliff foot.
    w = Math.max(w, 0.80 * spillwayWet(x, z) * (h < runLevel(z) + 1.6 ? 1 : 0.55));
    /* Everything near the falls is permanently soaked by the spray, and the
     * centre of that has moved: the impact is at the foot of the undercut,
     * eight metres further into the cliff than the old guess at the notch's
     * plan position. The falloff is short because spray is: the air is full
     * of it at ten metres and merely humid at forty, which is exactly the
     * gradient the walk is meant to feel.
     *
     * The inner term is the soak, and it is the only thing in the world that
     * reaches the top of the range. Five metres of near-total saturation with
     * a readable edge to it, because the boundary of a splash zone is a thing
     * you can see on a real waterfall and its absence was the single most
     * damning detail in the critique: dry matte rock, with dry leaf litter
     * clinging to it, a metre from the curtain. */
    const ds = Math.hypot(x - 1, z + 387.5);
    w = Math.max(w, 0.80 * smoothstep(44, 11, ds));
    w = Math.max(w, smoothstep(13.0, 4.5, ds));
    return clamp(w, 0, 1);
  }

  _buildHeights() {
    const { W, H } = this;
    const h = new Float32Array(W * H);
    const mud = new Float32Array(W * H);
    const wet = new Float32Array(W * H);
    const q = {};
    for (let j = 0; j < H; j++) {
      const z = this.z0 - j * STEP;
      for (let i = 0; i < W; i++) {
        const x = this.x0 + i * STEP;
        const k = j * W + i;
        const y = this.evalHeight(x, z, q);
        h[k] = y;
        mud[k] = this.evalMud(x, z, q);
        wet[k] = this.evalWet(x, z, y, q);
      }
    }
    this.h = h; this.mud = mud; this.wet = wet;
    this._buildHollow();
  }

  /**
   * Concavity of the ground, 0 on a ridge and 1 in a hollow.
   *
   * This is what lets the surface materials respond to the shape they are
   * lying on. Litter does not fall evenly: rain and wind move it downhill and
   * it piles up wherever the ground dishes, banks against every small step,
   * and is scoured off every convexity leaving bare humus and root. Without
   * this the leaves are a decal wrapped over the terrain, and the eye reads
   * that immediately even if it cannot say why — the ground and the stuff on
   * it look like two unrelated layers.
   *
   * Measured over a 1 m span rather than a single cell: at 0.5 m the answer is
   * dominated by the finest octave of the height noise and says nothing about
   * the shapes litter would actually collect in.
   */
  _buildHollow() {
    const { W, H, h } = this;
    const hollow = new Float32Array(W * H);
    const R = 2;   // cells, so 1 m
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const im = Math.max(0, i - R), ip = Math.min(W - 1, i + R);
        const jm = Math.max(0, j - R), jp = Math.min(H - 1, j + R);
        const avg = (h[j * W + im] + h[j * W + ip] + h[jm * W + i] + h[jp * W + i]) * 0.25;
        hollow[k] = clamp((avg - h[k]) * 7.0, 0, 1);
      }
    }
    this.hollow = hollow;
  }

  hollowAt(x, z) {
    let u = (x - this.x0) / STEP, v = (this.z0 - z) / STEP;
    u = clamp(u, 0, this.W - 1.001); v = clamp(v, 0, this.H - 1.001);
    return this.hollow[(v | 0) * this.W + (u | 0)];
  }

  /* ── queries ───────────────────────────────────────────────────────────── */

  /** Bilinear terrain height. This is the surface the player stands on. */
  height(x, z) {
    let u = (x - this.x0) / STEP, v = (this.z0 - z) / STEP;
    u = clamp(u, 0, this.W - 1.001); v = clamp(v, 0, this.H - 1.001);
    const i = u | 0, j = v | 0, fx = u - i, fy = v - j;
    const k = j * this.W + i;
    return lerp(lerp(this.h[k], this.h[k + 1], fx),
                lerp(this.h[k + this.W], this.h[k + this.W + 1], fx), fy);
  }

  /** Surface normal by central difference on the sampled height. */
  normal(x, z, out = new THREE.Vector3()) {
    const e = STEP;
    const hL = this.height(x - e, z), hR = this.height(x + e, z);
    const hD = this.height(x, z - e), hU = this.height(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  mudAt(x, z) {
    let u = (x - this.x0) / STEP, v = (this.z0 - z) / STEP;
    u = clamp(u, 0, this.W - 1.001); v = clamp(v, 0, this.H - 1.001);
    return this.mud[(v | 0) * this.W + (u | 0)];
  }

  wetAt(x, z) {
    let u = (x - this.x0) / STEP, v = (this.z0 - z) / STEP;
    u = clamp(u, 0, this.W - 1.001); v = clamp(v, 0, this.H - 1.001);
    return this.wet[(v | 0) * this.W + (u | 0)];
  }

  /* ── meshing ───────────────────────────────────────────────────────────── */

  /**
   * Build the chunk meshes.
   *
   * Chunk resolution is picked from the chunk's distance to the trail, not to
   * the camera. The player never leaves the trail, so that distance is a
   * standing proxy for view distance — which means LOD can be decided once at
   * build time and never re-evaluated, and no chunk ever pops.
   */
  build(material) {
    const { W, H } = this;
    const cx = Math.ceil((W - 1) / CHUNK), cz = Math.ceil((H - 1) / CHUNK);
    let tris = 0;

    for (let cj = 0; cj < cz; cj++) {
      for (let ci = 0; ci < cx; ci++) {
        const i0 = ci * CHUNK, j0 = cj * CHUNK;
        const iN = Math.min(CHUNK, W - 1 - i0), jN = Math.min(CHUNK, H - 1 - j0);
        if (iN <= 0 || jN <= 0) continue;

        const wx = this.x0 + (i0 + iN * 0.5) * STEP;
        const wz = this.z0 - (j0 + jN * 0.5) * STEP;
        const d = this.sampleField(wx, wz, {}).dist;
        const stride = d < 34 ? 1 : d < 68 ? 2 : 4;

        const g = this._chunkGeometry(i0, j0, iN, jN, stride);
        if (!g) continue;
        const m = new THREE.Mesh(g, material);
        /* Terrain casts as well as receives. Without it the ground has no
         * self-shadowing at all: banks do not darken their own lee side and
         * the trail does not sit in the shade of the slope beside it, which
         * is a large part of why untextured heightfields look inflated. */
        m.castShadow = true;
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        this.group.add(m);
        tris += g.index.count / 3;
      }
    }
    this.triangles = tris;
    return this.group;
  }

  _chunkGeometry(i0, j0, iN, jN, stride) {
    const nx = Math.floor(iN / stride) + 1, nz = Math.floor(jN / stride) + 1;
    if (nx < 2 || nz < 2) return null;

    // One skirt ring around the chunk. Neighbouring chunks can be at different
    // strides, which leaves hairline gaps along the shared edge; dropping a
    // vertical apron behind each border vertex fills them with ground-coloured
    // geometry instead of sky. Cheaper and far more robust than stitching.
    const total = nx * nz + 2 * (nx + nz);
    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const splat = new Float32Array(total * 3);

    const put = (vi, x, z, drop) => {
      const y = this.height(x, z) - drop;
      pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
      const e = STEP * stride;
      const hL = this.height(x - e, z), hR = this.height(x + e, z);
      const hD = this.height(x, z - e), hU = this.height(x, z + e);
      let nX = hL - hR, nY = 2 * e, nZ = hD - hU;
      const inv = 1 / Math.hypot(nX, nY, nZ);
      nrm[vi * 3] = nX * inv; nrm[vi * 3 + 1] = nY * inv; nrm[vi * 3 + 2] = nZ * inv;
      uv[vi * 2] = x; uv[vi * 2 + 1] = z;
      splat[vi * 3] = this.mudAt(x, z);
      splat[vi * 3 + 1] = this.wetAt(x, z);
      splat[vi * 3 + 2] = this.hollowAt(x, z);
    };

    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = this.x0 + (i0 + Math.min(i * stride, iN)) * STEP;
        const z = this.z0 - (j0 + Math.min(j * stride, jN)) * STEP;
        put(j * nx + i, x, z, 0);
      }
    }

    const idx = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        /* Winding: i runs +x but j runs -z, so the grid is mirrored in world
         * space relative to the obvious index order. Emitting a,c,b here — the
         * order that looks right on paper — produces downward-facing triangles
         * and the entire ground is backface-culled from standing height. */
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }

    // Skirt: duplicate each border vertex 1.2 m lower and bridge the two rings.
    let sv = nx * nz;
    const skirt = (getIdx, count, flip) => {
      const start = sv;
      for (let k = 0; k < count; k++) {
        const src = getIdx(k);
        pos[sv * 3] = pos[src * 3];
        pos[sv * 3 + 1] = pos[src * 3 + 1] - 1.2;
        pos[sv * 3 + 2] = pos[src * 3 + 2];
        nrm[sv * 3] = nrm[src * 3]; nrm[sv * 3 + 1] = nrm[src * 3 + 1]; nrm[sv * 3 + 2] = nrm[src * 3 + 2];
        uv[sv * 2] = uv[src * 2]; uv[sv * 2 + 1] = uv[src * 2 + 1];
        splat[sv * 3] = splat[src * 3];
        splat[sv * 3 + 1] = splat[src * 3 + 1];
        splat[sv * 3 + 2] = splat[src * 3 + 2];
        sv++;
      }
      for (let k = 0; k < count - 1; k++) {
        const a = getIdx(k), b = getIdx(k + 1), c = start + k, d = start + k + 1;
        if (flip) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    };
    skirt(k => k, nx, true);                                   // j = 0
    skirt(k => (nz - 1) * nx + k, nx, false);                  // j = max
    skirt(k => k * nx, nz, false);                             // i = 0
    skirt(k => k * nx + (nx - 1), nz, true);                   // i = max

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aSplat', new THREE.BufferAttribute(splat, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ── material ──────────────────────────────────────────────────────────────
 * One MeshStandardMaterial with the surface sampling replaced. Going through
 * the stock material rather than a raw ShaderMaterial keeps three's lighting,
 * shadow, fog and tone-mapping chunks working, which is a very large amount of
 * correct code to not have to reimplement in order to blend three textures.
 */
export function makeTerrainMaterial(renderer) {
  const dirt = bakeSurface(renderer, DIRT, { size: 1024, normalStrength: 2.6 });
  const litter = bakeSurface(renderer, LITTER, { size: 1024, normalStrength: 4.6 });
  const rock = bakeSurface(renderer, ROCK, { size: 1024, normalStrength: 3.0 });
  const macro = bakeSurface(renderer, MACRO, { size: 256, normal: false, orm: false });

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0,
    // Assigning these does nothing visually — every fetch is replaced below —
    // but three only compiles the map/normal/roughness code paths when the
    // corresponding slot is non-null, and those paths are what the injection
    // hooks into.
    map: dirt.map, normalMap: dirt.normalMap, roughnessMap: dirt.ormMap,
    normalScale: new THREE.Vector2(1, 1),
    // The floor of a closed forest sees a few degrees of sky through a hole in
    // the canopy, not a hemisphere of it.
    envMapIntensity: 0.30,
  });

  const U = {
    tDirtA: { value: dirt.map }, tDirtN: { value: dirt.normalMap }, tDirtO: { value: dirt.ormMap },
    tLitA: { value: litter.map }, tLitN: { value: litter.normalMap }, tLitO: { value: litter.ormMap },
    tRockA: { value: rock.map }, tRockN: { value: rock.normalMap }, tRockO: { value: rock.ormMap },
    tMacro: { value: macro.map },
    uWetTint: { value: new THREE.Color(0x2a2a26) },
    uMossTint: { value: new THREE.Color(0x2c3f1c) },
    /* Writes an intermediate of the splat straight to the framebuffer, past
     * lighting and tone mapping. Blending several textures by several masks
     * has no useful failure mode — everything wrong looks like "too dark" —
     * so being able to look at a mask on its own is the difference between
     * finding the bad term and rewriting the whole function. */
    uDebug: { value: 0 },
  };

  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    mat.userData.shader = sh;

    sh.vertexShader = `
      attribute vec3 aSplat;
      varying vec3 vSplat;
      varying vec3 vWPos;
      varying vec3 vWNrm;
    ` + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vSplat = aSplat;
       vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
       vWNrm = normalize(mat3(modelMatrix) * normal);`
    );

    sh.fragmentShader = SSTEP + `
      uniform sampler2D tDirtA, tDirtN, tDirtO;
      uniform sampler2D tLitA, tLitN, tLitO;
      uniform sampler2D tRockA, tRockN, tRockO;
      uniform sampler2D tMacro;
      uniform vec3 uWetTint, uMossTint;
      uniform float uDebug;
      vec3 gDbg;
      varying vec3 vSplat;
      varying vec3 vWPos;
      varying vec3 vWNrm;

      // Weights are shared by the albedo, normal and roughness fetches, so they
      // are computed once into globals rather than three times.
      vec3 gW; vec2 gUvF; vec2 gUvW; float gWall;
      vec3 gMacro; vec3 gMid; float gMoss; float gWet; float gAO; float gRough;
      float gSoak; float gRockS;

      /* World periods, chosen from the real size of the features each map
       * contains: ~2 m of trail surface, ~1.1 m of leaf litter (so the blades
       * land around 9 cm), ~3.6 m of bedding plane. */
      const float S_DIRT = 0.50;
      const float S_LIT  = 0.90;
      const float S_ROCK = 0.28;

      /* Biplanar sampling.
       *
       * A flat XZ projection is correct for the ground and catastrophically
       * wrong for a bank: the texture is stretched by 1/cos(slope), which on
       * these valley walls turns leaf litter into vertical smears. Full
       * triplanar fixes it with three fetches per map, but this surface is a
       * heightfield — no overhangs, so the normal's Y is always positive and
       * the weakest of the three axes contributes almost nothing. Dropping it
       * costs one extra fetch instead of two, and the difference is not
       * findable in a screenshot.
       */
      /* The scale is per-surface, not global. The three sets describe features
       * of very different real-world size — a 9 cm leaf, a 3 cm pebble, a
       * metre of bedding plane — and forcing them onto one world period makes
       * two of the three wrong. */
      vec3 biplanar(sampler2D t, float s){
        return mix(texture2D(t, gUvF * s).rgb, texture2D(t, gUvW * s).rgb, gWall);
      }

      void terrainWeights(){
        gUvF = vWPos.xz;
        // Project onto whichever vertical plane the wall most faces, so a bank
        // facing north and one facing east are both sheared equally little.
        gUvW = (abs(vWNrm.x) > abs(vWNrm.z))
             ? vec2(vWPos.z, vWPos.y)
             : vec2(vWPos.x, vWPos.y);
        /* Two scales of variation, and they do different jobs.
         *
         * The very large one (~180 m, never repeats within sight) stops the
         * whole level being one average colour. The mid one (~9 m) is the more
         * important of the two: it is at the scale the eye uses to judge
         * whether ground is a place or a pattern. Real forest floor is patchy
         * at exactly this scale — deep drifts of litter here, bare humus
         * there, a wet hollow, a dry rise — and without that a perfect leaf
         * texture still reads as wallpaper. */
        gMacro = texture2D(tMacro, vWPos.xz * 0.0055).rgb;
        gMid   = texture2D(tMacro, vWPos.xz * 0.115 + 0.37).rgb;

        float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
        gWall = sstep(0.16, 0.55, slope);
        float rockW = sstep(0.42, 0.82, slope + (gMacro.x - 0.5) * 0.22);
        float mudW = clamp(vSplat.x, 0.0, 1.0) * (1.0 - rockW);
        mudW = sstep(0.12, 0.72, mudW);
        gW = vec3(mudW, max(0.0, 1.0 - mudW - rockW), rockW);
        gWet = clamp(vSplat.y, 0.0, 1.0);

        /* The splash zone, split off the top of the same channel.
         *
         * Everything below 0.8 in the wetness field is *damp* — a shaded bank,
         * a seep, ground near standing water — and the response to it is the
         * mild darkening below. The band above 0.8 is only ever written within
         * a few metres of the fall, and it is a different material condition
         * entirely: rock under continuous spray is running with water, and it
         * is near-black, mirror-glossy and covered in the bright green things
         * that will grow nowhere else in a closed forest. The previous code
         * had one linear response for both, which is why rock a metre from
         * eighteen metres of falling water came out the same dry matte tan as
         * the blocks three hundred metres up the trail. */
        /* Evaluated per fragment from the world position, not read off the
         * vertex attribute, and that is the whole of the fix for the hard band.
         *
         * The wetness field is interpolated across the terrain's own triangles,
         * and a heightfield cliff is one quad column wide: eighteen metres of
         * vertical rock between two adjacent samples. So a gradient that is
         * smooth over nine metres of *plan* distance gets compressed into a
         * single quad edge on the face, and what the frame shows is a near-black
         * strip meeting lighter rock along a straight vertical line — a texture
         * swap, which is exactly how the critique read it. The distance to the
         * fall is a two-term expression and costs nothing to evaluate here,
         * where it is continuous by construction. */
        float dsf = length(vWPos.xz - vec2(1.0, -387.5));
        gSoak = sstep(12.0, 4.5, dsf);
        // The field still wins where it is higher: it also carries the seep
        // lines and the channel margins, which have no analytic form here.
        gSoak = max(gSoak, sstep(0.80, 0.98, vSplat.y));
        gWet = max(gWet, gSoak * 0.95);

        /* And the litter goes. Loose leaves do not stay on rock that is being
         * hosed; what is left is the rock itself, which is the other half of
         * the same finding — dry litter clinging on inside the splash radius.
         */
        gW.y *= 1.0 - 0.80 * gSoak;
        gW.z += (1.0 - gW.x - gW.y - gW.z) * gSoak;
        gW /= max(1e-3, gW.x + gW.y + gW.z);

        /* And the stone under running water is a different *size* of stone.
         *
         * The rock maps are authored at a 3.6 m period, which is a bedding
         * plane — right for eighteen metres of cliff and completely wrong for a
         * streambed, where at that scale the voronoi cells come out half a
         * metre across and the channel reads as a paved Roman lane. A bed is
         * cobbles: fist to head sized, so about a fifth of that.
         *
         * Gated on flatness rather than on the soak alone, because the other
         * place the soak reaches full strength is the cliff face inside the
         * splash radius, and that genuinely is a bedding plane. The wall term
         * is already computed and separates the two exactly. Costs nothing —
         * the scale is an argument to the same fetch. */
        gRockS = S_ROCK * (1.0 + 2.4 * gSoak * (1.0 - gWall));

        // Moss grows on the flat, the shaded and the damp, and not on the part
        // that gets walked on. Tying it to all four is what makes it land in
        // plausible places instead of scattering evenly.
        gMoss = sstep(0.42, 0.78, gMacro.y)
              * (1.0 - gW.x) * sstep(0.75, 0.25, slope)
              * (0.45 + 0.55 * gWet);
        /* Permanently wet rock is the one place in this forest where moss
         * does not need the shelter of a hollow, so the macro threshold drops
         * and the slope term goes: it grows on the vertical face too. */
        gMoss = max(gMoss, gSoak * sstep(0.26, 0.66, gMacro.y) * (1.0 - gW.x) * 0.92);
      }
      `
      // The trailing newline is required: three's shader opens with `#define
      // STANDARD`, and a preprocessor directive that does not start a line is
      // a compile error.
      + sh.fragmentShader
        .replace(
          '#include <map_fragment>',
          `terrainWeights();

           /* Litter is sampled at two world scales and crossfaded.
            *
            * One scale gives every leaf in the level the same apparent size,
            * which no real forest floor has and which the eye picks up as
            * repetition even when the tile itself is good. Mixing in a second
            * pass at roughly half the period puts big blades and small
            * fragments in the same view and breaks the tile period at the
            * same time, because the two periods are incommensurate. */
           vec3 litA = mix(biplanar(tLitA, S_LIT),
                           biplanar(tLitA, S_LIT * 0.53), gMid.x);

           /* Litter depth follows the ground, not a free-running noise.
            *
            * Leaves are moved by rain and wind until something stops them, so
            * they bank up in every dish and hollow and are scoured off every
            * rise, leaving bare humus and root on the convexities. Tying depth
            * to the terrain's own concavity is what makes the drift look like
            * it was deposited on this ground rather than wrapped around it. */
           float depth = clamp(sstep(0.24, 0.68, gMid.y) * 0.55
                             + vSplat.z * 0.75, 0.0, 1.0);
           vec3 humus = vec3(0.058, 0.048, 0.036) * (0.6 + 1.0 * gMid.z);
           litA = mix(humus, litA, 0.22 + 0.78 * depth);
           // Drift the colour temperature of the drift itself: fresher fall in
           // some patches, older grey material in others.
           litA *= mix(vec3(0.74, 0.82, 0.70), vec3(1.20, 1.06, 0.86), gMid.z);

           vec3 alb = biplanar(tDirtA, S_DIRT) * gW.x
                    + litA * gW.y
                    + biplanar(tRockA, gRockS) * gW.z;

           // ORM is fetched once here and reused by the roughness stage below,
           // which runs later in three's chunk order.
           vec3 orm = biplanar(tDirtO, S_DIRT) * gW.x
                    + biplanar(tLitO, S_LIT) * gW.y
                    + biplanar(tRockO, gRockS) * gW.z;
           gAO = orm.r; gRough = orm.g;

           alb *= 0.78 + 0.44 * gMacro.x;

           alb = mix(alb, uMossTint * (0.55 + 0.9 * gMacro.z), gMoss * 0.80);
           // Wet ground is darker because the water film traps light in the
           // surface; it is not just a grey overlay.
           alb = mix(alb, alb * uWetTint * 2.1, gWet * 0.55);
           /* A water film raises the effective index of the surface, which
            * suppresses the diffuse escape of light: soaked rock is close to
            * black. Just under a quarter, and the hue rides through unchanged:
            * normalizing a vector and then multiplying by its own length gives
            * the vector back, so the form this replaces was a scale and nothing
            * else, whatever the note on it claimed. It does not
            * need to do more: measured on the streambed the albedo comes out at
            * 47 per cent saturation against 30 to 40 for everything around it,
            * because what it is scaling is already rock and moss rather than
            * litter. What was washing the bed out was its specular, not this. */
           alb = mix(alb, alb * 0.22, gSoak);

           /* Baked cavity occlusion, applied to albedo.
            *
            * This is the single largest contributor to litter looking like a
            * layer of separate objects rather than a printed pattern. The gaps
            * between blades are physically almost fully occluded — very little
            * skylight reaches the bottom of a leaf drift — and without that
            * darkening every leaf sits in the same plane. The exponent pushes
            * the crevices down harder than a linear multiply would.
            */
           alb *= pow(clamp(gAO, 0.0, 1.0), 1.7);

           diffuseColor.rgb *= alb;

           gDbg = uDebug < 1.5 ? gW
                : uDebug < 2.5 ? alb
                : uDebug < 3.5 ? gMacro
                : uDebug < 4.5 ? vSplat
                : uDebug < 5.5 ? texture2D(tLitA, gUvF).rgb
                : vec3(gMoss, gWet, 0.0);`
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
           // Slot 7 is written here (see below) rather than up in the albedo stage because
           // the shading normal does not exist yet at that point, and the
           // shading normal is the one thing worth looking at that does not.
           if (uDebug > 8.5) gDbg = vec3(material.roughness, metalnessFactor, gRough);
           else if (uDebug > 7.5) gDbg = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
           else if (uDebug > 6.5) gDbg = normal * 0.5 + 0.5;
           if (uDebug > 0.5) gl_FragColor = vec4(gDbg, 1.0);`
        )
        /* Whole chunks, not lines inside them.
         *
         * three expands `#include` in WebGLProgram, which runs *after*
         * onBeforeCompile — so at this point the shader string still contains
         * the directives and none of the chunk bodies. Two of the injections
         * here used to target lines from inside the normal-map and roughness
         * chunks, which are simply not in the string yet, so both silently did
         * nothing for the entire life of this material.
         *
         * Nothing warns about it: `String.replace` with no match returns the
         * original, the shader compiles, and the surface renders — just with
         * three's stock behaviour, which for this material meant the whole
         * terrain took its normals and its roughness from the dirt ORM alone,
         * sampled at the raw world-space UV. That is one tile per metre, and
         * at any distance it aliases into a field of hard little glints that
         * looked for all the world like wet stones. Chasing it through the
         * albedo, the mesh and the lighting cost most of a day.
         *
         * The rule the hard way: only ever replace a directive.
         */
        .replace(
          '#include <normal_fragment_maps>',
          `vec3 mapN = (biplanar(tDirtN, S_DIRT) * gW.x
                      + biplanar(tLitN, S_LIT) * gW.y
                      + biplanar(tRockN, gRockS) * gW.z) * 2.0 - 1.0;
           mapN.xy *= normalScale;
           // A film of water fills in the micro-relief, so wet ground is
           // visibly flatter as well as darker and shinier.
           mapN.xy *= mix(1.0, 0.62, gWet) * mix(1.0, 0.42, gSoak);
           normal = normalize( tbn * mapN );`
        )
        .replace(
          '#include <aomap_fragment>',
          `/* Specular occlusion, which three only does for us if an aoMap is
            * bound and this material's AO arrives through the splat instead.
            * The gaps between leaves in a litter drift see almost none of the
            * sky, so they cannot return a sky reflection, and letting them do
            * it is what puts a sheen into exactly the places that should be
            * the darkest in frame. */
           float ao = pow(clamp(gAO, 0.0, 1.0), 1.4);
           reflectedLight.indirectSpecular *= ao;
           reflectedLight.directSpecular *= mix(0.55, 1.0, ao);
           /* And the soak's share of the image-based term goes, which is the
            * same finding the water material arrived at twice and the reason a
            * submerged streambed measured brighter than the sunlit dirt on its
            * own bank.
            *
            * Written out on its own, the specular on the bed came back at 70 of
            * 255 — four times its own albedo — at three per cent saturation and
            * with only thirty values of spread across a surface carrying strong
            * dappled shadow. So it is not the sun glint: that would be black in
            * the shade and clipping in the light. It is three's uniform sky dome
            * on a surface the soak has taken to roughness 0.2, where the
            * multi-scattering term on a dielectric is large and integrates to a
            * constant. A neutral constant is the worst thing that can happen to
            * this frame — every other surface in it sits between thirty and
            * forty per cent saturation, so a grey slab in the middle of them
            * reads as poured concrete, which is exactly how the channel read.
            *
            * The direct term is left alone on purpose. A wet surface is glossy
            * and the sun glint is most of what says so, but it is directional,
            * it rides the surface normal and it goes to nothing in shade, so it
            * cannot flatten anything. Cutting one and not the other is the same
            * asymmetry the pool needed. */
           reflectedLight.indirectSpecular *= mix(1.0, 0.14, gSoak);`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness * gRough;
           roughnessFactor = mix(roughnessFactor, 0.90, gMoss * 0.6);
           // Damp patches at the mid scale. Uniform roughness over a whole
           // hillside is one of the loudest CG tells there is: real ground
           // dries unevenly, and the varying sheen is what shows it.
           roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.74,
                                 sstep(0.55, 0.85, gMid.y) * (1.0 - gW.z));
           /* A water film is the smoothest thing in the scene, but not as
            * smooth as the physics alone would suggest: what the floor of a
            * closed forest reflects is a roof of leaves, not a sky, and
            * giving it a mirror finish against an unoccluded environment map
            * turns every damp patch into a hard pale blob. */
           roughnessFactor = mix(roughnessFactor, 0.42, gWet * 0.80);
           // Nothing down here is polished — except the splash zone, which is
           // under a moving film of water and is the glossiest surface in the
           // scene. The floor has to make way for it or the soak reads as a
           // dark patch rather than as a wet one, and gloss is most of what
           // says wet: the darkening on its own is just a stain.
           /* Glossy, but no longer a mirror. At 0.09 the soak returned a hard
            * specular sheet wherever a sun shaft crossed it, and the two places
            * that shows are the streambed and the basin floor — both of which
            * are *under* water, where the highlight belongs to the surface over
            * them and not to the gravel beneath. The channel came back reading
            * as a wet paved lane. 0.17 still leaves it the glossiest ground in
            * the scene, which is what the splash zone needs. */
           roughnessFactor = max(mix(roughnessFactor, 0.17, gSoak),
                                 mix(0.60, 0.16, gSoak));`
        );
  };
  mat.customProgramCacheKey = () => 'terrain-splat-v1';

  mat.userData.maps = { dirt, litter, rock, macro };
  /* The uniform block, reachable before the first compile. `userData.shader`
   * only appears once three has built a program for this material, and the
   * capture harness sets a uniform, poses the camera and renders in that
   * order — so from there it is reliably undefined at the moment it is
   * wanted, and `uDebug` silently does nothing. */
  mat.userData.uniforms = U;
  return mat;
}
