/* Procedural plant geometry.
 *
 * Every species here is assembled from two primitives — a bent leaf card and a
 * swept tube — and the entire difference between a fern, a palm and a canopy
 * tree is how those are arranged. Keeping it to two primitives is deliberate:
 * they can then share one leaf atlas and one bark material, which is what lets
 * the whole forest draw in a handful of instanced calls.
 *
 * Two things carry most of the realism and are easy to get wrong:
 *
 * Cards are bent, never flat. A flat quad reads as a quad the moment the light
 * moves across it, because the whole thing changes brightness at once. A card
 * with even four segments of droop has a gradient across it and catches a
 * highlight along one band, which is what a real leaf does. It is the cheapest
 * realism in the file: four extra triangles per leaf.
 *
 * Nothing is symmetric or evenly spaced. Every angle, length and phase gets a
 * jitter, because regular radial arrangement is the other half of the CG tell —
 * a fern with eight evenly spaced fronds looks like a parasol no matter how
 * good the texture on it is.
 *
 * Winding is not a detail here. Both primitives emit front faces that agree
 * with their own vertex normals, and for four passes they did not: `addTube`
 * wound every quad the other way, so the wood material — which is FrontSide —
 * culled the near wall of every trunk and drew the *inside* of the far one,
 * lit by normals pointing away from the camera. The result was a forest of
 * featureless black columns whose silhouettes were right and whose surfaces
 * carried no bark at all, and no amount of work on the bark texture could
 * have shown up. tools/wind-diag-style audits (geometric normal versus
 * averaged vertex normal, per triangle) are how that was finally caught, and
 * are worth re-running after any change in here.
 */
import * as THREE from 'three';
import { ATLAS_N, leafSpan } from './plantTex.js';

/* Atlas columns, matching plantTex.js: the shape family. The row — which
 * individual of that family, and how chewed it is — is passed separately as
 * `vary`, because the choice is ecological rather than aesthetic. */
export const CELL = { OVATE: 0, LANCE: 1, FROND: 2, SMALL: 3 };

const CELL_UV = 1 / ATLAS_N;

function cellUV(fam, vary) {
  return { u0: (fam % ATLAS_N) * CELL_UV, v0: (vary % ATLAS_N) * CELL_UV };
}

/* Which individual to draw. Row 0 of the atlas is a nearly intact young blade
 * and row 3 has been chewed to lace, so litter and old fronds want the bottom
 * of the atlas and a new canopy flush wants the top. Picking uniformly
 * everywhere is what put the same orange necrosis blotch on the fresh growth
 * and the dead leaves alike. */
export const anyLeaf = (rng) => (rng() * ATLAS_N) | 0;
export const freshLeaf = (rng) => (rng() * 2) | 0;
export const oldLeaf = (rng) => 2 + ((rng() * 2) | 0);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* Accumulates triangles from several builders into one geometry.
 * `flex` is how far a vertex is from the part of the plant that is anchored,
 * and the wind shader squares it — so a frond tip travels and the crown of the
 * trunk barely moves, from one attribute. */
export class Builder {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.flex = []; this.dead = [];
    this.rib = []; this.surf = [];
    this.idx = [];
    this._rib = null; this._occ = 1; this._moss = 0;
  }
  get count() { return this.pos.length / 3; }

  /* The rib is the line a vertex is offset *from*: the midrib of a leaf, the
   * centreline of a tube. It cannot be recovered from the position, and the
   * vertex shader needs it to widen anything that has shrunk below a pixel
   * across — which at forest densities is most of the frame. Set it before
   * emitting a row of vertices; pass null to make each vertex its own rib,
   * which disables the widening for that piece. */
  anchor(p) { this._rib = p; return this; }

  /* occ is baked contact occlusion and moss is signed: positive is a pile of
   * living moss sitting on top of the bark, negative is heartwood exposed
   * where the bark has rotted off. One attribute because they are mutually
   * exclusive on any given square centimetre of a trunk.
   *
   * On leaf geometry the second slot means something else entirely: it is a
   * per-leaf random that the leaf shader uses to pick an underside. Sharing
   * the attribute is not laziness — a leaf never has moss on it and a trunk
   * never has an abaxial surface, so the two uses cannot collide, and adding
   * a fifth per-vertex float to every leaf in the forest to say one number
   * per leaf would be the most expensive way possible to say it. */
  surface(occ, moss) { this._occ = occ; this._moss = moss; return this; }

  vert(p, n, u, v, flex, dead = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.flex.push(flex);
    this.dead.push(dead);
    const r = this._rib || p;
    this.rib.push(r.x, r.y, r.z);
    this.surf.push(this._occ, this._moss);
    return this.count - 1;
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aFlex', new THREE.Float32BufferAttribute(this.flex, 1));
    /* Senescence, per vertex.
     *
     * One leaf atlas has to serve both the living canopy and the dead litter
     * banked around every stem, and baking a second brown atlas would double
     * the texture memory to say something the shader can say in one lerp.
     * Per-vertex rather than per-instance because the interesting case is a
     * single yellowing frond on an otherwise healthy plant, and because it
     * lets a leaf die from the tip inward the way a real one does. */
    g.setAttribute('aDead', new THREE.Float32BufferAttribute(this.dead, 1));
    g.setAttribute('aRib', new THREE.Float32BufferAttribute(this.rib, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const _v = () => new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

/**
 * One leaf, as a card that droops along its length and cups across it.
 *
 * Built in a local frame where the leaf grows along +Z from the origin with +Y
 * up, then transformed into place by `m`. Curvature is integrated rather than
 * applied as a single rotation so the blade follows an arc: a leaf bends
 * continuously from its petiole, it does not hinge.
 *
 * @param {Builder} b
 * @param {THREE.Matrix4} m      places the leaf base and its growth direction
 * @param {object} o
 * @param {number} o.len         along the midrib, metres
 * @param {number} o.wid         full width at the widest point
 * @param {number} o.cell        atlas column — the shape family
 * @param {number} [o.vary]      atlas row — which individual, and how chewed
 * @param {number} [o.bend]      total droop over the length, radians
 * @param {number} [o.curl]      cross-section cupping, fraction of half-width
 * @param {number} [o.twist]     roll accumulated along the length, radians
 * @param {number} [o.nv]        segments along the length
 * @param {number} [o.nu]        segments across
 * @param {boolean} [o.half]     card spans one side of the midrib only (fronds)
 * @param {number} [o.mirror]    -1 to build the other half of a frond
 * @param {number} [o.flex0]     wind flex at the base
 * @param {number} [o.occ]       baked occlusion, 1 = open, 0 = buried
 */
/**
 * Sample the drooping arc a leaf or a frond hangs from.
 *
 * Shared because the pinnate builder has to attach leaflets to exactly the
 * curve `addLeaf` would have drawn a blade along; deriving it twice is how the
 * leaflets end up floating a centimetre off their own rachis.
 *
 * @returns {{C: THREE.Vector3[], F: THREE.Vector3[]}} points and unit tangents
 */
function ribArc(len, bend, steps, sag = 0, phase = 0) {
  const C = [], F = [];
  let py = 0, pz = 0;
  /* The arc is not a circle. A leaf's midrib is stiff for the first third,
   * gives way in the middle and often lifts again near the tip where the
   * lamina has dried, and a single monotone curve — however well chosen —
   * reads as a machined bend. Subtracting the wobble's value at the base
   * keeps the blade leaving its petiole in exactly the direction the caller's
   * matrix asked for, so adding sag never rotates the whole leaf. */
  const ang = (s) => -bend * Math.pow(s, 1.25)
                   + sag * (Math.sin(s * 5.1 + phase) - Math.sin(phase));
  for (let i = 0; i <= steps; i++) {
    const th = ang(i / steps);
    C.push(new THREE.Vector3(0, py, pz));
    F.push(new THREE.Vector3(0, Math.sin(th), Math.cos(th)));
    if (i < steps) {
      const th2 = ang((i + 0.5) / steps);
      const d = len / steps;
      py += Math.sin(th2) * d; pz += Math.cos(th2) * d;
    }
  }
  return { C, F };
}

/* Where the columns sit across the blade.
 *
 * Evenly spaced ones put most of the resolution down the middle, which is the
 * flattest part of any leaf, and describe the rolled margin — the only part
 * of the cross-section with real curvature in it — with a single segment. A
 * mild power pushes the samples outward for nothing, and it is the difference
 * between an edge that curls and an edge that is chamfered.
 */
const colPos = (q) => (q < 0 ? -1 : 1) * Math.pow(Math.abs(q), 0.74);

export function addLeaf(b, m, o) {
  const {
    len, wid, cell, vary = 0, bend = 0.9, curl = 0.25, twist = 0,
    nv = 4, nu = 2, half = false, mirror = 1, flex0 = 0.15, flex1 = 1,
    dead = 0, deadTip = 0, occ = 1,
    roll = 0, ripple = 0, phase = 0, asym = 0, sag = 0,
    relax = 0.60, tilt = 0, nick = 0, id = 0.5,
  } = o;
  const { u0, v0 } = cellUV(cell, vary);
  const base = b.count;
  b.surface(occ, id);

  // Sampling the arc keeps the droop smooth and lets the width taper follow it.
  const steps = nv;
  const { C, F } = ribArc(len, bend, steps, sag, phase);

  const S = _v(), N = _v(), T = _v(), P = _v(), NN = _v(), RIB = _v();
  const hw0 = wid * 0.5;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const f = F[i];
    // Side vector, rolled about the growth axis so the blade twists. The
    // power puts most of the roll out toward the tip, which is where a leaf
    // actually twists — the base is held rigid by the petiole.
    const tw = twist * Math.pow(s, 1.25);
    S.set(Math.cos(tw), Math.sin(tw) * f.z, -Math.sin(tw) * f.y);
    N.copy(f).cross(S).normalize().negate();

    /* Cut to the blade, not to the card, and this is the change that makes
     * close foliage stop reading as cards.
     *
     * The geometry used to be a rectangle with a leaf alpha-tested out of it,
     * so every shaping term in this function — the cup, the arc, the twist —
     * was applied to the rectangle. On an atlas cell whose blade fills half
     * its card, that put the whole of the curvature out in the transparent
     * margin and left the visible leaf as the flat middle of the dish. Which
     * is to say: the leaves were not flat because nobody bent them, they were
     * flat because the bend was happening somewhere the leaf was not.
     *
     * `leafSpan` is the outline the atlas shader bakes, evaluated on the CPU
     * against the same coefficients, and the small overshoot is headroom for
     * the margin undulation baked into the alpha plus the alpha dilation the
     * leaf material applies with distance. Undershooting is the dangerous
     * direction: it slices the blade off along a straight line.
     *
     * `half` cards are exempt. Those are the trunk epiphytes, which draw one
     * side of a cell that is not symmetric about its centre, and the mapping
     * for them is not this one. */
    const t = clamp01((s - 0.035) / 0.93);
    /* How hard the taper is applied depends on how many rows there are, and
     * that is not a nicety. A card with one segment along its length has rows
     * only at t = 0 and t = 1, where a real blade has no width at all, so
     * cutting such a card to its outline collapses it to a sliver — which
     * would silently delete the distant thicket, the one species built at one
     * segment. Below four rows the taper is eased off toward the old
     * full-width card, which is also the right call for the far LODs: the
     * material dilates their alpha with distance to keep small leaves from
     * eroding, and it can only dilate into geometry that exists. */
    const tight = clamp01((nv - 1) / 3);
    const g = Math.min(1, leafSpan(cell, vary, t) * 1.10 + 0.04);
    const span = half ? 1 : 1 + tight * (g - 1);
    const hw = hw0 * span;

    /* Margin undulation. A broad leaf buckles between its secondary veins, so
     * the two margins run up and down relative to the midrib along the length
     * of the blade — the single most recognisable thing about a large tropical
     * leaf seen at an angle, and the cheapest possible three-dimensionality
     * since it only moves vertices that already exist. */
    const rip = ripple * Math.sin(s * 6.4 + phase);

    /* The channel a blade holds along its midrib is not constant, and holding
     * it constant is the whole of the folded-cardboard read.
     *
     * A leaf is stiffest where it leaves the petiole — that is where the
     * midrib is thickest and where the two halves are still furled together —
     * and by the tip the rib is a thread and the lamina lies almost flat. One
     * curl applied uniformly puts the same V section at the base and at the
     * tip, so the crease runs the entire length of the blade at a constant
     * angle, which is what a sheet of card folded once looks like and what
     * nothing that grew ever looks like. Relaxing the cup along the length
     * turns that single hard crease into a channel that opens out, and the
     * highlight then runs *along* the leaf instead of sitting in a straight
     * line down the middle of it. */
    const cup = -curl * (1 - relax * smooth01(s * 1.20));
    /* An antisymmetric term on top of the symmetric one. Every cross-section
     * so far has been an even function of the distance from the midrib, so
     * both halves of every blade did the same thing at the same time — and a
     * surface with a mirror plane through it reads as manufactured however
     * curved it is. Real broadleaves are warped: one half lifts while the
     * other drops, and the amount changes along the length, which is what
     * gives a big leaf two separate highlights instead of one. */
    const tw2 = tilt * (0.30 + 0.70 * s);

    // The midrib point this row hangs off, in the same space as the vertices.
    RIB.copy(C[i]).applyMatrix4(m);
    b.anchor(RIB);

    for (let j = 0; j <= nu; j++) {
      const q = half ? (j / nu) * mirror : (j / nu) * 2 - 1;
      const xf = colPos(q);
      const ax = Math.abs(xf), sg = xf < 0 ? -1 : 1;
      // No leaf is symmetric about its midrib; one half is reliably broader
      // than the other and the whole blade sits skew because of it.
      const wSide = 1 + asym * sg;
      const e4 = ax * ax * ax * ax;
      /* Four terms across the blade: the dish, the rolled margin, the
       * undulation and the warp. The roll is a high power so it does nothing
       * until the last fifth of the half-width and then turns hard, which is
       * what a margin does — it is a curl, not a wider bowl. Its sign is the
       * caller's choice: young leaves cup inward and old ones reflex. */
      const cs = cup * xf * xf - roll * e4 * ax + rip * xf * xf + tw2 * xf * ax;
      const dcs = 2 * cup * xf - 5 * roll * e4 * sg + 2 * rip * xf + 2 * tw2 * ax;
      /* The margin, wandering in and out along the length — separately on
       * each side, which is what `sg` in the phases buys. The atlas already
       * bakes an undulating outline, but it bakes the *same* one on every
       * copy of a cell, so a stand of leaves drawn from four rows carries
       * four outlines and the eye finds the repeat. Perturbing the half-width
       * here moves the alpha cut with it, since the texture coordinate is
       * left alone, so it is a genuine change of silhouette per leaf and the
       * deeper excursions read as tears. */
      const hwj = nick === 0 ? hw : hw * (1
        + nick * (0.55 * Math.sin(s * 9.7 + phase * 2.3 + sg * 1.9)
                + 0.30 * Math.sin(s * 21.3 - phase * 1.7 + sg * 3.4)
                + 0.15 * Math.sin(s * 44.0 + phase + sg)));
      P.copy(C[i]).addScaledVector(S, xf * hwj * wSide).addScaledVector(N, cs * hwj);
      T.copy(S).multiplyScalar(wSide).addScaledVector(N, dcs).normalize();
      NN.copy(f).cross(T).normalize().negate();
      P.applyMatrix4(m);
      NN.transformDirection(m);
      const uu = half ? (j / nu) : 0.5 + xf * span * 0.5;
      // A dying leaf browns from the tip and the margins back toward the
      // petiole, which is still drawing water; a uniformly brown blade looks
      // painted rather than senescing.
      const d = Math.min(1, dead + deadTip * Math.pow(s, 1.6)
                            + deadTip * 0.35 * ax);
      b.vert(P, NN, u0 + uu * CELL_UV, v0 + s * CELL_UV, flex0 + (flex1 - flex0) * s, d);
    }
  }
  b.anchor(null).surface(1, 0);

  const row = nu + 1;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < nu; j++) {
      const a = base + i * row + j;
      b.quad(a, a + 1, a + row + 1, a + row);
    }
  }
}

/**
 * A pinnate frond built from real leaflets rather than one textured card.
 *
 * The card version is still in the atlas and still earns its place at
 * distance, but it cannot work in the near field and the reason is structural
 * rather than a matter of texture quality. A frond drawn as one flat cutout
 * has a single surface normal, so every leaflet on it brightens and dims
 * together as the light moves; the slots between the leaflets can only ever
 * show what is directly behind the whole frond, never a leaflet from the other
 * half of the same one; and nothing on it can overlap anything else. The eye
 * reads all three at once and calls it a printed ribbon, which is exactly the
 * word the critique used.
 *
 * Giving each pinna its own two quads fixes all of it for about sixty
 * triangles a frond. Each leaflet catches the light at its own angle, casts
 * its own silhouette against its neighbours, and the gaps are real gaps with
 * real depth behind them.
 *
 * Leaflets rake toward the frond tip rather than standing square to the
 * rachis, and they are longest around a third of the way along — a frond whose
 * pinnae are all the same length is a comb, and one whose pinnae stand at
 * ninety degrees is a fish skeleton.
 *
 * @param {Builder} b
 * @param {THREE.Matrix4} m
 * @param {object} o
 * @param {number} o.len       rachis length, metres
 * @param {number} o.wid       full span tip-to-tip across the frond
 * @param {number} o.pinnae    leaflets per side
 * @param {() => number} o.rng
 */
const _bx = _v(), _by = _v(), _bz = _v(), _bp = _v();
const _basis = new THREE.Matrix4(), _world = new THREE.Matrix4();

