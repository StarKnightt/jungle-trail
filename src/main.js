/* Jungle Trail — entry point.
 *
 * Boots the renderer, builds the world once, and runs a fixed-cap loop. The
 * capture harness in tools/ drives this file through `window.__game`, so the
 * control surface below (pause, render one frame, teleport, advance time) is
 * load-bearing rather than debug convenience.
 */
import * as THREE from 'three';
import { Trail } from './world/path.js';
import { Terrain, makeTerrainMaterial } from './world/terrain.js';
import { Sky } from './render/sky.js';
import { Vegetation } from './world/vegetation.js';
import { RuinPlan, Ruins } from './world/ruins.js';
import { Water, IMPACT, LIP } from './world/water.js';
import { Walker } from './player/controller.js';
import { CollisionWorld } from './player/collision.js';
import {
  PlayerBody,
  BODY_FIRST_PERSON_LAYER,
} from './player/body.js';
import { buildWorldField } from './render/field.js';
import { Canopy, patchCanopyLight } from './render/canopy.js';
import { Atmosphere } from './render/atmosphere.js';
import { Ambience } from './audio/engine.js';

/* Quality tiers.
 *
 * Boot on `high`, never `ultra`: the first seconds of a load are the worst
 * possible time to be measuring performance (shader compilation, texture
 * upload and the GC are all still running), and a tier chosen there is chosen
 * on bad data. The adaptive step below only moves once the frame time has been
 * stable for a while.
 */
