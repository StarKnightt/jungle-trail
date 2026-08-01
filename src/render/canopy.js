/* Dappled canopy light.
 *
 * This is the system the scene has been missing, and the reason it was missing
 * is worth writing down because it is not what it looks like.
 *
 * The obvious model — put the canopy in the shadow map and let the sun through
 * the gaps — is what the scene already did, and it produced exactly zero
 * sunflecks. That is measurable rather than a matter of taste: rendering with
 * the hemisphere fill, the environment and the leaf transmission all set to
 * zero and the sun at nearly double its normal strength leaves the forest
 * floor completely black, with no lit pixel anywhere in frame. Three storeys
 * of canopy patches placed on overlapping grids close the roof so thoroughly
 * that no ray reaches the ground, and no amount of extra sun intensity can
 * multiply zero into anything. That single measurement is the whole reason the
 * previous passes found the frame flat: there was no direct light in it at all,
 * so there was nothing for a light direction to be a direction *of*.
 *
 * A denser or higher-resolution shadow map does not fix it either, and would
 * be the wrong tool if it did. A sunfleck is the image of the sun's disc
 * projected through a hole tens of metres up; its softness comes from the
 * sun's angular size and the distance to the occluder, and a shadow map has no
 * idea about either. What it gives instead is a hard binary mask whose
 * penumbra is a fixed number of texels regardless of how far away the leaf is.
 *
 * So the roof comes out of the shadow map entirely (see the cast flags in
 * vegetation.js) and its occlusion is replaced by an analytic transmittance
 * function evaluated per fragment and per raymarch step:
 *
 *   - The coarse structure — where the roof genuinely has holes — comes from
 *     the world field, which evaluates the same gap functions vegetation.js
 *     used to place the canopy. Shafts therefore land under real holes.
 *   - The fine structure — leaf clusters breaking a hole into flecks — comes
 *     from a tiling texture projected along the sun direction, so it is
 *     constant along a sun ray. That is what makes a shaft a shaft: the floor
 *     fleck, the lit dust in the air above it and the lit leaf halfway up are
 *     all reading the same value.
 *   - Penumbra comes from the mip level, which grows with the distance to the
 *     roof. A fleck on the floor thirty metres below the canopy is soft; the
 *     same fleck on a leaf two metres under a low branch is sharp. This is the
 *     part a shadow map cannot do and the part the eye recognises.
 *   - The whole field drifts and shears slowly, because the canopy is moving.
 *     Static dapple reads as a texture painted on the ground; dapple that
 *     breathes is the single most documentary thing in the frame.
 *
 * The shadow map is still doing the job it is good at — trunks, logs, ferns
 * and the player, all near the ground and all wanting a hard contact shadow.
 * The two occluders are simply separated by scale, which is also why the frame
 * got cheaper: the canopy was the heaviest thing in the depth pass.
 */
import * as THREE from 'three';
import { bakeImage } from '../gfx/bake.js';
import { FIELD_GLSL } from './field.js';

/* The leaf-cluster mask.
 *
 * Three storeys of Worley clumps multiplied together, which is the cheapest
 * construction that produces the right *statistics*: a lot of area at zero, a
 * thin ring of partial values, and a small fraction near one. A single octave
 * of anything gives a field whose histogram peaks in the middle, and a canopy
 * whose transmittance is a uniform grey everywhere is a canopy that produces
 * an even wash rather than flecks — which is the state the scene was already
 * in by another route.
 *
 * The final ramp is baked rather than applied at runtime, and that ordering is
 * load-bearing. The mip chain has to blur the *thresholded* mask so that a
 * distant occluder gives a soft-edged fleck; thresholding after the blur would
 * put the edge back and there would be no penumbra at any distance.
 *
 * Two decorrelated fields are stored rather than one, and they are multiplied
 * at two different world scales at runtime — a large slow one and a small one
 * — so the pattern has structure at both the size of a gap and the size of a
 * leaf without a second bake.
 */