export function addPinnate(b, m, o) {
  const {
    len, wid, vary = 0, bend = 1.2, twist = 0, rng,
    pinnae = 7, nv = 5, flex0 = 0.08, deadTip = 0, occ = 1,
    sag = 0, phase = 0, pnv = 2, pnu = 1, id = 0.5,
  } = o;

  /* The rachis, as a narrow strap off the lanceolate column. It has to be
   * drawn: a frond whose leaflets are attached to nothing has a visible line
   * of empty space running down its spine, and the rachis is also the only
   * part of a senescing frond that stays rigid once the pinnae have curled.
   * It carries a channel rather than being flat, because a rachis is grooved
   * along its upper face and that groove is a hard dark line running the
   * length of the frond — one of the few high-contrast marks on a fern. */
  addLeaf(b, m, {
    len, wid: wid * 0.11, cell: CELL.LANCE, vary,
    bend, curl: -0.55, relax: 0.25, twist, nv, nu: pnu > 1 ? 2 : 1,
    flex0, flex1: 1, deadTip, occ, sag, phase, id,
  });

  /* Sampled far finer than the rachis card is tessellated, because a leaflet
   * attached to a linear interpolation of a curve sits visibly off it — and
   * this costs nothing, it is a build-time array. */
  const { C, F } = ribArc(len, bend, 24, sag, phase);
  const halfSpan = wid * 0.5;

  for (let k = -1; k <= 1; k += 2) {
    for (let i = 0; i < pinnae; i++) {
      /* Never quite opposite, and never evenly pitched either. The jitter is
       * most of a rachis's width now rather than a quarter of it: at a
       * quarter, the pinnae still landed in a recognisable rhythm and a
       * rhythm across twenty identical teeth is precisely what the word
       * "comb" describes. Real pinna spacing crowds in places and opens in
       * others because some of them aborted. */
      const s = Math.min(0.985,
        (i + 0.18 + rng() * 0.9) / pinnae * 0.88 + 0.09 + (k > 0 ? 0.02 : 0));
      // Gaps where a pinna has been torn off. An intact frond is a young one.
      if (rng() < 0.09) continue;

      const j = Math.min(24, Math.round(s * 24));
      const T = F[j];
      const rl = twist * s;
      _bx.set(Math.cos(rl) * k, Math.sin(rl) * T.z * k, -Math.sin(rl) * T.y * k);
      // The frond's own up, which is the plane the pinnae lie in.
      _by.copy(T).cross(_bx).normalize();

      /* Rake and droop. The rake opens out toward the tip — pinnae near the
       * base of a frond stand almost square to the rachis and the ones at the
       * end sweep forward nearly parallel to it, and that progression is most
       * of what makes a frond read as having grown from one end.
       *
       * The lift is new and it matters more than it looks. Every pinna used
       * to droop, by a varying amount, which still leaves the whole rank
       * inside one plane hanging off one side — a louvre. Letting a third of
       * them sit above the rachis breaks the rank into individual leaflets
       * that overlap and shade each other, which is what a frond does when
       * you look down the length of one. */
      const rake = 0.42 + 0.55 * s + (rng() - 0.5) * 0.34;
      const droop = 0.06 + 0.45 * s * s + rng() * 0.26 - (rng() - 0.35) * 0.40;
      _bz.copy(_bx).multiplyScalar(Math.cos(rake))
         .addScaledVector(T, Math.sin(rake))
         .addScaledVector(_by, -droop)
         .normalize();
      // Re-orthogonalise: the droop above pulled the up vector off square.
      _by.addScaledVector(_bz, -_by.dot(_bz)).normalize();
      _bx.copy(_by).cross(_bz);

      _basis.makeBasis(_bx, _by, _bz);
      _bp.copy(C[j]);
      _basis.setPosition(_bp);
      _world.multiplyMatrices(m, _basis);

      // Longest around a third along, short at both ends, jittered per pinna.
      const ext = Math.sin(Math.PI * Math.pow(s, 0.60)) * (0.74 + rng() * 0.36);
      // One pinna in eight has been bitten off partway along and has died
      // back from the wound. A rank of pinnae that are all whole is a rank
      // that grew this morning.
      const bitten = rng() < 0.13;
      const ll = halfSpan * Math.min(1.15, ext) * (bitten ? 0.34 + rng() * 0.28 : 1);
      addLeaf(b, _world, {
        /* Broader than the card's leaflets were. The lanceolate atlas cell
         * only fills about forty-five per cent of the card it is drawn on, so
         * a ratio that looks right as a number comes out at half of it on
         * screen — the first attempt at this gave the ferns pinnae at nine to
         * one and the whole plant went wispy. Real understory pinnae are
         * broad, four or five to one, and they overlap their neighbours. */
        len: ll, wid: ll * (0.42 + rng() * 0.18) * (bitten ? 1.5 : 1),
        cell: CELL.LANCE, vary: rng() < 0.7 ? vary : anyLeaf(rng),
        bend: 0.30 + rng() * 0.75, sag: (rng() - 0.5) * 0.55, phase: rng() * 6.283,
        /* Individually cupped, and the sign of it is per leaflet. A pinna
         * whose margins turn down catches light along its spine and one whose
         * margins turn up catches it along both edges, so a rank carrying
         * both has two different highlights running through it — which is why
         * a real frond does not read as one surface however flat it looks in
         * outline. This is also the change that stopped the leaflets being
         * literally planar: they were being built at one column across, and
         * a cross-section with two vertices in it cannot curve at all. */
        curl: (rng() < 0.62 ? 1 : -1) * (0.16 + rng() * 0.26),
        roll: (rng() < 0.5 ? 1 : -1) * (0.10 + rng() * 0.30),
        asym: (rng() - 0.5) * 0.30, nick: 0.05 + rng() * 0.07,
        tilt: (rng() - 0.5) * 0.24, id: id * 0.7 + rng() * 0.3,
        twist: (rng() - 0.5) * 0.9, nv: pnv, nu: pnu,
        /* The whole leaflet swings with the point of the rachis it is
         * attached to, plus a little of its own. Letting each one ramp to
         * full flex the way a free-standing leaf does would give a pinna at
         * the crown the same amplitude as one at the frond tip, and the plant
         * boils instead of bending. */
        flex0: flex0 + (1 - flex0) * s,
        flex1: flex0 + (1 - flex0) * Math.min(1, s + 0.12),
        deadTip: Math.min(1, deadTip * (0.35 + 0.9 * s) + (bitten ? 0.55 : 0)), occ,
      });
    }
  }
}

/**
 * Swept tube for trunks, stalks, branches and vines.
 *
 * Uses a parallel-transport frame rather than Frenet: a Frenet frame flips its
 * normal wherever the curve is momentarily straight, which puts a visible
 * twist in the bark exactly where a trunk is least interesting.
 *
 * `opts.profile(angle, s)` scales the radius per angle, which is what turns a
 * cylinder into a trunk. It is worth the numeric derivative it costs: the
 * normal of a fluted section is *not* radial, and shading a lobed bole with
 * radial normals gives back the smooth cylinder the lobes were there to
 * destroy. `opts.occ` and `opts.moss` are sampled the same way and feed the
 * wood material's contact-shadow and moss/rot terms.
 *
 * @param {object} [opts]
 * @param {(a:number,s:number)=>number} [opts.profile]
 * @param {(a:number,s:number,up:number)=>number} [opts.occ]
 * @param {(a:number,s:number,up:number)=>number} [opts.moss]
 */
export function addTube(b, pts, radii, sides = 7, vRepeat = 1, flexFrom = 1.0,
                        uv0 = { u0: 0, v0: 0 }, uvSpan = 1, opts = {}) {
  const { profile = null, occ = null, moss = null } = opts;
  const base = b.count;
  const n = pts.length;
  let up = new THREE.Vector3(0, 0, 1);
  const tan = _v(), nrm = _v(), bin = _v(), P = _v(), NN = _v(), ER = _v(), ET = _v();

  let arc = 0;
  const arcs = [0];
  for (let i = 1; i < n; i++) arcs.push(arc += pts[i].distanceTo(pts[i - 1]));
  const total = arc || 1;

  for (let i = 0; i < n; i++) {
    if (i === 0) tan.copy(pts[1]).sub(pts[0]);
    else if (i === n - 1) tan.copy(pts[n - 1]).sub(pts[n - 2]);
    else tan.copy(pts[i + 1]).sub(pts[i - 1]);
    tan.normalize();

    nrm.copy(up).addScaledVector(tan, -up.dot(tan));
    if (nrm.lengthSq() < 1e-6) { nrm.set(1, 0, 0).addScaledVector(tan, -tan.x); }
    nrm.normalize();
    bin.copy(tan).cross(nrm);
    up.copy(nrm);

    const s = arcs[i] / total;
    b.anchor(pts[i]);
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      let rp = 1, dr = 0;
      if (profile) {
        const e = 0.02;
        rp = profile(a, s);
        dr = (profile(a + e, s) - profile(a - e, s)) / (2 * e);
      }
      const ca = Math.cos(a), sa = Math.sin(a);
      ER.copy(nrm).multiplyScalar(ca).addScaledVector(bin, sa);
      ET.copy(nrm).multiplyScalar(-sa).addScaledVector(bin, ca);
      // Outward normal of the polar curve r(a): proportional to r*e_r - r'*e_t.
      NN.copy(ER).multiplyScalar(rp).addScaledVector(ET, -dr).normalize();
      P.copy(pts[i]).addScaledVector(ER, radii[i] * rp);
      // A flute is a groove and a groove sits in its own shade. Deriving it
      // from the profile here means any caller that asks for an irregular
      // section gets the occlusion that belongs with it, which is the half
      // that usually gets left out.
      const fl = Math.max(0, (s - (1 - flexFrom)) / Math.max(1e-3, flexFrom));
      const groove = Math.max(0.45, Math.min(1, 1 - 2.0 * (1 - rp)));
      b.surface((occ ? occ(a, s, NN.y) : 1) * groove,
                moss ? moss(a, s, NN.y) : 0);
      b.vert(P, NN, uv0.u0 + (j / sides) * uvSpan, uv0.v0 + s * vRepeat, fl * flexFrom);
    }
  }
  b.anchor(null).surface(1, 0);

  const row = sides + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * row + j;
      b.quad(a, a + 1, a + row + 1, a + row);
    }
  }
}

/* Buttress root.
 *
 * A plate running from partway up the trunk down and out to the ground — the
 * structure a shallow-rooted rainforest giant uses instead of a taproot, and
 * the single feature that makes a tall trunk read as tropical rather than as a
 * telegraph pole.
 *
 * An earlier version only ever emitted the plate's *outer edge*, which is a
 * ribbon sweeping through the air rather than a fin, and was invisible. The
 * grid here is spanned by (along the outer sweep) x (height above ground),
 * which is the surface that actually exists, with the thickness as two
 * mirrored copies of it plus a rim joining them along the free edge.
 *
 * The rewrite that followed emitted the right surface and was still invisible,
 * for two reasons that an isolation render found immediately once the leaves
 * were hidden.
 *
 * The first is this profile. It used to fall as (1 - s)^1.7, which puts the
 * plate at a third of its height by the time it is a third of the way out —
 * and the first third of its reach is still inside the trunk's own basal
 * flare. Everything that emerged into open air was a knee-high gusset, and
 * three or four of those around a bole merge into a smooth cone. That cone is
 * what the shots have been showing: not a tree with no buttresses, a tree
 * wearing a lampshade. A real buttress holds most of its height well out from
 * the bole and then drops steeply at the very end, so the curve below is flat
 * to about sixty per cent of the reach before it turns down.
 *
 * The second is that every vertex on a face carried the same hardcoded normal.
 * A plate lit by one constant normal has no gradient across it whatsoever, so
 * even where it did stand clear of the trunk there was nothing to separate it
 * from the silhouette. The normal is taken from the actual sweep tangent now,
 * and rolls over toward vertical along the rounded free edge.
 */
/* The fourth attempt, and this one is about the *surface* rather than the
 * outline. The previous plate had the right silhouette and still read as a
 * triangular fin, for a reason that only shows up when you ask what varies
 * across one of its faces: nothing does. The sweep was almost radial, so the
 * tangent barely turned, so every vertex on a face carried nearly the same
 * normal and the whole plate shaded as one flat value — a cut-out triangle
 * leaning on a tree. The corrugation term that was supposed to fix that only
 * modulated the plate's *thickness*, which on a plate seven centimetres thick
 * moves the surface by two, and two centimetres is nothing at four metres.
 *
 * So the ribs now displace the spine sideways rather than the thickness, the
 * plate leans further over as it rises, and the sweep wanders much harder.
 * All three put curvature into the face, which is what makes light run across
 * it instead of landing on it flat.
 *
 * The other half is the ending. A buttress does not stop; it runs out into a
 * surface root that snakes away across the litter and dives under it, and a
 * plate that terminates in clean air where its height curve reaches zero is
 * the single most artificial thing on these trees. The root is a tube, it
 * forks about half the time, and its last two points are below ground so it
 * disappears rather than stopping.
 */
/* The fifth attempt, and the first one that is not a plate at all.
 *
 * Every previous version built the buttress as a *separate object leaning on
 * the trunk*: a swept sheet with two faces and a rim, starting at the bole's
 * surface and stopping in the air where its height curve reached zero. Four
 * rounds of work went into the outline, the corrugation, the free edge and
 * the bark mapping, and the critique's verdict did not move — "pale,
 * hard-edged fins... they rise as separate triangular slabs". That is the
 * right reading of what the geometry was, and no amount of surface work was
 * ever going to change it, because the two things that say "inserted prop"
 * are structural:
 *
 *   1. The silhouette is a polygon. A sheet a few centimetres thick seen from
 *      any angle but edge-on is a flat region bounded by a hard line, and a
 *      hard line bounding a flat region is what a slab of cut stone looks
 *      like. Rock is the default reading for that shape because rock is the
 *      only natural material that comes in flat-sided pieces.
 *   2. There is a discontinuity where it meets the trunk. Two surfaces that
 *      interpenetrate at an angle, with different bark scales and different
 *      shading, read as two objects however well each is textured.
 *
 * So the plate is gone. A buttress is now a *thickened region of the trunk*
 * that runs out into a root: the bole's own profile carries a lobe at each
 * buttress bearing, fading out with height, so the flare and the plate are
 * literally the same surface with the same bark on it; and this function
 * sweeps the part that has left the bole as a closed teardrop section, tall
 * and narrow near the trunk, rounding and sinking as it runs away until it is
 * a lateral root under the litter. One sweep, no seam, no rim, no flat face —
 * the section curves continuously all the way round, so light runs across it
 * instead of landing on it flat.
 *
 * @param {number} ang     bearing from the bole
 * @param {number} hTop    crest height where it leaves the trunk
 * @param {number} reach   how far out the buttress proper runs
 * @param {number} rTrunk  bole radius at the base
 * @param {number} thick   half-thickness of the ridge at its widest
 */
function addRootRidge(b, ang, hTop, reach, rTrunk, thick, rng) {
  const base = b.count;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const ER = _v().set(ca, 0, sa);
  const ET = _v().set(-sa, 0, ca);
  const steps = 11, ns = 7;
  const row = ns + 1;

  // Sinuous in plan. A ridge that leaves the bole on a straight bearing is a
  // shelf bracket; a real one wanders, and the wander is most of what stops
  // the sides of it reading as two flat panels.
  const sway = (rng() - 0.5) * 0.85;
  const ribF = 2.2 + rng() * 2.6, ribPh = rng() * 6.283;
  const notch = 0.30 + rng() * 0.34;
  // The root goes on well past the buttress and dives under the litter; the
  // whole sweep is normalised over the two together.
  const rootLen = reach * (0.7 + rng() * 1.1);
  const total = reach + rootLen;
  const cut = reach / total;
  const sink = (0.6 + rng() * 0.7) * thick * 9;

  /* The spine: where the ridge is, in plan and in height, as a function of
   * how far along it we are. It starts *inside* the bole — well inside the
   * lobe the trunk profile carries at this bearing — so the first station's
   * section is buried in the trunk and there is no join to see. */
  const spine = (u) => {
    const d = rTrunk * 0.45 + total * u;
    const off = sway * reach * Math.sin(u / Math.max(1e-3, cut) * Math.PI)
              + 0.09 * reach * Math.sin(u * 7.0 + ribPh);
    // Level while it is a buttress, then descending steadily under the soil.
    const drop = -0.03 - sink * Math.pow(Math.max(0, u - cut * 0.75) / 0.9, 1.8);
    return _v().set(ER.x * d + ET.x * off, drop, ER.z * d + ET.z * off);
  };

  /* Crest height above the spine. Held high for the first half of the reach
   * and then dropped steeply, because a real buttress carries most of its
   * height well out from the bole — the previous curve was at a third of its
   * height a third of the way out, which put everything that emerged into
   * open air at knee level and left three or four knee-high gussets merging
   * into a smooth cone. The undulation and the single deep notch are the
   * worn, split ridge a photograph shows and a clean analytic curve does not. */
  const crest = (u) => {
    const t = Math.min(1, u / cut);
    const fall = Math.pow(Math.max(0, 1 - Math.pow(t, 2.8)), 0.62);
    const wear = 0.84 + 0.24 * Math.sin(u * ribF * 4.0 + ribPh * 2.0);
    const nick = 1 - 0.40 * Math.exp(-Math.pow((t - notch) / 0.10, 2));
    return hTop * fall * wear * nick + thick * 0.9;
  };
  // Half-width, and how far below the spine the section closes off. Fat at
  // the bole, thinning outward, then rounding into a root of even section.
  const half = (u) => {
    const t = Math.min(1, u / cut);
    return thick * (0.45 + 1.35 * Math.pow(1 - t, 0.8))
         * (1 - 0.55 * Math.max(0, u - cut) / Math.max(1e-3, 1 - cut));
  };
  const below = (u) => 0.05 + 2.2 * half(u);

  /* One point on the closed section, in the (lateral, vertical) plane at
   * station u. Above the spine it climbs to the crest and pinches to a narrow
   * ridge; below it, it closes off underground. The pinch is what makes it a
   * fin rather than a pipe, and doing it as a *curve* rather than as two flat
   * faces plus a rim is the entire difference from every previous version. */
  const sect = (u, phi, out) => {
    const c = Math.cos(phi), sn = Math.sin(phi);
    const up = Math.max(0, c);
    const w = half(u);
    // Ribs of tension wood, radiating up and out from where the ridge leaves
    // the bole. They displace the crest sideways, so the faces are genuinely
    // corrugated rather than merely thicker in places — two centimetres of
    // extra thickness is invisible at four metres and a wandering crest is not.
    const rib = w * 2.6 * Math.sin(u * ribF * 5.0 + ribPh + up * 2.4) * up * up;
    const lat = w * sn * (1 - 0.74 * Math.pow(up, 1.3)) + rib;
    const ver = c >= 0 ? crest(u) * Math.pow(c, 0.72) : below(u) * c;
    const sp = spine(u);
    return out.set(sp.x + ET.x * lat, sp.y + ver, sp.z + ET.z * lat);
  };

  const P = _v(), Pa = _v(), Pb = _v(), N = _v(), TA = _v(), TB = _v(), RIB = _v();
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const sp = spine(u);
    RIB.copy(sp);
    b.anchor(RIB);
    for (let j = 0; j <= ns; j++) {
      const phi = (j / ns) * Math.PI * 2;
      sect(u, phi, P);
      /* Normal from the actual surface rather than from a formula for it.
       * The previous plate gave every vertex on a face the same hardcoded
       * normal, so a whole face shaded as one flat value — which is the other
       * half of why it read as a cut-out triangle. Differencing the section
       * in both directions costs eight extra evaluations at build time and
       * gives a normal that turns with the ribs, the taper and the crest. */
      sect(u, phi + 0.09, Pa);
      sect(Math.min(1, u + 0.02), phi, Pb);
      TA.copy(Pa).sub(P);
      TB.copy(Pb).sub(P);
      N.copy(TA).cross(TB).normalize();
      if (!Number.isFinite(N.x) || N.lengthSq() < 0.5) N.copy(ET);
      const upN = Math.max(0, Math.cos(phi));
      /* Continuous with the bole's own contact occlusion, which starts at
       * 0.58 at ground level — a step in shading at the junction would put
       * back the seam the geometry no longer has. Darkest low down in the
       * crotch between the ridge and the trunk, which never sees light. */
      const o = 0.58 * (0.52 + 0.48 * smooth01(u * 2.6))
              + 0.42 * smooth01(upN * 1.5) * smooth01(u * 1.8);
      // Moss climbs the shaded lower flanks and stops partway up.
      const mo = smooth01((0.45 - upN) / 0.45)
               * (0.22 + 0.42 * smooth01(0.55 - u))
               * Math.max(0, Math.sin(phi * 2.0 + ribPh + u * 3.0));
      b.surface(o, mo);
      /* Bark at the bole's texel density, with the grain running out along
       * the ridge — which is the direction the fibres of a buttress actually
       * run, and it means the fissures flow off the trunk onto the root
       * instead of stopping at a line. The v axis is the one the bark map
       * stretches its cracks along, so distance-along-the-ridge goes there. */
      b.vert(P, N, (crest(u) * (j / ns) * 2.0) / 1.7, (total * u) / 1.7, 0);
    }
  }
  b.anchor(null).surface(1, 0);

  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < ns; j++) {
      const a = base + i * row + j;
      b.quad(a, a + 1, a + row + 1, a + row);
    }
  }

  /* A daughter root leaving the main one part way along. Roots divide, and a
   * single unbranched arc running away from a tree is a hose; the fork is
   * what makes the pair read as the visible corner of a system that carries
   * on under the litter in every direction. */
  if (rng() < 0.7) {
    const u0 = cut + (1 - cut) * (0.15 + rng() * 0.4);
    const from = spine(u0);
    from.y += half(u0) * 0.4;
    const dir = _v().copy(ER).addScaledVector(ET, (rng() - 0.5) * 2.2).normalize();
    addSurfaceRoot(b, from, dir, ET,
                   rootLen * (0.4 + rng() * 0.6), half(u0) * 1.5, rng);
  }
}

