/* Sky and image-based lighting.
 *
 * Single-scattering Rayleigh + Mie, evaluated per pixel on a backside sphere.
 * A gradient dome would be cheaper, but the sky is not decoration here — it is
 * the light source. Everything in a jungle that is not in a direct sunbeam is
 * lit almost entirely by skylight bouncing off the canopy, so the colour and
 * the vertical falloff of the dome decide what the shaded 95% of the frame
 * looks like. A two-colour lerp gets that flatly wrong; real skylight is much
 * bluer overhead than at the horizon and the gradient is not linear.
 *
 * The same shader is rendered into a cube and prefiltered into an environment
 * map, so the sky lighting the scene and the sky you can see through the leaves
 * are the same function of the sun direction.
 */
import * as THREE from 'three';
import { SSTEP } from '../gfx/glsl.js';

const VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Force the dome to the far plane so nothing can ever poke through it.
  gl_Position = (projectionMatrix * mv).xyww;
}
`;

const FRAG = SSTEP + /* glsl */ `
varying vec3 vDir;
uniform vec3 uSunDir;
uniform float uTurbidity;    // haze. A humid rainforest morning is 4-8.
uniform float uExposure;
uniform vec3 uGroundColor;   // canopy bounce, seen below the horizon
uniform vec3 uHazeColor;     // the shaded air the low sky is seen through

const float PI = 3.141592653589793;

// Rayleigh scattering coefficients at sea level (m^-1), 680/550/440 nm.
const vec3 BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float H_R = 8000.0;    // Rayleigh scale height
const float H_M = 1200.0;    // Mie scale height
const float R_EARTH = 6371000.0;
const float R_ATMOS = 6471000.0;

float rayleighPhase(float c){ return (3.0 / (16.0 * PI)) * (1.0 + c * c); }