const CANOPY_TEX = /* glsl */ `
float clump(vec2 uv, float freq, float seed, float rad){
  vec2 p = uv * freq + seed;
  vec2 w = pworley(p, vec2(freq));
  // The warp is what stops the clumps reading as cells. Worley alone gives
  // convex blobs on a lattice, and a canopy seen from underneath is neither.
  float warp = pfbm(p * 0.5, vec2(freq * 0.5), 3) * 0.42;
  return sstep(rad, rad * 0.22, w.x + warp);
}

float roofMask(vec2 uv, float s){
  float a = 1.0;
  a *= 1.0 - 0.93 * clump(uv,  9.0, s +  0.0, 0.76);
  a *= 1.0 - 0.85 * clump(uv, 19.0, s +  3.7, 0.70);
  a *= 1.0 - 0.72 * clump(uv, 40.0, s +  8.1, 0.62);
  a *= 1.0 - 0.55 * clump(uv, 82.0, s + 15.3, 0.56);
  return a;
}

void main(){
  gl_FragColor = vec4(
    sstep(0.05, 0.30, roofMask(vUv, 0.0)),
    sstep(0.05, 0.30, roofMask(vUv, 31.7)),
    0.0, 1.0);
}
`;

/* The runtime side. Assumes worldField() from field.js is already in scope,
 * and deliberately does not define its own smoothstep helper: every material
 * this is injected into already has one under a different name, and a second
 * definition is a compile error rather than a shadowing warning. */
