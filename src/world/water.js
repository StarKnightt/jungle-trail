/* System 5 — the falls, the pool, the river, the spray.
 *
 * The one problem this file exists to solve is that water does not hold still
 * and a texture does. Every cheap water effect fails in the same way: a map is
 * scrolled across a surface, the whole sheet translates rigidly, and the eye —
 * which is extremely good at this, because spotting moving water is a thing
 * eyes were selected for — reads it instantly as a picture being dragged
 * along. Three separate mechanisms here exist purely to break that, and they
 * are the parts of this file worth reading:
 *
 *  1. The surface is sampled in *flow space*, not world space. Each vertex
 *     carries a flow vector computed from the actual hydrology, and the
 *     fragment builds a local frame from it, so ripple crests always run
 *     across the current. Where the current turns, the ripples turn with it.
 *     A world-space scroll cannot do that at any cost.
 *
 *  2. The advection is two-phase. A texture offset that increases without
 *     bound has to wrap, and the wrap is visible as a jump; the standard
 *     answer, and the one used here, is to run two copies half a cycle apart
 *     and crossfade on the triangle wave between them, so the surface is
 *     always partly resetting and never seen to reset. Combined with two
 *     layers at different scales and speeds there is no single velocity for
 *     the eye to lock onto.
 *
 *  3. The falling curtain is not advected at all — it is *ballistic*. Each
 *     vertex knows how many seconds that parcel of water has been in the air,
 *     and the texture coordinate is the time the parcel left the lip. Because
 *     the map from fall-time to distance is quadratic, features stretch as
 *     they descend by exactly the factor gravity stretches real ones. That
 *     single change is most of the difference between a waterfall and a
 *     vertical conveyor belt.
 *
 * Everything is lit through MeshStandardMaterial rather than a bespoke water
 * shader. A hand-written BRDF would be better water and worse *scene*: it
 * would miss the canopy mask, the indirect fill, the fog and the shadows that
 * every other surface here is subject to, and water lit differently from the
 * rock it is sitting on is the thing that makes composites look composited.
 */
import * as THREE from 'three';
import { SSTEP } from '../gfx/glsl.js';
import { bakeRipple, bakeFoam, bakeStrands, bakeDroplets } from './waterTex.js';
import {
  POOL, POOL_Y, spillFloor, spillHalf, spillCentre, runLevel, ALCOVE_Y, poolBed,
} from './spillway.js';
import { SWALLOW, swallowDip } from './brook.js';
import { PlanarMirror } from '../render/mirror.js';

const G = 9.81;

/* The lip, and the throw over it.
 *
 * The lip position is read from the spillway tables rather than repeated, so
 * it cannot drift from the rock. The exit velocity is the one number here
 * that is chosen rather than derived, and it is chosen to land the water in
 * the alcove: 2.7 m/s of throw over a 1.55 s fall carries the sheet 4.2 m out
 * from the face, which puts the impact at z = -386.7, near the middle of the
 * catch basin and clear of the wall behind it. A slower exit would run the
 * water down the rock and there would be no fall at all; a faster one would
 * throw it past the alcove onto the apron.
 */
const LIP_Z = -390.9;
/* Thickness of the sheet as it rolls over, and the reason the lip has one at
 * all now. The chute's surface used to be authored 15 cm above the rock and
 * the curtain used to start *on* the rock, so the two met in a step — which is
 * exactly the "step-seam to the curtain below" the critique found under the
 * rectangular quad. Both now read this: the tongue is this deep at the lip and
 * the falling sheet begins at the top of it. */
const LIP_DEPTH = 0.24;
const LIP_Y = spillFloor(LIP_Z) + LIP_DEPTH;
const LIP_X = spillCentre(LIP_Z);
/* Half-width of the flow where it leaves the rock. The chute and the curtain
 * are both cut to this: they were 2.16 m and 2.90 m respectively, and a sheet
 * three quarters of a metre wider than the notch feeding it is the other half
 * of why the lip read as a card pasted on the cliff. */
const LIP_HALF = 2.15;
const EXIT_VZ = 2.7;      // downstream, +z
const EXIT_VY = -2.8;     // already falling as it leaves the chute

/* Seconds of free fall before the sheet reaches the alcove's surface.
 *
 * The positive root of 0.5gt^2 - vy0*t - drop = 0. Written with the sign of
 * EXIT_VY carried through rather than negated, because the water is already
 * moving downward as it leaves the chute and getting that sign wrong makes
 * the fall *longer* instead of shorter — which is a 37% error in the flight
 * time and puts the impact a metre and a half past the alcove, somewhere it
 * looks entirely plausible until you measure it. */
const FALL_T = (EXIT_VY + Math.sqrt(EXIT_VY * EXIT_VY + 2 * G * (LIP_Y - ALCOVE_Y))) / G;

const fallZ = (t) => LIP_Z + EXIT_VZ * t;
const fallY = (t) => LIP_Y + EXIT_VY * t - 0.5 * G * t * t;

/* The curtain is built past the water, not up to it.
 *
 * A surface that stops exactly on the water plane has a bottom edge, and a
 * bottom edge made of one row of vertices is a straight line however much
 * texture is on it — which is what the critique found: a clean polygon
 * boundary with a dark gap under it before the pool started. Running the
 * geometry a metre or so under the surface means there is no such row in
 * frame. It costs nothing: the submerged part is covered by the boil.
 */
const TF_END = FALL_T + 0.055;

/** Where the falling water hits, which is also where the audio and spray go. */
export const IMPACT = new THREE.Vector3(LIP_X, ALCOVE_Y, fallZ(FALL_T));
export const LIP = new THREE.Vector3(LIP_X, LIP_Y, LIP_Z);

/* Particle counts per tier.
 *
 * These look extravagant next to the two hundred and forty the first build
 * used and they cost slightly less, because the budget that matters for an
 * additive plume is the *sum of sprite areas* and not the count. The ejecta
 * were originally half a metre across, which at the pool is thirty pixels a
 * droplet — and thirty-pixel droplets are individually countable however
 * many of them there are, which is why the plume read as a swarm of
 * fireflies rather than as water. Taking them down to a tenth of the area
 * buys ten times as many for the same fill, and a spray is one of the few
 * things in a scene where the number of elements genuinely is the effect:
 * below a few hundred visible marks the eye resolves marks, and above it the
 * same marks integrate into a mist. The drift population is large-sprited
 * and unchanged in count, and it is still most of the fill here.
 *
 * The two populations are budgeted separately rather than as a fraction of
 * one total, because they are not comparable: a drift sprite is five times
 * the diameter of an ejecta sprite and therefore twenty-five times the fill,
 * so a single number scaled by tier moves the cost almost entirely through
 * the drift and almost entirely moves the *look* through the ejecta.
 *
 * `low` gets none: the volumetric plume below still puts mist in the air
 * there, so the shot degrades rather than breaking. */
const TIER_SPRAY = {
  low: { ejecta: 0, drift: 0 },
  medium: { ejecta: 1500, drift: 620 },
  high: { ejecta: 3400, drift: 1500 },
  ultra: { ejecta: 5600, drift: 2600 },
};

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* Resolution of the pool's reflection, as a fraction of the frame in each
 * axis. See render/mirror.js for the pass itself.
 *
 * A third rather than a half, and the number was measured rather than guessed:
 * captures of the basin at 0.5, 0.35 and 0.25 are indistinguishable by eye and
 * agree to one unit of luma on every percentile of the water's histogram. That
 * is not surprising once stated — the reflection is displaced by the ripple
 * normal before it is sampled and then scaled by a Fresnel term that is only
 * large where the surface is foreshortened to nothing, so the one place it
 * matters is the place where a screen pixel already covers metres of the
 * reflected world. Halving it again halves the cost of the only expensive
 * thing in this system.
 */
const MIRROR_SCALE = { high: 0.36, ultra: 0.5 };

/* Shared by the pool and the brook, which really are the same material: an
 * open water surface with a flow vector and a foam load. Splitting them would
 * double the programs for no visual difference. */
const SURFACE_COMMON = /* glsl */ `
uniform sampler2D tRipple;
uniform sampler2D tFoam;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSkyRefl;
uniform vec3 uBankRefl;
uniform vec3 uFoamCol;
uniform float uWaterDbg;
/* The planar reflection, and the flag that says whether there is one this
 * frame. See render/mirror.js: the pass is skipped whenever the pool is off
 * screen, which is most of the walk, so the material has to keep working with
 * nothing in the texture — hence a strength rather than a compile-time
 * branch. */
uniform sampler2D tMirror;
uniform float uMirror;
uniform float uMirrorY;
/* The basin's plan, so the surface can tell a stream from the pool it runs
 * into. See gStream in the colour block. */
uniform vec2 uPoolC;
uniform float uPoolR;
varying vec3 vWorldW;
varying float vBedW;
varying float vAgitW;
varying vec2 vFlowW;
varying vec4 vMirrorP;

/* One sample of a tiling map in the local flow frame.
 *
 * \`along\` and \`across\` are the world position resolved onto the flow
 * direction and its perpendicular, so the returned pattern is oriented by the
 * current and not by the world axes. The two fetches are half a cycle apart
 * and the crossfade weight is a triangle wave, which is what keeps the
 * advection from ever being seen to wrap: at every instant one of the two is
 * near the middle of its travel and carrying the image while the other is
 * near its reset and faded out.
 */
vec4 flowSample(sampler2D tx, float along, float across, float speed,
                float scale, float aniso, float period, float phase){
  float c = uTime / period + phase;
  float t0 = fract(c);
  float t1 = fract(c + 0.5);
  vec2 base = vec2(across * scale / aniso, along * scale);
  float k = speed * scale * period;
  vec4 a = texture2D(tx, base - vec2(0.0, k * t0));
  vec4 b = texture2D(tx, base - vec2(0.0, k * t1) + 0.437);
  return mix(a, b, abs(t0 * 2.0 - 1.0));
}
`;

export class Water {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./terrain.js').Terrain} terrain
   * @param {import('./path.js').Trail} trail
   */
  constructor(renderer, terrain, trail, opts = {}) {
    this.terrain = terrain;
    this.trail = trail;
    this.tier = opts.tier || 'high';
    this.root = new THREE.Group();
    this.root.name = 'water';
    this._time = 0;

    this.tex = {
      ripple: bakeRipple(renderer, 512),
      foam: bakeFoam(renderer, 512),
      strands: bakeStrands(renderer, 512),
      drops: bakeDroplets(renderer, 128),
    };

    this._buildSurfaceMaterial();
    this._buildCurtainMaterial();

    this.root.add(this._buildPool());
    this.root.add(this._buildBrook());
    this.root.add(this._buildChute());
    this.root.add(this._buildBoil());
    this.root.add(this._buildCurtain());
    this._buildSpray();

    /* Water is transparent and the scene's opaque pass has to be complete
     * before any of it draws. The default is already 0, but the pool, the
     * brook and the curtain overlap each other in places and three sorts
     * transparent objects back to front by their origin — which for a
     * fifty-metre grid whose origin is its centre is a poor proxy. Forcing
     * the order explicitly is more reliable than moving the origins: the
     * surfaces first, then the falling sheet over them, then the spray over
     * everything. */
    this.poolMesh.renderOrder = 10;
    this.brookMesh.renderOrder = 10;
    this.chuteMesh.renderOrder = 11;
    this.curtain.renderOrder = 12;
    /* After the curtain, not before it. The curtain's lowest rows deliberately
     * run below the water line so that no row of its vertices lies along the
     * surface; that only helps if the churn is drawn on top of them, and with
     * depth writes off on every water surface here the order is the only thing
     * deciding which wins. */
    this.boil.renderOrder = 13;
    if (this.spray) this.spray.renderOrder = 14;

    /** Exposed for main.js to hand to patchCanopyLight. */
    this.materials = [this.surfaceMat, this.streamMat, this.curtainMat, this.boilMat];

    /* The pool's reflection. Centred on the basin rather than on the pool
     * mesh's own bounds, because that mesh also carries the rapids and the
     * alcove sixteen metres away and a bounding sphere around all three would
     * keep the pass alive from most of the clearing. Radius covers the basin
     * and the brook's drowned delta, which is the other surface at this level.
     *
     * Off below `high`. It is one extra pass of the scene, and the tiers under
     * this one exist for machines that were already dropping frames — the
     * material falls back to the graded analytic reflection there, which is
     * what it used before this existed. */
    this.mirror = new PlanarMirror(renderer, POOL_Y, {
      centre: new THREE.Vector3(POOL.x + 1.0, POOL_Y, POOL.z - 2.0),
      radius: 18,
      range: 115,
      enabled: this.tier === 'high' || this.tier === 'ultra',
      scale: MIRROR_SCALE[this.tier] || 0.36,
    });
    this._surfaceUniforms().uMirrorY.value = POOL_Y;
  }

  /**
   * Render the pool's reflection. Call once per frame, before the scene pass
   * claims the offscreen buffer.
   *
   * Returns whether the pass actually ran, which the perf tooling reports: for
   * most of the walk it does not, and a reflection that is free everywhere
   * except the twenty seconds it is visible is the only version of this feature
   * worth having.
   */
  renderReflection(scene, camera) {
    const u = this._surfaceUniforms();
    /* The three surfaces at or near the plane, hidden for the pass. The pool
     * would feed its own texture back into itself; the brook's delta and the
     * cascade stand between the mirrored camera and the world above the water
     * and would fill the reflection with the underside of a water film. The
     * curtain and the churn are left in deliberately — the fall's white base
     * reflected in the basin under it is most of what makes the frame read as
     * water rather than as a hole.
     *
     * The spray is not, and that is a cost decision rather than an artistic
     * one: it is five thousand additive sprites and it is the most fill-bound
     * object in the scene, while what it contributes to a reflection is a faint
     * pale haze in front of a fall that is already the brightest thing in the
     * frame. Measured at three quarters of a millisecond for something no
     * capture could distinguish. */
    const ran = this.mirror.render(scene, camera,
      [this.poolMesh, this.brookMesh, this.chuteMesh, this.spray]);
    u.tMirror.value = this.mirror.texture;
    u.uMirror.value = ran ? 1 : 0;
    return ran;
  }

  setReflectionSize(w, h) { this.mirror?.setSize(w, h); }

  /* ---------------------------------------------------------------- flow */

  /* The current at a point on the open surface, in metres per second.
   *
   * Evaluated on the CPU at build time and stored per vertex, because it is
   * pure geometry and never changes: the alternative is three or four
   * branches per fragment on a surface that can cover half the screen.
   *
   * Two regimes. In the run the water is confined and it goes where the
   * channel goes, fast in proportion to the grade — that is nearly all of
   * what makes rapids read as rapids, because the eye judges speed from the
   * rate the foam streaks travel. In the pool it is unconfined, so the jet
   * from the run spreads radially and decays, and a slow gyre is added around
   * the basin: a plunge pool always has one, it is what carries the foam out
   * from the impact in a curve rather than a straight line, and a purely
   * radial field looks like a drain running backwards.
   */
  _flowAt(x, z, out) {
    if (z < -366) {
      // Confined. Downstream is +z; the grade over a metre sets the speed.
      const grade = (runLevel(z) - runLevel(z + 1.0));
      const sp = Math.max(0.5, Math.min(5.2, 0.9 + 13.0 * grade));
      // Steered toward the channel's centreline, so the current visibly bends
      // where the channel does instead of running straight through its bank.
      const c = spillCentre(z);
      const dx = Math.max(-0.7, Math.min(0.7, (c - x) * 0.16));
      const n = Math.hypot(dx, 1);
      out.set(sp * dx / n, sp / n);
      return out;
    }
    const mx = spillCentre(-366), mz = -366;
    let dx = x - mx, dz = z - mz;
    const d = Math.max(0.6, Math.hypot(dx, dz));
    dx /= d; dz /= d;
    const jet = 1.15 * Math.exp(-d / 8.5);
    // Anticlockwise about the basin, strongest at mid-radius the way a real
    // gyre is: zero at the centre it turns about and shed at the rim.
    const pr = Math.hypot(x - POOL.x, z - POOL.z) / POOL.r;
    const gyre = 0.34 * Math.sin(Math.min(1, pr) * Math.PI);
    const gx = -(z - POOL.z), gz = (x - POOL.x);
    const gn = Math.max(0.6, Math.hypot(gx, gz));
    out.set(dx * jet + gx / gn * gyre, dz * jet + gz / gn * gyre);
    /* And the draw toward the swallow, which is the term that makes the
     * outflow legible. A hole in the shore with still water over it is a dark
     * patch; a hole with half the basin's surface visibly leaning into it is a
     * drain. It has to reach far enough to be read as a field rather than as a
     * local eddy, so it falls off over eight metres rather than two, and it
     * accelerates hard at the lip the way a real drawdown does. */
    let sx = SWALLOW.x - x, sz = SWALLOW.z - z;
    const sd = Math.max(0.55, Math.hypot(sx, sz));
    const pull = 1.35 * Math.exp(-sd / 7.0) + 1.9 * Math.exp(-sd * sd / 3.2);
    out.x += sx / sd * pull;
    out.y += sz / sd * pull;
    return out;
  }