const TIERS = {
  low: { dpr: 0.75, shadow: 1024, shadowDist: 45, aniso: 4 },
  medium: { dpr: 1.0, shadow: 1536, shadowDist: 60, aniso: 8 },
  high: { dpr: 1.0, shadow: 2048, shadowDist: 80, aniso: 16 },
  ultra: { dpr: 1.25, shadow: 3072, shadowDist: 100, aniso: 16 },
};
const TIER_ORDER = ['low', 'medium', 'high', 'ultra'];

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.paused = false;
    this.running = false;
    this.fps = 0;
    this._acc = 0;
    this._frames = 0;
    this._fpsT = 0;
    this._stableFor = 0;

    const hash = new URLSearchParams(location.hash.slice(1));
    this.pinnedTier = TIER_ORDER.includes(location.hash.slice(1)) ? location.hash.slice(1)
                    : hash.get('tier');
    this.tier = this.pinnedTier || 'high';
    /* The user of this machine games on it. An uncapped loop on an RTX-class
     * card will happily render this at 300 fps and pull 150 W to do it, for a
     * scene that is a walking pace nature documentary. 60 is the target and
     * the cap. */
    this.frameCap = Number(hash.get('fps')) || 60;

    this._initRenderer();
    this._initScene();
  }

  _initRenderer() {
    const r = new THREE.WebGLRenderer({
      canvas: this.canvas,
      /* No multisampling on the canvas any more, and nothing has been given
       * up: the canvas only ever receives one full-screen triangle now. MSAA
       * moved to the offscreen half-float target the scene is drawn into (see
       * render/atmosphere.js), which is the only place it can be once the
       * frame has to be read back for volumetrics. The reason it is still on
       * at all is unchanged — nearly every silhouette here is a leaf edge and
       * the geometric edge is the one the eye follows. */
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    /* Tone mapping is off in the *scene* pass and happens once in the
     * composite instead. It is the same ACES fit at the same exposure — the
     * curve has not been touched and the grading pass is a later system — but
     * it has to run after the volumetric in-scatter has been added, because a
     * sun shaft is radiance like everything else and tone mapping it
     * separately from the surface behind it is what makes a shaft look like a
     * decal laid over the picture. */
    r.toneMapping = THREE.NoToneMapping;
    /* Nudged up with the fill light coming down, so the frame keeps its
     * median and gains the range: the histogram has been sitting with a p99
     * around 0.5 and nothing at all clipped, which is a picture using two
     * thirds of the values available to it. */
    r.toneMappingExposure = 1.48;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setPixelRatio(Math.min(devicePixelRatio, TIERS[this.tier].dpr));
    r.setSize(innerWidth, innerHeight, false);
    this.renderer = r;

    addEventListener('resize', () => this.resize());
  }

  _initScene() {
    const scene = new THREE.Scene();
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.08, 900);

    this.sky = new Sky(this.renderer);
    this.sky.setSun(38, 152);
    scene.add(this.sky.mesh);

    /* Depth cue. Real jungle air is thick with water vapour and the visibility
     * through it is short — you rarely see more than 30-40 m of forest. This is
     * a placeholder for the volumetric pass; exponential-squared falls off in
     * roughly the right shape and stops the far chunks reading as a hard edge. */
    /* Depth cue. Rainforest air is saturated and full of transpired water, and
     * the visibility through it is genuinely short — you rarely see more than
     * 30-40 m of forest, and that limit is a big part of why the space feels
     * enclosed. Exponential-squared falls off in roughly the right shape;
     * the volumetric pass in the atmosphere system replaces the look of it,
     * but this stays underneath as the thing that closes the far distance. */
    /* Dense, and dark. The rule the first few passes broke is that in a closed
     * forest the haze is *darker* than the foreground, not brighter: the air
     * between you and a tree thirty metres away is itself in shade, so it
     * scatters almost nothing back. Aerial perspective that brightens with
     * distance is what a mountain range does, and applying it here turned the
     * end of the trail into a lit white wall the eye reads as an exit. */
    /* Darkened and taken off yellow in the tenth pass. Fog is a lerp toward
     * its own colour, so it is also a contrast floor: nothing past twenty
     * metres can be darker than this value, and at the old one that floor sat
     * high enough that trunks, thicket and gaps all converged on the same
     * sage as they receded — the middle distance was not losing detail
     * gradually, it was being clamped flat. A darker, greyer haze lets the far
     * boles keep their silhouettes while still closing the corridor off. */
    /* Cut by nearly a third in the post pass's second round, and this is the
     * change the whole mid distance was waiting for. At 0.038 the fog was 44 per
     * cent at twenty metres and 73 at thirty, which means everything past eight
     * metres was being lerped most of the way to one colour — so depth was
     * being carried by fog rather than by silhouette layering and occlusion,
     * and a stack of overlapping crowns arrived as a flat khaki wall. Real
     * jungle mid-ground is the opposite: fog contributes very little and the
     * depth cue is that near dark holes overlap far bright leaves at half a
     * dozen scales.
     *
     * At 0.027 the same distances read 23 and 46 per cent, which leaves the
     * silhouettes their contrast while still closing the corridor. It is the
     * far end that has to keep working and it does: at fifty metres this is
     * still 82 per cent, so the waterfall seen from the temple clearing is the
     * same soft hazed smear behind the ruins that it was. Fog is exponential in
     * the square of distance, so it can be cut hard in the band the eye reads
     * detail in and barely move at the range that closes the world off. */
    scene.fog = new THREE.FogExp2(0x323c2c, 0.027);

    const sl = this.sky.sunLight();
    this.sun = new THREE.DirectionalLight(sl.color, sl.intensity);
    this.sun.castShadow = true;
    this._configureShadow();
    scene.add(this.sun);
    scene.add(this.sun.target);

    /* Sky/ground bounce. The environment map handles specular and most of the
     * diffuse, but a hemisphere light on top of it is the cheap way to keep the
     * undersides of things from going to pure black, which is where CG forests
     * usually give themselves away. */
    /* Sky/ground bounce, and the colour of it matters more than the amount.
     *
     * The obvious value for the sky term is the colour of the sky — a clean
     * pale blue — and under a closed canopy that is simply wrong. Almost no
     * fill light down here has come straight from the sky; it has been through
     * one or more leaves or bounced off them, so it arrives green and warm,
     * and the ground bounce is wet brown litter. Feeding real sky blue into
     * the shadows is what makes CG forests look like they were shot on an
     * overcast day in a car park, and it was the single loudest wrong note in
     * the first vegetation pass. */
    /* The upper colour is the underside of the canopy and the lower one is the
     * litter, and both are doing the same job: there is no black in a jungle
     * shadow. Almost nothing at eye level here is lit directly, so this pair is
     * what is actually lighting the picture — a shadow that goes neutral grey
     * is the difference between a forest and a car park at dusk. */
    /* Raised, and pulled off yellow. The frame was splitting into two
     * exposures — small mustard highlights on the canopy against black
     * understory — which is what happens when nearly all the fill is coming
     * from a sun that only reaches a few per cent of the surfaces. A closed
     * forest is lit almost entirely by this term, and more of it (with less
     * chroma in it) is what turns a set of lit objects in the dark back into
     * one space full of soft green light. */
    /* The level was raised again once alpha-to-coverage came off the leaves.
     * A2C had been leaking bright background through a fraction of the MSAA
     * samples at nearly every foliage pixel, and that leak was carrying a
     * surprising amount of the frame's apparent exposure — removing the
     * artefact took the median luminance down by a third, which is the sort of
     * thing that is easy to mistake for a lighting change and chase in the
     * wrong file. This is the honest amount of fill needed to light the
     * understory now that nothing is being lit by a bug. */
    /* The ground term was raised harder than the sky term, because it is the
     * one that lights a trunk. A hemisphere light weights its two colours by
     * the surface normal's y, so a vertical bole — and the underside of every
     * leaf above it — sees the average of the pair rather than the sky colour,
     * and with a dark ground term that average was low enough that any trunk
     * standing in the canopy's own shadow went to near black regardless of how
     * pale its bark map was. A rainforest floor is wet mid-brown litter with a
     * good deal of bounce in it, so the previous near-black value was not
     * defensible on physical grounds either. */
    /* Trimmed in the ninth pass. A hemisphere light is by construction the
     * least directional light there is — it varies only with the surface
     * normal's y — so it is simultaneously the thing keeping the understory
     * out of the black and the thing flattening it. The critique's fourth
     * finding was "no sense of light direction", and the honest first move is
     * to stop spending quite so much of the exposure on a term that cannot
     * have one, and to let the sun and the leaves' own transmission lobe
     * carry the difference. Dappled light through the canopy is a later
     * system and is not being attempted here. */
    /* The sky term lost most of its yellow in the tenth pass at the same
     * luminance. A green ambient multiplying a green albedo is squaring the
     * hue, and the two together were pushing every lit leaf toward the same
     * chartreuse regardless of what its atlas said — pale ones came out cream,
     * which is the "muddy but inconsistent colour" finding. Real shade under a
     * canopy is filtered, but it is also skylight, so it belongs on the cool
     * side of green rather than the warm one. The ground term stays warm and
     * stays brown: that half is bounce off wet litter and it is the only thing
     * keeping the underside of anything from reading as grey. */
    /* Trimmed again when the canopy fill arrived, and the amount matters less
     * than what it was replaced with. A hemisphere light is the least
     * directional light there is and it was carrying nearly the whole frame,
     * which is a complete account of why the middle distance read as one flat
     * wall: every surface at a given normal.y was receiving exactly the same
     * light no matter where in the world it stood. Most of that budget now
     * goes through canopyFill() in render/canopy.js, which is the same idea
     * with the roof's own thickness modulating it, so a thin patch of canopy
     * puts a well of light under itself and a thick one does not. This is what
     * is left: the isotropic floor under everything, which still has to exist,
     * because there is no black in a jungle shadow. */
    this.hemi = new THREE.HemisphereLight(0x82a081, 0x63513a, 0.55);
    scene.add(this.hemi);

    /* The scene used to carry a second, weak, unshadowed DirectionalLight here
     * standing in for skylight that had been through the canopy. It has been
     * removed rather than retuned: it was uniform across the world, and the
     * one thing scattered canopy light is not is uniform. Its replacement is
     * canopyFill() in render/canopy.js, which is the same physical idea driven
     * by the roof density field, and it costs one fewer light in every shader
     * in the scene as well. */

    this.trail = new Trail();

    /* The build order through here is a dependency chain and none of the links
     * are optional. The ruin *plan* is pure arithmetic over the trail, so it
     * comes first and the heightfield can consult it while it is being built —
     * which is what puts the terrace, the earthwork and the spoil banks into
     * the ground itself rather than leaving the masonry to be sunk into a
     * hillside that does not know it is there. The ruin *geometry* then needs
     * the finished heightfield to know where the ground is under every block,
     * and the vegetation needs the finished geometry so that it can grow on
     * the stone and refuse to grow through it. */
    this.ruinPlan = new RuinPlan(this.trail);
    this.terrain = new Terrain(this.trail, undefined, this.ruinPlan);
    this.terrainMat = makeTerrainMaterial(this.renderer);
    scene.add(this.terrain.build(this.terrainMat));

    /* Solids are registered while their procedural generators still know
     * what each merged or instanced piece represents. Keeping this registry
     * beside the walker avoids turning the render scene back into physics data
     * every frame, after that identity has deliberately been batched away. */
    this.collision = new CollisionWorld({ cellSize: 4 });

    this.ruins = new Ruins(this.renderer, this.terrain, this.trail, this.ruinPlan,
                           undefined, this.collision);
    scene.add(this.ruins.root);

    this.veg = new Vegetation(this.renderer, this.terrain, this.trail, undefined,
                              this.ruins, this.collision);
    scene.add(this.veg.root);

    /* Built after the vegetation, and the order matters even though water
     * grows nothing. Every surface in it is clipped per fragment against the
     * finished heightfield, and its levels were cut from the same spillway
     * tables the terrain used, so it has to see a terrain that has stopped
     * changing. It registers no collision: the causeway that keeps the trail
     * out of the pool is ground, and the walker is already stopped by the
     * bank's fifty-degree slope rather than by anything here. */
    this.water = new Water(this.renderer, this.terrain, this.trail,
                           { tier: this.tier });
    scene.add(this.water.root);

    this.sky.bake(scene);
    /* The environment map is the open sky, and under a roof of leaves only a
     * fraction of it is visible from any surface. Handing surfaces the full
     * unoccluded hemisphere is the other half of the blue-shadow problem, and
     * it is specifically where the cyan cast on the broad understory leaves
     * was coming from: those blades are near-horizontal and face straight up
     * into it. The hemisphere light above carries the fill instead, because
     * its upper colour is the underside of the canopy rather than the sky. */
    scene.environmentIntensity = 0.34;

    this.walker = new Walker(this.camera, this.terrain, this.trail,
                             this.collision).attach(this.canvas);
    this.body = new PlayerBody(this.renderer, this.walker, { tier: this.tier });
    scene.add(this.body.root);
    /* First-person limbs and the complete external body use separate layers.
     * This camera sees only the camera-aligned representation; PlayerBody
     * exposes the complete one to the depth traversal just long enough to cast
     * its shadow. A later third-person camera can swap those representations
     * without rebuilding the character or accepting doubled limbs. */
    this.camera.layers.enable(BODY_FIRST_PERSON_LAYER);

    /* Everything above builds surfaces; everything below decides how they are
     * lit. The order is forced — the field has to be sampled from a terrain
     * that has finished building, and the materials have to exist before they
     * can be patched — but the split is also the honest description of what
     * this system is. */
    this.field = buildWorldField(this.terrain);
    this.canopy = new Canopy(this.renderer, this.field);
    this.canopy.setSun(this.sky.sunDir);
    this.atmos = new Atmosphere(this.renderer, this.canopy);
    this.atmos.setTier(this.tier);
    this._syncAtmosphereSize();

    /* Every opaque MeshStandardMaterial in the scene, and the list is
     * deliberately exhaustive rather than a traversal: a surface that misses
     * the patch is not subtly wrong, it is a leaf standing in a shaft of light
     * that the shaft does not touch, and that reads instantly. */
    for (const m of [this.terrainMat, this.veg.leafMat, this.veg.woodMat,
                     this.ruins.material, ...this.water.materials,
                     ...this.body.materials]) {
      patchCanopyLight(m, this.canopy);
    }

    /* Nothing is allocated on the audio device here and no buffer is
     * synthesized: constructing Ambience only chains the walker's footfall
     * callbacks and arms a listener for the first user gesture. Browsers
     * refuse to start an AudioContext without one, so the bake and the graph
     * happen on the click that grabs pointer lock — which is also the moment
     * the player starts walking, and therefore the first moment any of it
     * would be heard. */
    this.ambience = new Ambience({
      camera: this.camera,
      trail: this.trail,
      terrain: this.terrain,
      walker: this.walker,
    });
    /* The score guessed at these from the terrain constants before the falls
     * existed — a base at the pool's rim and a lip on the cliff plane. Both
     * were out: the real impact is 1.3 m short in z and 0.8 m higher, and the
     * real lip is 4.4 m higher than the guess and two metres further into the
     * cliff, because the water leaves the rock at the top of an undercut
     * rather than at the notch's plan position. Four metres of error in the
     * lip is audible — it is most of the vertical separation between the
     * rumble and the hiss, which is the cue that tells you how tall the thing
     * in front of you is. */
    this.ambience.setWaterfallPosition(IMPACT, LIP);
    this.atmos.setFallsPlume(IMPACT);
  }

  _configureShadow() {
    const t = TIERS[this.tier];
    const s = this.sun.shadow;
    s.mapSize.set(t.shadow, t.shadow);
    const d = t.shadowDist;
    s.camera.left = -d; s.camera.right = d;
    s.camera.top = d; s.camera.bottom = -d;
    s.camera.near = 1; s.camera.far = d * 3.2;
    // Foliage shadows are thin and overlapping, which is exactly the case that
    // shows acne; normalBias does more for it than a constant bias and does not
    // cause the peter-panning that a large constant bias would.
    s.bias = -0.0006;
    s.normalBias = 0.06;
    s.camera.updateProjectionMatrix();
    if (s.map) { s.map.dispose(); s.map = null; }
  }

  /* Keep the shadow frustum around the player. A single cascade sized to the
   * whole level would give roughly 15 cm shadow texels; sized to 80 m around
   * the camera it is under 4 cm, which is the difference between leaf shadows
   * and grey blobs. */
  _trackSun() {
    const p = this.camera.position;
    const d = this.sky.sunDir;
    const dist = TIERS[this.tier].shadowDist * 1.6;
    this.sun.position.set(p.x + d.x * dist, p.y + d.y * dist, p.z + d.z * dist);
    this.sun.target.position.copy(p);
    this.sun.target.updateMatrixWorld();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, TIERS[this.tier].dpr));
    this.renderer.setSize(w, h, false);
    this._syncAtmosphereSize();
  }

  _syncAtmosphereSize() {
    if (!this.atmos) return;
    const v = this.renderer.getDrawingBufferSize(_size);
    this.atmos.setSize(v.x, v.y);
    // Spray sprites are sized in pixels, so they have to be told how many
    // pixels tall the frame is or the plume changes physical size with the
    // window and with whatever DPR the current tier picked.
    this.water?.setViewportHeight(v.y);
    this.water?.setReflectionSize(v.x, v.y);
  }

  setTier(name) {
    if (!TIERS[name] || name === this.tier) return;
    this.tier = name;
    this._configureShadow();
    this.body?.setQuality(name);
    this.atmos?.setTier(name);
    this.water?.setTier(name);
    this.resize();
  }

  /* Only ever steps one tier at a time and only after several seconds of
   * consistent evidence. Reacting fast to frame time produces a renderer that
   * oscillates between two tiers, which looks far worse than either. */
  _adapt(dt) {
    if (this.pinnedTier) return;
    const target = 1 / this.frameCap;
    const bad = dt > target * 1.55;
    this._stableFor = bad ? 0 : this._stableFor + dt;
    if (bad) {
      this._badFor = (this._badFor || 0) + dt;
      if (this._badFor > 1.6) {
        const i = TIER_ORDER.indexOf(this.tier);
        if (i > 0) this.setTier(TIER_ORDER[i - 1]);
        this._badFor = 0;
      }
    } else {
      this._badFor = 0;
    }
  }

  step(dt) {
    this.walker.update(dt);
    this.body.update(dt);
    this._trackSun();
    // The camera's world-inverse has to be current before the vegetation
    // rotates the sun into view space for its transmission term.
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.veg.update(dt, this.camera, this.sky.sunDir, this.sun.color, this.hemi.color);
    this.ruins.update(dt, this.camera);
    this.water.update(dt, this.camera, this.sky.sunDir, this.sun.color,
                      this.hemi.color, this.sun.intensity);
    this.canopy.update(dt);
    /* After the camera's world matrix is current, because the listener's
     * position and orientation are read straight out of it. Placing this
     * before the update above would put the ears one frame behind the eyes,
     * which is small but is exactly the error that makes a source seem to
     * swing as you turn. */
    this.ambience.update(dt);
  }

  render() {
    const r = this.renderer;
    /* The materials reconstruct world position from vViewPosition, so they
     * need the camera's world matrix as a uniform. Set once per frame here
     * rather than per material, because they all share the same uniform
     * object by reference. */
    this.canopy.uniforms.uViewToWorld.value.copy(this.camera.matrixWorld);

    /* Before the offscreen buffer is claimed, because this is a render of its
     * own into a target of its own and nesting it inside the scene pass would
     * mean saving and restoring the one the post chain is counting on. It also
     * has to come before the scene rather than after it for the obvious
     * reason: the pool samples the result. */
    this.water?.renderReflection(this.scene, this.camera);

    this.atmos.beginScene();
    this.body.prepareShadowPass();
    r.render(this.scene, this.camera);
    /* Snapshotted here because the post passes are render() calls of their
     * own and three resets its counters at the top of each one, so by the time
     * the frame is on screen the info block describes a single full-screen
     * triangle. This is the same quantity every earlier measurement reported —
     * three zeroes the counters after the shadow pass, so it is the visible
     * pass only — which is what keeps the numbers comparable across the
     * change. */
    this._sceneCalls = r.info.render.calls;
    this._sceneTris = r.info.render.triangles;
    this.atmos.finish(this.camera, this.sun.color, this.sun.intensity);
  }

  renderOnce() { this.render(); }

  begin() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.25) dt = 0.25;      // a tab that was backgrounded must not teleport

      if (this.paused) return;

      // Frame cap. Skipping the work rather than the present keeps the GPU
      // genuinely idle between frames instead of spinning on vsync.
      this._acc += dt;
      const budget = 1 / this.frameCap;
      if (this._acc < budget * 0.92) return;
      const step = this._acc;
      this._acc = 0;

      this.step(step);
      this.render();

      this._frames++;
      this._fpsT += step;
      if (this._fpsT >= 0.5) {
        this.fps = this._frames / this._fpsT;
        this._frames = 0; this._fpsT = 0;
        this._adapt(1 / Math.max(1, this.fps));
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  setPaused(p) {
    this.paused = !!p;
    this.ambience?.setPaused(this.paused);
  }

  /** Advance the simulation without waiting for wall-clock time. */
  warp(seconds, stepSize = 1 / 60) {
    for (let t = 0; t < seconds; t += stepSize) this.step(stepSize);
  }

  /** Teleport to normalised arc length along the trail. */
  goTo(t) { this.walker.setAuto(null).placeAt(t); return this; }

  setSun(elevationDeg, azimuthDeg) {
    this.sky.setSun(elevationDeg, azimuthDeg);
    const sl = this.sky.sunLight();
    this.sun.color.copy(sl.color);
    this.sun.intensity = sl.intensity;
    this.sky.bake(this.scene);
    this.canopy?.setSun(this.sky.sunDir);
    return this;
  }

  /**
   * Read the frame back and describe it numerically.
   *
   * Screenshots lie about exposure — a shot that looks "moody" on one display
   * is crushed to black on another, and judging it by eye is how you end up
   * grading the same scene three times. These are the numbers that decide
   * whether the frame has a usable range: the percentiles say where the
   * histogram actually sits, `black` and `blown` say how much of it has been
   * clipped away at either end, and `sky` vs `ground` separates the two
   * exposures that are fighting each other in a backlit forest.
   */
  probe(sampleStep = 4) {
    const w = this.renderer.domElement.width, h = this.renderer.domElement.height;
    const gl = this.renderer.getContext();
    const px = new Uint8Array(w * h * 4);
    this.render();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    const lum = [];
    let skyL = 0, skyN = 0, gndL = 0, gndN = 0, black = 0, blown = 0, total = 0;
    // readPixels is bottom-up, so the upper rows of the image are the high j.
    for (let j = 0; j < h; j += sampleStep) {
      for (let i = 0; i < w; i += sampleStep) {
        const k = (j * w + i) * 4;
        const l = (px[k] * 0.2126 + px[k + 1] * 0.7152 + px[k + 2] * 0.0722) / 255;
        lum.push(l);
        total++;
        if (l < 0.02) black++;
        if (l > 0.98) blown++;
        if (j > h * 0.62) { skyL += l; skyN++; } else { gndL += l; gndN++; }
      }
    }
    lum.sort((a, b) => a - b);
    const q = (p) => +lum[Math.min(lum.length - 1, Math.floor(p * lum.length))].toFixed(3);
    return {
      p01: q(0.01), p10: q(0.10), median: q(0.5), p90: q(0.90), p99: q(0.99),
      mean: +(lum.reduce((a, b) => a + b, 0) / lum.length).toFixed(3),
      contrast: +((q(0.95) - q(0.05)) * 255).toFixed(0),
      blackPct: +(100 * black / total).toFixed(1),
      blownPct: +(100 * blown / total).toFixed(1),
      upper: +(skyL / Math.max(1, skyN)).toFixed(3),
      lower: +(gndL / Math.max(1, gndN)).toFixed(3),
    };
  }

  info() {
    const i = this.renderer.info;
    return {
      calls: this._sceneCalls ?? i.render.calls,
      triangles: this._sceneTris ?? i.render.triangles,
      geometries: i.memory.geometries, textures: i.memory.textures,
      programs: i.programs ? i.programs.length : 0,
      water: this.water ? this.water.stats() : null,
      veg: this.veg ? this.veg.stats() : null,
      body: this.body ? this.body.stats() : null,
      collision: this.collision ? this.collision.stats() : null,
    };
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.ambience?.dispose();
    this.walker.dispose();
    this.body.dispose();
    this.atmos?.dispose();
    this.canopy?.dispose();
    this.renderer.dispose();
  }
}