export const CANOPY_GLSL = /* glsl */ `
uniform sampler2D tCanopy;
uniform vec3 uSunDirW;
uniform vec3 uSunU;
uniform vec3 uSunV;
uniform vec3 uSunStep;     // horizontal metres per metre of climb, and 1/sin(elevation)
uniform vec4 uCanopy;      // roof height above ground, slant fade length, two world periods
uniform vec3 uAperture;    // penumbra slant cap, shaft gate lo/hi
uniform vec4 uFleck;       // sharp ramp lo/hi, fully blurred ramp lo/hi
uniform vec4 uPenumbra;    // mip rate, blur rate, closed-roof ramp shift, roof ramp width
uniform vec4 uDrift;       // slow translation of the two samples
uniform vec2 uCanopyRot;   // cos, sin of the slow shear

float cnpRamp(float e0, float e1, float x){
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/* Fraction of the sun reaching a world point through the roof.
 *
 * lodBias exists because the two callers want different filtering. A surface
 * shader knows its own screen-space footprint and has to respect it or the
 * flecks alias into a crawling glitter; a raymarch has no meaningful
 * derivatives and wants the penumbra term alone.
 */
float canopyTransmit(vec3 wp, float groundY, float lodBias, out float open){
  float hUp = groundY + uCanopy.x - wp.y;
  if (hUp <= 0.0){ open = 1.0; return 1.0; }

  /* How far the sun ray travels through the canopy to get here — the slant
   * distance — rather than how far straight up the roof is.
   *
   * Using the vertical drop for this was one bug with three faces, and it is
   * the whole reason the shafts would not lean. Every quantity below is a
   * statement about how much canopy is left between this point and the sun,
   * and at a fifteen-degree sun that path is four times longer than the drop.
   * With the drop substituted for it: the penumbra stayed as tight at dawn as
   * at noon, so the beams kept a hard edge no real low sun has; the mask's
   * contrast recovery stayed put, so nothing softened; and worst, the fade at
   * the top of the canopy became a purely vertical brightening — light
   * increasing with altitude at a rate that did not depend on where the sun
   * was. That vertical gradient sits on top of the leaf mask, which *is*
   * correctly aligned with the sun, and drags the apparent origin of every
   * shaft toward the zenith. Measured in the in-scatter buffer, a fourteen
   * degree sun put its shafts' vanishing point about thirty degrees up. The
   * result reads as a spotlight hung above the clearing, which is exactly
   * what a critic called it. */
  float slant = hUp * uSunStep.z;

  /* Where this ray crosses the roof. Getting this offset right is why a shaft
   * leans: at a forty-degree sun the hole that lights your feet is thirty
   * metres away, not overhead.
   *
   * Analytic rather than a field lookup, and the reason is the one thing this
   * expression has to be. Slide along the sun ray and wp.xz gains exactly what
   * hUp loses, so the sampled point does not move: the value is constant along
   * a sun ray, and that constancy is the entire difference between a beam and
   * a column. An earlier version clamped the reach to keep the lookup inside
   * the corridor, and clamping breaks it — past the cap the offset stops
   * tracking height, the sample becomes a function of horizontal position
   * alone, and every ray in a vertical line of air shares one gate value. At
   * fourteen degrees that cap engaged below fifteen metres, which is all of
   * the visible understory and all of the mist, so the entire low-sun frame
   * was gated into vertical columns. The measurement was unambiguous once it
   * was made: the in-scatter buffer's dominant ridge sat at 82 degrees from
   * horizontal when the geometry called for 30. */
  float roof = roofAnalytic(wp.xz + uSunStep.xy * hUp);
  open = cnpRamp(0.08, 0.08 + uPenumbra.w, 1.0 - roof);

  vec2 b = vec2(dot(wp, uSunU), dot(wp, uSunV));
  vec2 r = vec2(uCanopyRot.x * b.x - uCanopyRot.y * b.y,
                uCanopyRot.y * b.x + uCanopyRot.x * b.y);
  /* Penumbra grows with the distance to the occluder, and the occluder that
   * sets a fleck's edge is the last leaf the ray grazed rather than the top of
   * the canopy. That distinction does not matter at noon, when the two are the
   * same thing, and it matters enormously at dawn: the honest slant to the
   * roof is then over a hundred metres, and blurring by that much walks the
   * mask five and a half mips down its chain, where the measured spread
   * between its median and its ninetieth percentile has fallen from 0.81 to
   * 0.34 and there is no longer a fleck in the data to threshold for. The
   * result was a low sun that produced no dapple whatever. A ray crossing a
   * nineteen-metre slab of canopy at a shallow angle exits the underside of it
   * long before it has travelled its full slant, so the distance that sets the
   * blur saturates; this cap is where. The fade below deliberately keeps the
   * uncapped value, because how much canopy is in the way is a different
   * question from how far away the last of it was. */
  float soft = min(slant, uAperture.x);
  float lod = log2(1.0 + soft * uPenumbra.x) + lodBias;
  float leaf = textureLod(tCanopy, r * uCanopy.z + uDrift.xy, lod).x;
  /* Breaks the tile, at a fifth of the amplitude it would take to dim the
   * flecks. Multiplying two full masks together was the first attempt and it
   * is wrong twice over: it squares an already sparse field, and because the
   * second sample's fine detail is blurred to its own mean by the time it
   * reaches the floor, what it actually contributes down there is a constant
   * factor of about an eighth. That measured constant was the whole reason the
   * first build of this system produced no visible flecks at all. */
  leaf *= 0.78 + 0.22 * textureLod(tCanopy, r * uCanopy.w + uDrift.zw, lod * 0.6).y;

  /* Re-expanding the contrast the mip chain took out, by the amount it took.
   *
   * A blurred mask does not merely soften, it collapses toward its own mean —
   * which for a canopy this closed is about an eighth — so a fleck arriving on
   * the floor from twenty-six metres up peaks at an eighth of full sun before
   * this line and reads as nothing at all. Sliding the ramp down to sit around
   * the blurred distribution restores the fleck's brightness while leaving its
   * *edge* soft, because the softness is in the data rather than in the
   * threshold. That distinction is the whole reason this is a ramp against a
   * blurred field and not a blur of a ramp.
   *
   * The roof field slides the same pair of edges rather than scaling the
   * result, so a thicker roof produces fewer flecks rather than the same
   * flecks dimmed, which is what a hole in a roof actually does. The shift is
   * deliberately small. An earlier version drove the edges past one under
   * closed canopy, on the reasoning that closed canopy passes nothing — and
   * because the roof field varies on a thirty-metre scale, the result was
   * that whole stretches of trail were uniformly unlit and whole others
   * uniformly lit. Neither of those is dapple. Real closed canopy still throws
   * sunflecks; there are simply fewer of them. */
  /* On the capped distance, not the raw one. This value only exists to slide
   * the ramp onto wherever the mip chain has left the distribution, so it has
   * to be driven by the same number that chose the mip. */
  float blur = clamp(soft * uPenumbra.y, 0.0, 1.0);
  float shift = (1.0 - open) * uPenumbra.z;
  float lo = mix(uFleck.x, uFleck.z, blur) + shift;
  float hi = mix(uFleck.y, uFleck.w, blur) + shift;
  float t = cnpRamp(lo, hi, leaf);

  /* Fades out toward the top of the canopy, so the roof's own leaves are lit
   * from above rather than being shadowed by a roof they are part of. On the
   * slant distance, which is what turns this from a bug into the term that
   * sells the sun's elevation: at noon a leaf punches straight out through a
   * few metres of crown and most of the upper storey is in sun, while at dawn
   * the same leaf has forty metres of canopy to cross sideways and only the
   * last few metres under the very top escape. The lit band at the top of the
   * frame therefore deepens and shallows with the sun, which is most of what
   * the eye uses to read the hour. */
  return mix(1.0, t, clamp(slant / uCanopy.y, 0.0, 1.0));
}

/* The two-argument form, for the callers that do not care how open the roof
 * up-sun was. GLSL has no default arguments and an out parameter every caller
 * has to declare a throwaway for is worse than one wrapper. */
float canopyTransmit(vec3 wp, float groundY, float lodBias){
  float ignored;
  return canopyTransmit(wp, groundY, lodBias, ignored);
}
`;