  /* How white the water is, before the shader adds its own shoreline foam.
   *
   * Foam is memory: it is generated where air is beaten into the water and
   * then carried downstream, so the field has to be smeared along the flow
   * rather than being a function of the local grade alone. That is what the
   * exponential tail below the impact is — without it the white stops dead at
   * the edge of the splash and the pool reads as a bathtub with a fizzy patch
   * in it.
   */
  _agitAt(x, z) {
    /* The aerated column, and the width of it is the whole argument. Foam is
     * made where the curtain enters the water and essentially nowhere else,
     * and the curtain is under four metres across; a Gaussian wide enough to
     * be generous here is wide enough to whiten a basin fourteen metres
     * across, which is what the first build did. */
    const di = Math.hypot(x - IMPACT.x, z - IMPACT.z);
    let a = 0.95 * Math.exp(-di * di / 7.0);
    if (z < -366) {
      /* Only the genuinely steep steps break white. Keying foam linearly off
       * the grade put two thirds of a unit of agitation on every reach of the
       * run, including the long glides, and squaring it in the shader was not
       * enough to save that — the whole watercourse came out as a white
       * ribbon. A threshold is also the truer model: a chute is either
       * supercritical and breaking or it is fast, smooth and green. */
      const grade = runLevel(z) - runLevel(z + 1.0);
      a = Math.max(a, smoothstep(0.06, 0.26, grade) * 0.55);
      /* Carried away from the impact, and only downstream of it. The first
       * version keyed this on |z - impact| alone, which is a band across the
       * whole basin at every x — so the entire fourteen-metre width of the
       * plunge pool came out at 0.85 agitation and therefore solid white,
       * upstream of the fall as well as below it. Foam goes where the water
       * goes: forward, and spreading about the channel's centreline. */
      if (z > IMPACT.z) {
        const off = x - spillCentre(z);
        a = Math.max(a, 0.5 * Math.exp(-(z - IMPACT.z) / 6.0)
                          * Math.exp(-off * off / 14.0));
      }
    } else {
      // What survives into the open pool: a plume off the channel mouth that
      // the gyre drags round, thin enough that the basin still reads as water.
      const dm = Math.hypot(x - spillCentre(-366), z + 366);
      a = Math.max(a, 0.45 * Math.exp(-dm / 5.0));
    }
    /* Foam collects on the draw. Everything floating in a basin ends up at
     * its outlet, and a raft of it sitting on the swallow and turning is the
     * cheapest possible proof that the water is going somewhere. */
    const ds = Math.hypot(x - SWALLOW.x, z - SWALLOW.z);
    a = Math.max(a, 0.62 * Math.exp(-ds * ds / 9.0));
    return Math.min(1, a);
  }

  /* --------------------------------------------------------- the surface */

  /* Two materials off one program, and the difference between them is a single
   * uniform. See `uStream` below for what it does and why it has to exist.
   *
   * They share `customProgramCacheKey`, so this costs one extra material and no
   * extra compile: three caches the program by that key and keeps the uniform
   * set per material. Everything they have in common — the ripple textures, the
   * clock, the palette — is the same uniform *object* in both, so there is one
   * place to set the time and one place to grade the colours.
   */
  _buildSurfaceMaterial() {
    this.surfaceMat = this._makeSurfaceMat(0.0);
    /* The brook. A pool and a stream are the same
     * physics and they are not the same picture, and the reason they need
     * separating is a measurement: the specular path in this material is scaled
     * down by three to five times to stop the *pool* blowing out, because a
     * 30 x 50 m mirror seen from eye height is at grazing incidence over almost
     * its whole visible area and three's multi-scattering term there is
     * enormous. A two-metre channel is never in that regime — you look down
     * into it at forty degrees, not across it at two — so the same scaling
     * leaves it with no specular at all, and water in shade with no specular is
     * not dark water, it is nothing. The brook measured out as a slightly
     * lighter stripe of dirt, which is precisely what the critique saw. */
    this.streamMat = this._makeSurfaceMat(1.0);
  }