/* A root running away from a buttress across the floor.
 *
 * Half-buried on purpose: the last points are below the terrain, so the root
 * ends by going under the litter rather than by stopping. Anything that
 * simply stops at ground level advertises where the model ran out.
 */
function addSurfaceRoot(b, from, dir, side, L, r0, rng) {
  const wob = (rng() - 0.5) * 1.9, ph = rng() * 6.283;
  const n = 5;
  const pts = [], radii = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = _v().copy(from)
      .addScaledVector(dir, L * u)
      .addScaledVector(side, wob * L * 0.26 * Math.sin(u * 2.2 + ph));
    /* Sinks as it runs, and is under the litter well before it stops.
     *
     * The first version arched clear of the soil and then ended: on the
     * sloping bank the buttressed trees actually stand on, that left a length
     * of pipe lying in the air with a flat cut end and daylight visible under
     * it — worse than having no root at all, because a floating cylinder is
     * read instantly and a missing root is not read. A surface root is only
     * ever a shoulder showing through the leaf mould, so the descent has to
     * dominate the profile and the radius has to reach nothing before the
     * geometry does. The height is taken relative to where the buttress
     * actually ended rather than to the plant's origin, which the first
     * version overwrote — that alone put a step at every joint. */
    p.y = from.y - 3.4 * r0 * u * u
        + 0.35 * r0 * Math.sin(u * 3.2 + ph) * (1 - u);
    pts.push(p);
    radii.push(r0 * (1 - 0.90 * u * u) + 0.004);
  }
  addTube(b, pts, radii, 5, Math.max(1, Math.round(L / 0.8)), 0.0,
          { u0: 0, v0: 0 }, 1, {
            occ: (a, s, up) => 0.30 + 0.55 * Math.max(0, up),
            moss: (a, s, up) => Math.max(0, up)
              * (0.22 + 0.45 * Math.max(0, Math.sin(a * 2.0 + s * 6.0))),
          });
}

/* ---------------------------------------------------------------- species */

/* Detail level, and the contract that makes it safe.
 *
 * `lod` may only ever change how finely something is tessellated. It must not
 * change how many fronds, leaflets or twigs a plant has, and it must not skip
 * an `rng()` call, because the two levels of the same variant are built from
 * two fresh streams off the same seed and vegetation.js swaps between them at
 * a distance. The moment the streams diverge the two are different plants and
 * the swap becomes a pop rather than a change of resolution.
 */
const D = (lod, hi, lo) => (lod ? lo : hi);

/**
 * Fern, in three habits.
 *
 * Every fern in the forest used to be the same shuttlecock of divided fronds,
 * and a third of the understory is ferns — so that one habit was carrying a
 * third of the near field on its own. The two additions are the ones that
 * actually grow beside a lowland trail and look nothing like the first: a
 * bird's-nest fern, whose fronds are entire straps rather than divided, and a
 * creeping ground fern with a visible rhizome and a handful of long fronds
 * lying almost flat.
 */
export function fern(rng, scale = 1, lod = 0, vi = 0) {
  /* Chosen from a table rather than by a modulo, because the three habits are
   * not equally common and the understory is mostly fern by count. Taking
   * vi % 3 over five variants put strap-leaved fronds on three fifths of the
   * densest species in the forest, and the floor went from a monoculture of
   * folded broad blades — the fault this pass exists to fix — straight to a
   * monoculture of straps. A divided frond is what most ferns beside a
   * lowland trail actually look like; the other two are the exceptions that
   * stop it being the only thing. */
  const kind = [0, 1, 0, 2, 0][vi % 5];
  const leaf = new Builder(), wood = new Builder();
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  /* One crown-wide bias on top of the per-frond jitter. Real ferns lean toward
   * their light and the whole rosette is asymmetric because of it; jittering
   * each frond independently around a symmetric mean still averages back to a
   * parasol, which is what the understory has looked like. */
  const leanA = rng() * Math.PI * 2, leanK = 0.25 + rng() * 0.55;

  if (kind === 1) {
    /* Bird's-nest: a tight funnel of undivided strap fronds with a dark scaly
     * heart, catching falling litter. The silhouette is a solid rosette with
     * a hole in the middle of it and it shares nothing with a divided frond,
     * which is the entire point of having it. */
    const n = 9 + Math.floor(rng() * 8);
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + (rng() - 0.5) * 1.2;
      const pitch = 0.75 + rng() * 0.62 - leanK * 0.34 * Math.cos(yaw - leanA);
      const len = (0.42 + rng() * 0.72) * scale;
      e.set(-pitch, yaw, (rng() - 0.5) * 0.36, 'YXZ');
      m.makeRotationFromEuler(e);
      m.setPosition(Math.cos(yaw) * 0.03 * scale, 0.03 * scale + rng() * 0.05 * scale,
                    Math.sin(yaw) * 0.03 * scale);
      addLeaf(leaf, m, {
        len, wid: len * (0.17 + rng() * 0.11), cell: CELL.LANCE,
        vary: anyLeaf(rng),
        /* Reflexing hard near the tip is what makes a nest fern a nest: the
         * fronds go up, lean out and then flop over, so the outline is a
         * ring of arcs rather than a ring of spikes. */
        bend: 1.6 + rng() * 1.6, curl: 0.34 + rng() * 0.28, relax: 0.30,
        roll: (rng() < 0.55 ? 1 : -1) * (0.18 + rng() * 0.34),
        ripple: 0.07 + rng() * 0.12, asym: (rng() - 0.5) * 0.22,
        tilt: (rng() - 0.5) * 0.26, nick: 0.06 + rng() * 0.10, id: rng(),
        sag: (rng() - 0.5) * 0.85, phase: rng() * 6.283,
        twist: (rng() - 0.5) * 0.8, nv: D(lod, 6, 4), nu: D(lod, 4, 2),
        flex0: 0.06,
        occ: 0.55 + rng() * 0.45,
        deadTip: rng() < 0.24 ? 0.35 + rng() * 0.55 : 0,
      });
    }
    // The heart of the funnel is a mat of trapped, rotting litter, and it is
    // the darkest thing on the plant — without it the rosette is a hole.
    addLitterSkirt(leaf, rng, 0.0, 0.13 * scale, 8, 0.09 * scale, lod);
  } else if (kind === 2) {
    /* Creeping ground fern: a rhizome running across the litter with a few
     * long fronds off it at intervals. Horizontal rather than radial, so it
     * fills the floor between the upright plants instead of competing with
     * them for the same volume. */
    const dir = rng() * 6.283;
    const L = (0.5 + rng() * 0.7) * scale;
    const rp = [], rr = [];
    for (let k = 0; k <= 4; k++) {
      const s = k / 4;
      rp.push(new THREE.Vector3(
        Math.cos(dir) * (s - 0.35) * L + Math.sin(dir) * Math.sin(s * 3.4) * 0.08 * scale,
        0.012 * scale + Math.sin(s * 2.6) * 0.018 * scale,
        Math.sin(dir) * (s - 0.35) * L - Math.cos(dir) * Math.sin(s * 3.4) * 0.08 * scale));
      rr.push(0.014 * scale * (1 - 0.3 * s));
    }
    addTube(wood, rp, rr, 5, 3, 0.0, { u0: 0, v0: 0 }, 1, {
      occ: (a, s, up) => 0.30 + 0.45 * Math.max(0, up),
      moss: (a, s, up) => Math.max(0, up) * 0.35,
    });
    const n = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const s = (i + 0.4 + rng() * 0.5) / n;
      const k = Math.min(4, Math.round(s * 4));
      const yaw = dir + (rng() < 0.5 ? 1.4 : -1.4) + (rng() - 0.5) * 1.2;
      const pitch = 0.20 + rng() * 0.45;
      const len = (0.42 + rng() * 0.60) * scale;
      e.set(-pitch, yaw, (rng() - 0.5) * 0.40, 'YXZ');
      m.makeRotationFromEuler(e);
      m.setPosition(rp[k].x, rp[k].y + 0.01 * scale, rp[k].z);
      addPinnate(leaf, m, {
        len, wid: len * (0.36 + rng() * 0.16),
        vary: rng() < 0.4 ? oldLeaf(rng) : anyLeaf(rng),
        bend: 0.55 + rng() * 0.85, twist: (rng() - 0.5) * 0.9,
        sag: (rng() - 0.5) * 0.7, phase: rng() * 6.283, id: rng(),
        pinnae: Math.round(7 + len * 4.0), nv: D(lod, 5, 4),
        pnv: D(lod, 3, 2), pnu: D(lod, 2, 1),
        flex0: 0.10, rng,
        deadTip: rng() < 0.36 ? 0.3 + rng() * 0.55 : 0,
      });
    }
    addLitterSkirt(leaf, rng, 0.05, 0.42 * scale, 8, 0.12 * scale, lod);
  } else {
    const n = 6 + Math.floor(rng() * 7);
    for (let i = 0; i < n; i++) {
      // Jittered rather than evenly spaced: a regular fan is a parasol.
      const yaw = (i / n) * Math.PI * 2 + (rng() - 0.5) * 1.7;
      const pitch = 0.30 + rng() * 0.55 - leanK * 0.35 * Math.cos(yaw - leanA);
      const len = (0.50 + rng() * 0.75) * scale * (1 + leanK * 0.30 * Math.cos(yaw - leanA));
      e.set(-pitch, yaw, (rng() - 0.5) * 0.30, 'YXZ');
      m.makeRotationFromEuler(e);
      m.setPosition(0, 0.035 * scale + rng() * 0.05 * scale, 0);
      const old = rng() < 0.32;
      /* Real leaflets, not a frond-shaped cutout. A fern at the side of the
       * trail is the closest plant to the camera for most of this walk and
       * its fronds are the largest single area of foliage in frame, so it is
       * the one species where the card version's shortcomings are unmissable. */
      addPinnate(leaf, m, {
        len, wid: len * (0.44 + rng() * 0.16),
        vary: old ? oldLeaf(rng) : anyLeaf(rng),
        bend: 0.95 + rng() * 1.25, twist: (rng() - 0.5) * 0.7,
        sag: (rng() - 0.5) * 0.55, phase: rng() * 6.283, id: rng(),
        /* Slightly fewer leaflets than before, and each of them three times
         * the geometry. That is the right trade for the species the critique
         * named as reading like a comb: a comb is many identical teeth, so
         * spending the budget on making each leaflet an individual — cupped,
         * twisted, some of them bitten in half — buys more than spending it
         * on having more of them. */
        pinnae: Math.round(6 + len * 3.4), nv: D(lod, 5, 4),
        pnv: D(lod, 3, 2), pnu: D(lod, 2, 1),
        flex0: 0.08, rng,
        // The lowest, oldest fronds in a crown are always dying back.
        deadTip: old ? 0.35 + rng() * 0.6 : 0,
      });
    }
    addLitterSkirt(leaf, rng, 0.03, 0.50 * scale, 9, 0.13 * scale, lod);
  }

  return { leaf: leaf.geometry(), wood: wood.count ? wood.geometry() : null };
}

/* A petiole or a cane, as a bowed tapering tube from `from` toward `dir`.
 *
 * Shared because every architecture below needs one and they were being
 * written out four times with slightly different taper laws, which is how a
 * clump ends up looking like two species stapled together. The bow and the
 * swollen base are the load-bearing parts: a straight tapered rod meeting a
 * blade at an angle is a lollipop stick, and the S-curve plus the sheath at
 * the bottom are what make the join read as a joint.
 *
 * @returns {THREE.Vector3} the tip, which is where a blade gets attached
 */
function addStalk(b, from, dir, L, r0, bow, seg, opts = {}) {
  const { droop = 0.25, occ0 = 0.45 } = opts;
  const side = _v().set(-dir.z, 0, dir.x).normalize();
  const pts = [], radii = [];
  for (let k = 0; k <= seg; k++) {
    const s = k / seg;
    const p = _v().copy(from)
      .addScaledVector(dir, L * s)
      .addScaledVector(side, bow * L * Math.sin(s * Math.PI));
    p.y -= droop * L * s * s;
    pts.push(p);
    radii.push(r0 * (1 - 0.45 * s) * (1 + 0.9 * Math.pow(1 - s, 3)));
  }
  addTube(b, pts, radii, 5, Math.max(1, Math.round(L / 0.5)), 0.9,
          { u0: 0, v0: 0 }, 1, { occ: (a, s) => occ0 + (1 - occ0) * s });
  return pts[seg];
}

/* Which way a broad-leaved understory plant is put together.
 *
 * This is the answer to the loudest remaining complaint about the vegetation:
 * that one enormous folded blade was the foreground of nearly every frame. It
 * was, and no amount of jitter on that blade could have fixed it, because the
 * repeat the eye was finding is the *architecture* — the same rosette of the
 * same number of the same-shaped leaves at the same attachment angles. Size,
 * bend and colour vary underneath a silhouette that does not.
 *
 * Four genuinely different ways of holding leaves up, one per variant, is a
 * different kind of variation: two plants of different form share no outline
 * at any scale, so there is nothing to match. They cost nothing extra in draw
 * calls because the variant count is unchanged — the same five InstancedMesh
 * buckets per tile now hold five different plants instead of five sizes of
 * one.
 */
const FORM = { ROSETTE: 0, CANE: 1, COMPOUND: 2, STRAP: 3 };