const _size = new THREE.Vector2();

const game = new Game(document.getElementById('view'));
window.__game = game;
window.THREE = THREE;

/* Recording convenience: number keys jump to the authored viewpoints.
 *
 * The falls are eight minutes of walking from the trailhead, which is the
 * right length for the level and the wrong length for the twentieth take of a
 * capture. These reuse goTo() rather than moving the camera themselves, so a
 * warp lands in exactly the state the harness's stops land in — snapped to the
 * heightfield, facing along the trail, velocity zeroed, gait clock reset.
 *
 * Nothing is drawn and nothing is logged. The frame has no UI in it at all,
 * and a debug aid is the last thing that should be the exception. Delete this
 * block for a public build; the feature is nowhere else.
 */
const WARP_STOPS = [0.04, 0.34, 0.81, 0.88, 0.96];
addEventListener('keydown', (e) => {
  /* Only while the pointer is locked. A digit typed at a page that merely has
   * focus is not a request to move the player, and gating on the same flag the
   * walker uses means the capture harness — which drives goTo() directly and
   * never sends key events — cannot be perturbed by this at all. */
  if (!game.walker.enabled) return;
  const key = /^Digit([1-9])$/.exec(e.code);
  const t = key && WARP_STOPS[+key[1] - 1];
  if (t === undefined || t === null) return;
  game.goTo(t);
});

// The harness calls begin() itself so it can set state before the first frame.
if (!/(^|[#&])manual(&|$)/.test(location.hash)) game.begin();

document.getElementById('boot')?.remove();