// Henyey-Greenstein. g near 0.8 puts most of the Mie energy in a tight forward
// lobe, which is the bright halo you see around the sun through humid air.
float miePhase(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Distance from a point to the top of the atmosphere along a ray.
float atmosphereDepth(vec3 pos, vec3 dir){
  float b = dot(pos, dir);
  float c = dot(pos, pos) - R_ATMOS * R_ATMOS;
  float d = b * b - c;
  return d < 0.0 ? 0.0 : -b + sqrt(d);
}

void main(){
  vec3 dir = normalize(vDir);
  vec3 sun = normalize(uSunDir);

  // Below the horizon we are looking at the forest floor / canopy, not sky.
  // Fading rather than clipping keeps the environment map's lower hemisphere
  // continuous, which matters because that half is doing the bounce lighting.
  float below = sstep(0.055, -0.13, dir.y);

  vec3 origin = vec3(0.0, R_EARTH + 300.0, 0.0);
  float rayLen = atmosphereDepth(origin, dir);

  const int STEPS = 20;
  const int LIGHT_STEPS = 4;

  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;

  float mieScale = 21e-6 * (uTurbidity * 0.35);
  vec3 betaM = vec3(mieScale);

  /* Clamping the sample altitude at sea level is not a detail.
   *
   * A ray pointing below the horizon passes through the planet, where the
   * sample altitude goes to about -6e6 m and the density term exp(-h/H)
   * overflows to +Inf. The optical depth is then Inf, its transmittance
   * exp(-Inf) is 0, and the accumulation multiplies the two: Inf * 0 = NaN.
   * That NaN goes
   * into the lower half of the cube map, the PMREM blur spreads it across
   * every roughness level, and afterwards *every* PBR surface in the scene
   * renders pure black no matter what the lights are doing — with no warning
   * anywhere, because the shader compiled fine.
   */
  /* Sample spacing is quadratic, not uniform, and near the horizon that is the
   * difference between a sky and a banded mess.
   *
   * A ray pointing near-level travels several hundred kilometres before it
   * leaves the atmosphere, but essentially all of the scattering happens in
   * the first few — density falls off exponentially with a scale height of
   * 8 km. Spacing the samples evenly along the ray spends nineteen of them in
   * vacuum and one on the part that matters, and the result was a hard-edged
   * orange band across the horizon that looked like a bug in the tone mapping.
   * Warping the sample positions by t^2 puts most of them in the dense air
   * near the viewer for no extra cost.
   */
  float prevT = 0.0;
  for(int i = 0; i < STEPS; i++){
    float f = float(i + 1) / float(STEPS);
    float tEnd = rayLen * f * f;
    float segment = tEnd - prevT;
    vec3 p = origin + dir * (prevT + segment * 0.5);
    prevT = tEnd;
    float height = max(0.0, length(p) - R_EARTH);
    float hr = exp(-height / H_R) * segment;
    float hm = exp(-height / H_M) * segment;
    odR += hr; odM += hm;

    // Optical depth back toward the sun from this sample.
    float lightLen = atmosphereDepth(p, sun);
    float lseg = lightLen / float(LIGHT_STEPS);
    float lodR = 0.0, lodM = 0.0;
    for(int j = 0; j < LIGHT_STEPS; j++){
      vec3 lp = p + sun * (lseg * (float(j) + 0.5));
      float lh = max(0.0, length(lp) - R_EARTH);
      lodR += exp(-lh / H_R) * lseg;
      lodM += exp(-lh / H_M) * lseg;
    }
    vec3 tau = BETA_R * (odR + lodR) + betaM * 1.1 * (odM + lodM);
    vec3 attn = exp(-tau);
    sumR += attn * hr;
    sumM += attn * hm;
  }

  float c = dot(dir, sun);
  vec3 col = (sumR * BETA_R * rayleighPhase(c) + sumM * betaM * miePhase(c, 0.78)) * 22.0;

  // Sun disc. Angular radius ~0.0046 rad; smoothstep over a few times that so
  // it has an edge rather than an aliased dot, and a wide bloom-feeding core.
  float sunAmt = sstep(0.9997, 0.99995, c);
  col += vec3(1.0, 0.94, 0.84) * sunAmt * 120.0;

  /* Merge the low sky into the haze.
   *
   * The dome is never seen from open ground here — it is seen from under a
   * canopy, through the same thirty metres of humid shaded air that the
   * distance fog models. The fog cannot help, because the dome is at infinity
   * and is drawn unfogged, so any horizontal sightline that found a gap in the
   * thicket ended on raw un-attenuated sky. At the end of a trail corridor
   * that is a bright wedge sitting exactly where the vanishing point is, and
   * the eye reads it as daylight through an exit — which destroys the
   * enclosure the whole scene depends on. Anything within about fifteen
   * degrees of level therefore arrives already merged into the haze.
   */
  col = mix(col, uHazeColor * 2.0, sstep(0.26, 0.0, dir.y) * 0.94);

  col = mix(col, uGroundColor * (0.35 + 0.65 * max(0.0, sun.y)), below);

  /* Belt and braces. This dome is prefiltered into the environment map, and a
   * single non-finite texel there blacks out every lit surface in the scene
   * with no other symptom. A comparison against NaN is always false, so this
   * catches it where max() would not. */
  if (!(col.r >= 0.0) || !(col.g >= 0.0) || !(col.b >= 0.0)) col = vec3(0.0);

  gl_FragColor = vec4(col * uExposure, 1.0);
}
`;

export class Sky {
  constructor(renderer) {
    this.renderer = renderer;
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.28, 0.42, -0.86).normalize() },
      uTurbidity: { value: 5.5 },
      uExposure: { value: 1.0 },
      /* What the dome shows below the horizon. Not "the ground" — it is the
       * haze standing over the canopy, so it wants to be close to the fog
       * colour. Setting it dark like soil leaves a black band under the
       * skyline wherever the terrain does not quite reach the horizon. */
      uGroundColor: { value: new THREE.Color(0x4d5a41) },
      /* Kept in step with scene.fog by hand. The two have to agree: where a
       * fogged thicket meets the dome behind it there must be no seam, and a
       * mismatch there is visible as a horizon line even at low contrast. */
      uHazeColor: { value: new THREE.Color(0x475538) },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide, depthWrite: false, depthTest: true,
      toneMapped: false,   // the dome carries HDR values; grading happens in post
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(4000);
    this.mesh.name = 'sky';

    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._pmrem.compileEquirectangularShader();
    this._envRT = null;
  }

  get sunDir() { return this.uniforms.uSunDir.value; }

  /**
   * Set the sun by elevation/azimuth in degrees.
   * Elevation around 32-42 is the useful window: high enough that shafts reach
   * the floor through the canopy, low enough that they are still shafts.
   */
  setSun(elevationDeg, azimuthDeg) {
    const e = THREE.MathUtils.degToRad(elevationDeg);
    const a = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
    return this;
  }

  /**
   * Prefilter the dome into an environment map and hang it on the scene.
   *
   * Expensive enough that it must not run per frame — the sun only moves when
   * something asks it to, so this is called explicitly after a change rather
   * than being kept in sync automatically.
   */
  bake(scene, size = 256) {
    const cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.1, 10, cubeRT);
    const tmp = new THREE.Scene();
    const domeCopy = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.material);
    domeCopy.scale.setScalar(5);
    domeCopy.frustumCulled = false;
    tmp.add(domeCopy);
    cam.update(this.renderer, tmp);

    const prev = this._envRT;
    this._envRT = this._pmrem.fromCubemap(cubeRT.texture);
    scene.environment = this._envRT.texture;

    domeCopy.geometry.dispose();
    cubeRT.dispose();
    if (prev) prev.dispose();
    return this._envRT.texture;
  }

  /**
   * Colour and intensity for the sun's directional light, derived from the
   * same scattering as the dome so the key light and the sky cannot disagree.
   * Reddening near the horizon falls out of the extinction rather than being
   * hand-keyed.
   */
  sunLight() {
    const y = Math.max(0.02, this.sunDir.y);
    const airmass = 1.0 / (y + 0.15 * Math.pow(y + 0.02, -1.253));
    const ext = (beta) => Math.exp(-beta * airmass);
    const c = new THREE.Color(ext(0.19), ext(0.42), ext(0.95));
    const max = Math.max(c.r, c.g, c.b) || 1;
    c.multiplyScalar(1 / max);
    /* Raised again with the atmosphere system, and this time the increase is
     * one that shows up in the frame. Every previous attempt to turn the sun
     * up moved the histogram by literally nothing, for a reason that took a
     * measurement to find: three storeys of canopy patches in the shadow map
     * closed the roof completely, so the multiplier was being applied to zero
     * everywhere below it. With the roof's occlusion now modelled as a
     * transmittance rather than a shadow (render/canopy.js) there are surfaces
     * down here in direct sun again, and the ratio between a sunfleck and the
     * shade around it is the single strongest depth cue the forest floor has.
     * Under a closed canopy a fleck is on the order of ten times the ambient;
     * anything less and it reads as a light patch of ground.
     *
     * Trimmed back by a sixth afterwards, for the opposite failure. Ten times
     * the ambient is the right ratio for a fleck the size of a hand; the light
     * pool under a genuine canopy opening is tens of square metres of the same
     * value, and at this intensity ACES was rolling all of it to a flat cream
     * with no litter texture left in it. The tone curve desaturating toward
     * white is the signature of a value pushed past the shoulder, and once a
     * frame contains a patch that has gone there, everything else reads as
     * underexposed by comparison. The floor of the range is being lifted in
     * canopy.js at the same time; this is the other end of the same edit.
     *
     * The exponent is under one rather than the linear falloff a horizontal
     * surface's irradiance would follow, and this light is why. It stands in
     * for the direct beam and for the bright band of sky around a low sun
     * together, and the second of those does not fade at the same rate as the
     * first. On a straight sine a fourteen-degree sun came out at a third of
     * midday, which — multiplied by a canopy that a shallow ray has four
     * times as much of to cross — left the dawn frames with no directional
     * light in them at all and reading as overcast. */
    return { color: c, intensity: THREE.MathUtils.clamp(11.5 * Math.pow(y, 0.8), 0, 7.6) };
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this._pmrem.dispose();
    if (this._envRT) this._envRT.dispose();
  }
}