/** Broad-leaved understory: aroid rosettes, gingers, compound shrubs, straps. */
export function broadleaf(rng, scale = 1, lod = 0, vi = 0) {
  /* Weighted toward the rosette for the same reason the fern table is
   * weighted toward the divided frond: this species is the one carrying the
   * broad-leaved character of the understory, and the critique's list of
   * things that already work includes the contrast between broadleaf plants
   * and narrow foliage. Spreading four architectures evenly across it made
   * three quarters of the broadleaves not broad, and the frame lost a whole
   * category of shape. */
  const form = [FORM.ROSETTE, FORM.CANE, FORM.ROSETTE, FORM.COMPOUND,
                FORM.STRAP][vi % 5];
  const leaf = new Builder(), wood = new Builder();
  const m = new THREE.Matrix4(), e = new THREE.Euler(), q = new THREE.Quaternion();
  const leanA = rng() * Math.PI * 2, leanK = 0.3 + rng() * 0.6;
  const ORIG = _v().set(0, 0, 0);

  if (form === FORM.ROSETTE) {
    /* The aroid stool: blades on long petioles straight out of the ground.
     *
     * Still here, and still the biggest single surface in the frame, but no
     * longer three times the size of everything else. The blade length used
     * to run to 1.67 before the instance scale, and the instance scale runs
     * to about 1.7, so the largest of these were three and a half metre
     * leaves standing at the side of a footpath — which is why one of them
     * could fill a quarter of the frame and why the frame then had nothing
     * else in it. */
    const n = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + (rng() - 0.5) * 1.9;
      const pitch = 0.22 + rng() * 0.58 - leanK * 0.30 * Math.cos(yaw - leanA);
      /* Age spread within the clump. A stool carries a new furled blade, two
       * full-sized ones and a collapsing old one at the same time, and
       * building every leaf at the same length is what makes a clump look
       * stamped. */
      const ageF = Math.pow(rng(), 0.8);
      const len = (0.30 + ageF * 0.78) * scale;
      const dir = _v().set(0, Math.cos(pitch * 0.55), -Math.sin(pitch * 0.55))
        .applyAxisAngle(UPV, yaw);
      const tip = addStalk(wood, ORIG, dir, len * (0.40 + rng() * 0.50),
                           0.016 * scale, (rng() - 0.5) * 0.30, D(lod, 5, 3),
                           { droop: 0.18 });

      e.set(-pitch, yaw, (rng() - 0.5) * 0.5, 'YXZ');
      q.setFromEuler(e);
      m.makeRotationFromQuaternion(q);
      m.setPosition(tip.x, tip.y, tip.z);
      addLeaf(leaf, m, {
        len, wid: len * (0.40 + rng() * 0.32),
        cell: rng() < 0.75 ? CELL.OVATE : CELL.LANCE,
        // Old blades at the bottom of the stool are the chewed ones.
        vary: ageF > 0.72 ? oldLeaf(rng) : anyLeaf(rng),
        bend: 0.75 + rng() * 1.35,
        /* Shallower than it was, and it relaxes toward the tip. A cup of 0.62
         * held the whole length of a metre-long blade is a taco, and a taco
         * with five columns across it is a taco with a knife crease down the
         * middle — which is exactly the two words the critique used. */
        curl: 0.12 + rng() * 0.24, relax: 0.55 + rng() * 0.30,
        /* These are the largest single surfaces in the frame, so they get
         * every shaping term there is: a blade this size with a smooth
         * outline and one continuous curve is a slab, and no amount of
         * texture on it helps because the eye is reading the silhouette and
         * the highlight, both of which are geometry. */
        roll: (rng() < 0.62 ? 1 : -1) * (0.18 + rng() * 0.38),
        ripple: 0.09 + rng() * 0.15, asym: (rng() - 0.5) * 0.26,
        tilt: (rng() - 0.5) * 0.34, nick: 0.05 + rng() * 0.09,
        sag: (rng() - 0.5) * 0.7, phase: rng() * 6.283, id: rng(),
        // Six columns across rather than four. The cross-section is a smooth
        // curve and the whole point of the changes above is that it be read
        // as one; sampling it at five points describes it as a bent plate.
        twist: (rng() - 0.5) * 0.9, nv: D(lod, 6, 4), nu: D(lod, 6, 3), flex0: 0.25,
        deadTip: ageF > 0.82 ? 0.25 + rng() * 0.45 : 0,
      });
    }
  } else if (form === FORM.CANE) {
    /* A leafy cane: one or two arching stems with leaves alternating up them.
     *
     * Gingers, costus, the whole marantoid understory. The silhouette is a
     * line of medium blades stepping up and out rather than a fan converging
     * on a point, which is about as far from a rosette as an understory herb
     * gets while still being an understory herb. */
    const nCane = 1 + Math.floor(rng() * 3);
    for (let c = 0; c < nCane; c++) {
      const yaw = rng() * Math.PI * 2;
      const h = (0.65 + rng() * 1.35) * scale;
      const arch = 0.35 + rng() * 0.55;
      const cseg = D(lod, 7, 4);
      const cpts = [], crad = [];
      const dx = Math.cos(yaw), dz = Math.sin(yaw);
      // Nothing inside a loop whose length depends on `lod` may draw from the
      // stream: the two detail levels are the same seed run twice, and one
      // extra call here makes the coarse build a different plant.
      const kink = rng() * 6.283;
      for (let k = 0; k <= cseg; k++) {
        const s = k / cseg;
        // Bends over increasingly with height, the way a cane loaded with
        // leaves does; a straight one is a broom handle.
        cpts.push(new THREE.Vector3(
          dx * arch * h * s * s + Math.sin(s * 4.3 + kink) * 0.012 * scale,
          h * s * (1.02 - 0.30 * s * s),
          dz * arch * h * s * s + Math.cos(s * 3.7 + kink) * 0.012 * scale));
        crad.push((0.010 + 0.011 * (1 - s)) * scale * (0.6 + 0.5 * h));
      }
      addTube(wood, cpts, crad, 5, Math.max(2, Math.round(h / 0.4)), 0.85,
              { u0: 0, v0: 0 }, 1, {
                occ: (a, s) => 0.34 + 0.66 * smooth01(s * 4),
                moss: (a, s) => smooth01((0.16 - s) / 0.16) * 0.28,
              });

      const nL = 4 + Math.floor(rng() * 6);
      const spin = rng() * 6.283;
      for (let i = 0; i < nL; i++) {
        // Distichous or spiral, decided per cane. Two-ranked leaves make a
        // flat spray seen edge-on and a fan seen face-on, which is a strong
        // and very recognisable silhouette.
        const s = 0.24 + ((i + 0.5) / nL) * 0.74 + (rng() - 0.5) * 0.08;
        const k = Math.min(cseg, Math.round(s * cseg));
        const la = spin + yaw + (nCane > 1 ? i * 3.1416 : i * 2.39996)
                 + (rng() - 0.5) * 0.5;
        // Lower leaves are the older and larger ones; the tip is still furling.
        const ll = (0.40 - 0.20 * s + rng() * 0.22) * scale;
        const pitch = 0.30 + rng() * 0.55 - s * 0.25;
        const dir = _v().set(0, Math.sin(pitch), Math.cos(pitch))
          .applyAxisAngle(UPV, la);
        const tip = addStalk(wood, cpts[k], dir, ll * 0.22,
                             crad[k] * 0.55, (rng() - 0.5) * 0.4, 2,
                             { droop: 0.35, occ0: 0.5 });
        e.set(-pitch * 0.8, la, (rng() - 0.5) * 0.7, 'YXZ');
        m.makeRotationFromEuler(e);
        m.setPosition(tip.x, tip.y, tip.z);
        addLeaf(leaf, m, {
          len: ll, wid: ll * (0.26 + rng() * 0.16),
          cell: rng() < 0.5 ? CELL.LANCE : CELL.OVATE,
          vary: s < 0.5 ? oldLeaf(rng) : anyLeaf(rng),
          bend: 0.9 + rng() * 1.5, curl: 0.14 + rng() * 0.26,
          relax: 0.45 + rng() * 0.35,
          roll: (rng() < 0.5 ? 1 : -1) * (0.14 + rng() * 0.34),
          ripple: 0.05 + rng() * 0.10, asym: (rng() - 0.5) * 0.30,
          tilt: (rng() - 0.5) * 0.40, nick: 0.06 + rng() * 0.10,
          sag: (rng() - 0.5) * 0.8, phase: rng() * 6.283, id: rng(),
          twist: (rng() - 0.5) * 1.1, nv: D(lod, 5, 3), nu: D(lod, 4, 2),
          flex0: 0.30 + s * 0.4,
          deadTip: s < 0.42 && rng() < 0.4 ? 0.3 + rng() * 0.5 : 0,
        });
      }
    }
  } else if (form === FORM.COMPOUND) {
    /* Palmately compound: several leaflets radiating from the end of one
     * petiole. Scheffleras, cecropia seedlings, most of the fast pioneer
     * shrubs on a light gap edge.
     *
     * This is the architecture the whole understory was missing and the one
     * that reads most differently at a glance, because the gaps *inside* one
     * leaf are as large as the leaflets. A rosette of entire blades is a
     * solid mass with holes between the leaves; this is a lattice. */
    const n = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + (rng() - 0.5) * 2.0;
      const pitch = 0.42 + rng() * 0.55 - leanK * 0.24 * Math.cos(yaw - leanA);
      const reach = (0.28 + rng() * 0.52) * scale;
      const dir = _v().set(0, Math.sin(pitch), Math.cos(pitch))
        .applyAxisAngle(UPV, yaw);
      const hub = addStalk(wood, ORIG, dir, reach, 0.013 * scale,
                           (rng() - 0.5) * 0.26, D(lod, 4, 2),
                           { droop: 0.22 });
      const nLet = 3 + Math.floor(rng() * 4);
      const ll = (0.16 + rng() * 0.22) * scale;
      const spread = 0.9 + rng() * 0.8;
      for (let j = 0; j < nLet; j++) {
        /* Never a clean whorl. Leaflets on a real palmate leaf are unequal —
         * the middle one is the longest and the outer pair are half its size
         * and swept back — and an evenly spaced ring of equal ones is a
         * daisy, which is worse than the slab it replaced. */
        const off = (j / (nLet - 1) - 0.5) * 2;
        const la = yaw + off * spread + (rng() - 0.5) * 0.30;
        const lp = 0.05 + rng() * 0.45 - Math.abs(off) * 0.25;
        const lLen = ll * (1 - 0.42 * off * off) * (0.78 + rng() * 0.44);
        e.set(-lp, la, (rng() - 0.5) * 0.6, 'YXZ');
        m.makeRotationFromEuler(e);
        m.setPosition(hub.x, hub.y, hub.z);
        addLeaf(leaf, m, {
          len: lLen, wid: lLen * (0.36 + rng() * 0.22),
          cell: rng() < 0.4 ? CELL.SMALL : CELL.OVATE, vary: anyLeaf(rng),
          bend: 0.8 + rng() * 1.2, curl: 0.16 + rng() * 0.26,
          relax: 0.4 + rng() * 0.4,
          roll: (rng() < 0.55 ? 1 : -1) * (0.16 + rng() * 0.34),
          asym: (rng() - 0.5) * 0.34, tilt: (rng() - 0.5) * 0.36,
          nick: 0.06 + rng() * 0.10, id: rng(),
          sag: (rng() - 0.5) * 0.7, phase: rng() * 6.283,
          twist: (rng() - 0.5) * 0.9, nv: D(lod, 4, 3), nu: D(lod, 4, 2),
          flex0: 0.45,
          deadTip: rng() < 0.16 ? 0.3 + rng() * 0.5 : 0,
        });
      }
    }
  } else {
    /* A tuft of long keeled straps arching out of a short crown — dracaenas,
     * young pandans, the freshwater sedges along a wet bank. Nearly all
     * silhouette and almost no area, which is exactly what the near field
     * needed between the broad blades: something to break the mass up rather
     * than add to it. */
    const n = 6 + Math.floor(rng() * 8);
    const crownH = rng() * 0.22 * scale;
    if (crownH > 0.04) {
      const cp = [], cr = [];
      for (let k = 0; k <= 2; k++) {
        cp.push(new THREE.Vector3(0, crownH * (k / 2), 0));
        cr.push(0.030 * scale * (1 - 0.25 * (k / 2)));
      }
      addTube(wood, cp, cr, 5, 1, 0.4, { u0: 0, v0: 0 }, 1,
              { occ: (a, s) => 0.30 + 0.5 * s, moss: () => 0.25 });
    }
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + (rng() - 0.5) * 1.6;
      const pitch = 0.55 + rng() * 0.75 - leanK * 0.30 * Math.cos(yaw - leanA);
      const len = (0.42 + rng() * 0.75) * scale;
      e.set(-pitch, yaw, (rng() - 0.5) * 0.5, 'YXZ');
      m.makeRotationFromEuler(e);
      m.setPosition((rng() - 0.5) * 0.05 * scale, crownH,
                    (rng() - 0.5) * 0.05 * scale);
      addLeaf(leaf, m, {
        len, wid: len * (0.13 + rng() * 0.10), cell: CELL.LANCE,
        vary: anyLeaf(rng),
        // A strap leaf keeps its keel the whole way, so this is the one form
        // here that genuinely wants a hard fold and almost no relaxation.
        bend: 1.5 + rng() * 1.9, curl: 0.40 + rng() * 0.35, relax: 0.18,
        roll: (rng() < 0.5 ? 1 : -1) * (0.2 + rng() * 0.4),
        asym: (rng() - 0.5) * 0.20, nick: 0.04 + rng() * 0.06,
        tilt: (rng() - 0.5) * 0.20, id: rng(),
        sag: (rng() - 0.5) * 0.9, phase: rng() * 6.283,
        twist: (rng() - 0.5) * 1.8, nv: D(lod, 5, 3), nu: 2, flex0: 0.06,
        deadTip: rng() < 0.26 ? 0.4 + rng() * 0.5 : 0,
      });
    }
  }

  addLitterSkirt(leaf, rng, 0.04, 0.58 * scale, 10, 0.15 * scale, lod);
  return { leaf: leaf.geometry(), wood: wood.geometry() };
}

/** Understory palm: slim trunk, crown of arching fronds — feather or fan. */
export function palm(rng, scale = 1, lod = 0, vi = 0) {
  /* Half the palms are fan palms now. A feather palm and a fan palm are the
   * two silhouettes anyone can tell apart at a hundred metres — one is a
   * cluster of long arcs, the other a set of discs on sticks — and having
   * only the first meant every palm in every frame agreed about what a palm
   * looks like, which is precisely the small-kit read. */
  const fan = (vi % 2) === 1;
  const leaf = new Builder(), wood = new Builder();
  const h = (1.5 + rng() * 2.8) * scale;
  const lean = (rng() - 0.5) * 0.6;
  const pts = [], radii = [];
  const seg = 6;
  for (let k = 0; k <= seg; k++) {
    const s = k / seg;
    pts.push(new THREE.Vector3(
      lean * h * s * s, h * s,
      lean * 0.4 * h * s * s * Math.sin(s * 3.0)));
    radii.push((0.055 + 0.030 * (1 - s)) * scale);
  }
  // Leaf scars ring a palm stem every few centimetres, so the profile is
  // nearly round but the bark map has to run fast along it.
  addTube(wood, pts, radii, 7, Math.max(3, Math.round(h / 0.55)), 0.75,
          { u0: 0, v0: 0 }, 1, {
            occ: (a, s) => 0.34 + 0.66 * smooth01(s * 6),
            moss: (a, s) => smooth01((0.22 - s) / 0.22) * 0.35 * Math.max(0, Math.sin(a * 2.0)),
          });

  const crown = pts[seg];
  const n = 7 + Math.floor(rng() * 8);
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + (rng() - 0.5) * 1.3;
    // Older fronds sit lower and droop harder; new ones stand near vertical.
    const age = i / n;
    const pitch = -0.55 + age * 1.9 + (rng() - 0.5) * 0.6;
    const len = (1.1 + rng() * 1.7) * scale;
    e.set(-pitch, yaw, (rng() - 0.5) * 0.4, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(crown.x, crown.y - 0.05 * scale, crown.z);
    if (fan) {
      /* A fan palm's leaf is a disc of segments splitting from one point at
       * the end of a bare petiole, so almost all of its area sits at the far
       * end of a long empty stalk. That gap between the crown and the blade
       * is the whole silhouette, and it is the opposite of a feather palm's,
       * where the leaf begins where the stalk does. */
      const stalk = len * (0.45 + rng() * 0.30);
      const dir = _v().set(0, Math.sin(pitch), Math.cos(pitch))
        .applyAxisAngle(UPV, yaw);
      const hub = addStalk(wood, crown, dir, stalk, 0.014 * scale,
                           (rng() - 0.5) * 0.22, D(lod, 4, 2), { droop: 0.30 });
      const nSeg = 7 + Math.floor(rng() * 6);
      const blade = len - stalk * 0.75;
      const open = 1.05 + rng() * 0.55;
      const rip = 0.05 + rng() * 0.10;
      for (let j = 0; j < nSeg; j++) {
        const off = (j / (nSeg - 1) - 0.5) * 2;
        const sa = yaw + off * open + (rng() - 0.5) * 0.16;
        // The outer segments are shorter and hang lower, which is what makes
        // the disc read as a shallow cone rather than as a flat plate.
        const sp = pitch * 0.55 + Math.abs(off) * 0.55 + (rng() - 0.5) * 0.28;
        const sl = blade * (1 - 0.34 * off * off) * (0.80 + rng() * 0.36);
        e.set(-sp, sa, (rng() - 0.5) * 0.5, 'YXZ');
        m.makeRotationFromEuler(e);
        m.setPosition(hub.x, hub.y, hub.z);
        addLeaf(leaf, m, {
          len: sl, wid: sl * (0.13 + rng() * 0.09), cell: CELL.LANCE,
          vary: age > 0.6 ? oldLeaf(rng) : freshLeaf(rng),
          // Segments are folded along their own midrib — that pleat is what a
          // fan palm is — and split at the tip where the fold has torn.
          bend: 0.7 + age * 1.3 + rng() * 0.9,
          curl: 0.45 + rng() * 0.35, relax: 0.22,
          roll: (rng() < 0.5 ? 1 : -1) * (0.15 + rng() * 0.3),
          ripple: rip, asym: (rng() - 0.5) * 0.18,
          tilt: (rng() - 0.5) * 0.18, nick: 0.05 + rng() * 0.09, id: rng(),
          sag: (rng() - 0.5) * 0.55, phase: rng() * 6.283,
          twist: (rng() - 0.5) * 0.7, nv: D(lod, 5, 3), nu: 2, flex0: 0.35,
          deadTip: age > 0.70 ? (age - 0.70) * 2.4 + rng() * 0.4 : 0,
        });
      }
      continue;
    }
    addPinnate(leaf, m, {
      len, wid: len * (0.38 + rng() * 0.14),
      vary: age > 0.6 ? oldLeaf(rng) : freshLeaf(rng),
      /* Curvature randomised per frond rather than per plant. Every crown in
       * the first six passes was built from fronds that all bent by the same
       * amount plus a small jitter, so every palm in frame was the same
       * umbrella at a different size — which is precisely the repeat the eye
       * locks onto across a hundred metres of understory. */
      bend: 0.9 + age * 1.5 + rng() * 1.0,
      twist: (rng() - 0.5) * 0.6,
      sag: (rng() - 0.5) * 0.6, phase: rng() * 6.283, id: rng(),
      pinnae: Math.round(6 + len * 2.0), nv: D(lod, 6, 5),
      pnv: D(lod, 3, 2), pnu: D(lod, 2, 1),
      flex0: 0.05, rng,
      deadTip: age > 0.70 ? (age - 0.70) * 2.8 + rng() * 0.35 : 0,
    });
  }
  addLitterSkirt(leaf, rng, 0.05, 0.66 * scale, 11, 0.16 * scale, lod);
  return {
    leaf: leaf.geometry(),
    wood: wood.geometry(),
    /* Keep the collision fact beside the draw that chose the stem. Recovering
     * it later from a merged variant would turn every frond and litter blade
     * into part of the bounds and make a flexible palm block several metres. */
    solid: { type: 'palm', radius: radii[0] * 1.08, height: h },
  };
}

/** Small ground sprig: seedlings and low herbs, the layer that hides the
 *  boundary between a plant and the soil it is standing on. */