/* The rest of the light in the understory, which is nearly all of it.
 *
 * The scene used to carry this as a second, unshadowed DirectionalLight aimed
 * along the sun. That was the right idea and the wrong object: a directional
 * light is uniform across the world, and the one thing this term should not be
 * is uniform. Light that has been through the canopy is strongest under the
 * thin parts of it, so the correct shape is the roof field, smoothly — and
 * that low-frequency variation across the frame is most of the answer to the
 * middle distance reading as one flat wall. A wall lit evenly is a wall; the
 * same wall with light wells and deep shade in it is a series of layers.
 *
 * It is added into the indirect irradiance rather than being a light because
 * that is what it physically is, and because doing it there costs the frame
 * one fewer light loop in every material in the scene.
 */
export const CANOPY_FILL_GLSL = /* glsl */ `
uniform vec3 uFillColor;
uniform vec3 uSkyFill;
uniform vec3 uWarmFill;
uniform vec4 uFill;        // amount, height gain, contact depth, 1/contact height
/* How the transmitted light is arranged in angle, which is not a constant.
 *
 * The four numbers are lateral weight, the floor and exponent of the sun-facing
 * term, and the floor of the upward-facing one, and the CPU interpolates all of
 * them from the sun's elevation because they describe the same physical fact
 * from four directions. Light that gets under a closed canopy at noon arrives
 * from a broad patch of sky more or less overhead, so it is close to isotropic
 * and slightly top-weighted. Light that gets under the same canopy near dawn
 * cannot come from overhead at all — there is forty metres of crown that way —
 * so it arrives through the thin edge, from one azimuth, almost horizontally,
 * and having crossed enough atmosphere to be orange.
 *
 * Treating those two as the same distribution and varying only its brightness
 * is what made a fourteen-degree sun look like a dim noon. It is also the term
 * that has to carry the hour when the camera is pointed near the sun, because
 * a shaft seen end-on is a blob no matter how correctly it rakes, whereas a
 * trunk lit hard down one side reads as low light from every angle there is. */
uniform vec4 uLateral;     // lateral weight, side floor, side exponent, up floor

/* Contact darkening where something meets the ground.
 *
 * The screen-space occlusion in the atmosphere pass is the general answer to
 * this and it cannot be the whole answer here, for a reason specific to this
 * scene: it works from the depth buffer, and the depth buffer of a rainforest
 * floor is a chaos of alpha-tested leaf edges at half resolution. The normals
 * it derives there are noise, so the occlusion it finds averages out to a mild
 * overall dimming instead of the hard dark line where a stem enters the
 * litter — which is precisely the line whose absence makes the understory look
 * like it is hovering a centimetre above the ground.
 *
 * This is the missing line, done analytically for nothing: the world field
 * already knows the ground height at every point, so anything standing within
 * a knee's height of it and facing sideways is in the crevice between itself
 * and the floor. The normal term is what keeps it honest — it darkens stems,
 * root buttresses, the sides of logs and the near edge of every upright blade,
 * and leaves the litter lying flat on the ground alone, because a leaf lying
 * flat is not in a crevice, it *is* the floor.
 */
float canopyContact(vec3 wp, vec3 nW, vec4 field){
  float low = 1.0 - cnpRamp(0.0, 1.0, (wp.y - field.x) * uFill.w);
  return 1.0 - uFill.z * low * (1.0 - abs(nW.y));
}

/* Indirect light in the understory.
 *
 * The four factors below multiply, and the floor under each of them is the
 * part worth reading carefully, because getting those wrong is what crushed
 * the shadows in the pass before this one. Four independent factors each
 * bottoming out near a quarter give a product near four thousandths, so the
 * darkest surface in frame — a downward-facing leaf under thick roof, turned
 * away from the sun, near the ground — was receiving about a fortieth of what
 * the brightest one got from a term that is supposed to represent *diffuse
 * skylight*. Skylight in real canopy shade does not vary by a factor of
 * forty; it is close to ambient by definition, and the deep shade of a
 * rainforest is green and legible rather than black. The floors are raised
 * here to bring that ratio to about fifteen, and the ranges kept, so the
 * modelling each factor contributes survives at the top while the bottom
 * stops clipping.
 */
vec3 canopyFill(vec3 wp, vec3 nW, vec4 field){
  /* Neither this floor nor the additive skylight nor the occlusion has any
   * authority over the last two crushed patches, and it is worth writing down
   * why so nobody spends another pass on them here. The trail at the
   * eighteen-metre stop and the ground under the log at fifty-two sit at a
   * tenth to a fifteenth of full white. Switching the occlusion off entirely
   * moves them by nothing; raising the additive skylight by half moves them by
   * one level; raising this floor by a fifth moves them by nothing at all,
   * because the trail carries a light well by construction and is already at
   * the open end of this ramp. What sets their value is a wet-mud albedo of
   * about a twentieth, and an albedo is not a lighting term. */
  float well = 0.46 + 0.54 * cnpRamp(0.10, 0.62, 1.0 - field.z);
  /* Scattered light still remembers which way it came from. A pure ambient
   * has no side to it, and a frame lit entirely by terms with no side is the
   * "no sense of light direction" finding restated. Half a wrap toward the
   * sun is as much directionality as light that has been through two leaves
   * can honestly claim. */
  float face = dot(nW, uSunDirW) * 0.5 + 0.5;
  float side = uLateral.y + (1.0 - uLateral.y) * pow(face, uLateral.z);
  float up = uLateral.w + (1.0 - uLateral.w) * (nW.y * 0.5 + 0.5);
  /* And it gets stronger with height, because there is less canopy left above
   * you. This is a small term with a large job: it puts a vertical gradient
   * across the middle distance, so the understory band, the sapling band and
   * the crowns separate instead of stacking into one value. */
  float lift = 0.66 + 0.34 * clamp((wp.y - field.x) * uFill.y, 0.0, 1.0);
  /* And a floor that nothing modulates at all. Every term above is a product,
   * so every one of them can take the result to nearly nothing; this is the
   * light that is present regardless, and it is deliberately the one term here
   * that is not green. Light reaching the floor through a canopy has been
   * filtered by leaves, but light reaching it down the gaps has not, and a
   * shade colour built only from the filtered half is the reason deep shadow
   * was reading as a flat dark green rather than as air. */
  /* Only the side facing the sun warms, and only when the sun is low. Warming
   * the whole fill would be the easy version and it is wrong: at dawn the lit
   * flank of a trunk is orange because that light came the long way through
   * the atmosphere, while its shaded flank is lit by sky and goes *cooler*, not
   * warmer. Splitting the tint by facing is what turns a global colour shift
   * into a modelled one, and the split is the thing the eye reads as evening. */
  vec3 tint = mix(uFillColor, uWarmFill, uLateral.x * cnpRamp(0.35, 1.0, face));
  return tint * (uFill.x * well * side * up * lift) + uSkyFill;
}
`;