  _makeSurfaceMat(stream) {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.17,
      metalness: 0.0,
      transparent: true,
      /* Off, and this is the reason the pool does not read as a green
       * surface. Water is only visible at all because of what it reflects and
       * what shows through it; making it opaque and giving it an albedo is
       * how you get the "another leaf-coloured plane" failure the ruins hit.
       * With depth-driven alpha the shallows show real wet gravel — the
       * terrain's own shader, already darkened by the wetness field — and
       * only the deep middle of the basin is water-coloured. */
      depthWrite: false,
      side: THREE.DoubleSide,
      /* Above the scene default of 0.34, because open water in a gap in the
       * roof genuinely does see more sky than the shaded ground around it and
       * the sheen of sky in it is doing more than any other single term to
       * say "water" — but nothing like as far above it as the first pass had.
       *
       * At 1.7 the pool blew out. A surface this smooth seen from eye height
       * across a basin is almost entirely at grazing incidence, where the
       * Fresnel term goes to one and the reflection is the *whole* of the
       * shading; multiplying a uniform sky dome by five and then by a Fresnel
       * of one gives a flat white field with the canopy's leaf shadows
       * printed on it, which is what the arrival shot showed. The reflection
       * has to stay in range so that the ripple riding on it is visible: a
       * clipped highlight has no texture in it by definition. */
      /* And the stream gets nearly three times as much, for the reason the
       * two materials exist at all. The number above is set by a thirty-metre
       * mirror seen at two degrees, where the Fresnel term is one over the
       * whole visible area and any image-based specular is the entire shading.
       * A two-metre channel is looked *down into* at thirty or forty degrees,
       * where the same term is two or three per cent — so the pool's setting
       * leaves it with no reflected sky at all, and water in shade with no
       * reflected sky is not dark water, it is a wet path. This is the single
       * measurement that decides whether the brook reads as a stream. */
      envMapIntensity: stream > 0.5 ? 1.15 : 0.42,
    });

    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this._surfaceUniforms(),
                    { uStream: { value: stream } });
      // Convention shared with the other patched materials here, so the
      // console and the capture tools have one place to reach the uniforms.
      m.userData.shader = sh;
      sh.vertexShader = `
        attribute float aBed;
        attribute float aAgit;
        attribute vec2 aFlow;
        varying vec3 vWorldW;
        varying float vBedW;
        varying float vAgitW;
        varying vec2 vFlowW;
        varying vec4 vMirrorP;
      ` + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vWorldW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vBedW = aBed; vAgitW = aAgit; vFlowW = aFlow;
      `)
        /* The reflection's texture coordinate, which is simply this fragment's
         * own screen position.
         *
         * That is exact rather than approximate, and it is worth writing down
         * why, because the usual formulation carries a whole texture matrix in
         * order to say the same thing. A point on the mirror plane is a fixed
         * point of the reflection, so it lies on the same ray through both
         * cameras and lands on the same pixel; and render/mirror.js skews only
         * the third row of the mirrored projection, so the horizontal and
         * vertical mapping the two cameras use is identical. The projected
         * position is therefore all that is needed, and it is resolution
         * independent, which a gl_FragCoord scheme is not. */
        .replace('#include <project_vertex>', /* glsl */ `
        #include <project_vertex>
        vMirrorP = vec4(gl_Position.xy * 0.5 + gl_Position.w * 0.5,
                        gl_Position.zw);
      `);

      /* The two injections are in the order three runs them, which is the
       * opposite of the order they were first written in and cost a compile
       * to notice: `color_fragment` comes several chunks *before*
       * `normal_fragment_maps` in the physical shader, so all of the shared
       * work — the flow frame, the ripple fetches, the depth — has to happen
       * in the first of them and the second does nothing but install the
       * result. Both patch the `#include` line itself rather than its
       * contents, because three expands directives after onBeforeCompile and
       * a replacement aimed at the expanded body matches nothing at all. */
      sh.fragmentShader = SSTEP + SURFACE_COMMON + sh.fragmentShader
        .replace('#include <color_fragment>', /* glsl */ `
          #include <color_fragment>

          float spd = length(vFlowW);
          vec2 fdir = spd > 1e-3 ? vFlowW / spd : vec2(0.0, 1.0);
          gAlong  = dot(vWorldW.xz, fdir);
          gAcross = dot(vWorldW.xz, vec2(-fdir.y, fdir.x));
          gWaterSpd = spd;
          gWaterDepth = vWorldW.y - vBedW;

          /* How much of a *stream* this fragment is, which is not the same
           * question as which mesh it belongs to, and the difference showed up
           * as the worst seam in the system.
           *
           * The two materials exist because a thirty-metre basin at grazing
           * incidence and a two-metre channel looked down into need opposite
           * specular budgets — see _buildSurfaceMaterial. What that split gets
           * wrong is the brook's last few metres: the channel opens into a delta
           * *inside the plunge basin*, drowned to exactly the pool's level, and
           * that delta was still being given the channel's gain. The result was
           * a pale mottled quadrilateral with a hard straight edge lying across
           * the middle of the pool, reading as a sheet of plastic floating on
           * it. The brook's delta is not a stream. It is the pool, and the test
           * for that is where it is rather than what drew it.
           */
          float basin = 1.0 - sstep(uPoolR - 2.0, uPoolR + 2.5,
                                    length(vWorldW.xz - uPoolC));
          gStream = uStream * (1.0 - basin);
          /* envMapIntensity is a material constant and cannot follow the line
           * above, so the stream material's extra radiance has to be taken back
           * out by hand wherever it is behaving as pool water. 0.42 over 1.15,
           * which is the ratio of the two settings. */
          gEnvFix = mix(1.0, 0.365, uStream * (1.0 - gStream));

          /* Whether this fragment is on the mirrored plane, which is not the
           * same question as whether it is water. One grid carries the basin,
           * the rapids and the alcove, and the second and third of those stand
           * one and a half metres above the pool — a reflection rendered for
           * y = 0.05 sampled up there is the right image in the wrong place,
           * and it shows up as the far bank appearing to float inside the
           * cascade. The brook's drowned tail *is* at pool level and does want
           * it, so the test is height rather than which mesh this is. */
          gMirror = uMirror * (1.0 - sstep(0.06, 0.55, abs(vWorldW.y - uMirrorY)));

          /* Two layers, and they must not share a speed. One layer at any
           * scale is a single velocity and the eye locks onto it in about a
           * second; two moving at 1.0 and 0.62 of the current have no common
           * period over the length of a shot, and the interference between
           * them is what reads as a surface being deformed rather than
           * translated. The coarse one is stretched 2.4:1 across the flow
           * because that is what a wave train in a current does. */
          vec4 r0 = flowSample(tRipple, gAlong, gAcross, spd,        0.55, 2.4, 1.35, 0.0);
          vec4 r1 = flowSample(tRipple, gAlong, gAcross, spd * 0.62, 1.90, 1.5, 0.83, 0.37);
          /* A third band for the stream only, at a scale set by the width of
           * the channel rather than by the width of a lake. The first two are
           * a wave train two and a half metres long; a brook two metres across
           * has nothing that big in it, and with only those two the surface
           * came out smooth enough to be a varnish. The cross-flow stretch is
           * dropped to 1.1 because in a narrow channel the banks are what set
           * the wavelength, not the current. */
          vec4 r2 = flowSample(tRipple, gAlong, gAcross, spd * 1.28, 4.30, 1.1, 1.70, 0.71);
          vec3 nr = normalize(vec3(
            (r0.x - 0.5) * 2.0 + (r1.x - 0.5) * 1.1 + (r2.x - 0.5) * 1.5 * gStream,
            1.0,
            (r0.y - 0.5) * 2.0 + (r1.y - 0.5) * 1.1 + (r2.y - 0.5) * 1.5 * gStream));

          /* Amplitude follows depth. A ripple needs water under it: a wave
           * train running up onto a gravel bar and over the top of it is one
           * of the most obviously wrong things a river can do, and the
           * shallows are exactly where the camera gets closest. */
          /* Flattened with distance, and this is specular anti-aliasing
           * rather than a level-of-detail saving.
           *
           * A mip chain averages normals toward flat, but the specular lobe
           * they drive is not linear in the normal, so the average of the
           * highlight is not the highlight of the average. On a surface this
           * smooth the result is a field of sub-pixel glints crawling over
           * the water — and because the ripple has a preferred direction, the
           * glints line up and it appears as a moving diagonal hatch, which
           * is precisely what the first build of this showed. The fix is to
           * put the lost detail back as roughness instead: below, the same
           * fade drives the surface toward rough, so the energy stays and
           * only the aliasing goes.
           */
          gFlat = 1.0 / (1.0 + length(vViewPosition) * 0.022);
          gNormalW = normalize(mix(vec3(0.0, 1.0, 0.0), nr,
                     gFlat * sstep(0.0, 0.35, gWaterDepth)
                           * (0.45 + 0.55 * min(1.0, spd))
                           * (1.0 + 0.55 * gStream)));
          gRip = r0.w;

          /* Foam, in three parts, because it collects for three reasons.
           *
           * The advected part is foam the water is carrying — generated at
           * the impact and in the rapids and streaming away downstream. The
           * shoreline part is where the sheet thins to nothing over the bank,
           * which is where scum and bubbles always end up. The third is the
           * standing white at the impact itself, which is not really foam at
           * all but the aerated water column, and it has to be near-opaque or
           * the plunge point looks like a hole in the pool. */
          vec4 fm = flowSample(tFoam, gAlong, gAcross, gWaterSpd * 1.05, 0.36, 1.9, 1.9, 0.11);
          vec4 fmFine = flowSample(tFoam, gAlong, gAcross, gWaterSpd * 1.05, 0.9, 1.4, 1.1, 0.6);

          /* Squared, and that one character is the difference between a river
           * and a bath full of milk. Foam coverage is not proportional to
           * agitation — it is closer to a threshold process, because air has
           * to be entrained faster than it escapes before any of it persists
           * at the surface. A linear map put half-strength foam over every
           * calm reach in the level, and since foam is also nearly opaque and
           * nearly white, the entire river read as a flat white ribbon with
           * no water in it anywhere. */
          float load = vAgitW * vAgitW;
          float carried = load * sstep(0.55 - 0.32 * load, 0.95 - 0.32 * load,
                                       fm.z + fm.y * 0.25);
          /* Scum at the waterline, and it has to be thin. The first version
           * faded it in over the first 42 cm of depth, which sounds modest
           * until you notice the brook is 35 cm deep along its whole length —
           * so "the shallow edge" selected the entire stream. */
          /* And it has to be *weak* as well as thin. The causeway leaves a
           * broad shelf of ankle-deep water along both of its banks — which
           * is correct, it is the margin of a river against a raised path —
           * but a strong scum term over a shelf that wide painted two white
           * borders down the middle of the arrival shot. A waterline is a
           * suggestion of collected bubbles, not a kerb. */
          float shore = sstep(0.09, 0.01, gWaterDepth) * sstep(0.62, 0.88, fm.x) * 0.22;
          float foam = clamp(max(carried, shore) * (0.62 + 0.38 * fmFine.y), 0.0, 1.0);
          // Directly under the fall it is not foam but aerated water, and
          // that has to go nearly opaque or the plunge point is a hole.
          /* The basin only. It is a description of an eighteen-metre plunge, and
           * the brook's own shoals now reach the same agitation as that — so left
           * ungated it put an opaque white patch over every gravel bar in the
           * stream, which is a snowdrift. What a bar deserves is the carried term
           * above, which is broken up by the foam map and lets the cobbles show
           * between the bubbles. */
          foam = max(foam, sstep(0.80, 0.95, vAgitW) * (1.0 - gStream));
          /* Broken water where the bed comes up through the surface, which is
           * the term the brook was missing and the one the eye uses to decide a
           * channel has water in it at all.
           *
           * A stream is legible not from its colour — under this canopy it has
           * almost none — but from the white collar behind every stone that
           * nearly breaks the surface. The carried term above cannot supply it:
           * it is driven by agitation alone, and agitation over a shoal is about
           * 0.6 here, which squares to a third and then has a threshold applied
           * to it. Requiring shallow *and* agitated instead selects exactly the
           * few square metres immediately around each emergent block, and the
           * fine map breaks the patch up so it reads as tumbling rather than as
           * a painted ring. */
          float rock = sstep(0.10, 0.015, gWaterDepth)
                     * sstep(0.34, 0.70, vAgitW)
                     * sstep(0.46, 0.82, fmFine.z + 0.30 * fm.y);
          foam = max(foam, rock * 0.88);

          /* The body colour is dark and slightly blue-green and it stays
           * dark. The instinct when water looks wrong is to brighten it, and
           * it is always the wrong move: deep water is one of the darkest
           * things in any landscape and it looks like water because of the
           * *specular* on top of it, not because of its albedo. Brightening
           * the body is exactly how it ends up the same value as the foliage
           * around it. */
          /* Absorption with depth. Exponential, because that is what it is,
           * and with a short length scale — a metre and a half of tannic
           * forest water is already essentially black. */
          /* And the stream's length scale is nearly three times the basin's,
           * which is the measurement that turned out to be under the whole of
           * "the brook does not read as water".
           *
           * The reach the walk passes is backwater: the trail tread there is
           * seventy-five centimetres above pool level, so the surface has no
           * fall left to spend and brook.js pins it at the basin's height for
           * the last sixty metres while the cut floor keeps descending. The
           * water over it is therefore 65 to 80 cm deep rather than the 30 the
           * profile authors, and at the basin's absorption 75 cm is opaque and
           * black. Every shallow-water cue in this material then switches off at
           * once — the bed stops showing through, the shoal foam never opens,
           * the waterline scum never opens — and what is left is a dark matte
           * film, which is exactly how it read.
           *
           * The fix is not to fake the depth, it is that the two bodies of water
           * genuinely have different optics. A plunge basin is three and a half
           * metres of still tannic water over dark rock. A brook is a hand's
           * depth of it, renewed every few seconds, running over cobble: you can
           * see every stone in the bottom of one. Same expression, honest
           * coefficient.
           */
          vec3 body = mix(uShallow, uDeep,
                          1.0 - exp(-max(0.0, gWaterDepth)
                                    * mix(1.15, 0.42, gStream)));
          diffuseColor.rgb = mix(body, uFoamCol, foam);

          /* Alpha from depth, so the shallows are genuinely see-through and
           * the bed under them is the terrain's own wet gravel rather than a
           * painted approximation of it. */
          float opa = 1.0 - exp(-max(0.0, gWaterDepth) * mix(1.9, 0.80, gStream));
          opa = mix(opa, 1.0, foam * 0.94);
          /* A floor on the film for the stream, and it is the difference
           * between a surface and a stain. The depth curve is right for a
           * basin, where the shallows are a metre-wide fringe nobody looks at;
           * a brook is *all* fringe, so the whole of it came back at a third of
           * a unit of alpha and what the eye read was the bed with a faint
           * grey wash over it. Thirty per cent is enough to carry a highlight
           * and still let the cobbles through. */
          /* Raised to a half, because a third was not. Measured off the
           * cross-channel frame: at 0.32 over a bed the wetness field has
           * already taken to near-black, the composite is 68 per cent black
           * cobble and the film contributes almost nothing the eye can find —
           * which is the "dark matte gravel" reading exactly. A half is still
           * transparent enough that the stones show through and read as a bed
           * rather than as a painted bottom, and it is enough film to carry
           * the reflection below. */
          /* And back down to 0.38 now that the absorption above is honest. The
           * half was propping up a curve that had already gone opaque by 40 cm,
           * so it was doing nothing at all over most of the channel and hiding
           * the bed in the shallows, which is the one place the bed is the whole
           * point. The floor's only job is that the last few centimetres of
           * fringe still carry a highlight. */
          opa = max(opa, 0.38 * gStream * sstep(0.015, 0.10, gWaterDepth));

          // Grazing angles. A water surface seen nearly edge-on reflects
          // almost everything and transmits almost nothing, and this is most
          // of why a real pool has a bright far shore and a transparent near
          // one — the single strongest depth cue the surface has.
          vec3 nView = normalize((viewMatrix * vec4(gNormalW, 0.0)).xyz);
          float ndv = clamp(dot(nView, normalize(vViewPosition)), 0.0, 1.0);
          float fres = pow(1.0 - ndv, 4.0);
          opa = clamp(mix(opa, 1.0, fres * 0.75), 0.0, 1.0);

          /* And the reflection that goes with that opacity, which was the
           * missing half of the same physics.
           *
           * Going opaque at a grazing angle is right, but the previous code
           * left the *colour* at the body's near-black — so a surface that
           * should have been a mirror returned an opaque dark sheet instead,
           * which is precisely the finding that the pool "returns nothing" at
           * two degrees. A dielectric at grazing incidence reflects almost
           * everything it sees, and what this one sees is the clearing's
           * canopy gap. Mixed into the diffuse rather than added as a light,
           * so it cannot run away the way the indirect-specular term did: it
           * is bounded by the colour above and it is still multiplied by the
           * shading, so it stays inside the frame's exposure and the ripple
           * riding on it keeps its contrast.
           *
           * What it reflects has to depend on *where the reflected ray goes*,
           * and the first attempt at this did not — it mixed toward one bright
           * colour by the Fresnel term alone. From eye height across a basin
           * essentially every fragment is at grazing incidence, so that is a
           * constant, and a constant mixed in by a constant is a flat pale
           * sheet with the canopy's leaf shadows printed on it. It made the
           * arrival frame worse than the dark version it replaced, which is
           * the same failure the environment-map notes below describe from a
           * different direction.
           *
           * The elevation of the reflected ray is what carries the image. A
           * near-horizontal bounce lands on the far bank and the cliff, which
           * are almost black; a steeper one reaches the gap in the roof, which
           * is the brightest thing in the clearing. And because the ripple
           * normal is what decides which of those a given fragment gets, the
           * reflection breaks up into the moving mottle a real pool has —
           * darks and brights interleaved — rather than a wash. */
          vec3 vdir = normalize(vWorldW - cameraPosition);
          vec3 rdir = reflect(vdir, gNormalW);
          /* 0.30 rather than 0.34, which is a small move, and the reason it is
           * small is worth recording because the first attempt at this finding
           * was a large one and it was wrong.
           *
           * The complaint is that the pool "returns nothing" at two degrees. The
           * first fix pulled this ceiling down to 0.16 so that the ripple could
           * reach the bright end of the ramp at grazing incidence, and it did —
           * and it also saturated the term to one over the *whole* pool at every
           * angle above about six degrees, because rdir.y there is already past
           * the ceiling before the ripple touches it. The result was a flat pale
           * olive sheet with the canopy's leaf shadows printed on it, brighter
           * than the stone around it: the exact failure this material has been
           * dragged back from twice, arrived at from a third direction.
           *
           * The geometry is not negotiable. From two degrees off the surface the
           * reflected ray leaves at two degrees, and what lies two degrees above
           * the horizon on the far side of a plunge basin is the far bank and a
           * thirty-metre cliff. It is *not* the canopy gap, which is eighty
           * metres up and needs a bounce forty degrees steep to reach. So the
           * honest answer at grazing is dark, and the ramp's job is only to keep
           * the ripple's variance alive without letting the average run away. */
          float sky = sstep(0.02, 0.30, rdir.y);
          vec3 refl = mix(uBankRefl, uSkyRefl, sky);
          /* And it is switched off where the water is moving fast, which is
           * the correction for the lip.
           *
           * A mirror needs a still surface. The chute is a metre and a half of
           * water accelerating at six metres a second over rock, and its
           * surface is corrugated at a scale far finer than this shader
           * resolves — physically that scatters the reflection into a diffuse
           * sheen rather than returning an image. Left in, the grazing term
           * painted the tongue with the canopy-gap colour and the lip came out
           * as a pale cream opaque slab *brighter* than the sheet below it,
           * inverting the dark-glassy-tongue reading it exists to produce. */
          float still = 1.0 - min(1.0, gWaterSpd * 0.42);
          gStill = still;
          gFres = fres;
          /* Eight tenths for the pool, up from seven. At grazing incidence a
           * dielectric reflects essentially all of what it sees and transmits
           * essentially none of it; leaving nearly a third of the body colour
           * showing through is what kept the near-mirror looking like a tinted
           * sheet with a reflection painted faintly over it. */
          /* Stood down where the reflection is real. This mix and the flick
           * below are both stand-ins for an image, and once render/mirror.js
           * is supplying one they are counting the same light twice: the
           * symptom is a pool whose reflection is correct in structure and a
           * third too bright, which is worse than either version alone. What
           * is deliberately *left* is a fifth of the term, because it is also
           * doing a second job the mirror cannot — mixing toward a near-black
           * bank colour is what keeps the water from going transparent at
           * grazing incidence, and that part is not double counted. */
          diffuseColor.rgb = mix(diffuseColor.rgb, refl,
                                 fres * mix(0.80, 0.34, gStream)
                                      * (1.0 - foam) * still
                                      * (1.0 - 0.80 * gMirror));

          /* The glints, and this is where the bright half of the reflection has
           * to come from — for the pool at grazing incidence *and* for the brook,
           * for the same reason and by the same term.
           *
           * Neither of them can get it from the Fresnel mix above. On the pool at
           * two degrees the mix is strong but everything it can reach is dark, as
           * the note above explains. On the brook the opposite holds: a walker
           * looks *down into* a two-metre gully at thirty or forty degrees, where
           * a water surface reflects three per cent, so fres to the fourth is
           * 0.003 and the whole reflection is arithmetically absent however its
           * colours are graded. Three passes of pushing those colours apart moved
           * nothing, because none of them were ever reaching the frame.
           *
           * What both surfaces actually show is not a mirror image, it is
           * *specks*. The canopy gap is a hundred or more times brighter than
           * the shaded bank, so even a three per cent reflection of it is worth
           * more than everything else the surface returns — but only off the
           * facets that happen to be pointed at it. So the term to write is not
           * a Fresnel ramp, it is a threshold on how far the ripple has lifted
           * the reflected ray *above where flat water would have sent it*.
           *
           * Written that way it is independent of the viewing angle, which is
           * what makes it work on a lake at two degrees and a brook at forty
           * without tuning. It is also sparse by construction — the lift is zero
           * on flat water by definition and only the steeper facets clear the
           * threshold — so it cannot degenerate into the pale wash that every
           * other attempt at this became. The water between the specks keeps the
           * dark bank, which is the contrast that reads as a moving surface. */
          float lift = max(0.0, rdir.y + vdir.y);
          float flick = sstep(0.10, 0.26, lift);
          diffuseColor.rgb = mix(diffuseColor.rgb, uSkyRefl * 1.30,
                                 flick * mix(0.34, 0.46, gStream) * (1.0 - foam)
                                       * (1.0 - 0.55 * gMirror));

          // The waterline itself. Feathered over the last few centimetres so
          // the edge wanders with the ripple instead of cutting the bed on a
          // hard contour, which is what betrays a clipped plane.
          float rim = sstep(-0.012, 0.075, gWaterDepth + (gRip - 0.5) * 0.055);
          if (rim <= 0.001) discard;
          diffuseColor.a *= opa * rim;

          // Foam is rough and water is not, and nothing sells the difference
          // between them faster than one of them killing the highlight.
          gFoam = foam;
        `)
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
          #include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.72, gFoam);
          roughnessFactor = mix(roughnessFactor, 0.34, min(1.0, gWaterSpd * 0.22));
          // The other half of the specular anti-aliasing above: ripples the
          // frame can no longer resolve become roughness, which is what they
          // physically are once they are smaller than a pixel.
          roughnessFactor = mix(0.42, roughnessFactor, gFlat);
        `)
        /* The glare, cut down. Two lines, and finding which one mattered took
         * longer than everything else in this material put together.
         *
         * The symptom was that the east half of both arrival frames was a
         * flat white sheet with the canopy's leaf shadows printed on it,
         * brighter than the cliff and brighter than the falls, with no ripple
         * and no bed visible through it. It read as a hole in the clearing
         * floor rather than as water. The albedo was ruled out (it is
         * near-black), then the foam (tinting uFoamCol red left the sheet
         * white), then the environment map — and `envMapIntensity` turned out
         * to do *nothing at all* here, which is the finding worth recording:
         * the glare is not the reflected sky image. It is the multi-scattering
         * term of three's indirect specular, which is driven by the ambient
         * irradiance rather than by the environment radiance, and on a
         * dielectric this smooth seen almost entirely at grazing incidence it
         * is enormous. No material property reaches it. Scaling the light
         * path itself is the only lever, and it had to be found by writing
         * each of the four terms out as its own image.
         *
         * The canopy factor on the second line is the part that is doing the
         * *artistic* work rather than just the exposure work: three hands
         * this surface a uniform sky with no notion that there are eighty
         * metres of roof over the basin, and a mirror under a broken roof
         * has to show the broken roof or it is not a mirror. Reusing the
         * canopy's own occlusion term puts that structure back for one
         * multiply, and it is the cheapest possible stand-in for a
         * screen-space reflection.
         *
         * `aomap_fragment` is the injection point rather than
         * `lights_fragment_end` because the canopy patch has already claimed
         * the latter, and it is the last chunk before the terms are summed. */
        .replace('#include <aomap_fragment>', /* glsl */ `
          #include <aomap_fragment>
          /* The scaling is for the basin. A stream keeps its sun glint: where a
           * shaft crosses a brook the surface throws back a broken line of
           * near-white sparks, and in a forest interior that is the loudest
           * single statement that a thing is water — louder than colour, than
           * transparency and than the ripple itself. Crushed to 0.30 along with
           * the pool it had none, and read as damp dirt. */
          /* 1.05 rather than 1.75, and the difference is sparks against a sheet.
           *
           * Written out on its own this term measured 0.87 of a unit across the
           * whole width of the channel wherever a sun shaft crosses it — not a
           * broken line of glints but a continuous pale slab, because at seven
           * metres the shaft is wider than the stream and the specular lobe on a
           * roughness-0.25 surface is broad enough to keep every fragment inside
           * it. Gain cannot make a highlight sparse; only the normal can. So the
           * gain comes back to about unity, where the sun is still the brightest
           * thing on the water, and the breaking-up is left to the third ripple
           * band and to the foam. */
          reflectedLight.directSpecular *= mix(0.30, 1.05, gStream);
          /* The reflection is of the sky *through the roof*, not of an open
           * sky, and this is the line that makes the pool read as water
           * rather than as a hole cut in the clearing floor.
           *
           * three's image-based specular has no idea there are eighty metres
           * of canopy over this basin: it hands the surface a uniform sky
           * dome, the surface is at grazing incidence over its whole visible
           * area, and the result was a flat pale sheet with no structure in
           * it at all — brighter than the cliff behind it and brighter than
           * the falls. Water is a mirror, and a mirror under a broken roof
           * shows the broken roof. Reusing the canopy's own occlusion term
           * costs one multiply and puts the leaf pattern into the reflection,
           * which is both what a real pool looks like and the cheapest
           * possible substitute for a screen-space reflection. */
          /* The image-based term is raised far less than the direct one, and the
           * asymmetry is the whole lesson of this material. Three's indirect
           * specular is a uniform sky dome with no ripple structure in it, so
           * turning it up does not add sparkle — it adds a flat pale wash, which
           * is the failure the notes above describe from the pool's side. The
           * sun glint is directional and rides the ripple, so it breaks into
           * moving highlights instead. Raising one and not the other is the
           * difference between water and a sheet of plastic. */
        /* The stream's share is raised to 0.72 all the same, and the asymmetry
         * argument above is exactly why that is safe here and would not be on
         * the pool. The failure mode of this term is a flat pale wash over a
         * large area at grazing incidence; the brook is neither large nor at
         * grazing incidence, and its ripple normal is 1.55 times the pool's, so
         * what a raised dome term does to it is vary the Fresnel across the
         * ripple and break into sheen rather than flatten. Combined with the
         * material's own envMapIntensity above this is about six times the
         * reflected sky the brook had, and it is the difference between a
         * channel with a surface in it and a slightly lighter stripe of dirt. */
        /* 0.30, not 0.72, and this is the same argument arriving at the opposite
         * answer once it was measured instead of reasoned about.
         *
         * The claim above is that the failure mode of this term needs a large
         * area at grazing incidence and the brook is neither. The brook the
         * *player* sees is both. A walker on the trail is six to twelve metres
         * from the channel and about twenty degrees above its surface, not forty
         * looking down into it, and over that reach the stream fills a third of
         * the lower frame. Written out on its own the term came back as a
         * featureless pale tan slab — ten values of spread between its tenth and
         * ninetieth percentile over the whole surface — so all it was
         * contributing was a floor under everything else, and a floor is the one
         * thing water must not have. What is left is still three and a half
         * times the pool's share, which is enough to keep the surface from going
         * to pure black in shade. */
        /* And crushed almost out of existence on the pool once the mirror is
         * running, which is the whole of the fix to the flat pale sheet.
         *
         * It is worth being precise about what that sheet was, because it
         * survived four passes of being tuned. It was never the albedo, never
         * the foam and never the environment map's own image: it is three's
         * multi-scattering estimate for the indirect specular, which is driven
         * by the *ambient irradiance* rather than by the environment radiance,
         * so no material property reaches it and envMapIntensity does
         * nothing to it at all. On a dielectric this smooth, seen at two to ten
         * degrees over twenty-five metres, it integrates to a constant — and it
         * was the dominant term in the pool by a wide margin. A capture with
         * the water hidden settled it: the pale olive plane with leaf shadows
         * printed on it was the surface, and this line was almost all of it.
         *
         * It could not simply be removed before, because it was also the only
         * reflection the pool had. Now that there is a real one, it can be. */
          reflectedLight.indirectSpecular *= gEnvFix
                                           * mix(mix(0.20, 0.05, gMirror), 0.30, gStream)
                                           * mix(0.35, 1.0, gCanopyOcc);
          /* And tinted, for the stream only, which is the correction for the
           * cyan the raise above brought with it.
           *
           * three hands this surface an unoccluded sky dome, and a sky dome is
           * blue. On the pool the term is small enough not to matter; on the
           * brook it is now the dominant reflection, so the channel came back a
           * slate blue-grey — measurably cooler than everything around it
           * (r-b = -10 against +27 for the litter on its own banks) and reading
           * as wet asphalt. What a stream in a closed forest actually reflects
           * is leaves: a hundred per cent canopy, a few per cent of sky through
           * gaps in it. Warming the term is a two-word stand-in for that and it
           * keeps the sparkle the raise bought. */
          reflectedLight.indirectSpecular *=
            mix(vec3(1.0), vec3(1.26, 1.06, 0.58), gStream);
        `)
        /* The reflection itself, added as light and not as albedo.
         *
         * Every previous version of this reflection was mixed into
         * `diffuseColor` instead, for a defensible reason — a colour mixed into
         * the albedo is bounded by the shading and cannot run away the way an
         * added term can. It is also why none of them read as a mirror. A
         * reflection multiplied by the local irradiance is a reflection that
         * goes dark wherever the water is in shade, and this pool is in shade
         * over most of its area: what the eye then sees is a picture of the far
         * bank with the canopy's shadow pattern lying across it, which is not
         * how a mirror behaves. Reflected light has already been through its own
         * shading on the way to the surface; the only thing left to do to it is
         * scale it by Fresnel.
         *
         * Placed before `tonemapping_fragment` so that `fog_fragment`, which
         * three runs afterwards, hazes the reflection along with everything else
         * in the fragment. A crisp reflection in a hazed frame is one of the
         * loudest tells a planar mirror has, and getting it for free by
         * injecting one chunk earlier is the whole reason for the position.
         *
         * The alpha blend does the rest of the physics without being asked: the
         * surface is only opaque where it is at grazing incidence, which is
         * exactly where the reflection is strong, so a shallow transparent
         * shoal cannot acquire a mirror it has no business having. */
        .replace('#include <tonemapping_fragment>', /* glsl */ `
          if (gMirror > 0.002) {
            float w = gMirror * gFres * gStill * (1.0 - gFoam);
            /* Displaced by the ripple, in screen space, which is the one
             * approximation in this whole path. Doing it properly means
             * intersecting the perturbed ray with the reflected scene, and the
             * cheap version is indistinguishable at a metre of wave height
             * because the error is second order in the slope. Faded with
             * distance by the same term that flattens the ripple normal, so
             * the far half of the basin does not shimmer at a pixel scale. */
            vec2 muv = vMirrorP.xy / max(1e-4, vMirrorP.w)
                     + gNormalW.xz * 0.070 * gFlat;
            vec3 mcol = texture2D(tMirror, clamp(muv, vec2(0.002), vec2(0.998))).rgb;
            gMirrorCol = mcol;
            gMirrorW = w;
            gl_FragColor.rgb += mcol * (w * 0.95);
          }
          #include <tonemapping_fragment>
        `)
        /* Debug taps, the same way the terrain exposes its splat channels.
         * "The pool is white" has at least four candidate causes — foam
         * coverage, depth-driven opacity, the fresnel term and the specular
         * off the environment map — and they are indistinguishable in a
         * screenshot. Being able to write each one out as a greyscale image
         * turns a guessing game into one capture. */
        .replace('#include <dithering_fragment>', /* glsl */ `
          #include <dithering_fragment>
          if (uWaterDbg > 0.5) {
            float v = uWaterDbg < 1.5 ? gFoam
                    : uWaterDbg < 2.5 ? clamp(gWaterDepth * 0.4, 0.0, 1.0)
                    : uWaterDbg < 3.5 ? vAgitW
                    : uWaterDbg < 4.5 ? clamp(gWaterSpd * 0.25, 0.0, 1.0)
                    : diffuseColor.a;
            gl_FragColor = vec4(v, v, v, 1.0);
            // The three light paths, separately, because "the pool is white"
            // was chased through the albedo, the foam and the environment
            // intensity before it turned out to be none of them.
            if (uWaterDbg > 5.5) gl_FragColor = vec4(diffuseColor.rgb, 1.0);
            if (uWaterDbg > 6.5) gl_FragColor = vec4(reflectedLight.directSpecular, 1.0);
            if (uWaterDbg > 7.5) gl_FragColor = vec4(reflectedLight.indirectSpecular, 1.0);
            if (uWaterDbg > 8.5) gl_FragColor = vec4(reflectedLight.indirectDiffuse, 1.0);
            // The ripple normal itself, remapped. "The surface looks flat" has
            // two candidate causes — no normal, or a normal nothing is lighting
            // — and they need separating before either can be worked on.
            if (uWaterDbg > 9.5) gl_FragColor = vec4(gNormalW * 0.5 + 0.5, 1.0);
            // And the reflection, as its weight and as its image. "The mirror
            // is not appearing here" has two candidate causes and they need
            // separating: either the term is zero, or it is sampling something
            // that looks like what it replaced.
            if (uWaterDbg > 10.5) gl_FragColor = vec4(vec3(gMirrorW), 1.0);
            if (uWaterDbg > 11.5) gl_FragColor = vec4(gMirrorCol, 1.0);
          }
        `)
        // Nothing left to do here but install what the colour block worked
        // out. Rotating a world-space normal into view space is exact for a
        // surface this close to horizontal, and it means these grids need no
        // tangent attribute and no meaningful UVs.
        .replace('#include <normal_fragment_maps>',
                 'normal = normalize((viewMatrix * vec4(gNormalW, 0.0)).xyz);');

      // Declared ahead of everything, because the blocks that write them and
      // the blocks that read them are several chunks apart; three's own
      // chunks never touch these names.
      sh.fragmentShader = 'float gWaterDepth; float gWaterSpd; float gRip;\n'
        + 'float gAlong; float gAcross; float gFoam = 0.0; float gFlat = 1.0;\n'
        + 'float gMirror = 0.0; float gFres = 0.0; float gStill = 1.0;\n'
        + 'float gMirrorW = 0.0; vec3 gMirrorCol = vec3(0.0);\n'
        + 'float gStream = 0.0; float gEnvFix = 1.0;\n'
        + 'uniform float uStream;\n'
        + 'vec3 gNormalW = vec3(0.0, 1.0, 0.0);\n' + sh.fragmentShader;
    };
    m.customProgramCacheKey = () => 'water-surface';
    return m;
  }

  _surfaceUniforms() {
    if (!this._surfUni) {
      this._surfUni = {
        tRipple: { value: this.tex.ripple },
        tFoam: { value: this.tex.foam },
        uTime: { value: 0 },
        /* Measured off the deep end of a shaded forest pool rather than
         * picked: it is very dark, and barely blue. Tropical plunge pools are
         * not the postcard turquoise — that colour comes from a white
         * limestone or sand bed lit from above, and this one is dark rock
         * under a canopy. */
        uDeep: { value: new THREE.Color(0x0a1614) },
        /* The other end of the absorption curve. Half a metre of water over
         * wet gravel is not the same colour as four metres of it over nothing
         * — it is warmer, browner and much lighter, because most of what comes
         * back out of it never went far enough for the water to take the red
         * out. Interpolating between the two by depth is the cheapest possible
         * stand-in for Beer's law and it is the cue the critique found missing
         * when it called the pool "opaque matte grey-tan": one colour
         * everywhere is a painted plane by definition, whatever is under it. */
        uShallow: { value: new THREE.Color(0x2c3327) },
        /* What a canopy gap looks like from below, which is what this pool
         * reflects at a grazing angle and what it was returning nothing of.
         * Deliberately a desaturated warm grey rather than a sky blue: the
         * reflection is of a bright hole in a green roof seen through haze,
         * and putting a real sky colour here is how water turns cyan. */
        uSkyRefl: { value: new THREE.Color(0x8d9585) },
        // The far bank, the cliff and the closed forest behind them, which is
        // what a nearly horizontal bounce off this pool actually finds.
        uBankRefl: { value: new THREE.Color(0x151a15) },
        /* Grey, not white, and this was the last thing wrong with the pool.
         *
         * Foam reads as white because it is the brightest thing in a river,
         * not because it has a high albedo — it is a scatter of bubbles over
         * dark water and about half of what a paper white would be. At 0xd8
         * even a third of a unit of coverage gave an albedo of 0.25, and a
         * 0.25 albedo standing in one of the clearing's sun shafts is a
         * blown-out sheet: the whole east half of the arrival frame was a
         * white plane with leaf shadows printed on it. Taking the colour down
         * costs nothing in the shade, where the foam still reads as the
         * lightest thing in the shot, and stops it clipping in the light. */
        uFoamCol: { value: new THREE.Color(0xaab5b2) },
        uWaterDbg: { value: 0 },
        tMirror: { value: null },
        uMirror: { value: 0 },
        uMirrorY: { value: POOL_Y },
        uPoolC: { value: new THREE.Vector2(POOL.x, POOL.z) },
        uPoolR: { value: POOL.r },
      };
    }
    return this._surfUni;
  }

  /* The pool, the alcove and the rapids between them, as one grid.
   *
   * One mesh rather than three, because the alternative is seams. These are a
   * single connected body of water whose surface descends from the alcove to
   * the basin, and any join between separately-built pieces would be a place
   * where two surfaces meet at slightly different heights with slightly
   * different ripple phases. Sampling one grid against `runLevel` and letting
   * the fragment clip it against the bed gives all three shapes — and gives
   * the shoreline for free, at fragment resolution, following every rock the
   * heightfield has rather than the grid's own quantisation.
   */
  _buildPool() {
    const X0 = -15.5, X1 = 14.5, Z0 = -391.5, Z1 = -341.0;
    const step = this.tier === 'low' ? 0.85 : 0.55;
    const nx = Math.ceil((X1 - X0) / step), nz = Math.ceil((Z1 - Z0) / step);
    const g = this._grid(nx, nz, (i, j) => {
      const x = X0 + (X1 - X0) * i / nx;
      const z = Z0 + (Z1 - Z0) * j / nz;
      // Level everywhere except over the swallow, which pulls a dimple in it.
      return [x, runLevel(z) - swallowDip(x, z), z];
    }, null, (x, z) => {
      /* The sheet's domain, declared rather than discovered.
       *
       * Every fragment of this grid is clipped against the ground under it, so
       * for most of its life it did not need one: outside the basin the ground
       * is above the water and the surface simply vanishes. That stopped being
       * true the moment the outflow gutter was cut, because the gutter's floor
       * is a metre and a half below the basin's surface and it runs *under*
       * this mesh — so the pool grew a rectangular tongue of water flowing up
       * a hillside. The two places this sheet is allowed to exist are the
       * basin and the channel above it, and saying so costs one attribute.
       */
      const inBasin = poolBed(x, z) < POOL_Y;
      const inRun = z <= -364.5 && Math.abs(x - spillCentre(z)) < spillHalf(z) + 1.4;
      const inSwallow = Math.hypot(x - SWALLOW.x, z - SWALLOW.z) < SWALLOW.r + 0.6;
      return (inBasin || inRun || inSwallow) ? null : 1e3;
    });
    this.poolMesh = new THREE.Mesh(g, this.surfaceMat);
    this.poolMesh.name = 'pool';
    this.poolMesh.frustumCulled = false;
    return this.poolMesh;
  }

  /* The brook.
   *
   * Every number in it now comes from `terrain.brook`, which is also what cut
   * the channel and what the audio's panner slides along. That is the whole
   * of the fix to the bug this system shipped with: the surface used to be
   * derived here from the trail's tread and the channel was carved over there
   * from the surrounding ground, and because the trail is the *lowest* line
   * across the corridor and the channel runs out on the shoulder, the two
   * references differed by one to two and a half metres. The water sat that
   * far under its own bed, was clipped away by the depth test at every
   * fragment, and two hundred metres of river drew nothing at all while still
   * being submitted every frame. See world/brook.js.
   *
   * Downstream is +t: the ground falls about eight metres from t = 0.40 to the
   * basin, so this brook runs *into* the pool rather than out of it. That is
   * worth stating because the intuition is the other way round — the falls is
   * the loud water, so it feels like the source — but the basin is the lowest
   * ground in the level and everything drains to it. The audio agrees:
   * brookGain fades the babble down after t = 0.88 as the falls takes over.
   */
  _buildBrook() {
    const B = this.terrain.brook;
    const st = B.st.slice(B.i0, B.i1 + 1);
    const n = st.length - 1;
    /* Seven columns rather than five, because the mesh now runs up both banks
     * (see MESH_MARGIN in brook.js) and the two outer columns are spent on
     * ground the depth test is going to discard: at five, the remaining three
     * had to carry the whole of the water and the ripple normal was being
     * interpolated across a metre. */
    const M = 7;
    const half = (s) => B.meshHalf(s);
    const g = this._grid(M, n, (i, j) => {
      const s = st[j];
      const u = (i / M) * 2 - 1;
      return [s.cx + s.tz * u * half(s), s.y, s.cz - s.tx * u * half(s)];
    }, (i, j) => {
      const s = st[j];
      const u = (i / M) * 2 - 1;
      const wx = s.cx + s.tz * u * half(s), wz = s.cz - s.tx * u * half(s);
      /* Speed and foam are the station's own, which after the step-pool
       * quantisation means the glides run slow and clear and each 22 cm drop
       * runs fast and white. A brook whose whole length is at one speed is
       * the same failure as a curtain with one texture speed. */
      /* Plus what the bed does to it, which the station profile cannot know.
       *
       * The profile is one number per cross-section, so it has grade and
       * nothing else, and over the last sixty metres before the basin it has no
       * grade either: the clearing floor sits barely half a metre above the
       * pool, so the water surface down there is flat by hydrology and no
       * amount of authoring can put a step in it. That reach is also the only
       * part of the brook the player ever walks beside, so "white water only
       * where there is a drop" meant no white water anywhere it counts.
       *
       * What a flat reach does have is a rough bed — cobbles, and the ruins'
       * own fallen blocks standing in the channel. Water running over a rock
       * that nearly breaks the surface breaks white behind it whatever the
       * grade is, and the depth over each vertex is already known here because
       * the bed is sampled from the terrain the channel was cut into. So the
       * shoals get the foam, which puts it exactly where an obstacle is rather
       * than in a band, and it costs one height fetch per vertex at build time.
       */
      const d = s.y - this.terrain.height(wx, wz);
      /* Eleven centimetres, not twenty-four, and it matters because of what the
       * brook's own depth is. A glide here is 19 to 37 cm deep by construction,
       * so a shoal test that opens at 24 cm selects *most of the stream* — and
       * then feeds it into an agitation term that saturates the material's foam
       * threshold. The channel came back white from bank to bank. A shoal is
       * water you could see the tops of the stones through: a hand's depth, not
       * a knee's. */
      /* Midstream only, and the gate is what separates a stone in the current
       * from the margin.
       *
       * Both are shallow, so depth alone cannot tell them apart — and the
       * channel here is asymmetric, with a broad ankle-deep shelf along one
       * bank for most of the visible reach. Keyed on depth alone the shoal term
       * selected that whole shelf and the foam channel came back as a white
       * ribbon twenty metres long down one side of the brook, which is a beach,
       * not a riffle. The margin already has its own much weaker scum term. */
      const shoal = smoothstep(0.14, 0.03, d) * smoothstep(0.72, 0.42, Math.abs(u));
      /* And they speed it up, for the same reason and by the same continuity
       * argument the narrows do: the discharge is fixed, so where the section
       * shrinks the water has to go faster. It is the moving foam that reads as
       * speed, so this is most of what stops the flat reach looking like a
       * canal. */
      const sp = s.speed * (1.0 + 0.9 * shoal) * Math.min(1.7, 1.25 / s.half);
      /* The shoal sits on one bank, so the white it makes does too.
       *
       * The station cannot apply that itself — it is one number for a whole
       * cross-section, and one number painted across a seven-column mesh is a
       * stripe from bank to bank. Measured foam coverage over the reach the walk
       * passes was a third of a unit at every column, which is why sixty metres
       * of channel came back as a pale ribbon rather than as water with riffles
       * in it. brook.js publishes which side the bar is on; this is the only
       * place the lateral coordinate exists to spend it.
       *
       * Faded out at the very edge as well, because the margin has its own much
       * weaker scum term and two whitening terms meeting on the waterline is a
       * kerb.
       */
      const barGate = smoothstep(-0.30, 0.42, u * s.barSide)
                    * smoothstep(0.96, 0.74, Math.abs(u));
      return {
        flow: [s.tx * sp, s.tz * sp],
        /* No blanket floor. The station already carries one, and adding a second
         * constant here is what made the three foam terms sum to a white
         * ribbon — this one only has the right to raise the white where the bed
         * is actually breaking the surface. */
        agit: Math.max(s.agitFlow, s.agitBar * barGate, 0.78 * shoal),
      };
    });
    this.brookMesh = new THREE.Mesh(g, this.streamMat);
    this.brookMesh.name = 'brook';
    return this.brookMesh;
  }

  /* The water in the chute above the lip.
   *
   * Short, and it exists for one shot: standing at the pool and looking up,
   * the sheet has to come *from* somewhere. Without this the curtain begins
   * in mid-air at the lip, and a fall with no feed above it is the same tell
   * as a river with no source.
   */
  _buildChute() {
    const Z0 = -397.5, ZE = LIP_Z - 0.55, n = 26, M = 8;
    const g = this._grid(M, n, (i, j) => {
      const z = Z0 + (ZE - Z0) * j / n;
      const c = spillCentre(z);
      const s = j / n;
      // Narrowing into the lip: the notch funnels, which is what concentrates
      // the flow enough to leave the rock as one sheet.
      const half = Math.min(spillHalf(z), 3.4) * (1 - 0.30 * s) - (1 - s) * 0.0;
      const u = (i / M) * 2 - 1;
      return [c + u * half, spillFloor(z) + this._chuteDepth(u, s), z];
    }, (i, j) => {
      const z = Z0 + (ZE - Z0) * j / n;
      const sp = Math.max(1.5, Math.min(6.5, (spillFloor(z) - spillFloor(z + 1)) * 6.5));
      /* The bed is taken from the authored floor rather than from the sampled
       * heightfield, which everywhere else is the right source and here is
       * not. The lip drops sixteen metres across less than two, so a bilinear
       * fetch from a half-metre grid anywhere near it returns a height from
       * partway down the face — and the depth-driven clip would then decide
       * the last two metres of the chute are dry, cutting the feed off just
       * where it has to connect to the curtain. */
      /* Almost no foam, and this is the correction to the fourth finding.
       *
       * The tongue used to carry 0.35 to 0.85 of agitation, which through the
       * foam term is a near-opaque white blotchy sheet — and that white sheet,
       * sitting where the water leaves the rock, is what made the whole fall
       * read as *whitest at the top and thinning to grey at the bottom*. It is
       * exactly backwards. Water accelerating over a lip has not entrained any
       * air yet: it is glassy, dark, coherent and mirror-smooth, and it only
       * goes white after several metres in the air. The white belongs to the
       * curtain material and it now lives at the far end of it. */
      return {
        flow: [0, sp],
        agit: 0.03 + 0.10 * (j / n),
        bed: spillFloor(z),
      };
    });
    /* The still-water material, not the stream one, and the difference is the
     * specular gain. The tongue is a metre and a half of water accelerating at
     * six metres a second over rock: its surface is corrugated far below the
     * scale this shader resolves, so physically it scatters rather than
     * reflecting, and the reading it has to produce is dark and glassy. Given
     * the stream's glint budget it came back as a pale slab brighter than the
     * curtain below it, which is the exact inversion the lip was fixed for. */
    this.chuteMesh = new THREE.Mesh(g, this.surfaceMat);
    this.chuteMesh.name = 'chute';
    return this.chuteMesh;
  }

  /* Depth of the tongue across the chute, which is what stops it being a
   * rectangle. Water in a notch is deepest in the middle and goes to nothing
   * at the rock on either side, so the depth-driven clip fades the sheet out
   * along its own edges and the four corners the critique counted have nowhere
   * to be. The dent is a boulder sitting in the flow a couple of metres above
   * the lip: it splits the tongue in two, which is what puts a vertical seam
   * of daylight through the top of the curtain and is the single cheapest way
   * to stop a fall looking extruded.
   */
  _chuteDepth(u, s) {
    /* Zero at the rock on both sides and at the upstream end, not merely small.
     *
     * The taper used to bottom out at 0.027 m at the edge, and the surface's
     * clip fades in over the first 7.5 cm of depth — so the margins came back
     * at four tenths opacity instead of nothing, and the tongue kept the
     * straight sides and hard corners it was supposed to have lost. A power
     * slightly above one keeps the middle full while pinning the ends. */
    const d = (0.34 - 0.10 * s) * Math.pow(Math.max(0, 1 - u * u), 1.25)
            * smoothstep(0.0, 0.14, s);
    const b = (u + 0.34) / 0.20;
    return Math.max(0.0, d * (1 - 0.85 * Math.exp(-b * b) * smoothstep(0.30, 0.62, s)));
  }

  /* A gridded surface with the water attributes attached.
   *
   * `pos(i, j)` returns world position; `data(i, j)` returns the flow and
   * agitation, defaulting to the analytic field. The bed height is always
   * sampled from the terrain at the vertex's own position, which is what
   * couples every one of these meshes to the ground it is lying in.
   */
  _grid(nx, nz, pos, data = null, bedOverride = null) {
    const W = nx + 1, H = nz + 1;
    const P = new Float32Array(W * H * 3);
    const bed = new Float32Array(W * H);
    const flow = new Float32Array(W * H * 2);
    const agit = new Float32Array(W * H);
    const f = new THREE.Vector2();
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const [x, y, z] = pos(i, j);
        P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z;
        bed[k] = this.terrain.height(x, z);
        if (bedOverride) {
          const b = bedOverride(x, z);
          if (b !== null) bed[k] = b;
        }
        if (data) {
          const d = data(i, j);
          flow[k * 2] = d.flow[0]; flow[k * 2 + 1] = d.flow[1];
          agit[k] = d.agit;
          if (d.bed !== undefined) bed[k] = d.bed;
        } else {
          this._flowAt(x, z, f);
          flow[k * 2] = f.x; flow[k * 2 + 1] = f.y;
          agit[k] = this._agitAt(x, z);
        }
      }
    }
    const idx = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aBed', new THREE.BufferAttribute(bed, 1));
    g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
    g.setAttribute('aAgit', new THREE.BufferAttribute(agit, 1));
    // Flat up. The real shading normal is rebuilt per fragment from the
    // ripple, so a per-vertex one would only be overwritten.
    const nrm = new Float32Array(W * H * 3);
    for (let k = 0; k < W * H; k++) nrm[k * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(W * H * 2), 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  /* ------------------------------------------------------------- the boil */

  /* What happens where eighteen metres of water arrives, which up to now was
   * nothing: the streaks went through the surface and continued below it, and
   * the plane they crossed did not react.
   *
   * The thing that is missing in that description is not foam — the surface
   * material already whitens here — it is *relief*. A plunge is a jet driven
   * several metres under, and what comes back up is a standing dome of aerated
   * water a couple of metres across with a violently unstable top, surrounded
   * by a ring of foam travelling outward and a train of waves behind it. All
   * three of those are displacement, and none of them can be painted onto a
   * flat plane: the dome is what catches light on its shoulder and shadows on
   * its far side, and it is the only cue in the frame that says the water has
   * somewhere to go when the fall hits it.
   *
   * A dedicated radial mesh rather than displacement on the pool grid. The
   * pool is a fifty-metre sheet at half-metre spacing, so it has neither the
   * density here nor the topology — displacing a Cartesian grid with a radial
   * feature quantises the ring waves into squares. This is one draw call and
   * about nine hundred triangles, it is parameterised in the coordinates the
   * phenomenon actually has, and it fades to the pool's own surface at its rim
   * so the join is not visible.
   */
  _buildBoil() {
    /* Dense enough to carry the churn's relief. Still one draw call, and the
     * triangle count is noise next to the two and a half million in frame.
     *
     * The angular count is what it is because of where the camera stands. The
     * two framings this feature is judged on put the eye 16 cm and 36 cm above
     * the alcove's surface, so the boil is always seen from within its own
     * plane — and a displaced mesh viewed along its plane draws its own
     * tessellation as the silhouette. At 96 segments that was a row of straight
     * facets a hand's width each, which is the "faceted churn" reading; the
     * relief is not the problem at that point, the polygon count is. At 160 the
     * same silhouette is fine enough to read as froth. 18k triangles against
     * 2.4M in frame, and it measured free.
     */
    const NR = 56, NA = 160, R = 7.4;
    const W = NA + 1, H = NR + 1;
    const P = new Float32Array(W * H * 3);
    const pol = new Float32Array(W * H * 2);
    for (let j = 0; j < H; j++) {
      /* Nearly uniform radial spacing, and the exponent is why the churn was
       * faceted.
       *
       * At 1.7 the rings piled up against the centre — the first was 19 mm out
       * and the last four spanned two and a half metres. That is the wrong way
       * round for this surface: the relief is smooth and broad at the middle
       * and its *steepest* part is the shoulder of the mound at two to three
       * metres, which is exactly where the spacing had grown to half a metre.
       * A height field sampled at half a metre where it changes by a third of a
       * metre draws flat plates with straight silhouette edges, which is what
       * the frames show. 1.15 puts the samples where the gradient is.
       */
      const r = R * Math.pow(j / NR, 1.15);
      for (let i = 0; i < W; i++) {
        const a = (i / NA) * Math.PI * 2;
        const k = j * W + i;
        const x = IMPACT.x + Math.cos(a) * r, z = IMPACT.z + Math.sin(a) * r;
        /* One height for every vertex, which is not a detail. Sampling the
         * level table per vertex — the obvious thing, and what this did at
         * first — walks the upstream half of the disc straight up the
         * spillway, because the table is the *channel's* profile and four
         * metres upstream of the impact the channel is already several metres
         * up the cliff. The alcove is a pool. A pool is level. */
        P[k * 3] = x; P[k * 3 + 1] = IMPACT.y; P[k * 3 + 2] = z;
        pol[k * 2] = r; pol[k * 2 + 1] = a;
      }
    }
    const idx = [];
    for (let j = 0; j < NR; j++) {
      for (let i = 0; i < NA; i++) {
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        /* Wound so the front face points up. The ring runs anticlockwise in x
         * and z, so the obvious order (a, c, b) gives a face normal of -y: on a
         * mesh drawn FrontSide that is the whole disc facing the basin floor,
         * and every camera above the water culls it. It survived review because
         * the shading normal is computed analytically in the vertex shader and
         * does point up, so nothing about the lighting looked wrong — the churn
         * was simply not drawn. All that reached the frame were the triangles on
         * the mound's shoulder steep enough to flip, which is a thin wavy line
         * at the foot of the curtain and nothing else. */
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aPolar', new THREE.BufferAttribute(pol, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(W * H * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(W * H * 2), 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.boundingSphere.radius += 2;

    /* Single-sided, which the previous version was not and which is half of why
     * the churn read as folded paper. There is no view of a plunge pool from
     * which the *underside* of its own boil is something the eye should be
     * shown; drawing it two-sided with depth writes off meant every fold in the
     * surface presented its back face through its front one as a thin white
     * blade with a hard silhouette. Front faces only, and the relief is low
     * enough now that no trough needs the back face to close it. */
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.4, metalness: 0.0,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
      envMapIntensity: 0.7,
    });

    /* The surface, written once and used three times — for the height, for
     * the two finite differences that give the normal, and nowhere else. The
     * terms are, in order: the standing dome over the jet; its unstable top,
     * which is what makes a boil boil; the outgoing wave train; and the swell
     * that the wave train rides on.
     */
    const SURF = /* glsl */ `
      // Descending smoothstep. GLSL's own is undefined when the edges are
      // reversed, and every fade here is a fade *out* with radius.
      float bfade(float e0, float e1, float x){
        float k = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
        return k * k * (3.0 - 2.0 * k);
      }
      float boilH(float r, float a, float t){
        /* Every term is a function of *position*, and that is the whole of the
         * faceting fix rather than a refactor.
         *
         * The previous version detuned the wave train with harmonics in the
         * bearing — sin(a * 3.7), sin(a * 5.3), sin(a * (0.9 + r * 0.8)). A
         * non-integer multiple of the bearing is *discontinuous where the
         * bearing wraps*: at a = 0 the term is sin(0) and one vertex round the
         * disc, at a = 2*pi, it is sin(7.4*pi), and the two are not equal. So
         * the height field had a step in it along the whole +x radius, the
         * analytic normal across that step pointed sideways, and what came out
         * was a hard crease with flat plates either side of it. Chasing it as
         * a resolution problem is why two passes of re-tuning the exponent and
         * the ring count did not shift it: no amount of sampling represents a
         * discontinuity.
         *
         * Sampling the *world position* instead is continuous by construction —
         * there is no seam to cross, because the field does not know the disc is
         * parameterised in polar coordinates at all. It also fixes the second
         * half of the same bug for free: a term in the bearing has ground
         * wavelength 2*pi*r/k, which collapses to nothing at the pole and can
         * never be meshed there, while a term in x and z has the same
         * wavelength everywhere. And it is not periodic in the angle, so the
         * concentric-CD reading the critique caught cannot come back either.
         */
        vec2 p = vec2(cos(a), sin(a)) * r;
        float wob = sin(p.x * 0.61 + 1.7) * cos(p.y * 0.53 - 0.9)
                  + 0.62 * sin(p.x * 0.29 - p.y * 0.37 + 2.4);
        float amp = 0.62 + 0.34 * sin(p.x * 0.44 - p.y * 0.31 + 0.8);
        /* Half the relief it had, and the reason is self-occlusion rather than
         * taste.
         *
         * At 1.25 m of total amplitude over a mound about three metres across,
         * the surface has places where it is steeper than 45 degrees — and this
         * mesh is drawn two-sided with no depth write, from a camera two metres
         * above the water. A steep two-sided surface seen from near its own
         * plane shows its underside through its topside, and every fold becomes
         * a thin white blade with a hard silhouette edge. The isolated frame of
         * it read as a folded paper bird. A boil is not a tall object: it is a
         * *broken* surface barely raised above the pool, so the height comes
         * down, the mesh goes single-sided, and the churn is carried by the foam
         * coverage in the fragment shader where it cannot fold anything. */
        float dome = 0.46 * exp(-r * r / 7.0);
        /* The crown — the unstable top that makes a boil boil. Kept at a ground
         * wavelength of roughly two metres, which the 16 cm mesh spacing at the
         * shoulder carries with a dozen samples to spare. */
        float crown = 0.115 * exp(-r * r / 10.0)
          * (sin(p.x * 3.3 + p.y * 1.9 + t * 2.1)
               * sin(p.y * 2.7 - p.x * 1.4 - t * 2.6)
           + 0.55 * sin(p.x * 1.7 - p.y * 3.1 - t * 1.5));
        /* A second octave at about an 80 cm wavelength, which is the finest
         * relief this mesh can hold: at the shoulder the spacing is 10 cm
         * across and 13 cm out, so 80 cm is six samples and still smooth.
         * Without it the churn is a dune — one broad mound with a clean
         * silhouette, which is the "reads as a solid object" note. Churn is a
         * surface with something happening at every scale down to the bubble,
         * and this is the last scale before the fragment shader takes over. */
        crown += 0.045 * exp(-r * r / 12.0)
          * sin(p.x * 7.7 - p.y * 3.4 + t * 3.7)
          * sin(p.y * 6.9 + p.x * 2.8 - t * 4.3);
        /* Waves radiating out, and the phase has to be r - ct with c
         * positive or the rings travel inward, which reads as a drain. The
         * amplitude decays with radius twice over: once because a circular
         * wave spreads its energy round a growing circumference, and once
         * because it damps. */
        float ring = 0.15 * amp * exp(-r * 0.26) / sqrt(1.0 + r)
          * sin((r + wob * 0.55) * 2.05 - t * 3.4);
        ring += 0.065 * amp * exp(-r * 0.20) / sqrt(1.0 + r)
          * sin((r - wob * 0.90) * 1.31 - t * 2.15);
        float swell = 0.05 * sin(p.x * 0.70 - p.y * 0.40 - t * 1.35);
        /* And all of it goes to nothing before the mesh does. The disc has an
         * outline and the water does not, so anything still moving when the
         * rim arrives draws that outline for you — a raised elliptical table
         * edge sitting on an otherwise flat pool. */
        float h = (dome + crown + ring + swell) * bfade(7.4, 1.8, r);
        /* Nothing dips below the pool, and this is the dark hole.
         *
         * The wave troughs and the negative half of the crown together reached
         * about forty centimetres under the still-water plane. With depth writes
         * off on every water surface, a depressed patch of this mesh is seen
         * from a low camera *through* the pool as its own unlit underside — a
         * dark trapezoid punched in the water directly beneath the churn, with
         * straight edges where the surface crossed the plane. Compressing the
         * troughs and lifting the whole sheet a few centimetres keeps the wave
         * train legible while guaranteeing the churn is always the topmost
         * water in its own footprint. */
        return 0.055 + (h < 0.0 ? h * 0.22 : h);
      }
    `;

    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        tFoam: { value: this.tex.foam },
        uTime: this._surfaceUniforms().uTime,
        // Held below the curtain's own white. The churn is lit by the same
        // skylight and is no brighter than the sheet feeding it; brighter and
        // it separates from the fall and reads as a foreign object.
        uWhite: { value: new THREE.Color(0xb5b2a4) },
        /* Warmed toward the pool it sits in. Neutral grey plus a smooth white
         * surface at low roughness reflects the cool sky and comes back
         * steel-blue, which against an olive basin is a local palette break —
         * the one thing in this scene that must never happen. */
        uDeep: { value: new THREE.Color(0x2b2e26) },
        /* And the shade floor is warm too. This was a dark teal, and a teal
         * floor added to a neutral white under a cool sky is what actually put
         * the ice into the frame: the churn came back blue-white against an
         * olive basin and read as a snowdrift rather than as water. Nothing in
         * this scene is lit by anything but filtered green-gold daylight. */
        uScatter: { value: new THREE.Color(0x1e2119) },
      });
      sh.vertexShader = SURF + `
        attribute vec2 aPolar;
        uniform float uTime;
        varying vec2 vPolar;
        varying float vH;
      ` + sh.vertexShader
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          vPolar = aPolar;
          float h = boilH(aPolar.x, aPolar.y, uTime);
          vH = h;
          transformed.y += h;
        `)
        .replace('#include <beginnormal_vertex>', /* glsl */ `
          #include <beginnormal_vertex>
          {
            float r = aPolar.x, a = aPolar.y, t = uTime;
            float e = 0.09;
            float dr = (boilH(r + e, a, t) - boilH(r - e, a, t)) / (2.0 * e);
            // Angular difference converted to a real one: an arc of da at
            // radius r is r*da long, and dividing by anything smaller than a
            // few centimetres at the pole gives a normal pointing at nothing.
            float da = (boilH(r, a + e, t) - boilH(r, a - e, t))
                       / (2.0 * e * max(0.35, r));
            vec3 tr = normalize(vec3(cos(a), dr, sin(a)));
            vec3 ta = normalize(vec3(-sin(a), da, cos(a)));
            objectNormal = normalize(cross(ta, tr));
          }
        `);

      sh.fragmentShader = SSTEP + /* glsl */ `
        uniform sampler2D tFoam;
        uniform float uTime;
        uniform vec3 uWhite;
        uniform vec3 uDeep;
        uniform vec3 uScatter;
        varying vec2 vPolar;
        varying float vH;
        float gFoam = 0.0;
      ` + sh.fragmentShader
        .replace('#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          float r = vPolar.x, a = vPolar.y;
          vec2 xz = vec2(cos(a), sin(a)) * r;

          /* Foam sampled in a frame that moves outward with the water, so
           * the bubble rafts translate away from the impact instead of
           * sitting still while the mesh moves under them. Two scales: rafts
           * a metre across, and the clusters of bubbles inside them. */
          float adv = uTime * 0.85;
          vec2 dir = vec2(cos(a), sin(a));
          /* Sampled in a frame that is *stretched along the direction the water
           * is going*, which is what turns a field of blobs into rafts.
           *
           * Foam on moving water is always longer than it is wide: it is a
           * passive tracer being sheared by a velocity field, so it arrives as
           * trains and streaks rather than as spots. An isotropic sample of a
           * bubble map cannot express that however it is thresholded — it gives
           * round clumps, and round clumps at uniform density are the speckle
           * the critique read as grey dust. Three to one along the outward
           * radial, and the rafts draw themselves out into tails as they go. */
          /* And the *shapes* come from the map's coarse warped raft mask in .b,
           * with the bubble-scale channel used only as sparkle inside them.
           *
           * Reading the shapes out of .g — the 54-to-96-cell bubble field — and
           * then stretching it along the flow does not make rafts. It makes
           * hair: a field whose features are already smaller than a hand,
           * combed three to one, at constant density over a fifteen-metre disc.
           * That is the "static hatched noise reading as fur" the critique named
           * at the very start, arrived at from the opposite direction. .b is
           * warped and thresholded at about six cells, so its features are
           * metres across and survive being stretched.
           *
           * The anisotropy comes down with it. Just under two to one is enough
           * for the rafts to lean outward and be read as travelling; three to
           * one combs them whatever channel they came from. */
          /* The across-flow coordinate has to come from the *bearing*, not from
           * a component of the position, and getting that wrong is why the
           * rafts never broke up.
           *
           * Every point of this disc is dir * r by construction, so the
           * across-flow axis ac is perpendicular to the only direction the
           * position has: dot(rc, ac) is identically zero at every fragment.
           * The sample therefore ran along a single row of the foam map indexed
           * by radius alone, which makes the entire raft field a function of r —
           * concentric rings, thresholded into concentric bands. No amount of
           * cutting a field that has no angular variation produces patches.
           *
           * Sampling dir * g(r) instead keeps the advection and restores the
           * bearing, and the anisotropy comes out of the shape of g: the radial
           * scale is dg/dr and the tangential scale is g(r)/r, so holding g
           * below r by a fixed offset stretches features along the radial
           * without combing them. 0.58 with the offset taken at the middle of
           * the raft annulus is a shade under two to one there, which is the
           * ratio the note below asks for. */
          vec2 rc = dir * (0.58 * (r - adv) + 0.42 * 4.0);
          vec4 f1 = texture2D(tFoam, rc * 0.128 + 0.5);
          vec4 f2 = texture2D(tFoam, (xz - dir * adv * 1.7) * 0.20 + vec2(0.31, 0.77));

          /* Coverage. Total over the dome, then a ring that the waves carry
           * outward, then rags trailing off downstream — foam is memory, and
           * a boil with a hard-edged circle of white round it is a bathtub. */
          /* Whitest at the impact and dispersing outward, which is the
           * direction this had backwards.
           *
           * The previous version reached full coverage only inside 1.4 m —
           * which is entirely hidden behind the falling sheet — and everything
           * the camera could actually see was the thin outer speckle. So the
           * footprint of eighteen metres of falling water read as clean green
           * water with grey dust sprinkled round it. Foam is *made* where the
           * jet enters and destroyed slowly as it drifts, so the profile is a
           * solid white disc a good four metres across, breaking into rafts
           * only once it is outside the churn, and the modulation by the map
           * has to be applied to the rafts and not to the core: multiplying the
           * core by a noise field is what turned it into speckle. */
          /* The core, with a broken boundary. A solid disc is right — the jet
           * makes foam faster than it can drift away, so the footprint really
           * is saturated — but its *edge* must not be a circle, so the radius it
           * is tested against is displaced by the map rather than being
           * constant. */
          /* Two displacement scales on the radius it is tested against, not
           * one. A single one gives a circle with a wobble in it — the outline
           * is still one closed smooth curve, which is what makes the churn read
           * as a solid object with a soft edge. Adding a second scale three
           * times finer lets the boundary reach *inward* in places as well as
           * outward, so the core's edge has bays and headlands in it and the
           * rafts outside it look like they came off something. */
          /* The core is the width of the sheet and not the width of the mesh.
           *
           * At 4.6 m the saturated disc reached most of the way to the rim, so
           * once the mesh was actually being drawn the churn arrived as one
           * white object nine metres across with a soft edge — the "solid mass
           * rather than a raft field" reading, with the raft machinery outside
           * it having nothing left to break up. The sheet is a little over three
           * metres wide where it enters, and that is the only part of the basin
           * where foam is made faster than it disperses. Everything beyond it is
           * drifting foam and belongs to the threshold terms below.
           *
           * This is deliberately not the same radius as the alpha override
           * further down. The override has to cover the curtain's own lower
           * edge or the fall terminates on a visible line, but covering it with
           * *opacity* and covering it with *white* are different claims: what
           * the override needs is for the basin to be opaque there, and dark
           * water with rafts on it satisfies that as well as a white sheet does
           * and reads as water rather than as meringue. */
          float cov = sstep(3.5, 1.7, r + 1.5 * (f1.r - 0.5)
                                        + 0.62 * (f2.b - 0.5));
          /* Narrower than it was. At 2.1 m of Gaussian width this covered the
           * whole raft annulus on its own, so whatever the thresholds below did
           * was applied on top of a veil that never went to zero — and a veil
           * is the one thing that stops separate patches reading as separate. A
           * wave crest carrying foam out is about a metre wide. */
          float ring = exp(-pow((r - 3.5 - 0.55 * sin(uTime * 0.7)
                                 - 0.8 * sin(a * 2.0 + uTime * 0.3)) / 1.7, 2.0));
          /* Rafts by *threshold*, not by scale, and this is the correction to
           * "the rafts do not break up outward".
           *
           * The previous line multiplied the map by a radial fade, which cannot
           * produce a raft: scaling a smooth field down gives a dimmer smooth
           * field, so the outer churn came back as a uniform grey veil at about
           * a third of a unit of coverage — one solid object with a soft edge.
           * A raft is a *region*, with white inside it and dark water beside it,
           * and the only way to get regions out of a continuous field is to cut
           * it at a level. The level rises with radius, so the rafts thin and
           * separate as they travel instead of all ending at one contour. */
          /* Cut higher, everywhere. With the core pulled back to the width of
           * the sheet the rafts now have the whole annulus from three to seven
           * metres to themselves, and at the old level they simply filled it —
           * a threshold that passes two thirds of a field is not a raft field,
           * it is the same solid disc arrived at from outside. */
          float lvl = 0.42 + 0.34 * sstep(2.0, 7.2, r);
          float rf = f1.b * (0.55 + 0.75 * f1.r);
          /* Cut hard. A 0.26-wide transition on a field whose own contrast is
           * about that leaves no fully-covered interior and no clean outside —
           * it is a soft grey veil again, arrived at from the other direction.
           * A raft has a *rim*: white bubbles, then water, over a few
           * centimetres. Halving the transition is what makes the outer churn
           * read as a scatter of separate things. */
          float rafts = sstep(lvl, lvl + 0.13, rf) * sstep(7.3, 2.0, r);
          /* A second population at a coarser scale and a higher level, so the
           * rafts are not all one size. Foam that has survived to five metres
           * out has been through the same shear as the rest and has agglomerated
           * — the surviving patches are bigger and further apart than the ones
           * just leaving the churn, and one threshold on one field cannot say
           * both. This is the term that puts a few large slabs among the small
           * ones instead of a uniform grain. */
          float big = sstep(0.56, 0.66, f2.b * (0.62 + 0.62 * f1.g))
                    * sstep(8.6, 3.0, r);
          rafts = max(rafts, big * 0.85);
          /* And the tails. Everything the basin makes leaves it to the north —
           * the outwash runs from the alcove to the pool — so the rafts that
           * survive are drawn out downstream rather than radiating evenly, and
           * without this the foam field is symmetric, which no foam field on
           * moving water ever is. */
          float tail = sstep(0.40, 0.72, f1.b * (0.5 + 0.9 * f2.r))
                     * sstep(-0.5, 3.4, xz.y) * sstep(8.0, 3.0, r) * 0.9;
          cov = clamp(max(max(cov, ring * (0.22 + 0.46 * f1.r)
                                       * sstep(0.34, 0.66, f1.b)),
                          max(rafts, tail)), 0.0, 1.0);

          /* Bubbles read as light *between* dark water, so the white goes on
           * top of the deep colour rather than the surface being tinted. */
          /* Bubble sparkle from the fine channel, read isotropically so it stays
           * bubbles. This is the only place the 54-cell field belongs: as value
           * variation inside a raft whose shape something else decided.
           *
           * The range is wide on purpose. At 0.78-to-1.0 of the way to white the
           * foam mass had four per cent of internal contrast, so it arrived as
           * one flat tone with a smooth outline — a meringue. A mass of bubbles
           * is not one tone: it is lit crests with genuinely dark water in the
           * crevices between them, and that contrast is the entire difference
           * between reading it as churn and reading it as a solid object. */
          float bub = f2.g * (0.55 + 0.75 * f2.r);
          diffuseColor.rgb = mix(uDeep, uWhite, cov * (0.42 + 0.62 * bub));
          // The rim has to disappear into the pool. Anything sharper than
          // this is the mesh's own outline drawn across still water.
          float edge = sstep(7.4, 4.6, r);
          /* Alpha follows the foam and almost nothing else.
           *
           * There used to be a flat 0.30 floor under this, so every fragment of
           * a fifteen-metre disc drew at least a third of a unit of dark olive
           * whether there was foam on it or not — a tinted lens lying over the
           * basin, and in an isolated frame the churn read as a dark green mound
           * with white blades on it rather than as foam on water. Where there is
           * no foam there is no boil: the pool's own surface is already there and
           * is already correct. The height term is kept at a fraction of what it
           * was, purely so the shoulder of the mound still catches a little light
           * and the relief does not vanish entirely in the clear water between
           * rafts. */
          diffuseColor.a *= clamp((cov + 0.22 * max(0.0, vH - 0.06)) * edge,
                                  0.0, 1.0);
          /* And the churn is opaque, over the two metres where the sheet is
           * entering it. This is the term that makes the water touch the water:
           * the curtain's geometry runs on through the surface and this covers
           * the place where it does, so there is no boundary to see. */
          /* Ragged, not a disc — and pulled well inside the mesh's own rim.
           *
           * The override used to carry alpha out to six metres, which is past
           * the point where the height has faded to nothing. So beyond the
           * mound there was a flat half-opaque annulus lying exactly in the
           * water plane, and a flat annulus seen from eye height projects to a
           * bright horizontal line across the whole frame. That was the razor
           * seam. Multiplying by the same fade the geometry uses means the
           * churn's opacity and its relief end together. */
          /* Widened to 5.6 m, because the sheet is that wide by the time it
           * arrives. At 4.4 the override stopped inboard of the curtain's own
           * lower edge, so the outer metre of the fall ran on down past the
           * churn and terminated on the still-water plane — a hard horizontal
           * line either side of the mound, which is the same artificial edge
           * this term exists to remove, just moved sideways. */
          diffuseColor.a = max(diffuseColor.a,
                               sstep(5.6, 2.4, r) * (0.55 + 0.62 * f1.r))
                         * edge;
          gFoam = cov;
        `)
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
          #include <roughnessmap_fragment>
          // Never a mirror. The floor is what stops the churn returning a
          // specular image of the sky, which is the other half of the blue.
          roughnessFactor = mix(0.62, 0.88, gFoam);
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */ `
          #include <emissivemap_fragment>
          // The same argument as the curtain's floor: a mass of bubbles in
          // shade is still bright, because it is scattering skylight from
          // every facet, and no BRDF on a single surface will say so.
          totalEmissiveRadiance += uScatter * gFoam * diffuseColor.a;
        `);
    };
    m.customProgramCacheKey = () => 'water-boil';

    this.boilMat = m;
    this.boil = new THREE.Mesh(g, m);
    this.boil.name = 'boil';
    return this.boil;
  }

  /* ---------------------------------------------------------- the curtain */

  _buildCurtainMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.5,
    });

    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        tStrands: { value: this.tex.strands },
        uTime: this._surfaceUniforms().uTime,
        uFallT: { value: FALL_T },
        // The surface the sheet lands in, so it can be cut off at it.
        uWaterY: { value: ALCOVE_Y },
        uGlass: { value: new THREE.Color(0x0d1a1a) },
        /* Pulled well down from 0xe6eeee, and this is the correction to the
         * regression rather than a taste adjustment.
         *
         * Aerated water is the brightest thing in a gorge, and the previous
         * pass took "brightest" to mean "near the top of the range". It is not
         * the same claim. Once the diffuse, the forward scatter and the shade
         * floor were all pushed up together, the lower two thirds of the sheet
         * arrived at the tone mapper already clipped — and a clipped region has
         * no tonal structure in it *by definition*, so the fall lost its
         * volume and became a flat white truncated cone. What makes water read
         * as powerful is contrast within it: a bright core against darker,
         * translucent, disintegrating limbs. That needs headroom, and headroom
         * is what this number buys back. */
        uWhite: { value: new THREE.Color(0xbcc6c2) },
        // Cool, because it is skylight that has been through a cloud of
        // water, and dim, because this is a floor and not a light source.
        // Halved for the same reason as the white above.
        uScatter: { value: new THREE.Color(0x161e20) },
      });

      sh.vertexShader = `
        attribute float aFall;
        attribute float aAcross;
        attribute float aCol;
        attribute float aShell;
        attribute float aCrest;
        varying float vFall;
        varying float vAcross;
        varying float vCol;
        varying float vShell;
        varying float vCrest;
        varying float vWY;
      ` + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vFall = aFall; vAcross = aAcross; vCol = aCol; vShell = aShell;
        vCrest = aCrest;
        vWY = (modelMatrix * vec4(transformed, 1.0)).y;
      `);

      sh.fragmentShader = SSTEP + /* glsl */ `
        uniform sampler2D tStrands;
        uniform float uTime;
        uniform float uFallT;
        uniform float uWaterY;
        uniform vec3 uGlass;
        uniform vec3 uWhite;
        uniform vec3 uScatter;
        varying float vFall;
        varying float vAcross;
        varying float vCol;
        varying float vShell;
        varying float vCrest;
        varying float vWY;
        float gAer = 0.0;
        float gRope = 0.0;
      ` + sh.fragmentShader
        .replace('#include <color_fragment>', /* glsl */ `
          #include <color_fragment>

          float f = clamp(vFall / uFallT, 0.0, 1.0);

          /* The advected coordinate, and the reason this does not read as a
           * scrolling texture.
           *
           * A parcel of water currently at fall-time vFall left the lip at
           * (uTime - vFall), so that difference is a *label* identifying the
           * parcel — constant for a given parcel for its whole descent. Using
           * it as the texture coordinate means the pattern is attached to the
           * water rather than to the mesh, and because fall-time maps to
           * distance quadratically, a feature that is half a metre long at
           * the lip is nearly two metres long by the time it reaches the
           * bottom. That stretch is the visual signature of gravity and no
           * amount of scrolling a texture at a constant rate produces it. */
          /* Sheared with fall time, which is what the tearing needed and did
           * not have.
           *
           * The previous coordinate was constant across a column for the whole
           * descent, so every rope was a perfectly vertical stripe from lip to
           * pool and the sheet came back as woven linen at every focal length.
           * Adding a term in f drags each column's pattern sideways as it
           * falls, by an amount proportional to the same per-column drift the
           * geometry uses — so strands lean, converge and cross, which is what
           * a disintegrating sheet does and what no amount of detail in the map
           * itself can supply.
           *
           * The per-column offset is also much smaller than it was. At 0.41 of
           * the map's width, adjacent columns were sampling places with no
           * relationship to each other, and a set of neighbouring but
           * uncorrelated vertical stripes is precisely the weave. */
          float parcel = (uTime - vFall);
          /* Small. The first attempt at this used a shear of up to 1.3 of the
           * map's width, which is more than a whole period between adjacent
           * columns — so the coordinate gradient across every quad was enormous
           * and the sheet came back as stretched diagonal swirls, reading as
           * polished wood rather than as water. The lateral tearing is the
           * geometry's job; the texture only has to avoid contradicting it. */
          float shear = vCol * (0.05 + 0.17 * f);
          vec2 uv = vec2(vAcross * 1.35 + shear, parcel * 0.34);
          vec4 st = texture2D(tStrands, uv);
          // A second, slower read for the surges travelling down the sheet.
          vec4 sg = texture2D(tStrands, vec2(uv.x * 0.6 + 0.2, parcel * 0.14 + 0.5));
          // And a third, fine and fast, for the shredded bottom.
          vec4 sf = texture2D(tStrands, vec2(uv.x * 2.4 + 0.13, parcel * 0.66 + 0.31));

          /* Breakup as a function of time in the air, which is the physically
           * meaningful variable — a sheet comes apart because surface tension
           * loses to the growth of its own instabilities, and that is a clock
           * that starts at the lip. Three overlapping regimes rather than
           * three separate looks, so the transitions are continuous:
           *
           *   glassy   coherent, transparent, a mirror. Very short: this is
           *            the tongue over the lip and the first metre or two.
           *   torn     filaments separating, holes opening between them.
           *   spray    no sheet left, just droplets and the air between them.
           */
          float torn  = sstep(0.04, 0.34, f);
          float burst = sstep(0.42, 0.94, f);

          /* Perforation. A threshold that *falls* with fall-time, compared
           * against a correlated random field, so more of the sheet exceeds
           * it as the water descends and the holes always open in the same
           * thin places between strands rather than the sheet dissolving
           * uniformly. Fading a curtain out with a scalar alpha is the single
           * most obvious way to make it look like a decal.
           *
           * The direction of the comparison is the whole thing and it was
           * inverted at first: the strands map's tear channel is *high*
           * between filaments, so testing for values below the threshold
           * punched the holes through the middle of every strand and left the
           * gaps solid — a photographic negative of a waterfall, which from a
           * distance looks like a grey slab. */
          float thr = 1.0 - torn * 0.62;
          float hole = sstep(thr - 0.06, thr + 0.20, st.a);
          hole *= 1.0 - st.r * 0.62;

          float strand = st.r * (0.55 + 0.6 * sg.g);

          /* Ropes and the voids between them, as two hard-edged masks rather
           * than as one smooth field.
           *
           * This is the difference between the current sheet and the one two
           * revisions back that the critique preferred. The smooth mask above is a
           * smooth product of two maps, and a smooth field between 0.3 and 0.9
           * pushed through a near-opaque alpha gives an even satin — every
           * column present, none of them separated. What reads as rope is
           * *contrast*: a filament that is essentially solid with a gap beside
           * it that is essentially empty. Two steepened thresholds give that,
           * and the void mask is what puts the dark lines back between the
           * columns that the old build had and this one lost. */
          float rope = sstep(0.30, 0.66, strand + 0.22 * sg.b);
          float void_ = sstep(0.46, 0.86, st.a * (0.7 + 0.5 * sg.r));

          /* Three alphas, blended by the same clock as everything else.
           *
           * The coherent one is nearly solid, and it has to be. A tongue of
           * water going over a lip is twenty or thirty centimetres thick and
           * you cannot see the rock through it — what makes it read as water
           * rather than as white paint is that it is *dark* and mirror
           * smooth, not that it is faint. The first pass had it at half
           * alpha, which over a dark cliff is nearly nothing, and the top of
           * the fall simply was not there. */
          float aTorn = mix(0.20, 1.0, rope) * (1.0 - hole * 0.88)
                      * (1.0 - void_ * 0.78);
          float a = mix(0.94, aTorn, torn);

          /* The bottom third, which the critique wanted as *a chaotic mass of
           * opaque white water*, and which the previous version got exactly
           * backwards by thinning it to a grey haze.
           *
           * The body of it is near-solid: a fall's lowest few metres carry
           * every litre that went over the lip plus the air beaten into them,
           * and you cannot see through that. The rag is at the margins, where
           * packets that have separated are individually small enough to see
           * between. So the core term is driven by distance from the sheet's
           * centreline and the fringe by the fine map, rather than the whole
           * thing being faded by one scalar. */
          float core = sstep(0.86, 0.30, abs(vAcross));
          float aBurst = core * (0.80 + 0.20 * sf.b)
                       + 0.55 * sf.r * (0.30 + 0.70 * rope);
          a = mix(a, clamp(aBurst, 0.0, 1.0), burst);

          /* Mass in the bottom third's core, and only there.
           *
           * Pulling the exposure down fixed the clipping and overshot into
           * gauze: the cliff's cell texture read straight through the middle of
           * a twenty-metre fall, which is not translucency, it is absence. The
           * limbs are meant to be transparent and stay so — this term is gated
           * on distance from the centreline as well as on fall time, so it
           * cannot reach them. The inner third of the sheet's width, over the
           * last third of its drop, is carrying the entire discharge plus the
           * air beaten into it, and nothing is visible through that. */
          float mass = burst * sstep(0.44, 0.16, abs(vAcross));
          a = mix(a, 0.94 + 0.06 * rope, mass);

          /* The limbs, which is the term the sheet was missing and the reason
           * its silhouette terminated on a clean geometric line.
           *
           * A fall of this size has a bright aerated core carrying most of the
           * discharge and, outside it, limbs that are already mostly air —
           * individually separated ropes and packets with sky between them. The
           * previous alpha was near-uniform right out to a feathered edge, so
           * the sheet had one opacity across its whole width and the outline of
           * the mesh became the outline of the water. Taking the outer fifth
           * down to a fraction of the core, modulated by the rope mask so what
           * survives out there is filaments rather than a wash, lets the cliff
           * read faintly through the wings and lets the boundary dissolve
           * instead of ending. */
          float outer = sstep(0.52, 1.00, abs(vAcross));
          a *= mix(1.0, 0.12 + 0.46 * rope, outer * (0.35 + 0.65 * torn));

          /* The tongue, given the limbs' falloff along its leading edge.
           *
           * The four rows above the lip are the water still rolling over the
           * rock, and every alpha term above is written in fall time — so at
           * f = 0 the torn, burst and mass mixes all collapse to their
           * coherent end and the whole crest came out at one flat 0.94. The
           * mesh ends there, so that flat value ended on the mesh's boundary:
           * a hard top edge, two square corners where it met the width
           * feather, and a uniform grey-blue face between them. A slab, which
           * is what it read as — a fixture with water coming out of it rather
           * than a stream arriving at an edge.
           *
           * The fix is the term the limbs have and the crest did not. Alpha
           * falls off toward the leading edge through the same rope mask, so
           * what survives at the boundary is filaments with gaps between them
           * — the comb of strands a tongue actually breaks into as it thins
           * over a lip — and what is left inboard is streaked rather than
           * flat. Nothing here can reach f > 0: vCrest is zero from the lip
           * down, so the curtain's core opacity is untouched.
           */
          float lead = sstep(0.10, 0.95, vCrest);
          a *= mix(1.0, 0.10 + 0.44 * rope, lead);

          // The sheet's own edges. Feathered, because a curtain of water has
          // no edge — it frays into the air, and a straight vertical boundary
          // is the giveaway. Only lightly at the lip, where the flow is still
          // confined by the rock it just left.
          /* And harder across the crest, which is what rounds the corners off
           * the tongue. The geometry there is slightly *wider* than the lip,
           * so with the sheet's own feather the outermost columns were still
           * carrying half their alpha out to a square end. Bringing the
           * feather inboard as the rows go upstream turns the plan of the
           * tongue into a wedge that narrows into the notch. */
          a *= sstep(1.14 - 0.26 * vCrest, 0.84 - 0.34 * torn - 0.22 * vCrest,
                     abs(vAcross));
          // The back face is behind a metre of water and reads accordingly.
          a *= vShell < 0.0 ? 0.72 : 1.0;

          /* And the part that is under the water, which exists only so that
           * the geometry has no row of vertices lying along the surface. It
           * fades out fast: it is there to be overlapped by the boil, not to
           * be seen through the pool. */
          a *= 1.0 - sstep(0.988, 1.012, vFall / uFallT) * 0.97;
          /* And the same cut expressed in world height, which is the one that
           * actually holds.
           *
           * The fall-time gate above assumes every column reaches the water at
           * the same moment, and none of them do — each one is dropped by up to
           * 1.7 m by its own lag, so a column can be two metres under the
           * surface while its fall-time still says it is short of it. Two metres
           * of curtain was therefore drawn *below* the pool at nearly full alpha,
           * and from a camera near the water that is a mass of pale plates
           * hanging under the churn where there should be dark water. The boil's
           * opacity override covers the surface, not the volume beneath it.
           *
           * Height is the physically correct variable and it cannot be fooled by
           * the drift: below the water there is no curtain, there is pool. */
          a *= mix(0.03, 1.0, sstep(uWaterY - 0.30, uWaterY + 0.14, vWY));

          /* Aeration, which is what actually turns the water white — and the
           * direction of this gradient is the fourth finding.
           *
           * It is not the same thing as breakup. The tongue at the lip is
           * already fast and already turbulent but it is still bulk water:
           * dark, clear, glassy, a mirror. It goes white progressively as air
           * is beaten into it during the descent, and it is whitest in the
           * last few metres before impact where it is more foam than water.
           * The previous curve started at 0.42 at the lip and saturated by a
           * third of the way down — whitest at the top, thinning to grey —
           * which is the inversion the critique caught. This one starts at
           * nothing and does not reach full until the bottom. */
          gAer = clamp(sstep(0.03, 0.72, f) * (0.78 + 0.34 * sg.g)
                       + 0.14 * strand * torn, 0.0, 1.0);
          /* And the value it maps to keeps its structure, which is the other
           * half of the saturation problem.
           *
           * Even with the white pulled down, driving the mix by aeration alone
           * gives one value everywhere aeration has saturated — a flat field
           * over the lower two thirds. Water does not do that: within a bright
           * core there are denser and thinner packets, and the difference
           * between them is what the eye integrates as mass. The rope mask
           * carries most of that variation and the surge map the rest, and the
           * ceiling stays short of the white so there is somewhere for a lit
           * highlight to go without clipping. */
          float val = gAer * (0.34 + 0.50 * rope + 0.22 * sg.g);
          // The limbs are thinner water and therefore darker as well as more
          // transparent; without this they are pale and the sheet keeps its
          // hard edge in value even after it has lost it in alpha.
          val *= 1.0 - outer * 0.30;
          // The dense core is white as well as opaque. Opacity alone over a
          // dark cliff gives a grey slab, which is the other way to lose a
          // fall's lower third.
          val = mix(val, 0.78 + 0.18 * rope, mass * 0.85);
          // A floor, so the glassy top still catches enough light to exist
          // against a dark cliff rather than vanishing into it.
          diffuseColor.rgb = mix(uGlass, uWhite, clamp(max(val, 0.07), 0.0, 1.0));
          diffuseColor.a *= clamp(a, 0.0, 1.0);
          gRope = rope;
        `)
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
          #include <roughnessmap_fragment>
          // Glass at the lip, wet chalk at the bottom.
          roughnessFactor = mix(0.06, 0.72, gAer * (0.5 + 0.5 * gRope));
        `)
        /* Forward scattering, and it is not decoration: a sheet of aerated
         * water is a cloud of droplets, and a cloud lights up when you look
         * through it toward the sun. This is the term that makes the falls
         * glow when the light is behind it and go flat grey when it is not,
         * which is most of why the low-sun and high-sun captures look like
         * different times of day rather than the same object at two
         * exposures. Added to emissive rather than to the diffuse so it
         * survives being in shadow, which is the whole point — the sheet is
         * lit from behind, so the surface facing the camera is not. */
        .replace('#include <emissivemap_fragment>', /* glsl */ `
          #include <emissivemap_fragment>
          #if NUM_DIR_LIGHTS > 0
            /* vViewPosition runs from the fragment to the camera, so its
             * negation is the view ray, and the sun's direction here also
             * points toward the light. The two agreeing means the camera is
             * looking through the sheet at the sun, which is precisely when
             * a cloud of droplets lights up. */
            float fwd = clamp(dot(-normalize(vViewPosition),
                                  directionalLights[0].direction), 0.0, 1.0);
            /* Halved, and modulated by the rope mask rather than applied flat.
             * At 0.6 this term alone was enough to push the lower sheet past
             * the tone mapper's shoulder whenever the sun was anywhere behind
             * it, which is most of the day here — and it was doing so
             * uniformly, so it erased the structure the diffuse had. */
            totalEmissiveRadiance += directionalLights[0].color
              * pow(fwd, 5.0) * gAer * (0.10 + 0.30 * gRope) * diffuseColor.a;
          #endif
          /* And a floor under it that owes nothing to the sun.
           *
           * This fall stands in a notch in a thirty-metre cliff and spends
           * most of the day in that cliff's shadow, where the direct term
           * above is zero and the canopy occlusion has taken most of the
           * ambient as well. Real white water in shade is still one of the
           * brightest things in a gorge, because it is a mass of droplets
           * scattering skylight in every direction — an effect a surface BRDF
           * has no way to express. Without this the fall goes the same value
           * as the rock behind it whenever the sun is not directly on it,
           * which is most of the shots. */
          totalEmissiveRadiance += uScatter * gAer * diffuseColor.a;
        `);
    };
    m.customProgramCacheKey = () => 'water-curtain';
    this.curtainMat = m;
  }

  /* The falling sheet, on the trajectory it would actually take.
   *
   * Built as a ballistic ribbon rather than a plane hung off the cliff. The
   * difference is visible from the side, which is where the player first sees
   * it: the sheet leaves the lip on the chute's tangent, arcs out from the
   * face, and steepens toward vertical as the horizontal component of its
   * velocity stops mattering. A flat plane has to be either vertical (and
   * intersect the undercut) or leaning (and hit the rock), and a fall whose
   * profile does not curve is the second-most obvious tell after a scrolling
   * texture.
   *
   * The sheet also has a cross-section. It bows downstream in the middle,
   * because that is where the water is deepest and fastest, and it spreads as
   * it descends — a falling ribbon widens as air resistance works on its
   * edges. Both are small, and both are what stop the curtain reading as a
   * piece of paper when the light rakes across it.
   */
  _buildCurtain() {
    /* Four rows above the lip and thirty below it, in two shells.
     *
     * The shells are the answer to the first craft finding, which was that
     * edge-on the fall had no volume at all — a zero-thickness card with the
     * cliff's voronoi readable straight through it. A curtain is a slab: a
     * couple of hundred millimetres of water at the lip and well over a metre
     * of churning mass by the bottom, and the two faces of that slab are not
     * the same water. Building it as two surfaces a thickness apart, joined
     * round the rim, gives the silhouette a cross-section, doubles the alpha
     * through the body so it is genuinely opaque where it should be, and —
     * because the back shell samples the strand map at a different parcel
     * time — puts a second layer of structure moving at its own rate behind
     * the first. That parallax between the two is most of what stops a sheet
     * reading as a printed image.
     *
     * The four rows above the lip are the tongue rolling over the edge, and
     * they are part of this mesh rather than of the chute so that there is no
     * join between them: the water accelerates off the rock, thins, and is
     * airborne, in one continuous surface with one continuous set of texture
     * coordinates.
     */
    /* More columns than before, because each one is now an independently
     * drifting rope and a wide one is a flat panel. At sixteen the outermost
     * column carried half a metre of width out to two and a half metres of
     * drift, which draws a translucent quadrilateral wing — visibly a sheet of
     * glass rather than a separated packet. */
    const NS = 30, NA = 24, CR = 4;
    const W = NA + 1, H = NS + CR + 1;
    const N = W * H * 2;
    const P = new Float32Array(N * 3);
    const fall = new Float32Array(N);
    const across = new Float32Array(N);
    const col = new Float32Array(N);
    const shell = new Float32Array(N);
    // 1 on the tongue's leading edge, 0 from the lip down. See the crest
    // alpha in the fragment shader: fall time cannot express this, because
    // the rows above the lip all clamp to f = 0.
    const crest = new Float32Array(N);
    const nrm = new Float32Array(N * 3);

    /* Per-column lateral velocity, which is what tears the sheet into ropes.
     *
     * A falling sheet does not stay a sheet: surface tension loses to its own
     * instabilities within two or three metres and it separates into discrete
     * strands that drift apart, so their edges are not parallel and the gaps
     * between them widen with depth. That is geometry, not texture — a texture
     * can perforate a sheet but it cannot make its silhouette non-parallel,
     * which is why the long-lens frame came back as evenly-spaced vertical
     * satin stripes however good the map on them was. Each column gets a small
     * random sideways speed and the offset grows superlinearly with fall time,
     * exactly as it would if the sheet had let go of it at the lip. */
    let s0 = 0x51a3f7;
    const rnd = () => (s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296;
    /* Four numbers per column, and the magnitudes are the whole correction.
     *
     * The first attempt gave each column a lateral velocity of 0.75 m over an
     * eighteen-metre drop, against a sheet that spreads to four and a half
     * metres of half-width — sixteen per cent, which is below the threshold at
     * which the eye reads a silhouette as ragged rather than as straight. The
     * critique's phrase was "orders of magnitude below visibility" and it was
     * right. `tear` is now metres, not a fraction, and there is a second
     * harmonic in `wig` so the drift is not monotonic: a column that only ever
     * moves one way traces a straight oblique line, which is a cone with a
     * different opening angle rather than a torn sheet.
     *
     * `lag` is the one that matters most for the bottom edge. Columns arrive at
     * the water at different times because they left the lip at different
     * speeds, so the base of a real fall is a ragged front over a metre or more
     * of depth. Every column arriving at exactly the same height is what drew
     * the straight bottom boundary the critique called the most artificial line
     * in the system.
     */
    const tear = [], wig = [], lag = [], wide = [];
    for (let i = 0; i < W; i++) {
      tear.push(rnd() * 2 - 1);
      wig.push(rnd() * 6.283);
      lag.push(rnd());
      wide.push(0.88 + rnd() * 0.24);
    }

    const put = (k, sh, j, i) => {
      const u = (i / NA) * 2 - 1;
      let tf, y, z, half, thick;
      if (j < CR) {
        /* The crest. Parameterised backwards in fall time from the lip, with
         * the height blended from the rock's own profile onto the ballistic
         * one so the sheet leaves the edge tangentially instead of hinging
         * off it. */
        const k2 = (CR - j) / CR;
        tf = -0.19 * k2;
        z = LIP_Z + EXIT_VZ * tf;
        const rock = spillFloor(z) + LIP_DEPTH * (1.0 + 0.9 * k2);
        y = fallY(tf) * (1 - k2) + rock * k2;
        half = LIP_HALF * (1 + 0.10 * k2);
        thick = LIP_DEPTH * (1 + 1.2 * k2);
      } else {
        /* Biased toward the top: the first fifth of the drop contains the
         * whole coherent-to-torn transition, which is the part with structure
         * in it. The bottom is a chaotic mass and needs few vertices. */
        const s = Math.pow((j - CR) / NS, 1.30);
        tf = s * TF_END;
        z = fallZ(tf); y = fallY(tf);
        /* A far shallower spread than before, and this is what actually kills
         * the cone.
         *
         * The mesh used to more than double its half-width over the drop, which
         * is a trapezoid whatever noise is applied on top of it — the two
         * generatrices are straight lines because the function generating them
         * is monotonic and shared by every column. A real fall of this
         * discharge stays close to the width of its notch and grows *ragged*
         * rather than wide: what spreads is the individual ropes, which is the
         * per-column drift below. Halving the systematic term and leaving the
         * random one at plus or minus a metre and a half means the outline is
         * made mostly of noise. */
        half = LIP_HALF * (1 + 0.55 * Math.pow(s, 1.25));
        thick = 0.30 + 1.45 * Math.pow(s, 1.05);
        /* Past the water line the sheet is not a sheet any more, it is the
         * splash it makes. Flaring the last rows hard and letting them run
         * below the surface is what removes the bottom edge: there is no row
         * of vertices lying along the water for the eye to find, because the
         * geometry carries straight through it and the boil is drawn over the
         * top. */
        /* Past the water line the rows narrow rather than flare. Flaring them
         * drew a translucent apron spreading out past the churn on both sides —
         * a lampshade base, which is worse than the straight edge it replaced.
         * They exist only so that no row of vertices lies along the surface,
         * and they are almost entirely faded out in the shader. */
        const sub = Math.max(0, (tf - FALL_T) / (TF_END - FALL_T));
        half *= 1 - 0.20 * sub;
        thick *= 1 + 1.2 * sub;
      }
      const s = Math.max(0, tf / FALL_T);
      /* Lateral drift, in metres, with a wobble on it. At the bottom this is
       * up to about two and a half metres against a half-width of four and a
       * half, which is what makes the left and right silhouettes ragged at
       * every height instead of two straight generatrices. */
      const splay = tear[i] * (1.55 * Math.pow(s, 1.5))
                  + Math.sin(wig[i] + s * 5.1) * 0.62 * Math.pow(s, 1.3);
      // Cosine bow: the middle of the sheet is thrown further than the wings.
      const bow = Math.cos(u * Math.PI * 0.5) * (0.30 + 0.55 * s);
      // Per-column width, so the sheet does not open as a single clean angle.
      P[k * 3] = LIP_X + u * half * (j < CR ? 1 : wide[i]) + splay;
      /* The back face lags. Water against the rock is slowed by it, so the
       * upstream surface of a curtain is always a little behind and a little
       * higher than the free one; without the offset the two shells are
       * parallel and the slab reads as one thick card rather than as a mass. */
      // And every column reaches the water at its own moment.
      const drop = j < CR ? 0 : (lag[i] * 1.35 + 0.35 * Math.sin(wig[i] * 2.1))
                              * Math.pow(s, 2.6);
      P[k * 3 + 1] = y + (sh < 0 ? 0.22 * s : 0) - drop;
      P[k * 3 + 2] = z + bow + sh * thick * 0.5
                   + Math.sin(wig[i] * 1.7) * 0.55 * Math.pow(s, 1.6);
      // A parcel label per shell, so the two faces are never the same image.
      fall[k] = tf + (sh < 0 ? 0.13 : 0);
      across[k] = u;
      // Signed, and the same number the geometry drifted by, so the texture
      // shears with the column it belongs to instead of against it.
      col[k] = tear[i];
      shell[k] = sh;
      crest[k] = j < CR ? (CR - j) / CR : 0;
      /* The shading normal, taken from the trajectory rather than from the
       * mesh, and this is the fix for the flat rectangular plates in the sheet.
       *
       * They were never a texture problem. Each column here drifts, wobbles in
       * z and reaches the water at its own moment, by up to a couple of metres
       * against a column spacing of about thirty centimetres — so in the lower
       * half of the fall neighbouring columns genuinely cross one another and
       * the quads between them are non-planar and self-intersecting. That is
       * intended, it is what makes the silhouette ragged, and on its own it
       * costs nothing: the sheet is drawn with an alpha that comes from the
       * strand maps, not from the surface orientation.
       *
       * What made it visible was computeVertexNormals() below, which averaged
       * the face normals of those crossing triangles and produced a different
       * essentially arbitrary direction for each one. The material is a standard
       * PBR surface, so its diffuse and specular both read that normal, and
       * adjacent triangles a fraction of a degree apart in reality came back
       * shaded a stop apart — which is precisely a field of flat plates with
       * hard edges. Three passes looked for it in the strand map, the mip chain
       * and the two-shell alpha, none of which were ever involved.
       *
       * A curtain's normal is a property of its trajectory, and the trajectory
       * is known analytically here: the sheet is falling along the velocity
       * vector, so its face points at right angles to it in the vertical plane.
       * At the lip that is 46 degrees off horizontal, which is the tongue still
       * rolling over the edge; twenty metres down the water is doing 21 m/s
       * straight down and the face is vertical. Authoring it costs four lines,
       * cannot be affected by the geometry crossing itself, and gives the sheet
       * a single coherent response to the light shafts instead of a mosaic. */
      const vy = EXIT_VY - G * Math.max(0, tf), vz = EXIT_VZ;
      const vl = Math.hypot(vy, vz) || 1;
      nrm[k * 3] = 0;
      nrm[k * 3 + 1] = (vz / vl) * sh;
      nrm[k * 3 + 2] = (-vy / vl) * sh;
    };

    for (let sh = 0; sh < 2; sh++) {
      const sgn = sh === 0 ? 1 : -1;
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) put(sh * W * H + j * W + i, sgn, j, i);
      }
    }

    const idx = [];
    for (let sh = 0; sh < 2; sh++) {
      const o = sh * W * H;
      for (let j = 0; j < H - 1; j++) {
        for (let i = 0; i < NA; i++) {
          const a = o + j * W + i, b = a + 1, c = a + W, d = c + 1;
          if (sh === 0) idx.push(a, c, b, b, c, d);
          else idx.push(a, b, c, b, d, c);
        }
      }
    }
    // The rim, closing the two shells into a slab. Without it the silhouette
    // edge-on is two lines with a gap of nothing between them.
    for (const i of [0, NA]) {
      for (let j = 0; j < H - 1; j++) {
        const a = j * W + i, b = W * H + a;
        const c = a + W, d = b + W;
        idx.push(a, b, c, b, d, c);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aFall', new THREE.BufferAttribute(fall, 1));
    g.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 1));
    g.setAttribute('aShell', new THREE.BufferAttribute(shell, 1));
    g.setAttribute('aCrest', new THREE.BufferAttribute(crest, 1));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(N * 2), 2));
    g.setIndex(idx);
    // No computeVertexNormals: it would discard the trajectory normals authored
    // above, which is the bug that drew the plates. See put().
    g.computeBoundingSphere();

    this.curtain = new THREE.Mesh(g, this.curtainMat);
    this.curtain.name = 'falls';
    return this.curtain;
  }

  /* ------------------------------------------------------------ the spray */

  /* Splash and drift, as one additive point cloud.
   *
   * Points rather than quads, and additive rather than sorted alpha. Both
   * choices are about the same risk: this plume is a screen-filling object
   * when the player stands at the pool, so every pixel of it is overdraw on
   * top of a frame that already has a volumetric pass to run. Point sprites
   * are one vertex each and need no sorting; additive blending is
   * order-independent, which is the only way to avoid sorting a few hundred
   * moving sprites every frame. The scene composites in a half-float target
   * before tone mapping, so the sum does not clip on the way — additive spray
   * against a bright sky would blow out in an LDR pipeline and here it simply
   * rolls off through the ACES shoulder.
   *
   * Two populations from one buffer, distinguished by a flag in the seed:
   * ejecta, which are thrown out of the impact ballistically and fall back,
   * and drift, which is what is left airborne and rises and wanders. A single
   * population cannot do both, and having only ejecta is the classic
   * "fountain" look — the plume above a real fall is mostly the second kind.
   */
  _buildSpray() {
    const mix = TIER_SPRAY[this.tier] || TIER_SPRAY.low;
    const n = mix.ejecta + mix.drift;
    this._sprayCount = n;
    if (!n) { this.spray = null; return; }

    const seed = new Float32Array(n * 4);
    const kind = new Float32Array(n);
    // Deterministic, so two captures of the same frame are identical.
    let s = 0x2f6e2b1;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n; i++) {
      seed[i * 4] = rnd();               // azimuth
      seed[i * 4 + 1] = rnd();           // speed / radius
      seed[i * 4 + 2] = rnd();           // phase through its own life
      seed[i * 4 + 3] = rnd();           // size
      kind[i] = i < mix.ejecta ? 0 : 1;  // ejecta : drift
    }
    const g = new THREE.BufferGeometry();
    // Every particle is positioned by the vertex shader; the attribute only
    // has to exist and put the bounding sphere in the right place.
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = IMPACT.x; pos[i * 3 + 1] = IMPACT.y; pos[i * 3 + 2] = IMPACT.z;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    g.boundingSphere = new THREE.Sphere(IMPACT.clone().add(new THREE.Vector3(0, 5, 0)), 26);

    this.sprayUniforms = {
      tDrops: { value: this.tex.drops },
      uTime: this._surfaceUniforms().uTime,
      uOrigin: { value: IMPACT.clone() },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      /* The sun's colour *times its intensity*, which was the omission that
       * made the first plume invisible. three keeps the two separate on a
       * light and every material it owns multiplies them back together; a
       * hand-written shader that reads only the colour is working with a
       * unit-luminance sun, and against a scene exposed for the real one that
       * is a plume some five times too dim to see. */
      uSunCol: { value: new THREE.Color(0xffffff) },
      uAmbient: { value: new THREE.Color(0x6a7f70) },
      uScale: { value: 600 },
      uFade: { value: 1 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.sprayUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: SSTEP + /* glsl */ `
        attribute vec4 aSeed;
        attribute float aKind;
        uniform float uTime;
        uniform vec3 uOrigin;
        uniform float uScale;
        uniform vec3 uSun;
        varying float vLife;
        varying float vKind;
        varying float vFwd;
        varying float vShrink;

        void main(){
          float life = mix(1.5, 5.2, aSeed.y) * mix(1.0, 1.9, aKind);
          // Each particle runs on its own clock, offset by its phase, so the
          // plume never pulses — a shared clock gives one puff per lifetime
          // and reads as a machine.
          float u = fract(uTime / life + aSeed.z);
          vLife = u; vKind = aKind;

          float az = aSeed.x * 6.2831853;
          vec3 p = uOrigin;
          float sink = 0.0;

          if (aKind < 0.5){
            /* Ejecta: thrown out of the impact and pulled back down in a
             * cone that is wide and shallow, because a vertical jet entering
             * water throws a *sheet* out along the surface. The near-vertical
             * component a fountain has comes from a nozzle, not from an
             * impact — and with the sixty-degree elevations this first had,
             * the fastest ejecta reached three metres above the pool and hung
             * there, putting isolated bright marks in the middle of empty air
             * exactly where the plume should be thinning to nothing. */
            float sp = mix(1.5, 5.4, aSeed.y * aSeed.y);
            float el = mix(0.10, 0.72, aSeed.w);
            vec3 v = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el)) * sp;
            /* A short flight, and shortening it is how the ejecta became a
             * mass rather than a scatter. Density is the whole effect here:
             * the same number of droplets spread over two seconds of arc
             * covers eight times the volume it covers over one, and a plume
             * that has been diluted eightfold is a plume the eye can count.
             * Real ejecta off a plunge pool are also gone in well under a
             * second — what stays in the air is the fine fraction, which is
             * the other population. */
            float t = u * life * 0.26;
            p += v * t - vec3(0.0, 4.905 * t * t, 0.0);
            /* And they stop at the water, which they did not before: the
             * arcs carried straight on through the surface and went on being
             * drawn underneath it, so the pool had bright streaks passing
             * *behind* its own plane. A droplet that reaches the water has
             * joined the water. */
            sink = sstep(0.02, -0.30, p.y - uOrigin.y);
          } else {
            /* Drift: the fine fraction that never comes down. It rises on
             * the air the fall drags with it, spreads as it goes, and is
             * pushed downstream. Speed falls off with height because the
             * entrained draught does. */
            /* The mist column. It has to climb about half the height of the
             * fall, which for eighteen metres is nine, and the old ceiling
             * of 3.4 m was the reason the plume read as a low puff sitting on
             * the pool rather than as the standing column of vapour that is
             * the most visible thing about a big fall from any distance. The
             * draught that carries it is the air the sheet drags down with it
             * and turns over at the bottom, so the rise is fast at first and
             * asymptotes as the droplets lose it. */
            float t = u * life;
            float rise = 9.5 * (1.0 - exp(-t * 0.30));
            float rad = mix(0.6, 5.6, aSeed.y) * (0.30 + 0.95 * sqrt(t / life));
            p += vec3(cos(az) * rad, rise + t * 0.30, sin(az) * rad * 0.8);
            // A slow wander so the plume is never two nested cylinders.
            p.x += sin(uTime * 0.31 + aSeed.x * 9.0) * 0.9 * (t / life);
            p.z += cos(uTime * 0.24 + aSeed.w * 7.0) * 1.1 * (t / life);
          }

          /* The scattering geometry, resolved per particle rather than per
           * fragment: it varies over the plume but not within one sprite,
           * and a sprite is a few dozen pixels. Looking along the view ray
           * toward the sun is the forward-scattering case. */
          vFwd = clamp(dot(normalize(p - cameraPosition), uSun), 0.0, 1.0);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;

          float grow = mix(0.5, 1.0, u);
          /* Squared seed, so the size distribution has a long thin tail
           * instead of being uniform. Evenly-sized particles are one of the
           * two things that made the first plume read as a field of fireflies
           * — a real spatter is mostly fine with a few large drops in it, and
           * a population where every member is the same size is a population
           * the eye can count. The ejecta are also far smaller than they
           * were: at the old size a single droplet subtended thirty pixels at
           * the pool, which is not a droplet, it is a snowball. */
          /* The drift sprite is smaller than it was, because the count is six
           * times what it was and the cost of an additive point is its area.
           * The trade is the right way round: a mist column is an integration
           * of many marks, and at 240 sprites the marks were individually
           * countable however large each one was — which is why the claimed
           * nine-metre column did not appear in any wide frame. Fifteen hundred
           * smaller ones cover about twice the fill for a column that actually
           * reads as vapour. */
          float base = aKind < 0.5 ? mix(0.10, 0.40, aSeed.w * aSeed.w)
                                   : mix(0.30, 1.00, aSeed.w) * 1.9;
          float size = base * grow;
          float px = size * uScale / max(1.0, -mv.z);
          /* Clamped at the top end, and the clamp is a fill-rate guard rather
           * than an aesthetic one. A point sprite's cost is the square of its
           * size, so one particle drifting a metre from the camera can cost
           * more than the entire rest of the plume. */
          gl_PointSize = clamp(px, 1.0, 46.0);
          /* And faded at the bottom end, which the clamp alone gets wrong.
           * A sprite whose true size is a third of a pixel still has to be
           * rasterised at one, so it is drawn nine times too large and
           * therefore nine times too bright — and since it is additive and
           * moving, what that produces is a distant twinkle exactly where the
           * plume should be dissolving quietly into the volumetric mist.
           * Scaling alpha by the area that was rounded away puts the energy
           * back where it belongs. */
          vShrink = min(1.0, px * 0.5);
          vShrink *= vShrink;
          vShrink *= 1.0 - sink;
        }
      `,
      fragmentShader: SSTEP + /* glsl */ `
        uniform sampler2D tDrops;
        uniform vec3 uSunCol;
        uniform vec3 uAmbient;
        uniform float uFade;
        varying float vLife;
        varying float vKind;
        varying float vFwd;
        varying float vShrink;

        void main(){
          vec4 d = texture2D(tDrops, gl_PointCoord);
          // In and out. Nothing may pop: a sprite that appears at full
          // strength is a flash, and a few hundred of them is a sparkle
          // field. The out-fade is much longer than the in-fade because
          // droplets evaporate and disperse rather than landing.
          float env = sstep(0.0, 0.09, vLife) * (1.0 - sstep(0.35, 1.0, vLife));

          /* Lit as a cloud, not as a surface. A droplet has no meaningful
           * normal, so the only sensible model is the phase function: a mist
           * is brilliant looked at through toward the sun and nearly
           * invisible with the sun behind you, and the swing between those
           * two is far larger than any diffuse term would give. It is also
           * why the same plume reads completely differently at a sun
           * elevation of 14 and of 72. */
          vec3 col = uAmbient + uSunCol * (0.18 + 1.4 * pow(vFwd, 3.0));

          /* Well under half what the first build used. Additive sprites sum,
           * so per-particle opacity and particle count trade against each
           * other for the same integrated brightness — but they do not trade
           * for the same *look*. Bright and sparse is a constellation; faint
           * and dense is a cloud, because no single member is ever the thing
           * being looked at. The plume is two and a half times as populous as
           * it was and each member is about half as strong, which is the same
           * light and a completely different object.
           *
           * The ejecta figure in particular is the one that had to come down
           * furthest and it is worth stating in absolute terms rather than as
           * a ratio: a sprite must never add more light than the surface
           * behind it already has, or it is a specular highlight — a small
           * bright hard-edged thing, which is what the eye calls a firefly.
           * The scene's median is around 0.2 and the sun term here can reach
           * two and a half, so anything above about a tenth of opacity puts a
           * blown white mark on the frame for every single droplet. Under it,
           * one droplet is invisible and forty overlapping ones are a boil.
           *
           * Four and a half per cent looks absurd written down and it is the
           * number the arithmetic gives: against a sun term that reaches two
           * and a half and a scene whose shaded ground sits near 0.03 in
           * linear light, anything an order of magnitude above this is a
           * clipped highlight the moment the fragment is looked at through
           * the shafts.
           *
           * The drift figure is the one that was wrong for four rounds, and
           * the mistake is worth recording because it was a diagnosis error
           * rather than a tuning error: the bright countable ovals in front
           * of the fall were assumed to be the ejecta, and cutting the ejecta
           * by a factor of seven changed the picture not at all. They were
           * always the drift — five times the diameter and therefore
           * twenty-five times the area of an ejectum, so a drift sprite at
           * half opacity is two orders of magnitude more light than an ejecta
           * sprite at the same number. Sprite opacity is not comparable
           * between populations of different sizes and has to be reasoned
           * about per population. */
          float a = d.a * env * uFade * vShrink * (vKind < 0.5 ? 0.07 : 0.10);
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });

    this.spray = new THREE.Points(g, mat);
    this.spray.name = 'spray';
    this.spray.frustumCulled = false;
    this.root.add(this.spray);
  }

  /* ------------------------------------------------------------- runtime */

  setTier(tier) {
    if (tier === this.tier) return;
    this.tier = tier;
    if (this.mirror) {
      this.mirror.enabled = tier === 'high' || tier === 'ultra';
      this.mirror.scale = MIRROR_SCALE[tier] || 0.36;
      if (!this.mirror.enabled) this._surfaceUniforms().uMirror.value = 0;
    }
    if (this.spray) {
      this.root.remove(this.spray);
      this.spray.geometry.dispose();
      this.spray.material.dispose();
      this.spray = null;
    }
    this._buildSpray();
    if (this.spray) this.spray.renderOrder = 13;
  }

  update(dt, camera, sunDir, sunColor, hemiColor, sunIntensity = 1) {
    this._time += dt;
    this._surfaceUniforms().uTime.value = this._time;
    if (this.spray) {
      const u = this.sprayUniforms;
      u.uSun.value.copy(sunDir);
      u.uSunCol.value.copy(sunColor).multiplyScalar(sunIntensity);
      u.uAmbient.value.copy(hemiColor).multiplyScalar(0.55);
      /* Point size is in pixels, so it has to track the projection or the
       * plume changes physical size with the window and with the DPR the
       * tier picked. */
      u.uScale.value = camera.projectionMatrix.elements[5] * 0.5
        * (this._vh || 900);
      /* Faded out at range instead of being culled outright. The plume is
       * additive and its contribution at eighty metres is a haze the
       * volumetric pass already renders more cheaply and more correctly, so
       * this is where the two hand over. */
      const d = camera.position.distanceTo(IMPACT);
      u.uFade.value = 1 - smoothstep(58, 92, d);
    }
  }

  setViewportHeight(h) { this._vh = h; }

  stats() {
    return {
      spray: this._sprayCount,
      impact: [+IMPACT.x.toFixed(2), +IMPACT.y.toFixed(2), +IMPACT.z.toFixed(2)],
      lip: [+LIP.x.toFixed(2), +LIP.y.toFixed(2), +LIP.z.toFixed(2)],
      fallSeconds: +FALL_T.toFixed(2),
      drop: +(LIP_Y - ALCOVE_Y).toFixed(2),
      mirror: this.mirror
        ? (this.mirror.active ? `${this.mirror.target.width}x${this.mirror.target.height}` : 'idle')
        : 'off',
    };
  }

  dispose() {
    for (const t of Object.values(this.tex)) t.dispose?.();
    this.surfaceMat.dispose();
    this.streamMat.dispose();
    this.curtainMat.dispose();
    this.spray?.material.dispose();
    this.mirror?.dispose();
  }
}