export function sprig(rng, scale = 1) {
  const leaf = new Builder();
  const n = 3 + Math.floor(rng() * 6);
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  for (let i = 0; i < n; i++) {
    const yaw = rng() * Math.PI * 2;
    const pitch = 0.12 + rng() * 0.55;
    const len = (0.10 + rng() * 0.24) * scale;
    e.set(-pitch, yaw, (rng() - 0.5) * 0.5, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(0, 0.01, 0);
    addLeaf(leaf, m, {
      len, wid: len * (0.5 + rng() * 0.4),
      cell: rng() < 0.6 ? CELL.SMALL : CELL.LANCE,
      vary: freshLeaf(rng),
      bend: 0.7 + rng() * 1.1, curl: 0.18 + rng() * 0.30, nv: 3, nu: 2,
      roll: (rng() < 0.5 ? 1 : -1) * (0.15 + rng() * 0.35),
      sag: (rng() - 0.5) * 0.6, phase: rng() * 6.283, id: rng(),
      asym: (rng() - 0.5) * 0.3, tilt: (rng() - 0.5) * 0.3,
      twist: (rng() - 0.5) * 0.9, flex0: 0.2,
    });
  }
  return { leaf: leaf.geometry(), wood: null };
}

/** Tussock of narrow strap leaves — sedges and jungle grass along the verge. */
export function tussock(rng, scale = 1) {
  const leaf = new Builder();
  const n = 7 + Math.floor(rng() * 10);
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  for (let i = 0; i < n; i++) {
    const yaw = rng() * Math.PI * 2;
    const pitch = 0.05 + rng() * 0.55;
    const len = (0.26 + rng() * 0.60) * scale;
    e.set(-pitch, yaw, (rng() - 0.5) * 0.3, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition((rng() - 0.5) * 0.06, 0.01, (rng() - 0.5) * 0.06);
    addLeaf(leaf, m, {
      len, wid: len * (0.085 + rng() * 0.04), cell: CELL.LANCE,
      vary: anyLeaf(rng),
      /* Three columns rather than two. A strap leaf is keeled — it folds
       * along its midrib — and a card built at one column across has no
       * midrib vertex, so the `curl` of 0.55 this species has always asked
       * for was silently doing nothing at all: the two margins were offset
       * by the same amount, which is a translation, not a fold. Every blade
       * in every tussock in the game was a flat ribbon. */
      bend: 1.3 + rng() * 1.7, curl: 0.45 + rng() * 0.35, relax: 0.18,
      nv: 3, nu: 2,
      roll: (rng() < 0.5 ? 1 : -1) * (0.2 + rng() * 0.4),
      sag: (rng() - 0.5) * 0.8, phase: rng() * 6.283, id: rng(),
      twist: (rng() - 0.5) * 1.6, flex0: 0.05,
      deadTip: rng() < 0.22 ? 0.4 + rng() * 0.5 : 0,
    });
  }
  return { leaf: leaf.geometry(), wood: null };
}

/** Hanging liana: a woody strand off a branch with leaves paired along it. */
export function vine(rng, scale = 1) {
  const leaf = new Builder(), wood = new Builder();
  const len = (3.0 + rng() * 7.0) * scale;
  const seg = 9;
  const pts = [], radii = [];
  const swayX = (rng() - 0.5) * 1.2, swayZ = (rng() - 0.5) * 1.2;
  for (let k = 0; k <= seg; k++) {
    const s = k / seg;
    pts.push(new THREE.Vector3(
      swayX * Math.sin(s * 2.4) * s,
      -len * s,
      swayZ * Math.sin(s * 1.7 + 1.0) * s));
    radii.push(0.030 * scale * (1 - 0.55 * s));
  }
  addTube(wood, pts, radii, 5, 6, 1.0, { u0: 0, v0: 0 }, 1,
          { occ: () => 0.72, moss: (a, s) => 0.18 * Math.max(0, Math.sin(a * 2.0 + s * 5.0)) });

  const m = new THREE.Matrix4(), e = new THREE.Euler();
  const nLeaf = Math.floor(len * 4);
  for (let i = 0; i < nLeaf; i++) {
    const s = 0.06 + rng() * 0.92;
    const k = Math.min(seg, Math.floor(s * seg));
    const yaw = rng() * Math.PI * 2;
    e.set(-(0.9 + rng() * 0.8), yaw, (rng() - 0.5) * 0.6, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(pts[k].x, pts[k].y, pts[k].z);
    const ll = (0.10 + rng() * 0.16) * scale;
    addLeaf(leaf, m, {
      len: ll, wid: ll * 0.62, cell: CELL.SMALL, vary: anyLeaf(rng),
      bend: 0.8 + rng() * 0.7, curl: 0.28, nv: 3, nu: 2, id: rng(),
      tilt: (rng() - 0.5) * 0.3,
      twist: (rng() - 0.5) * 0.8, flex0: 0.4 + s * 0.5,
    });
  }
  return { leaf: leaf.geometry(), wood: wood.geometry() };
}

/**
 * Canopy tree.
 *
 * Scaled to a real emergent: 20-34 m to the crown with a clear bole for the
 * first two thirds. That proportion is the point — a jungle feels enclosed
 * because the walls are trunks with nothing on them for six storeys, and the
 * leaves are all somewhere above your head where you cannot see them properly.
 * Foliage is deliberately biased outward and above, so from the trail you get
 * silhouette and filtered light rather than a bush on a stick.
 */
export function tree(rng, scale = 1) {
  const leaf = new Builder(), wood = new Builder();
  const h = (19 + rng() * 14) * scale;
  /* Heavy-tailed rather than uniform. A stand where every bole is the same
   * width reads as a plantation; a real one is mostly middling trunks with the
   * occasional giant that dwarfs them, and it is that one giant in frame which
   * establishes the scale of everything else. */
  const rBase = (0.46 + Math.pow(rng(), 1.8) * 1.30) * scale;
  const rTop = rBase * 0.34;

  const lx = (rng() - 0.5) * 0.10, lz = (rng() - 0.5) * 0.10;

  /* The buttresses are decided before the bole is built, because they are
   * part of it. Each one puts a lobe on the trunk's own cross-section that
   * fades out at the height the ridge's crest reaches, so what a walker sees
   * at the base of a tree is one continuously curved, deeply fluted form
   * rather than a cylinder with fins attached — and the transition from bark
   * on the trunk to bark on the buttress happens on a single surface with a
   * single texture on it, which is what the seam between them used to
   * advertise. */
  const nB = 3 + Math.floor(rng() * 3);
  const buts = [];
  for (let i = 0; i < nB; i++) {
    buts.push({
      ang: (i / nB) * Math.PI * 2 + rng() * 0.9,
      // Sized off the bole rather than in absolute metres. Buttressing is a
      // response to the load the tree is carrying, so a two-metre giant grows
      // four-metre plates and a sapling-sized bole grows knee-high ones.
      h: (0.9 + rng() * 1.1) * (0.8 + 0.75 * rBase) * scale,
      reach: (0.60 + rng() * 0.80) * (0.7 + 0.8 * rBase) * scale,
      thick: 0.075 * (0.6 + rBase) * scale,
      // How wide a sector of the bole this one swells, in radians. Narrow
      // buttresses on a slim trunk, broad ones on a giant.
      wid: 0.34 + rng() * 0.30,
      amp: 0.45 + rng() * 0.45,
    });
  }

  /* Sampled unevenly up the bole. A buttress is one to three metres tall on a
   * trunk twenty-five metres long, so a uniform fourteen rings puts two of
   * them inside the whole feature and the lobes above are interpolated
   * straight through — the flare would exist in the profile function and not
   * in the geometry. Bunching the rings toward the base gives five rings in
   * the first three metres for six extra rings overall, and the part of a
   * tree anyone on the trail can look at closely is exactly that. */
  const seg = 20;
  const sOf = (k) => Math.pow(k / seg, 1.75);
  // Which ring is nearest a given height fraction, for everything hung on the
  // bole later. A linear index into an unevenly sampled array is a silent way
  // to put a branch four metres from where it was asked for.
  const ringAt = (s) => {
    let k = 0;
    while (k < seg && sOf(k + 1) < s) k++;
    return k;
  };
  /* Girth that wanders with height, which is the "irregular taper" a real
   * bole has and an analytic one does not. Two slow harmonics over the length
   * put a swelling above one buttress and a waist above the next, at an
   * amplitude — six per cent of the radius — that is invisible as a shape and
   * unmistakable as a silhouette: the outline of the trunk stops being two
   * straight lines. The ring count went up with it, because a wobble at this
   * frequency sampled every two and a half metres is just noise on the
   * vertices. */
  const wf1 = 4.5 + rng() * 3.5, wf2 = 9 + rng() * 5;
  const wp1 = rng() * 6.283, wp2 = rng() * 6.283;
  const pts = [], radii = [];
  for (let k = 0; k <= seg; k++) {
    const s = sOf(k);
    pts.push(new THREE.Vector3(
      lx * h * s * s + Math.sin(s * 4.1) * 0.10 * scale,
      h * s,
      lz * h * s * s + Math.cos(s * 3.3 + 1.0) * 0.10 * scale));
    /* Flare in the bottom tenth, then taper slowly. A linear taper from base
     * to tip is the classic CG cone and is immediately readable as one.
     *
     * Pulled back from three quarters to a third, because the buttresses are
     * now large enough to be the flare. With both at full strength the bole
     * swelled into a smooth cone that swallowed the bottom two thirds of every
     * plate — the flare and the buttresses were competing to describe the same
     * piece of the tree and the smooth one was winning. */
    const flare = 1 + 0.34 * Math.pow(Math.max(0, 1 - s * 11), 2.4);
    const wander = 1 + 0.062 * Math.sin(s * wf1 + wp1) + 0.034 * Math.sin(s * wf2 + wp2);
    radii.push((rTop + (rBase - rTop) * Math.pow(1 - s, 1.5)) * flare * wander);
  }

  /* An out-of-round bole.
   *
   * A tropical trunk is not a cylinder: it is fluted between its buttresses,
   * it carries the healed ridges of old climbers, and the cross-section is
   * lumpy all the way up. Two harmonics that drift in phase with height give
   * that for nothing, and because the tube derives its normals from the
   * profile the flutes actually catch light along their crests instead of
   * being a texture painted on a perfect circle. The amplitude fades upward
   * because it is the base — the part anyone on the trail is looking at — that
   * is misshapen. */
  const f1 = 3 + ((rng() * 3) | 0), f2 = f1 + 2 + ((rng() * 3) | 0);
  const f3 = f2 + 4 + ((rng() * 5) | 0);
  const ph1 = rng() * 6.283, ph2 = rng() * 6.283, ph3 = rng() * 6.283;
  const amp = 0.075 + rng() * 0.12;
  /* Three harmonics, and the third one is not decoration. Two produce a lobed
   * section that is still smooth all the way round, which at trunk scale is a
   * gently rippled column; the third puts a ridge at roughly the width of a
   * hand, which is the scale of a healed climber scar or a strip of adventive
   * root, and it is the one that catches a distinct line of light down the
   * bole. Its amplitude has to stay small — the tube derives its normals from
   * this function, so a high-frequency term at full strength turns the whole
   * surface into corduroy. */
  /* And on top of it, the buttresses themselves.
   *
   * This is the term that makes the base of the tree one object. Each ridge
   * swells the bole over a sector of it, at an amplitude that dies away at
   * the height the ridge's crest reaches, so the trunk *becomes* the buttress
   * rather than being penetrated by it: there is no line where one ends and
   * the other starts, because there is only one surface and the sweep outside
   * simply continues it. The squared falloff is deliberate — a linear one
   * leaves a visible kink where the lobe reaches zero, and a kink running
   * horizontally round a trunk is the seam this whole rewrite exists to
   * remove. The trough between two adjacent lobes is a real flute a metre
   * deep, which is what a buttressed bole looks like from the trail. */
  const butLobe = (a, s) => {
    let e = 0;
    for (const t of buts) {
      let d = a - t.ang;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const fade = Math.max(0, 1 - (s * h) / t.h);
      e += t.amp * Math.exp(-(d * d) / (t.wid * t.wid)) * fade * fade;
    }
    return e;
  };
  const profile = (a, s) => (1 + amp * (0.56 * Math.cos(f1 * a + ph1 + s * 1.3)
                                     + 0.32 * Math.cos(f2 * a + ph2 - s * 0.8)
                                     + 0.12 * Math.cos(f3 * a + ph3 + s * 2.4))
                                  * (0.40 + 0.60 * Math.pow(1 - s, 0.7)))
                          + butLobe(a, s);

  /* Contact. The metre of trunk nearest the soil is in the deepest shade in
   * the forest — litter banked against it, buttress crotches either side, no
   * sky visible from it at all — and a trunk that stays evenly lit right down
   * to where it meets the ground is the single clearest sign that a tree has
   * been placed on the terrain rather than grown out of it. */
  const contact = Math.min(0.35, 2.2 / h);
  const mossPh = rng() * 6.283;
  addTube(wood, pts, radii, 12, Math.max(3, Math.round(h / 1.7)), 0.55,
          { u0: 0, v0: 0 }, Math.max(1, Math.round(2 * Math.PI * rBase / 1.7)), {
            profile,
            occ: (a, s) => 0.58 + 0.42 * smooth01(s / contact),
            /* Moss in patches, not as a coat, and this is why the near trunks
             * have been reading as flat dark green columns.
             *
             * The previous term was non-zero all the way round the bole and
             * ran up nearly six metres, which is the whole of the tree that a
             * walker on the trail can see. The wood shader replaces albedo
             * with moss colour rather than tinting it, so a floor of 0.20
             * everywhere meant a seventh of every bark texel on the lower
             * bole was being overwritten with dark green — and the bark map
             * was still there underneath, just at a seventh less contrast on
             * top of the contact occlusion and its own AO. Nothing was
             * missing; it was buried.
             *
             * Real moss is heaviest on one side of a trunk, stops at a
             * ragged line, and leaves plenty of bare bark between patches.
             * Thresholding two angular harmonics gives that, and the band is
             * halved to the height moss actually reaches. */
            moss: (a, s) => {
              const band = smooth01((contact * 1.5 - s) / (contact * 1.5));
              const patch = Math.sin(a * 2.1 + mossPh) * 0.62
                          + Math.sin(a * 5.3 - mossPh * 1.7 + s * 9.0) * 0.38;
              return band * smooth01((patch - 0.24) / 0.52) * 0.85;
            },
          });

  /* The part of each buttress that has left the bole. Its crest starts at the
   * height the lobe on the trunk fades out at, and its section is widest
   * where the lobe is deepest, so the sweep and the bole describe the same
   * shape at the junction and neither one has an edge there. */
  for (const t of buts) {
    addRootRidge(wood, t.ang, t.h, t.reach, rBase * (1 + t.amp * 0.8),
                 t.thick, rng);
  }

  /* Branch scars. A bole with a perfectly clean surface for twenty metres has
   * never dropped a limb, and every tree has. The collar left behind is a
   * short stub that flares where it leaves the trunk, and it is worth its
   * twenty triangles because it breaks the silhouette — an outline with three
   * bumps in it stops being a cylinder even when the bark on it is not
   * resolvable. */
  const nScar = 2 + ((rng() * 4) | 0);
  for (let i = 0; i < nScar; i++) {
    const s0 = 0.06 + rng() * 0.42;
    const ki = ringAt(s0);
    const a = rng() * Math.PI * 2;
    const rise = 0.25 + rng() * 0.7;
    const r0 = radii[ki];
    const L = (0.16 + rng() * 0.50) * scale;
    const sp = [], sr = [];
    for (let k = 0; k <= 3; k++) {
      const s = k / 3;
      const d = r0 * 0.45 + (r0 * 0.55 + L) * s;
      sp.push(new THREE.Vector3(pts[ki].x + Math.cos(a) * d,
                                pts[ki].y + rise * (r0 * 0.55 + L) * s,
                                pts[ki].z + Math.sin(a) * d));
      /* A branch collar, which is what these were missing. A stub of constant
       * dark wood poking out of a trunk is a peg, and "black pegs" is what
       * the critique called them. A real shed limb leaves a swollen ring of
       * healing tissue where it met the bole and tapers away from it, so the
       * base is half again as wide as the stub. */
      sr.push(r0 * (0.52 - 0.34 * Math.sqrt(s)) + 0.014 * scale);
    }
    addTube(wood, sp, sr, 5, 1, 0.0, { u0: 0, v0: 0 }, 1, {
      occ: (aa, s) => 0.45 + 0.35 * s,
      /* Mossy where the bark survived and bare pale heartwood at the break.
       * The exposed end of a snapped limb is one of the lightest things on a
       * trunk, and giving these a flat mossy dark instead is most of why they
       * read as pegs rather than as wounds. */
      moss: (aa, s) => (s > 0.62 ? -(0.30 + 0.55 * (s - 0.62) / 0.38) : 0.18),
    });
  }

  /* Climbers. A bare cylinder is the most obviously synthetic thing that can
   * be in frame, and in a rainforest it does not exist — every trunk carries
   * lianas, aerial roots and a coat of moss, and the vertical lines of those
   * climbers are half of what gives the trunk its scale and its silhouette. */
  const nClimb = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < nClimb; i++) {
    const a0 = rng() * Math.PI * 2;
    const twistRate = (rng() - 0.5) * 2.4;
    const top = 0.4 + rng() * 0.55;
    const cpts = [], crad = [];
    const cs = 10;
    for (let k = 0; k <= cs; k++) {
      const s = (k / cs) * top;
      const ki = ringAt(s);
      const a = a0 + twistRate * s;
      /* Held just off the bark, and bowing away from it between contacts. The
       * profile has to be in here now that the bole is deeply fluted at the
       * base: a climber laid on the mean radius runs straight through the
       * flank of a buttress lobe and out the other side. */
      const r = radii[ki] * profile(a, s) * 1.04
              + 0.05 * scale * Math.abs(Math.sin(s * 7.0));
      cpts.push(new THREE.Vector3(
        pts[ki].x + Math.cos(a) * r, s * h, pts[ki].z + Math.sin(a) * r));
      crad.push((0.020 + rng() * 0.016) * scale);
    }
    addTube(wood, cpts, crad, 4, 12, 0.15, { u0: 0, v0: 0 }, 1,
            { occ: (a, s) => 0.35 + 0.5 * s, moss: () => 0.22 });
  }

  /* Shingle aroids on the lower bole.
   *
   * This is the part of a trunk anyone walking the trail actually sees, and a
   * bare cylinder there is the loudest remaining CG tell on a tree. Climbing
   * aroids press themselves flat against the bark in overlapping ranks — the
   * "shingle" habit — and they are all over the first few metres of almost
   * every mature trunk in a lowland forest. They also do useful work as
   * geometry: they give the trunk a broken, leafy edge instead of a clean
   * silhouette, which is what makes it stop reading as a cylinder.
   */
  const sm = new THREE.Matrix4(), se = new THREE.Euler();
  const nShingle = 14 + Math.floor(rng() * 22);
  const sa0 = rng() * Math.PI * 2, sSpin = (rng() - 0.5) * 1.6;
  for (let i = 0; i < nShingle; i++) {
    const s = Math.pow(rng(), 1.4) * 0.30;
    const ki = ringAt(s);
    const a = sa0 + sSpin * s * 8.0 + (rng() - 0.5) * 1.5;
    // On the real surface rather than on the mean radius, so an aroid on the
    // flank of a buttress lobe sits on it instead of inside it.
    const r = radii[ki] * profile(a, s) * 0.94;
    // Pressed to the bark and hanging slightly, blade outward.
    se.set(-(1.15 + rng() * 0.45), a, (rng() - 0.5) * 0.7, 'YXZ');
    sm.makeRotationFromEuler(se);
    sm.setPosition(pts[ki].x + Math.cos(a) * r,
                   s * h + (rng() - 0.5) * 0.5 * scale,
                   pts[ki].z + Math.sin(a) * r);
    const ll = (0.16 + rng() * 0.30) * scale;
    addLeaf(leaf, sm, {
      len: ll, wid: ll * (0.55 + rng() * 0.35),
      cell: rng() < 0.6 ? CELL.SMALL : CELL.OVATE, vary: anyLeaf(rng),
      bend: 0.5 + rng() * 0.7, curl: 0.22, nv: 2, nu: 2, id: rng(),
      twist: (rng() - 0.5) * 0.7, flex0: 0.05,
      occ: 0.55 + 0.45 * s / 0.30,
      deadTip: rng() < 0.18 ? 0.3 + rng() * 0.5 : 0,
    });
  }

  // Epiphytes: fern and bromeliad clumps living on the trunk and branch forks.
  const em = new THREE.Matrix4(), ee = new THREE.Euler();
  const nEpi = 2 + Math.floor(rng() * 5);
  for (let i = 0; i < nEpi; i++) {
    const s = 0.25 + rng() * 0.6;
    const ki = ringAt(s);
    const a = rng() * Math.PI * 2;
    const r = radii[ki] * profile(a, s) * 0.9;
    const cx = pts[ki].x + Math.cos(a) * r, cz = pts[ki].z + Math.sin(a) * r;
    const cy = s * h;
    const nL = 6 + Math.floor(rng() * 8);
    for (let j = 0; j < nL; j++) {
      // Splayed outward and upward from the attachment, catching falling
      // litter — which is exactly how a bird's nest fern feeds itself.
      const ja = a + (rng() - 0.5) * 2.6;
      ee.set(-(0.1 + rng() * 1.0), ja, (rng() - 0.5) * 0.6, 'YXZ');
      em.makeRotationFromEuler(ee);
      em.setPosition(cx, cy + (rng() - 0.5) * 0.4 * scale, cz);
      const ll = (0.35 + rng() * 0.55) * scale;
      addLeaf(leaf, em, {
        len: ll, wid: ll * (0.18 + rng() * 0.22),
        cell: rng() < 0.5 ? CELL.LANCE : CELL.FROND, vary: anyLeaf(rng),
        bend: 1.4 + rng() * 1.2, curl: 0.35, nv: 4, nu: 2, id: rng(),
        half: rng() < 0.4, twist: (rng() - 0.5) * 0.8, flex0: 0.2,
      });
    }
  }

  // Branches, all in the top third.
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  const nBr = 4 + Math.floor(rng() * 4);
  const tips = [];
  for (let i = 0; i < nBr; i++) {
    const s0 = 0.62 + (i / nBr) * 0.34 + rng() * 0.04;
    const k = ringAt(s0);
    const yaw = (i / nBr) * Math.PI * 2 + rng() * 1.2;
    const reach = (2.4 + rng() * 4.2) * scale;
    const rise = (0.9 + rng() * 2.2) * scale;
    const bpts = [], brad = [];
    for (let j = 0; j <= 4; j++) {
      const s = j / 4;
      bpts.push(new THREE.Vector3(
        pts[k].x + Math.cos(yaw) * reach * s,
        pts[k].y + rise * Math.sqrt(s) - reach * 0.10 * s * s,
        pts[k].z + Math.sin(yaw) * reach * s));
      brad.push(radii[k] * 0.55 * (1 - 0.8 * s) + 0.02 * scale);
    }
    addTube(wood, bpts, brad, 6, 4, 1.0, { u0: 0, v0: 0 }, 1,
            { moss: () => 0.14 });
    tips.push(bpts[4]);
  }

  // Foliage clusters hung off the branch ends and out past them.
  for (const tip of tips) {
    const nC = 5 + Math.floor(rng() * 4);
    for (let c = 0; c < nC; c++) {
      const cx = tip.x + (rng() - 0.5) * 4.4 * scale;
      const cy = tip.y + (rng() - 0.2) * 2.2 * scale;
      const cz = tip.z + (rng() - 0.5) * 4.4 * scale;
      const nL = 16 + Math.floor(rng() * 16);
      for (let i = 0; i < nL; i++) {
        const yaw = rng() * Math.PI * 2;
        const pitch = -0.5 + rng() * 1.9;
        e.set(-pitch, yaw, (rng() - 0.5) * 0.8, 'YXZ');
        m.makeRotationFromEuler(e);
        m.setPosition(cx + (rng() - 0.5) * 1.9 * scale,
                      cy + (rng() - 0.5) * 1.5 * scale,
                      cz + (rng() - 0.5) * 1.9 * scale);
        const ll = (0.55 + rng() * 0.95) * scale;
        addLeaf(leaf, m, {
          len: ll, wid: ll * (0.34 + rng() * 0.26),
          cell: rng() < 0.5 ? CELL.OVATE : CELL.SMALL,
          // The crown is where the new growth is; the chewed rows belong down
          // in the understory where the insects live.
          vary: freshLeaf(rng),
          bend: 0.9 + rng() * 1.1, curl: 0.18 + rng() * 0.30, nv: 3, nu: 2,
          // Free variation: the roll moves vertices that already exist, and
          // a crown whose leaves all present the same oval outline is the
          // repeat the eye finds first when it looks up.
          roll: (rng() < 0.55 ? 1 : -1) * (0.2 + rng() * 0.45),
          sag: (rng() - 0.5) * 0.7, phase: rng() * 6.283, id: rng(),
          asym: (rng() - 0.5) * 0.35, tilt: (rng() - 0.5) * 0.3,
          twist: (rng() - 0.5) * 1.2, flex0: 0.55,
        });
      }
    }
  }

  // Deep litter and debris banked into the buttresses.
  addLitterSkirt(leaf, rng, rBase * 0.7, rBase * 0.7 + 2.6 * scale, 44, 0.22 * scale);
  return {
    leaf: leaf.geometry(),
    wood: wood.geometry(),
    height: h,
    /* The flare is wider than the nominal bole and the ridges continue beyond
     * it. These simple pieces preserve that silhouette in collision without
     * asking the instanced render geometry for triangles at runtime. Surface
     * roots after the ridge remain step-through: they are low enough to walk
     * over and making every fine root solid would close the whole forest. */
    solid: {
      type: 'tree',
      radius: rBase * 1.42,
      height: h,
      buttresses: buts.map(t => ({
        angle: t.ang,
        start: rBase * 0.42,
        end: rBase * 0.45 + t.reach,
        radius: Math.max(t.thick * 1.9, rBase * 0.12),
        height: t.h,
      })),
    },
  };
}

/* Litter piled against the base of something.
 *
 * A plant whose stem meets the ground at a clean line looks dropped onto the
 * terrain rather than grown out of it, and that read survives any amount of
 * work on the plant itself — the eye goes straight to the intersection. In a
 * rainforest nothing has a clean base: litter drifts against every obstruction
 * and decomposes there, so the join is always buried under a few centimetres
 * of debris. Adding the debris to the *plant* rather than the ground means it
 * is always in the right place, at whatever height the terrain happens to be.
 */
function addLitterSkirt(b, rng, r0, r1, n, size, lod = 0) {
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const rr = r0 + Math.pow(rng(), 0.6) * (r1 - r0);
    // Nearly flat, and tipped up where it has banked against the stem.
    const pitch = -0.08 + rng() * 0.38;
    e.set(-pitch, a + (rng() - 0.5) * 2.2, (rng() - 0.5) * 0.7, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(Math.cos(a) * rr, 0.015 + rng() * 0.10, Math.sin(a) * rr);
    const ll = size * (0.6 + rng() * 0.8);
    addLeaf(b, m, {
      len: ll, wid: ll * (0.5 + rng() * 0.4),
      cell: rng() < 0.5 ? CELL.OVATE : CELL.SMALL, vary: oldLeaf(rng),
      bend: 0.10 + rng() * 0.30, curl: (rng() < 0.6 ? -1 : 1) * (0.30 + rng() * 0.40),
      /* A hard curl at the very margin, which is what a drying leaf actually
       * does and what makes a drift read as a heap of separate objects rather
       * than as a printed pattern: every one of these lifts an edge a
       * centimetre off whatever it is lying on, and that centimetre is a
       * shadow the eye can find. */
      roll: (rng() < 0.7 ? -1 : 1) * (0.45 + rng() * 0.75),
      sag: (rng() - 0.5) * 0.8, phase: rng() * 6.283, id: rng(),
      asym: (rng() - 0.5) * 0.35, nick: 0.06 + rng() * 0.12,
      nv: D(lod, 3, 2), nu: 2, twist: (rng() - 0.5) * 1.6, flex0: 0.0,
      // The deeper into the drift, the less light ever reaches it.
      occ: 0.45 + 0.55 * ((rr - r0) / Math.max(1e-3, r1 - r0)),
      // All of this is fallen litter, at every stage from just-shed and still
      // yellow-green through to black and half composted.
      dead: 0.38 + rng() * 0.58,
    });
  }
}

/**
 * A patch of loose leaf litter with actual thickness.
 *
 * The ground material already paints litter, and painted litter is flat: it
 * has no silhouette against the leaves behind it, it cannot cast a shadow onto
 * itself, and nothing standing in it is occluded by it. A real forest floor is
 * a structural mat several centimetres deep, and the giveaway is at the
 * horizon of the ground plane a few metres ahead, where a texture stays
 * perfectly smooth and a real litter layer breaks into a hundred separate
 * overlapping edges.
 *
 * Three sizes of debris rather than one. A floor made entirely of similar
 * whole leaf blades is the "paper confetti" read: real litter is a graded mix
 * where the big recent falls sit on top of a mat of half-decomposed fragments,
 * with twigs and dropped petioles laced through it, and the fragments are
 * what supply the fine texture that stops the whole layer looking like it was
 * shaken out of a hole punch.
 */
export function litterMat(rng, scale = 1, lod = 0) {
  const leaf = new Builder(), wood = new Builder();
  const m = new THREE.Matrix4(), e = new THREE.Euler();

  /* Decomposition runs from one edge of the patch to the other rather than
   * being drawn per leaf. Rot is a place, not a property of an individual: a
   * damp hollow is black and greasy all the way across and the drier lip of it
   * still has recognisable brown leaves on it, and that correlation is what
   * makes a floor read as decaying rather than as randomly tinted. */
  const wetA = rng() * Math.PI * 2, wetK = 0.30 + rng() * 0.5;
  const wetAt = (x, z) => clamp01(0.5 + wetK * (Math.cos(wetA) * x + Math.sin(wetA) * z) / (0.9 * scale));

  const n = 34 + Math.floor(rng() * 20);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * 0.85 * scale;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    /* A leaf's growth axis is local +Z, so pitch is measured up from the
     * horizontal and flat litter is pitch ~0. Never exactly flat, though: a
     * leaf lying on other leaves is tipped by whatever is under it. The roll
     * used to run to forty degrees and a good fraction of the mat was
     * standing on edge like a card index, which is why it read as scattered
     * paper — real litter lies down, and only the curled margins lift. */
    const pitch = (rng() - 0.5) * 0.44;
    /* Which of four kinds of debris this is.
     *
     * "Several litter shape families" is the specific thing the critique
     * asked for, and it is right that one family cannot do the job: a mat
     * built from one shape at a range of sizes and angles is still a mat of
     * one shape, and the eye reads the repeat long before it reads any
     * individual leaf. These four differ in the axis that actually shows at
     * ankle height — how far the thing stands off the ground.
     *
     *  0  a recent whole fall, lying nearly flat with its margins turned up
     *  1  a leaf that has dried into a tube and is sitting proud of the mat
     *  2  a fragment, pressed flat and half composted into the humus
     *  3  a chewed skeleton, big but full of holes, propped on what is under it
     */
    const fam = rng();
    const kind = fam < 0.26 ? 0 : fam < 0.42 ? 1 : fam < 0.80 ? 2 : 3;
    const stand = kind === 1 ? 0.55 + rng() * 0.75 : kind === 3 ? 0.20 + rng() * 0.45 : 0;
    e.set(-pitch - stand, rng() * 6.283, (rng() - 0.5) * 0.55, 'YXZ');
    m.makeRotationFromEuler(e);
    const y = 0.006 + rng() * 0.11;
    m.setPosition(x, y, z);
    const big = kind === 0 || kind === 3;
    const ll = (big ? 0.13 + rng() * 0.16 : 0.045 + rng() * 0.09) * scale;
    const wet = wetAt(x, z);
    addLeaf(leaf, m, {
      len: ll, wid: ll * (0.40 + rng() * 0.55),
      cell: rng() < 0.55 ? CELL.OVATE : CELL.SMALL,
      // Fragments and skeletons are what is left of the most damaged blades.
      vary: kind === 0 ? oldLeaf(rng) : 3,
      bend: (rng() - 0.35) * 0.9, nv: D(lod, 3, 2), nu: D(lod, 2, 1),
      /* Signed, and that is the whole point of this species. A leaf dries
       * from the margins inward and the margins pull up, so a litter layer is
       * a heap of little upturned dishes with air under them — which is why
       * it self-shadows into a mottle instead of averaging to a flat brown.
       * All-positive curl gave every leaf the same downward cup and the mat
       * went back to reading as a printed texture. The curl is stronger on
       * the big recent falls, because a fragment has already been flattened
       * into the mulch. */
      curl: (rng() < 0.62 ? -1 : 1)
          * (kind === 1 ? 1.35 + rng() * 0.75 : big ? 0.55 + rng() * 0.85 : 0.16 + rng() * 0.30),
      // The rolled family also twists hard along its length, which is what
      // turns a dished blade into the little dry tubes real litter is full of.
      roll: (rng() < 0.72 ? -1 : 1) * (kind === 2 ? 0.15 + rng() * 0.3 : 0.5 + rng() * 0.9),
      sag: (rng() - 0.5) * 0.9, phase: rng() * 6.283,
      asym: (rng() - 0.5) * 0.4,
      twist: (rng() - 0.5) * (kind === 1 ? 3.0 : 1.5), flex0: 0.0,
      occ: 0.42 + 0.58 * clamp01(y / 0.10) * (1 - 0.35 * wet),
      // Nothing on a forest floor is at one stage of decay, and the family a
      // piece belongs to says most of where it is in the sequence.
      dead: clamp01((kind === 2 ? 0.55 : 0.16) + 0.40 * wet + rng() * 0.45),
    });
  }

  /* Seed pods, husks and nut cases.
   *
   * The floor was leaves and sticks and nothing else, and a real one is not:
   * a lowland canopy drops an enormous mass of fruit, and the hard, rounded,
   * dark objects that result are the only things down there that are neither
   * a blade nor a line. They matter out of all proportion to their size for
   * that reason — three of them in frame is what stops the litter reading as
   * one material shredded at two scales. Five-sided spindles, so the whole
   * scatter costs less than two broad leaves. */
  const nP = 4 + Math.floor(rng() * 6);
  for (let i = 0; i < nP; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * 0.82 * scale;
    const dir = rng() * 6.283;
    const L = (0.035 + rng() * 0.075) * scale;
    const fat = (0.011 + rng() * 0.022) * scale;
    const tilt = (rng() - 0.5) * 0.5;
    const pts = [], radii = [];
    const rings = D(lod, 3, 2);
    for (let k = 0; k <= rings; k++) {
      const s = k / rings;
      pts.push(new THREE.Vector3(
        Math.cos(a) * rr + Math.cos(dir) * L * (s - 0.5),
        0.010 + fat * 0.5 + tilt * L * (s - 0.5),
        Math.sin(a) * rr + Math.sin(dir) * L * (s - 0.5)));
      // Fat in the middle and closed at both ends: a pod, not a length of pipe.
      radii.push(fat * (0.18 + 0.82 * Math.sin(Math.PI * (0.12 + 0.76 * s))));
    }
    const split = rng() < 0.35;
    addTube(wood, pts, radii, D(lod, 5, 4), 1, 0.0, { u0: 0, v0: 0 }, 1, {
      occ: (aa, s, up) => 0.34 + 0.5 * Math.max(0, up),
      // A pod that has already dehisced shows pale dry pith inside its rim.
      moss: () => (split ? -0.45 : 0.10),
    });
  }

  /* Twigs and dropped petioles. Under a canopy that sheds branches constantly
   * these are as much of the floor by area as the leaves are, and they are the
   * one element that gives the mat a hard straight edge to break up all those
   * soft blade outlines. Four-sided tubes, so a dozen of them cost less than
   * one broad leaf. */
  const nT = 5 + Math.floor(rng() * 7);
  for (let i = 0; i < nT; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * 0.8 * scale;
    const x0 = Math.cos(a) * rr, z0 = Math.sin(a) * rr;
    const dir = rng() * 6.283, bendK = (rng() - 0.5) * 1.1;
    const L = (0.14 + rng() * 0.5) * scale;
    const r0 = (0.005 + rng() * 0.013) * scale;
    const pts = [], radii = [];
    for (let k = 0; k <= 3; k++) {
      const s = k / 3;
      const th = dir + bendK * s;
      pts.push(new THREE.Vector3(
        x0 + Math.cos(th) * L * s,
        0.006 + Math.sin(s * Math.PI) * 0.018 * scale + rng() * 0.006,
        z0 + Math.sin(th) * L * s));
      radii.push(r0 * (1 - 0.55 * s));
    }
    const bare = rng() < 0.45;
    addTube(wood, pts, radii, 4, 2, 0.0, { u0: 0, v0: 0 }, 1, {
      occ: () => 0.40 + 0.35 * rng(),
      // Bark gone and the sapwood weathered pale, or still barked and mossy.
      moss: () => (bare ? -0.35 - 0.4 * rng() : 0.25 + 0.4 * rng()),
    });
    /* Twigs that fork. A floor scattered with straight single sticks looks
     * swept and re-dressed; what falls off a tree is a branchlet, and the Y
     * where it divided is the shape that says so. Two thirds of them keep the
     * fork because it is nine triangles. */
    const forkAt = 0.35 + rng() * 0.4, sideDir = dir + (rng() - 0.5) * 2.4;
    if (rng() < 0.62) {
      const bx = x0 + Math.cos(dir + bendK * forkAt) * L * forkAt;
      const bz = z0 + Math.sin(dir + bendK * forkAt) * L * forkAt;
      const bl = L * (0.25 + rng() * 0.35);
      const bp = [], br = [];
      for (let k = 0; k <= 2; k++) {
        const s = k / 2;
        bp.push(new THREE.Vector3(bx + Math.cos(sideDir) * bl * s,
                                  0.007 + Math.sin(s * 2.2) * 0.012 * scale,
                                  bz + Math.sin(sideDir) * bl * s));
        br.push(r0 * 0.55 * (1 - 0.6 * s));
      }
      addTube(wood, bp, br, 4, 1, 0.0, { u0: 0, v0: 0 }, 1, {
        occ: () => 0.38, moss: () => (bare ? -0.4 : 0.28),
      });
    }
  }

  /* The surface root that used to arc through every second patch has gone,
   * and it is worth recording why, because the object itself was right and
   * the place it lived was wrong.
   *
   * It was here because a low arc of root is one of the few things at ankle
   * height that is not a leaf. But a litter patch is a *scatter*, and once
   * the placement started drawing patch scales over a genuinely wide range —
   * which is what "mix several scales" required — the root scaled with
   * everything else. At the top of that range it became a four-metre, half-
   * metre-thick tube of bark lying across the trail, with the bark map
   * stretched over its length until the fissure network read as a few smooth
   * swells: a slab of putty, and by some margin the worst object in the
   * frame. Nothing about the root was wrong; it simply must not be a
   * multiple of a quantity that exists to vary the size of leaf fragments.
   *
   * Roots are now their own species with their own scale, their own sane
   * range and an orientation chosen from the terrain — see rootRun. */

  // No collision proxy: a litter mat is ankle-deep leaf debris and the one
  // thing it must not do is stop the player, the way the other scatter
  // species here also return none.
  return { leaf: leaf.geometry(), wood: wood.geometry() };
}

/**
 * Sapling: a thin stem with a few disproportionately large leaves.
 *
 * These are what actually fill a rainforest at head height, and their
 * proportions are counter-intuitive — a two-metre sapling on the forest floor
 * carries leaves nearly as big as a mature tree's, because it is starved of
 * light and has to maximise area per unit of stem. Drawing them to scale, with
 * small leaves, is a common and very visible mistake.
 */
export function sapling(rng, scale = 1, lod = 0, vi = 0) {
  /* Phyllotaxis, per variant, because it is the cheapest architectural
   * variation there is and one of the most legible. A seedling with paired
   * leaves at each node, one with them in threes, and one carrying pinnately
   * compound leaves are three different plants at any distance where the stem
   * resolves at all, and they cost exactly the same as three copies of the
   * spiral one. */
  const PHYL = { SPIRAL: 0, OPPOSITE: 1, WHORL: 2, PINNATE: 3 };
  const phyl = vi % 4;
  const leaf = new Builder(), wood = new Builder();
  /* Kept well under head height on average. The first version ran to nearly
   * seven metres before the instance scale was applied, which planted a stand
   * of eleven-metre poles two metres apart along the whole trail: from the
   * ground that is not an understory, it is a bamboo grove, and it was the
   * single thing making the forest read as temperate. A real seedling bank is
   * knee-to-shoulder high and only the occasional individual has got away. */
  const h = (1.1 + rng() * 2.6) * scale * (rng() < 0.12 ? 1.9 : 1.0);
  const lean = (rng() - 0.5) * 1.05;
  const seg = 5;
  const pts = [], radii = [];
  for (let k = 0; k <= seg; k++) {
    const s = k / seg;
    pts.push(new THREE.Vector3(
      lean * h * s * s, h * s, lean * 0.5 * h * s * s * Math.sin(s * 2.7 + 1.0)));
    radii.push((0.014 + 0.038 * (1 - s)) * scale * (h / 3));
  }
  addTube(wood, pts, radii, 5, Math.max(3, Math.round(h / 0.7)), 0.85,
          { u0: 0, v0: 0 }, 1, {
            occ: (a, s) => 0.32 + 0.68 * smooth01(s * 5),
            moss: (a, s) => smooth01((0.18 - s) / 0.18) * 0.3,
          });

  const m = new THREE.Matrix4(), e = new THREE.Euler();
  /* How many leaves leave the stem together, and how many nodes there are.
   *
   * The node count is divided by the leaves per node so a paired-leaf sapling
   * carries about as much foliage as a spiral one rather than twice as much:
   * the point of the variation is a different arrangement of the same plant,
   * not a bigger plant. */
  const perNode = phyl === PHYL.OPPOSITE ? 2 : phyl === PHYL.WHORL ? 3 : 1;
  const nNode = Math.max(2, Math.round((5 + rng() * 9) / perNode));
  const spin = rng() * 6.283;
  for (let i = 0; i < nNode; i++) {
    /* Leaves go up the stem in order, whatever the arrangement.
     *
     * Scattering leaf positions and bearings independently is the difference
     * between a plant and a bunch: a random scatter puts three leaves on the
     * same side at the same height and leaves a bare quarter turn elsewhere,
     * which no seedling does, because a seedling that shaded its own leaves
     * would die. The golden angle is what real alternate phyllotaxis
     * approximates; paired leaves cross at a right angle from node to node,
     * which is why a decussate stem looks square from above. */
    const s = clamp01(0.40 + ((i + 0.5) / nNode) * 0.58 + (rng() - 0.5) * 0.10);
    const k = Math.min(seg, Math.round(s * seg));
    const nodeYaw = spin + (perNode === 1 ? i * 2.39996
                          : perNode === 2 ? i * 1.5708 : i * 1.1);
    for (let j = 0; j < perNode; j++) {
      const yaw = nodeYaw + (j / perNode) * 6.283 + (rng() - 0.5) * 0.42;
      const pitch = 0.38 + rng() * 0.52;
      const ll = (0.42 + rng() * 0.65) * scale / (perNode > 1 ? 1.28 : 1);

      /* A petiole, drooping under the weight of the blade. Sapling leaves
       * used to erupt straight out of the stem with no stalk at all, which is
       * most of why these read as leaves stuck on a pole: the join carried no
       * information, so the eye had nothing to tell it the two parts belonged
       * to one organism. A compound leaf's is longer, because the whole rank
       * of leaflets has to clear the stem. */
      const gx = Math.sin(yaw) * Math.cos(pitch);
      const gy = Math.sin(pitch), gz = Math.cos(yaw) * Math.cos(pitch);
      const pl = ll * (phyl === PHYL.PINNATE ? 0.30 + rng() * 0.16
                                             : 0.15 + rng() * 0.20);
      const pp = [], pr = [];
      for (let q = 0; q <= 2; q++) {
        const u = q / 2;
        pp.push(new THREE.Vector3(
          pts[k].x + gx * pl * u,
          pts[k].y + gy * pl * u - 0.22 * pl * u * u,
          pts[k].z + gz * pl * u));
        pr.push(radii[k] * 0.30 * (1 - 0.3 * u) + 0.004 * scale);
      }
      addTube(wood, pp, pr, 4, 1, 0.9, { u0: 0, v0: 0 }, 1,
              { occ: (a, u) => 0.42 + 0.5 * u });

      e.set(-pitch * 0.7, yaw, (rng() - 0.5) * 0.9, 'YXZ');
      m.makeRotationFromEuler(e);
      m.setPosition(pp[2].x, pp[2].y, pp[2].z);
      if (phyl === PHYL.PINNATE) {
        /* A compound leaf on a sapling — the young inga, cedrela and cassia
         * habit, and enormously common in a seedling bank. It reuses the
         * frond builder because a pinnate leaf is a frond: what makes it read
         * as a tree seedling instead of a fern is the pinnae being few and
         * broad rather than many and narrow. */
        addPinnate(leaf, m, {
          len: ll * 1.35, wid: ll * (0.52 + rng() * 0.22),
          vary: s < 0.6 ? oldLeaf(rng) : anyLeaf(rng),
          bend: 0.5 + rng() * 0.9, twist: (rng() - 0.5) * 0.6,
          sag: (rng() - 0.5) * 0.5, phase: rng() * 6.283, id: rng(),
          pinnae: 3 + ((rng() * 3) | 0), nv: D(lod, 5, 3),
          pnv: D(lod, 3, 2), pnu: D(lod, 2, 1),
          flex0: 0.35 + s * 0.4, rng,
          deadTip: s < 0.55 ? 0.15 + rng() * 0.4 : 0,
        });
        continue;
      }
      addLeaf(leaf, m, {
        len: ll, wid: ll * (0.40 + rng() * 0.26),
        cell: rng() < 0.7 ? CELL.OVATE : CELL.LANCE,
        // Lowest leaves are the oldest and the most eaten.
        vary: s < 0.6 ? oldLeaf(rng) : anyLeaf(rng),
        bend: 0.8 + rng() * 1.3, curl: 0.16 + rng() * 0.26,
        relax: 0.45 + rng() * 0.35,
        roll: (rng() < 0.6 ? 1 : -1) * (0.18 + rng() * 0.40),
        ripple: 0.06 + rng() * 0.12, asym: (rng() - 0.5) * 0.28,
        tilt: (rng() - 0.5) * 0.34, nick: 0.05 + rng() * 0.09, id: rng(),
        sag: (rng() - 0.5) * 0.65, phase: rng() * 6.283,
        nv: D(lod, 5, 4), nu: D(lod, 5, 3),
        twist: (rng() - 0.5) * 1.1, flex0: 0.35 + s * 0.4,
        deadTip: s < 0.55 && rng() < 0.3 ? 0.3 + rng() * 0.4 : 0,
      });
    }
  }
  addLitterSkirt(leaf, rng, 0.04, 0.54 * scale, 9, 0.14 * scale, lod);
  return { leaf: leaf.geometry(), wood: wood.geometry() };
}

/**
 * A fallen trunk, rotting on the floor.
 *
 * Treefall is the main disturbance event in a rainforest and the floor is
 * littered with the results at every stage of decay. A forest floor with no
 * deadwood on it is a managed one, and the absence reads as tidiness even to
 * someone who could not name what is missing.
 *
 * Almost everything below is about the two ends and the underside. A log that
 * is a smooth tube with flat open ends is a length of pipe, and it reads as
 * one instantly: a real fallen trunk snapped, so both ends are a ring of
 * splinters at different lengths, its bark has come away in patches to show
 * pale punky heartwood, moss has taken the upper surface only, and it is
 * half-sunk into the litter with no light at all reaching underneath it.
 */
export function log(rng, scale = 1, lod = 0) {
  const leaf = new Builder(), wood = new Builder();
  const len = (2.6 + rng() * 6.0) * scale;
  const rad = (0.15 + rng() * 0.28) * scale;
  const seg = 20;

  /* Where this log is rotting hardest.
   *
   * Decay in a fallen trunk is not uniform and it is not a gradient: it is
   * one or two patches, usually where the log touches the ground or where a
   * limb was torn out, and within a patch the wood has lost most of its
   * volume and gone to punk. Everywhere else the trunk is still sound. The
   * previous version had one smooth taper and two rot sines running the whole
   * length, which is a swollen tube with ripples on it — a shape with no
   * *incident* in it, and "smooth swollen tube" is exactly what a shape with
   * no incident looks like. */
  const nRot = 1 + ((rng() * 2) | 0);
  const rots = [];
  for (let i = 0; i < nRot; i++) {
    rots.push({
      at: 0.18 + rng() * 0.64,
      wid: 0.06 + rng() * 0.10,
      // A collapsed patch has lost between a fifth and half its radius. Less
      // than that is a ripple; more and the log looks bitten through.
      deep: 0.22 + rng() * 0.30,
      ang: rng() * 6.283,
    });
  }
  const rotAt = (s) => {
    let d = 0;
    for (const t of rots) d += t.deep * Math.exp(-Math.pow((s - t.at) / t.wid, 2));
    return Math.min(0.62, d);
  };

  const pts = [], radii = [];
  const bowY = rng() * 0.30, bowZ = (rng() - 0.5) * 0.8;
  const rotPh = rng() * 6.283, rotPh2 = rng() * 6.283;
  for (let k = 0; k <= seg; k++) {
    const s = k / seg;
    pts.push(new THREE.Vector3(
      (s - 0.5) * len,
      rad * 0.38 + Math.sin(s * Math.PI) * bowY * rad,
      Math.sin(s * 2.2) * bowZ));
    /* Tapers toward the crown end, and it is thinner where it has rotted.
     * Two frequencies of rot rather than one: a single sine is a swelling
     * that repeats at a constant pitch, which on a five-metre trunk reads as
     * a series of identical sausages. */
    const r = rad * (1 - 0.52 * s)
              * (0.86 + 0.22 * Math.sin(s * 9.0 + rotPh))
              * (0.92 + 0.16 * Math.sin(s * 3.3 + rotPh2))
              * (1 - rotAt(s));
    /* Very nearly full radius right to both ends, because the ends are no
     * longer ends: they are breaks, closed by a recessed socket and a collar
     * of splintered fibre. Pinching the sweep shut over the last five
     * centimetres — which is what this did — turns a break into a bolster,
     * and no tree has ever broken into a hemisphere. A quarter is taken off
     * over the last tenth only because wood does crush a little as it goes,
     * and because it keeps the socket's rim inside the log's silhouette
     * rather than level with it. */
    radii.push(r * (0.76 + 0.24 * Math.min(smooth01(s / 0.10),
                                           smooth01((1 - s) / 0.10))));
  }

  const brk0 = rng() * 6.283, brk1 = rng() * 6.283;
  const oval = 0.06 + rng() * 0.08, ovalPh = rng() * 6.283;
  const barePh = rng() * 6.283;
  const splitPh = rng() * 6.283, splitN = 2 + ((rng() * 3) | 0);
  /* A rot hole in the flank. One cavity, big enough to put a hand in, on the
   * shaded side — it is the single feature that most says "this wood is
   * hollow and full of insects" rather than "this is a shape". It is worth
   * more than any amount of surface detail because it is the only place on
   * the log where the silhouette is interrupted and the only place that goes
   * genuinely black. */
  const cav = { at: rots[0].at + (rng() - 0.5) * 0.10, ang: rots[0].ang,
                wid: 0.055 + rng() * 0.045, aw: 0.55 + rng() * 0.35,
                deep: 0.34 + rng() * 0.26 };
  const cavAt = (a, s) => {
    let d = a - cav.ang;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.exp(-Math.pow(d / cav.aw, 2) - Math.pow((s - cav.at) / cav.wid, 2));
  };
  const profile = (a, s) => {
    let p = 1 + oval * Math.cos(a * 2 + ovalPh) + 0.05 * Math.cos(a * 5 - s * 2.0);
    /* An out-of-round section that changes as it runs. The old term was two
     * fixed harmonics, so every cross-section of the log was the same oval in
     * the same orientation and the whole thing extruded — which is most of
     * what made it read as machined. Drifting the phase with length means no
     * two sections match and the highlight running down the top of it wanders
     * instead of being a straight line. */
    p += 0.055 * Math.cos(a * 3 + s * 5.3 + ovalPh * 1.7)
       + 0.035 * Math.cos(a * 7 - s * 8.1 + splitPh);
    /* The break at each end tore the fibres off at different lengths around
     * the circumference — but not into four lobes of ninety per cent, which
     * is what this was and which is precisely the "blunt peg-like breaks" the
     * critique named. A single harmonic at that amplitude is a four-pointed
     * star, and a four-pointed star swept over the last sixth of a log is
     * four pegs; there is no texture or shading that makes four identical
     * radially-symmetric prongs read as a tear. Three incommensurate
     * harmonics at a third of the amplitude give an outline with no symmetry
     * and no repeat, and the raggedness that the big term was trying to
     * supply now comes from the splinters, which is where raggedness on a
     * broken end actually lives. */
    const e = Math.max(smooth01((0.14 - s) / 0.14), smooth01((s - 0.86) / 0.14));
    const bph = s < 0.5 ? brk0 : brk1;
    p *= 1 + e * (0.34 * Math.cos(a * 3 + bph)
                + 0.26 * Math.cos(a * 5 - bph * 1.7)
                + 0.17 * Math.cos(a * 8 + bph * 0.6));
    /* Heart checks. A trunk that has been down for a few wet seasons splits
     * along the grain as the sapwood shrinks, and those two or three deep
     * dark lines running the length of it are the most recognisable thing
     * about deadwood — much more so than any amount of bark texture, because
     * they are the only high-contrast feature that survives the log being in
     * shade. The high power keeps them as creases rather than as lobes. */
    p -= 0.12 * Math.pow(Math.max(0, Math.cos(a * splitN + s * 0.9 + splitPh)), 9.0);
    // Where the bark has sloughed the log is a bark's thickness thinner, and
    // the step at the edge of the patch is what makes the loss read.
    const bare = smooth01((Math.sin(s * 5.1 + barePh) - 0.15) / 0.45)
               * Math.max(0, Math.sin(a * 1.7 + s * 3.3 + barePh));
    p *= 1 - 0.075 * bare;
    p -= cav.deep * cavAt(a, s);
    return Math.max(0.10, p);
  };

  addTube(wood, pts, radii, D(lod, 12, 7), Math.max(3, Math.round(len / 0.72)), 0.0,
          { u0: 0, v0: 0 }, Math.max(1, Math.round(2 * Math.PI * rad / 0.95)), {
            profile,
            // Nothing gets under a log. The underside is the darkest surface
            // in the scene and the contact line is what sits it in the litter
            // rather than on top of it. The cavity is darker than the
            // underside: it is a hole, and the light that reaches the back of
            // a hole is none.
            occ: (a, s, up) => (0.16 + 0.84 * smooth01((up + 0.5) / 1.2))
                             * (0.55 + 0.45 * smooth01(Math.min(s, 1 - s) / 0.08))
                             * (1 - 0.88 * cavAt(a, s)),
            moss: (a, s, up) => {
              const m = Math.max(0, up) * (0.25 + 0.60 * Math.max(0,
                Math.sin(a * 2.3 + s * 7.0)));
              /* Bark sloughed off in bands, exposing weathered sapwood, and
               * mostly gone over the collapsed patches — punk wood has little
               * bark left on it and is the pale orange-brown that negative
               * moss already means. Modulated by angle rather than taken
               * straight from the rot depth: at full strength the whole
               * collapsed section went to bare sapwood at once, and a metre
               * of uniform pale on a log is a poured concrete kerb. Rot
               * spreads from where the wood touches the ground, so the
               * underside of a decaying stretch is punk and the crown of it
               * still carries bark. */
              const bare = Math.max(
                smooth01((Math.sin(s * 5.1 + barePh) - 0.15) / 0.45)
                  * Math.max(0, Math.sin(a * 1.7 + s * 3.3 + barePh)) * 0.9,
                rotAt(s) * (0.55 + 0.75 * smooth01(0.35 - up))
                         * (0.55 + 0.45 * Math.sin(a * 2.6 + s * 4.0 + barePh)));
              return bare > m ? -Math.min(1, bare) : m;
            },
          });

  /* Both breaks. A trunk snaps in tension across the grain and in shear along
   * it, so the end of a fallen bole is never a face: it is a ragged collar of
   * long fibres around a recessed, paler, hollowing centre. Building it as
   * separate geometry rather than as more profile terms is the only way to
   * get fibres that stand clear of the silhouette, and standing clear of the
   * silhouette is the whole point — a break that stays inside the tube's
   * outline is a texture, and the eye reads a texture as paint. */
  for (const end of [0, 1]) {
    const ki = end ? seg : 0;
    const r0 = radii[ki];
    const AX = _v().set(end ? 1 : -1, 0, 0);
    /* Not reduced at distance, unlike the tessellation around it. The LOD
     * contract only allows detail levels to differ in how finely a thing is
     * subdivided — dropping two splinters at range would change how many
     * times the shared stream is drawn and turn the far version into a
     * different log, which pops on the swap instead of softening. */
    const nSpl = 5 + ((rng() * 4) | 0);
    /* A socket, and it has to be stitched to the tube rather than merely
     * placed over its mouth.
     *
     * Two versions of this went wrong in the same way and both faults were in
     * the fit rather than in the idea. The first was a flat fan, which on the
     * one log in the scene whose break faces the camera filled a quarter of
     * the frame with a single pale evenly-lit facet. The second sized its rim
     * by an independent expression, so it did not coincide with the tube's
     * last ring: at nine segments against a section carrying a four-lobed
     * break term it produced a wild star with metre-long straight edges, and
     * because its own uv only spanned a quarter of a tile the bark on it was
     * magnified until the fissure net came out as a few smooth swells. The
     * result read as a sheet of putty stuck on the end of the log — worse
     * than the blunt hemisphere either of them replaced.
     *
     * So the rim is now *exactly* the tube's own last ring: the same segment
     * count, the same radius function at the same station, and the same uv
     * scale, which makes the join watertight, keeps the bark at one texel
     * density across it and puts the star-shaped tearing where it belongs —
     * in the profile that both surfaces share. Inside that rim the wall falls
     * away in two steps to a recessed floor, so a break is a hole with a lip
     * rather than a face: the normals sweep from radial at the lip to axial
     * at the bottom, which is the only way this surface can turn through the
     * light at all, and the occlusion ramp down the wall does the rest. */
    const cbase = wood.count;
    const fn = D(lod, 12, 7);
    const uvSpan = Math.max(1, Math.round(2 * Math.PI * rad / 0.95));
    const vEnd = end ? Math.max(3, Math.round(len / 0.72)) : 0;
    const CN = _v();
    /* The floor of the socket is the darkest surface on the log and it is not
     * pale. Weathered sapwood at a break is pale where the air gets at it —
     * the lip, the standing fibres — and the heart at the back of a hole
     * stays wet, keeps its bark-dark colour and never sees a photon. Giving
     * the whole face the heartwood tint was what made the first two versions
     * read as a sheet of putty stuck on the end of the log: the pallor has to
     * be graded from the rim inward or it is just a light-coloured lid. */
    wood.anchor(null).surface(0.05, 0.0);
    wood.vert(_v().set(pts[ki].x - AX.x * r0 * 1.15, pts[ki].y, pts[ki].z),
              AX, 0.5 * uvSpan, vEnd, 0);
    for (const ring of [0.52, 1.0]) {
      for (let j = 0; j <= fn; j++) {
        const a = (j / fn) * Math.PI * 2;
        const rr = r0 * profile(a, end) * ring;
        /* Neither ring lies in a plane. Wood tears at different depths around
         * the circumference, and an end whose boundary is planar is a saw cut
         * — the one thing a fallen trunk in a forest has definitely not had
         * done to it. The rim itself is left flush so the seam stays closed;
         * all the depth variation is on the inner ring, where it shows as a
         * ragged lip against the dark of the socket. */
        const dx = -r0 * (1.15 * (1 - ring)
                          + 0.55 * (1 - ring) * (0.5 + 0.5 * Math.sin(a * 2.3 + brk1)));
        CN.set(AX.x * (1 - ring) * 2.2, Math.sin(a) * ring, Math.cos(a) * ring).normalize();
        /* Dark at the bottom of the socket and lit on the torn rim, and pale
         * in inverse proportion: the fibres at the lip are weathered grey
         * sapwood and the heart at the back of the hole is wet, dark and half
         * rotten. */
        wood.surface(0.05 + 0.42 * ring * ring * (0.7 + 0.3 * Math.sin(a * 5.0 + brk0)),
                     -0.62 * ring * ring * (0.6 + 0.4 * Math.sin(a * 3.7 + brk1)));
        wood.vert(_v().set(pts[ki].x + AX.x * dx,
                           pts[ki].y + Math.sin(a) * rr,
                           pts[ki].z + Math.cos(a) * rr),
                  CN, (j / fn) * uvSpan, vEnd, 0);
      }
    }
    /* Wound the other way at the far end. Both ends walk the section in the
     * same direction in (y, z), so a single index order faces outward at one
     * of them and inward at the other — and the wood material is FrontSide,
     * which means half the breaks in the forest would have simply had no
     * visible face at all. */
    const r1 = cbase + 1, r2 = cbase + 1 + fn + 1;
    for (let j = 0; j < fn; j++) {
      const a1 = r1 + j, b1 = r1 + j + 1, a2 = r2 + j, b2 = r2 + j + 1;
      if (end) {
        wood.quad(cbase, b1, a1, cbase);
        wood.quad(a1, a2, b2, b1);
      } else {
        wood.quad(cbase, a1, b1, cbase);
        wood.quad(a1, b1, b2, a2);
      }
    }

    /* The fibres themselves: long slivers of sapwood still attached at the
     * root and torn to a point, at wildly different lengths. The variation in
     * length is what does the work — a collar of equal spikes is a crown, and
     * a crown is as artificial as the hemisphere it replaced. */
    for (let i = 0; i < nSpl; i++) {
      const a = rng() * Math.PI * 2;
      const rr = r0 * profile(a, end) * (0.55 + 0.42 * rng());
      /* Shortened by more than half from the first attempt, which ran to
       * nearly three radii and produced a bundle of metre-long dowels lying
       * across the litter. A splinter is a torn fibre, not a branch: past
       * about a radius it stops reading as part of the break and starts
       * reading as deadfall that happens to be touching it. */
      const L = r0 * (0.20 + Math.pow(rng(), 1.7) * 1.0);
      const p0 = _v().set(pts[ki].x - AX.x * r0 * 0.25,
                          pts[ki].y + Math.sin(a) * rr,
                          pts[ki].z + Math.cos(a) * rr);
      const sp = [], sr = [];
      for (let k = 0; k <= 2; k++) {
        const u = k / 2;
        sp.push(_v().copy(p0)
          .addScaledVector(AX, (r0 * 0.25 + L) * u)
          // Splinters do not point straight out; they splay and curl as they
          // dry, and a shaft that bends is the difference between a torn
          // fibre and a dowel.
          .add(_v().set(0, Math.sin(a) * L * 0.22 * u * u + (rng() - 0.5) * 0.01,
                        Math.cos(a) * L * 0.22 * u * u)));
        sr.push(r0 * (0.14 - 0.12 * u) * (0.5 + rng() * 0.9) + 0.002 * scale);
      }
      const dirt = 0.26 + 0.26 * rng();
      addTube(wood, sp, sr, D(lod, 4, 3), 1, 0.0, { u0: 0, v0: 0 }, 1, {
        occ: () => dirt,
        // Torn fibre is bare wood along its whole length by definition, and
        // greyer the longer it has been weathering at the tip.
        moss: (aa, s) => -(0.40 + 0.35 * s),
      });
    }
  }
  wood.anchor(null).surface(1, 0);

  /* Snapped-off branch stubs. A trunk that came down took its limbs with it,
   * and the two or three stubs left pointing out of it are the fastest way to
   * say "this was a tree" rather than "this is a cylinder on the ground". */
  const nStub = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < nStub; i++) {
    const s0 = 0.15 + rng() * 0.7;
    const ki = Math.min(seg, Math.floor(s0 * seg));
    const a = rng() * Math.PI * 2;
    const L = (0.14 + rng() * 0.4) * scale;
    const r0 = radii[ki];
    // Biased upward: a stub on the underside is buried in the litter and only
    // costs triangles, and one pointing straight down inverts the sweep frame.
    const dy = Math.abs(Math.sin(a)) * 0.8 + 0.2, dz = Math.cos(a);
    const sp = [], sr = [];
    for (let k = 0; k <= 2; k++) {
      const s = k / 2;
      const d = r0 * 0.4 + (r0 * 0.6 + L) * s;
      sp.push(new THREE.Vector3(pts[ki].x + (rng() - 0.5) * 0.02,
                                pts[ki].y + dy * d, pts[ki].z + dz * d));
      sr.push(r0 * (0.34 - 0.20 * s) + 0.008 * scale);
    }
    addTube(wood, sp, sr, 5, 1, 0.0, { u0: 0, v0: 0 }, 1, {
      occ: (aa, s, up) => 0.30 + 0.6 * Math.max(0, up),
      moss: (aa, s, up) => (up > 0.2 ? 0.4 : -0.3),
    });
  }

  // Litter banked along the downhill side, and things growing out of it.
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  const n = Math.floor(len * 6);
  for (let i = 0; i < n; i++) {
    const s = rng();
    const k = Math.min(seg, Math.floor(s * seg));
    const side = rng() < 0.5 ? -1 : 1;
    e.set(-(0.05 + rng() * 0.40), rng() * 6.283, (rng() - 0.5) * 0.9, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(pts[k].x + (rng() - 0.5) * 0.4,
                  rng() * rad * 1.1,
                  pts[k].z + side * rad * (0.7 + rng() * 1.5));
    const ll = (0.10 + rng() * 0.24) * scale;
    addLeaf(leaf, m, {
      len: ll, wid: ll * (0.5 + rng() * 0.5), cell: CELL.SMALL,
      vary: oldLeaf(rng),
      bend: 0.6 + rng() * 1.0, curl: (rng() < 0.6 ? -1 : 1) * (0.25 + rng() * 0.4),
      roll: (rng() < 0.7 ? -1 : 1) * (0.4 + rng() * 0.7),
      sag: (rng() - 0.5) * 0.8, phase: rng() * 6.283,
      nv: D(lod, 3, 2), nu: 2, twist: (rng() - 0.5) * 1.4, flex0: 0.15,
      occ: 0.4 + 0.5 * rng(), dead: 0.35 + rng() * 0.55,
    });
  }
  // Seedlings and sprigs colonising the top of it — a nurse log is the
  // brightest patch of bare substrate on the whole floor and everything
  // germinates on it.
  const nS = 2 + ((rng() * 5) | 0);
  for (let i = 0; i < nS; i++) {
    const s = 0.15 + rng() * 0.7;
    const k = Math.min(seg, Math.floor(s * seg));
    const a = (rng() - 0.5) * 1.6;
    e.set(-(0.5 + rng() * 0.7), rng() * 6.283, (rng() - 0.5) * 0.5, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(pts[k].x + (rng() - 0.5) * 0.15,
                  pts[k].y + radii[k] * 0.85, pts[k].z + Math.sin(a) * radii[k] * 0.6);
    const ll = (0.07 + rng() * 0.16) * scale;
    addLeaf(leaf, m, {
      len: ll, wid: ll * (0.5 + rng() * 0.4), cell: CELL.SMALL,
      vary: freshLeaf(rng),
      bend: 0.7 + rng() * 0.9, curl: 0.3, nv: 2, nu: 2,
      twist: (rng() - 0.5) * 1.0, flex0: 0.35, occ: 0.75,
    });
  }
  return {
    leaf: leaf.geometry(),
    wood: wood.geometry(),
    /* The sweep bows, so use its actual end stations rather than assuming the
     * visual remained on the local x axis. A capsule intentionally ignores the
     * splinters: they should affect the outline, not enlarge the obstruction. */
    solid: {
      type: 'log',
      a: [pts[0].x, pts[0].y, pts[0].z],
      b: [pts[seg].x, pts[seg].y, pts[seg].z],
      radius: rad * 1.18,
    },
  };
}

/**
 * An exposed surface root crossing the ground, with the debris caught against
 * its uphill side.
 *
 * This exists for the trail margin specifically. A worn path through a forest
 * does not have an edge in the sense of a line: it has a *structure*, and the
 * structure is roots. Traffic and runoff strip the litter and the topsoil off
 * the tread, so the lateral roots of everything growing along it are left
 * standing proud, running out of the bank, over the bare ground and back
 * under it, with a windrow of swept leaves banked on the upslope side of each
 * one and scoured soil below. That is what makes a trail look walked rather
 * than drawn, and no amount of work on the density gradient can produce it,
 * because the gradient is a continuous function and this is an *object*.
 *
 * The centreline crosses the ground plane several times on purpose. Anything
 * that stays above the soil is a cable lying on it; a root that submerges and
 * surfaces gets clipped by the terrain into a series of separate arcs, which
 * is both what a real one looks like and free — the geometry does the work
 * the depth buffer is doing anyway.
 */
export function rootRun(rng, scale = 1, lod = 0) {
  const leaf = new Builder(), wood = new Builder();
  const len = (1.7 + rng() * 2.2) * scale;
  const rad = (0.030 + rng() * 0.055) * scale;
  const seg = D(lod, 13, 7);

  const wobF = 1.6 + rng() * 2.4, wobP = rng() * 6.283;
  const riseF = 2.2 + rng() * 2.6, riseP = rng() * 6.283;
  const lean = (rng() - 0.5) * 0.9;
  /* How much of the run is above the soil. Low values give a root that barely
   * breaks the surface twice along its length, high ones an arch you would
   * trip over; both exist on a real path and the difference between them is
   * most of the variation between instances. */
  const bare = 0.55 + rng() * 1.35;
  const at = (u) => _v().set(
    (u - 0.5) * len,
    rad * (bare * Math.sin(u * riseF * 3.1 + riseP) - 0.45),
    lean * len * (u - 0.5) * 0.6
      + 0.10 * len * Math.sin(u * wobF * 2.4 + wobP));

  const pts = [], radii = [];
  for (let k = 0; k <= seg; k++) {
    const u = k / seg;
    pts.push(at(u));
    /* Thick at the trunk end and tapering, with the swellings a woody root
     * gets where it has been growing round a stone for thirty years. Not a
     * cone: a smoothly tapering cylinder on a forest floor is a hosepipe. */
    radii.push(rad * (1.05 - 0.55 * u)
                   * (0.82 + 0.30 * Math.sin(u * 5.3 + wobP))
                   * (0.90 + 0.18 * Math.sin(u * 11.0 - riseP)));
  }
  addTube(wood, pts, radii, D(lod, 7, 5), Math.max(2, Math.round(len / 0.8)), 0.0,
          { u0: 0, v0: 0 }, 1, {
            /* Ovalled and slightly flat-topped, which is what a root that has
             * been walked on for years actually looks like: the bark on the
             * crown is worn smooth and pale and the sides keep theirs. */
            profile: (a, s) => 1 + 0.16 * Math.cos(a * 2 + wobP)
                                 - 0.10 * Math.pow(Math.max(0, Math.cos(a)), 3.0),
            // Buried below, lit on the crown, and darkest right at the soil
            // line where the litter is banked against it.
            occ: (a, s, up) => 0.20 + 0.72 * smooth01((up + 0.35) / 1.1),
            /* Moss on the shaded flanks, bare polished heartwood along the
             * top. Both at once is the point: a root that is uniformly one or
             * the other is a length of dowel, and the worn crown is the only
             * thing on the forest floor that is genuinely pale. */
            moss: (a, s, up) => (up > 0.55
              ? -(0.30 + 0.45 * smooth01((up - 0.55) / 0.45))
              : 0.30 + 0.40 * Math.max(0, Math.sin(a * 2.2 + s * 5.0))),
          });

  /* One or two daughters. A single arc is a shape; a fork is a system, and
   * the fork is what tells the eye that the rest of it is under the soil. */
  const nFork = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < nFork; i++) {
    const u0 = 0.25 + rng() * 0.5;
    const from = at(u0);
    const side = (rng() < 0.5 ? -1 : 1);
    const fl = len * (0.25 + rng() * 0.35);
    const fr = rad * (0.35 + rng() * 0.35);
    const spread = 0.5 + rng() * 0.9;
    const fp = [], frr = [];
    const fseg = D(lod, 5, 3);
    for (let k = 0; k <= fseg; k++) {
      const u = k / fseg;
      fp.push(_v().set(from.x + fl * u * 0.55,
                       from.y + rad * 0.4 * Math.sin(u * 4.0 + wobP) - rad * 1.8 * u * u,
                       from.z + side * fl * u * spread));
      frr.push(fr * (1 - 0.85 * u * u) + 0.003 * scale);
    }
    addTube(wood, fp, frr, D(lod, 5, 4), Math.max(1, Math.round(fl / 0.8)), 0.0,
            { u0: 0, v0: 0 }, 1, {
              occ: (a, s, up) => 0.22 + 0.60 * Math.max(0, up),
              moss: (a, s, up) => (up > 0.5 ? -0.25 : 0.34),
            });
  }

  /* The windrow. Leaves swept along the tread pile up against the upslope
   * face of a root and stop there, so the debris beside one is not the even
   * scatter of the open floor — it is a line of it, packed, on one side only.
   * A dozen blades is enough to say so and they are the cheapest thing in
   * this function. */
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  const bankSide = rng() < 0.5 ? -1 : 1;
  const nL = 9 + ((rng() * 8) | 0);
  for (let i = 0; i < nL; i++) {
    const u = 0.06 + rng() * 0.88;
    const p = at(u);
    const r = rad * (1.05 - 0.55 * u);
    // Tipped up against the root and lying almost flat away from it, which is
    // the shape of every drift that ever piled against an obstruction.
    const off = r * (0.9 + Math.pow(rng(), 0.6) * 4.5);
    e.set(-(0.05 + rng() * 0.5) * (1 - off / (r * 5.5)),
          rng() * 6.283, (rng() - 0.5) * 0.7, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(p.x + (rng() - 0.5) * 0.25 * scale,
                  Math.max(-r * 0.3, p.y - r * 0.55) + rng() * r * 0.7,
                  p.z + bankSide * off);
    const ll = (0.055 + rng() * 0.16) * scale;
    addLeaf(leaf, m, {
      len: ll, wid: ll * (0.42 + rng() * 0.5),
      cell: rng() < 0.5 ? CELL.OVATE : CELL.SMALL, vary: oldLeaf(rng),
      bend: (rng() - 0.3) * 0.9, nv: D(lod, 3, 2), nu: 2,
      curl: (rng() < 0.6 ? -1 : 1) * (0.3 + rng() * 0.7),
      roll: (rng() < 0.7 ? -1 : 1) * (0.3 + rng() * 0.8),
      sag: (rng() - 0.5) * 0.8, phase: rng() * 6.283, id: rng(),
      asym: (rng() - 0.5) * 0.4, nick: 0.08 + rng() * 0.16,
      twist: (rng() - 0.5) * 1.6, flex0: 0.0,
      // Packed and shaded: the bottom of a windrow never sees light at all.
      occ: 0.30 + 0.45 * (off / (r * 5.5)),
      dead: 0.45 + rng() * 0.5,
    });
  }

  return { leaf: leaf.geometry(), wood: wood.geometry() };
}

/** A bare hanging strand — a dead liana, or one whose leaves are all in the
 *  canopy where it climbed to. There are far more of these in a real forest
 *  than there are leafy ones at eye level, and they are very good at breaking
 *  up a sightline for almost no triangles. */
export function deadVine(rng, scale = 1) {
  const wood = new Builder();
  const len = (5 + rng() * 13) * scale;
  const seg = 8;
  const pts = [], radii = [];
  const sx = (rng() - 0.5) * 2.0, sz = (rng() - 0.5) * 2.0;
  for (let k = 0; k <= seg; k++) {
    const s = k / seg;
    pts.push(new THREE.Vector3(
      sx * Math.sin(s * 2.1) * s, -len * s, sz * Math.sin(s * 1.4 + 0.7) * s));
    radii.push((0.016 + rng() * 0.020) * scale * (1 - 0.4 * s));
  }
  addTube(wood, pts, radii, 4, 8, 1.0, { u0: 0, v0: 0 }, 1,
          { occ: () => 0.68, moss: () => -0.20 });
  return { leaf: null, wood: wood.geometry() };
}

/**
 * Distant thicket.
 *
 * The understory species are far too heavy to plant out to a hundred metres,
 * so past about fifty the forest simply stopped — and you could see the sky
 * under the canopy, all the way to the horizon. That is the most damaging
 * single thing that can happen to a jungle shot, because the enclosure is the
 * whole feeling of the place.
 *
 * At that range the fog has already taken all the detail, so what is needed is
 * not a plant but an opaque green mass of roughly the right height and a
 * ragged top edge, for about a twentieth of the triangles. This is the one
 * piece of deliberate cheating in the vegetation system and it is invisible:
 * nothing this far out is ever resolved.
 *
 * The cards are deliberately large. Merging the mid-distance into fewer, wider
 * shapes is the whole job out here — a hundred thin ones at the same coverage
 * is sub-pixel alpha test, which is not foliage, it is stipple.
 */
export function thicket(rng, scale = 1) {
  const leaf = new Builder();
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  const n = 9 + Math.floor(rng() * 7);
  const h = (1.8 + rng() * 2.8) * scale;
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * 1.5 * scale;
    e.set(-(0.15 + rng() * 0.9), rng() * Math.PI * 2, (rng() - 0.5) * 0.9, 'YXZ');
    m.makeRotationFromEuler(e);
    m.setPosition(Math.cos(a) * rr, rng() * h * 0.7, Math.sin(a) * rr);
    const ll = (1.1 + rng() * 1.7) * scale;
    addLeaf(leaf, m, {
      len: ll, wid: ll * (0.50 + rng() * 0.36),
      cell: rng() < 0.5 ? CELL.OVATE : CELL.FROND, vary: freshLeaf(rng),
      bend: 0.9 + rng() * 1.0, curl: 0.2, id: rng(),
      // One segment each way. Nothing out here is ever more than a few pixels.
      nv: 1, nu: 1, twist: (rng() - 0.5) * 0.8, flex0: 0.5,
    });
  }
  return { leaf: leaf.geometry(), wood: null };
}

/**
 * A patch of canopy, with no tree under it.
 *
 * The roof of a rainforest is continuous and it is what makes the light on the
 * ground. Growing it honestly — enough trees that their crowns touch — would
 * cost thousands of trunks that are never in frame, because from the trail you
 * are looking at a ceiling twenty metres up and cannot tell which trunk any of
 * it belongs to. These patches fill between the real trees so the sky is
 * broken and the sun arrives in shafts.
 */
export function canopyPatch(rng, scale = 1) {
  const leaf = new Builder();
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  /* Dense enough to be opaque. A patch that only half covers its own footprint
   * leaves the sky showing through, and a rainforest roof seen from the floor
   * is not a scattering of leaves against blue — it is a solid dark ceiling
   * with a few bright punctures in it. Those punctures come from the gaps
   * between patches, which is where they can be controlled; they must not come
   * from each patch being individually thin. */
  const n = 62 + Math.floor(rng() * 54);
  const spread = (3.0 + rng() * 2.4) * scale;
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    // Biased toward the middle so patches have a dense core and a ragged rim,
    // which is what makes two overlapping ones read as one crown.
    const rr = Math.pow(rng(), 0.7) * spread;
    const yaw = rng() * Math.PI * 2;
    // Mostly near-horizontal: this is a ceiling seen from below.
    const pitch = -0.30 + rng() * 0.9;
    e.set(-pitch, yaw, (rng() - 0.5) * 1.0, 'YXZ');
    m.makeRotationFromEuler(e);
    // Several leaf-layers thick, so a shaft of light through it is broken up
    // rather than a clean hole.
    m.setPosition(Math.cos(a) * rr, (rng() - 0.5) * 3.4 * scale, Math.sin(a) * rr);
    // Larger and fewer than the first version: at twenty metres up these are
    // a handful of pixels each, and coverage held in big shapes survives
    // minification where the same coverage in small ones turns to speckle.
    const ll = (0.95 + rng() * 1.7) * scale;
    addLeaf(leaf, m, {
      len: ll, wid: ll * (0.44 + rng() * 0.36),
      cell: rng() < 0.55 ? CELL.OVATE : CELL.SMALL, vary: freshLeaf(rng),
      bend: 0.8 + rng() * 1.0, curl: 0.16 + rng() * 0.28, nv: 3, nu: 2,
      roll: (rng() < 0.55 ? 1 : -1) * (0.2 + rng() * 0.45),
      sag: (rng() - 0.5) * 0.7, phase: rng() * 6.283, id: rng(),
      asym: (rng() - 0.5) * 0.35,
      twist: (rng() - 0.5) * 1.3, flex0: 0.6,
    });
  }
  return { leaf: leaf.geometry(), wood: null };
}