export class Canopy {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{texture: THREE.Texture, map: THREE.Vector4}} field
   */
  constructor(renderer, field) {
    this.field = field;
    this.texture = bakeImage(renderer, CANOPY_TEX, {
      size: 1024,
      colorSpace: THREE.NoColorSpace,
      wrap: THREE.RepeatWrapping,
      transparent: false,
    });
    this.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

    /* One object, handed to every material and to both post passes by
     * reference. The alternative — a copy per consumer kept in step by an
     * update loop — is how the floor and the shafts end up disagreeing about
     * where the sun is for one frame after every change. */
    this.uniforms = {
      tField: { value: field.texture },
      uFieldMap: { value: field.map },
      tCanopy: { value: this.texture },
      uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
      uSunU: { value: new THREE.Vector3(1, 0, 0) },
      uSunV: { value: new THREE.Vector3(0, 0, 1) },
      uSunStep: { value: new THREE.Vector3() },
      /* Roof at twenty-six metres over the ground with eighteen metres of
       * depth to it. Those are the heights vegetation.js actually places the
       * two canopy storeys at — twelve to twenty and twenty-one to thirty-one
       * — so a leaf in the upper storey is above the transmittance function
       * and gets lit, and everything under the lower one is fully inside it. */
      uCanopy: { value: new THREE.Vector4(26.0, 31.0, 1 / 24.0, 1 / 61.0) },
      /* How far the penumbra distance is allowed to grow, and the two ends of
       * the ramp the volumetric pass uses to decide whether a stretch of air
       * is under a real hole. Surfaces do not use that ramp: a closed canopy
       * still throws sunflecks and gating those away is how the trail ends up
       * with lit stretches and unlit stretches instead of dapple. A shaft is a
       * different claim — it says light is pouring through an opening — and
       * it should not be made where there is no opening. */
      uAperture: { value: new THREE.Vector3(55.0, 0.06, 0.52) },
      /* The ramp the mask is thresholded through, at zero blur and at full
       * blur. The first pair is close to binary because a leaf a metre under
       * the crown really is either in the sun or not; the second sits down
       * around the blurred field's mean, which is where the signal actually
       * is by the time it has fallen twenty-six metres. */
      uFleck: { value: new THREE.Vector4(0.10, 0.45, 0.36, 0.70) },
      /* Mip rate, blur rate, and the two ends of the roof-openness ramp.
       *
       * The mip rate is not a taste value. The sun subtends about half a
       * degree, so an occluder h metres up throws a penumbra about h/108
       * metres wide; at 24 m of world per 1024 texels that is 0.4h texels, and
       * log2 of it is the mip level that blurs by exactly that much. Getting
       * this from the geometry rather than by eye is the entire reason the
       * flecks harden correctly as you look up into the crowns.
       *
       * Both rates are against the slant distance now rather than the drop,
       * which is a change of a factor of 1.6 at the reference sun and of 4 at
       * a low one. The mip rate is held slightly under its geometric value:
       * the full 0.40 is right, but the dapple as it stands at 38 degrees is
       * the part of this system a reviewer signed off on, and buying textbook
       * dawn penumbra at the cost of the midday flecks that already work is a
       * bad trade. 0.32 keeps the reference sun within a third of a mip of
       * where it was and still gives the low sun the 1.7 mips of extra
       * softening that stops it looking like a stage light.
       *
       * The blur rate saturated at forty-two metres of slant, and that one
       * number was quietly collapsing two elevations into one. The reference
       * sun reaches the floor at forty-two metres of slant and a fourteen
       * degree sun at a hundred and seven, so both were pinned at full blur
       * and thresholded through an identical ramp — the floors of a dawn frame
       * and a mid-morning frame came out of the same expression with the same
       * arguments. Ninety metres puts the reference sun at about half blur and
       * leaves full blur to the sun that has actually earned it, which is what
       * finally separates dawn dapple from morning dapple. */
      uPenumbra: { value: new THREE.Vector4(0.32, 1 / 90.0, 0.12, 0.52) },
      uDrift: { value: new THREE.Vector4() },
      uCanopyRot: { value: new THREE.Vector2(1, 0) },
      /* The colour of light that has been through two leaves: green, and
       * warmer than the sky it started as. */
      uFillColor: { value: new THREE.Color(0x8fa878) },
      /* Skylight that reached the floor without going through a leaf. Small,
       * and cooler than everything else in the understory on purpose. */
      uSkyFill: { value: new THREE.Color(0x445851) },
      /* The same filtered light after a low sun has dragged it through a great
       * deal more atmosphere. Matched in luminance to uFillColor rather than
       * being simply brighter, so that swinging the sun down the sky changes
       * the colour of the understory without changing its exposure. */
      uWarmFill: { value: new THREE.Color(0xc99a5e) },
      uLateral: { value: new THREE.Vector4(0, 0.42, 1.4, 0.52) },
      /* The contact band is deeper than a stem base is tall, and that is
       * deliberate: the ground height it measures against comes from a field
       * sampled every metre and smoothed, so on rough litter the base of a
       * plant already reads twenty or thirty centimetres up before it has
       * left the ground at all. A band tight enough to be physically correct
       * spends most of itself on that error. */
      uFill: { value: new THREE.Vector4(0.84, 1 / 11.0, 0.55, 1 / 0.70) },
      uViewToWorld: { value: new THREE.Matrix4() },
      uCanopyDbg: { value: 0 },
    };
    this._t = 0;
  }

  setSun(dir) {
    const u = this.uniforms;
    u.uSunDirW.value.copy(dir);
    /* An orthonormal frame perpendicular to the sun, which is what makes the
     * leaf mask constant along a sun ray. The fallback matters at noon: the
     * cross product with world up collapses when the sun is overhead, and a
     * zero-length basis puts the entire canopy mask on one texel. */
    const up = Math.abs(dir.y) > 0.999 ? _fallback : _up;
    u.uSunU.value.crossVectors(dir, up).normalize();
    u.uSunV.value.crossVectors(dir, u.uSunU.value).normalize();
    /* Horizontal metres travelled per metre climbed, and the same reciprocal
     * again on its own — which is 1/sin(elevation), the factor that turns a
     * vertical drop into a distance along the sun ray. They are one quantity
     * and they are shipped together so that no consumer can use one of them
     * without the other being available, which is how the slant distance came
     * to be missing from the transmittance in the first place. */
    const k = 1 / Math.max(0.08, dir.y);
    u.uSunStep.value.set(dir.x * k, dir.z * k, k);

    /* The angular distribution of the transmitted light, redone whenever the
     * sun moves. The ramp is on sin(elevation) and it is placed where it is
     * because the interesting part of the range is the bottom of it: between
     * noon and forty degrees a canopy's interior barely changes, and between
     * twenty degrees and the horizon it changes completely. */
    const low = smoothstep(0.58, 0.06, dir.y);
    u.uLateral.value.set(
      low,
      /* At noon a surface turned away from the sun still receives most of what
       * one turned toward it does, because the light is coming from all over
       * the roof. Near the horizon it receives a seventh, because there is one
       * direction the light can be coming from and that is not it. */
      lerp(0.42, 0.14, low),
      lerp(1.4, 2.1, low),
      /* And the preference for upward-facing surfaces goes away with it. A low
       * sun's light is horizontal, so it lands on trunks and stems rather than
       * on the tops of leaves, and leaving the overhead weighting in was what
       * kept vertical surfaces dark in exactly the conditions that should be
       * lighting them hardest. */
      lerp(0.52, 0.80, low),
    );
  }

  /* The canopy moving. Two incommensurate rates on each axis so the drift
   * never repeats, plus a shear, because a crown does not slide — it twists,
   * and a fleck that only translates reads as a projector fault. */
  update(dt) {
    this._t += dt;
    const t = this._t;
    const d = this.uniforms.uDrift.value;
    d.x = Math.sin(t * 0.083) * 0.021 + Math.sin(t * 0.211 + 1.7) * 0.0075;
    d.y = Math.cos(t * 0.067) * 0.019 + Math.sin(t * 0.173 + 4.2) * 0.0068;
    d.z = Math.sin(t * 0.049 + 2.4) * 0.013;
    d.w = Math.cos(t * 0.058 + 0.9) * 0.012;
    const a = Math.sin(t * 0.041) * 0.030 + Math.sin(t * 0.127 + 2.2) * 0.011;
    this.uniforms.uCanopyRot.value.set(Math.cos(a), Math.sin(a));
  }

  dispose() {
    if (this.texture.userData.rt) this.texture.userData.rt.dispose();
    this.field.texture.dispose();
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _fallback = new THREE.Vector3(1, 0, 0);

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Give a MeshStandardMaterial the canopy's direct mask and its indirect fill.
 *
 * Applied from outside rather than written into each material's own
 * onBeforeCompile, because three's materials here already have one and the two
 * jobs are unrelated: this file owns lighting and those files own surfaces.
 * The existing handler runs first and this wraps whatever it produced, so
 * every replacement below has to survive the other one having already been
 * there — which is why they all target directives that nothing else touches,
 * and why the two that do overlap insert *before* a directive rather than
 * replacing it.
 */
export function patchCanopyLight(material, canopy) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;

  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, canopy.uniforms);

    shader.fragmentShader = 'uniform mat4 uViewToWorld;\nuniform float uCanopyDbg;\n'
      + FIELD_GLSL + CANOPY_GLSL + CANOPY_FILL_GLSL
      + 'vec3 gCanopyMask = vec3(1.0);\nvec3 gCanopyFill = vec3(0.0);\nfloat gCanopyOcc = 1.0;\n'
      + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader
      /* Wrapping three's own direct BRDF rather than scaling the accumulated
       * result afterwards. The accumulated result is the sum over every light
       * plus the indirect terms, and the mask belongs to exactly one of them;
       * multiplying the sum would occlude the ambient as well, which is most
       * of the frame's light and none of it comes through the roof in a
       * straight line. */
      .replace('#include <lights_physical_pars_fragment>', /* glsl */ `
        #include <lights_physical_pars_fragment>
        void RE_Direct_Canopy( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
          IncidentLight dl = directLight;
          dl.color *= gCanopyMask;
          RE_Direct_Physical( dl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Canopy
      `)
      /* Both terms are computed here because this is the last directive before
       * the light loops and the first point at which the shading normal is
       * final. World position is reconstructed from the view position rather
       * than carried as a varying: three's materials all have vViewPosition
       * already, the three files this is applied to name their world-space
       * varyings differently or not at all, and one matrix multiply is
       * cheaper than convincing all of them to agree. */
      .replace('#include <lights_physical_fragment>', /* glsl */ `
        #include <lights_physical_fragment>
        vec3 wPosC = (uViewToWorld * vec4(-vViewPosition, 1.0)).xyz;
        vec3 wNrmC = normalize(mat3(uViewToWorld) * normal);
        vec4 fieldC = worldField(wPosC.xz);
        float contactC = canopyContact(wPosC, wNrmC, fieldC);
        gCanopyMask = vec3(canopyTransmit(wPosC, fieldC.x, 0.0) * contactC);
        gCanopyFill = canopyFill(wPosC, wNrmC, fieldC) * contactC;
        gCanopyOcc = contactC;
      `)
      /* The contact term multiplies the ambient as well as the direct, which
       * is why it goes here rather than being folded into the fill alone: down
       * in the crevice between a stem and the litter the hemisphere light is
       * the thing that is being occluded, and it is also nearly all of the
       * light there is. */
      .replace('#include <lights_fragment_end>',
               'irradiance = irradiance * gCanopyOcc + gCanopyFill;\n#include <lights_fragment_end>')
      .replace('#include <dithering_fragment>',
               'if (uCanopyDbg > 0.5) gl_FragColor.rgb = gCanopyMask;\n#include <dithering_fragment>');
  };

  /* Every material patched here gets byte-identical injected source, so they
   * can and should share programs with each other on the strength of it; the
   * key only has to stop them sharing with the unpatched version they were
   * before. */
  material.customProgramCacheKey = prevKey
    ? () => prevKey.call(material) + '|canopy'
    : () => 'canopy';
  return material;
}
