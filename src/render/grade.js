/* The lens and the film: everything between "the scene has finished being lit"
 * and "there are eight-bit pixels on the canvas".
 *
 * This is the tail of the pipeline that render/atmosphere.js begins. That file
 * renders the world into a half-float target, marches mist and shafts through
 * it, occludes it, and composites the three together — and it used to finish
 * the job by tone mapping straight to the canvas. It now stops one step short
 * and hands a linear HDR image to this file instead, which does the optics and
 * the film.
 *
 * The ordering below is not a preference, it is the order the physical events
 * happen in, and every one of these effects looks like a filter if it is put in
 * the wrong place:
 *
 *   1. shutter          the sensor integrates while the camera moves
 *   2. defocus          the lens does not converge every distance on the plane
 *   3. flare / bloom    light scatters inside the glass before it lands
 *   ---- all of the above are radiance, so they happen in linear HDR ----
 *   4. grade + curve    the response of the stock, then the print
 *   5. lateral colour   the glass does not focus the three primaries alike
 *   6. vignette         the barrel cuts the corners of the cone
 *   7. grain            the emulsion is made of particles
 *
 * Only the first three cost anything worth measuring; four through seven are
 * arithmetic inside one full-screen pass that has to run regardless, because
 * that pass is where the single ACES tone map lives.
 *
 * The rule this system was written under is that a viewer must not be able to
 * name any of it. Bloom that can be seen as bloom is too strong, defocus that
 * can be seen as defocus is too strong, and grain that can be counted is far
 * too strong. The measurements that matter are therefore small differences,
 * which is why the parameters here are in physical units — an aperture, a
 * shutter angle, a circle of confusion in pixels — rather than in arbitrary
 * strengths. A number with units can be argued about.
 */
import * as THREE from 'three';
import { FS_VERT, DEPTH_GLSL, SSTEP } from '../gfx/glsl.js';

/* What each tier is allowed.
 *
 * The grade, the vignette, the aberration and the grain are not in this table
 * because they are free: they are a few dozen instructions inside the final
 * pass, and the final pass exists at every tier because something has to tone
 * map. What costs money is anything that fetches the frame more than once, so
 * that is what the tiers move.
 *
 * `bloom` is a mip count, `dof` a tap count and `motion` a tap count; zero
 * means the pass is not run at all rather than run at strength zero.
 *
 * Every tier gets every effect, and the first version of this table did not:
 * defocus and the shutter were high and ultra only, on the reasoning that a
 * machine that has fallen to `low` needs the milliseconds more than it needs
 * the optics. Measured, that reasoning was wrong twice. The cost is 0.05 ms at
 * six taps, which is a third of a per cent of a frame on hardware slow enough
 * to be down here; and the thing being economised on is not a garnish, it is
 * the difference between a lens and a pinhole. Half the quality ladder was
 * shipping a look that had never been reviewed, which is the more expensive
 * outcome by a wide margin. The tiers scale the *sampling* of each effect
 * rather than its presence, so what changes going down is how much noise is in
 * the answer, not whether the answer is there.
 */
const TIER_GRADE = {
  low: { bloom: 4, dof: 6, motion: 8 },
  medium: { bloom: 5, dof: 8, motion: 12 },
  high: { bloom: 6, dof: 12, motion: 20 },
  ultra: { bloom: 7, dof: 16, motion: 28 },
};

const MAX_DOF = 16;
const MAX_MOTION = 28;

/* The grade itself, as data.
 *
 * Two constraints, and they are not the same constraint.
 *
 * The first is that every term moves blue *down* relative to green and none of
 * them moves it up — which for the power term means a larger exponent, since a
 * larger exponent darkens a value under one. The only additive term on blue is
 * negative. That is a mechanical guarantee rather than a matter of taste: the
 * warm olive palette this scene has been praised for is a couple of per cent of
 * blue gain away from reading cyan, and a grade is exactly the kind of thing
 * that gets nudged later by someone who does not know that.
 *
 * The second was learned the hard way and is the reason these numbers moved.
 * Warmth has to come out of blue and never out of red. The first version got
 * half of it by putting red *up* — a slope of 1.018 and an exponent of 0.990 —
 * which is a perfectly ordinary way to warm an image and is a disaster in this
 * one, because red rising against green is green falling against red, and the
 * green channel's lead over the red is the entire signal that a leaf is a leaf.
 * Measured across the stops it took the sunlit canopy from a lead of 4.9 code
 * values to 1.7 and the falls from -0.3 to -2.4, which is to say it left a
 * jungle net red-dominant. It was warm and it was not cyan and it was khaki,
 * and khaki was the single loudest complaint about the whole project. Red is
 * therefore pinned at unity in every multiplicative term here and the warmth is
 * blue's to give up.
 *
 * The magnitudes are all small on purpose. The image arriving here is already a
 * good one; the job is to make it look like it went through a camera, and the
 * difference between footage and a render is not a large colour move, it is a
 * set of small ones that are all consistent with the same piece of glass and
 * the same stock.
 */
const GRADE = {
  slope: new THREE.Vector3(1.000, 1.006, 0.966),
  offset: new THREE.Vector3(0.0, 0.0, -0.0008),
  power: new THREE.Vector3(1.000, 0.994, 1.014),
  cross: new THREE.Vector2(0.07, 1.8),
  print: new THREE.Vector4(0.014, 0.14, 0.28, 0),
  shadow: new THREE.Vector3(1.000, 1.000, 0.976),
  high: new THREE.Vector3(1.000, 1.000, 0.995),
  vignette: 0.13,
};

const NEUTRAL = {
  slope: new THREE.Vector3(1, 1, 1),
  offset: new THREE.Vector3(0, 0, 0),
  power: new THREE.Vector3(1, 1, 1),
  cross: new THREE.Vector2(0, 1.8),
  print: new THREE.Vector4(0, 0, 0.30, 0),
  shadow: new THREE.Vector3(1, 1, 1),
  high: new THREE.Vector3(1, 1, 1),
  vignette: 0,
};

/* A golden-angle spiral over the unit disc, as a constant.
 *
 * Every gather in this file wants the same thing: a set of directions with no
 * orientation the eye can find, spaced so that the samples are uniform over
 * the *area* rather than over the radius. A ring pattern gives a defocused
 * highlight visible spokes, and a random pattern per pixel gives it noise that
 * no half-resolution blur can hide. The golden angle is the arrangement with
 * the least structure at every count, so the same table works whether the tier
 * takes ten taps from it or sixteen.
 */
const SPIRAL_GLSL = /* glsl */ `
const vec2 SPIRAL[${MAX_DOF}] = vec2[${MAX_DOF}](
  vec2( 0.1768,  0.0000), vec2(-0.2258,  0.2068), vec2( 0.0346, -0.3938),
  vec2( 0.2846,  0.3712), vec2(-0.5222, -0.0924), vec2( 0.4947, -0.3147),
  vec2(-0.1655,  0.6155), vec2(-0.3156, -0.6076), vec2( 0.6846,  0.2500),
  vec2(-0.7123,  0.2940), vec2( 0.3434, -0.7337), vec2( 0.2537,  0.8089),
  vec2(-0.7647, -0.4432), vec2( 0.8971, -0.1972), vec2(-0.5475,  0.7788),
  vec2(-0.1265, -0.9761)
);
`;

/* Motion blur, reconstructed from depth and where the camera was last frame.
 *
 * There is no velocity buffer in this renderer and adding one would be a
 * per-material change across every shader in the project — the vegetation
 * alone would have to carry its previous wind phase through to the vertex
 * stage. What is available for free is the depth buffer and the previous
 * frame's view-projection, and between them they give the exact screen
 * velocity of every *static* surface. In a first-person walk that is almost
 * all of the motion there is: the camera is moving through a forest that is
 * standing still, and the parts genuinely moving on their own — leaves in the
 * wind, falling water, spray — are moving slowly enough at their scale that
 * their own blur would be a fraction of a pixel.
 *
 * The waterfall is the interesting exception and it is the reason the critic
 * asked for this. Its curtain is scrolling texture on nearly static geometry,
 * so a velocity buffer would report it as motionless too; what actually reads
 * as motion in a photograph of a fall is the camera's own drift smearing the
 * whole clearing, and that is precisely what this reconstructs.
 *
 * Shutter angle rather than a strength: a film camera's shutter is open for
 * some fraction of the frame interval, one hundred and eighty degrees being
 * the convention, and the blur is the path the image walked during that
 * opening. Expressing it that way means the blur is automatically correct at
 * any frame rate, which a pixel count is not.
 */
const MOTION_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
` + DEPTH_GLSL + SSTEP + /* glsl */ `
uniform sampler2D tScene;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uMotion;      // shutter fraction, ignore below and clamp at, pixels
uniform vec3 uPar;         // parallax pixels per dioptre, frame width, frame height
uniform int uTaps;
uniform float uDebug;

void main(){
  float d0 = rawDepth(vUv);
  vec3 centre = textureLod(tScene, vUv, 0.0).rgb;

  vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d0 * 2.0 - 1.0, 1.0);
  wp /= wp.w;
  vec4 pp = uPrevViewProj * wp;
  /* Behind the previous frame's camera. Nothing sensible can be said about
   * where such a pixel came from, and dividing by a negative w reflects it
   * across the frame, which would drag a streak from the far side of the
   * picture. */
  if (pp.w <= 0.0){ gl_FragColor = vec4(centre, 1.0); return; }
  vec2 prevUv = (pp.xy / pp.w) * 0.5 + 0.5;

  /* The sky needs no special case, which is worth saying because it looks like
   * it should. It has no geometry and no depth of its own, so the buffer holds
   * the clear value there and the reconstruction above places it on the far
   * plane — nine hundred metres out. Under rotation that is exactly right,
   * because rotation moves everything on the sensor alike whatever its
   * distance. Under translation the answer is wrong by the parallax of a point
   * at nine hundred metres against one at infinity, which for a walking pace is
   * five thousandths of a pixel. The sky was in fact the sharpest thing in a
   * fast pan, and the cause was not this; it was the weighting below.
   */
  vec2 vel = (vUv - prevUv) * uMotion.x;
  /* Measured in pixels from here on, not in uv. A displacement in uv is not a
   * distance — the frame is sixteen by nine, so the same uv length is 1.78
   * times as many pixels across as it is down — and every decision below is
   * about pixels: how far apart the taps are, when there is nothing left to
   * integrate, when the velocity has stopped being believable. The first
   * version of this pass compared uv lengths against a uv threshold and
   * therefore sampled a vertical pan at nearly half the density of a
   * horizontal one. */
  float speed = length(vel * uPar.yz);
  /* Under about half a pixel there is nothing to integrate and every tap would
   * land in the same texel, which costs the fetches and returns the original.
   * This is also what makes a paused capture identical to an unblurred one: the
   * harness renders a still frame, the camera has not moved, and the pass is a
   * copy. */
  if (speed < uMotion.y){ gl_FragColor = vec4(centre, 1.0); return; }
  /* Clamped, and the number is a sampling limit rather than a physical one.
   *
   * A sixtieth of a second at a hundred and sixty degrees a second is
   * fifty-six pixels of genuine travel at this field of view, and past that
   * the pass stops keeping up rather than being asked to: the taps would
   * spread beyond two pixels and start to comb. Failing by blurring slightly
   * less than reality is invisible; failing by combing is not. It is also what
   * catches a teleport between capture stops, which is a camera velocity of
   * some four hundred metres per frame, and the honest answer to "what did the
   * sensor see during that" is not a streak across the whole frame.
   *
   * The old limit was 0.022 in uv, which is thirty-five pixels wide and twenty
   * tall, and it was the reason a pan stopped getting blurrier at about a third
   * of that rate. */
  vel *= min(1.0, uMotion.z / speed);
  speed = min(speed, uMotion.z);

  float z0 = -viewZ(d0);

  /* How many taps this pixel gets, which is a property of the pixel and not of
   * the tier.
   *
   * The tier sets a ceiling; what is actually spent is whatever keeps the taps
   * about two pixels apart along the smear. That matters because the cost and
   * the artefact are on opposite sides of the same number. A fixed count is
   * either wasteful at a walking pace — eleven fetches to integrate a
   * two-pixel smear — or it undersamples in a whip, and undersampling here is
   * not a soft failure: the taps land far enough apart that each one enters and
   * leaves as a visible quantum, which across a frame of foliage reads as a
   * cross-hatch of dither laid over the motion. A pan is also the one moment in
   * a first-person walk when the tap budget is affordable, because it lasts
   * about a second and nothing else about the frame has changed.
   */
  int n = int(clamp(speed * 0.5, 3.0, float(uTaps)));

  /* Interleaved gradient noise on the tap offsets. Taps evenly spaced across a
   * smear are a comb, and a comb reads as a mistake where noise reads as
   * motion. */
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));

  vec3 sum = centre;
  float wsum = 1.0;
  for (int i = 0; i < ${MAX_MOTION}; i++){
    if (i >= n) break;
    /* Symmetric about now, not trailing behind it. A shutter that opens at
     * the sample instant and closes a frame later puts the sharpest part of
     * every object behind where it appears to be, which is visible as a lag
     * when the camera pans. */
    float t = ((float(i) + j) / float(n) - 0.5);
    vec2 uv = vUv + vel * t;
    float zt = -viewZ(rawDepth(uv));

    /* Whether that tap's surface actually swept across this pixel during the
     * exposure, and this is the term the sky hole was made of.
     *
     * The rule it replaces was that a surface much further away than this
     * pixel did not pass over it — it was behind it the whole time — which is
     * how camera blur otherwise puts a halo of distant forest around every
     * near trunk. That rule is sound for translation and wrong for rotation,
     * and rotation is what a pan is. Turning the camera moves *every* distance
     * across the sensor at the same angular rate, so a canopy gap and the leaf
     * in front of it sweep together and the boundary between them genuinely
     * smears. With a flat depth rejection it did not: the gap is thirty times
     * brighter than the foliage, so a fifteen per cent weight on it was
     * invisible from the dark side, the leaf edges survived the blur intact,
     * and the brightest region in a heavily streaked frame came out with a
     * hard aliased silhouette around it — the one element that should smear
     * most reading as the only sharp thing present.
     *
     * The physical quantity that distinguishes the two cases is parallax: two
     * depths move differently only insofar as the camera translated, by the
     * difference of their reciprocals times that translation. So rejection is
     * scaled by how much of this pixel's own smear is accounted for by the
     * disagreement between the two depths. Pure rotation puts that at zero and
     * rejects nothing; walking forward past a near trunk puts it at one and
     * rejects as before.
     */
    float dv = uPar.x * abs(1.0 / max(zt, 0.25) - 1.0 / max(z0, 0.25));

    float behind = sstep(0.0, 0.35 * z0 + 1.0, zt - z0);
    float w = 1.0 - 0.85 * behind * clamp(dv / max(speed, 1e-6), 0.0, 1.0);
    sum += textureLod(tScene, uv, 0.0).rgb * w;
    wsum += w;
  }

  if (uDebug > 0.5){
    /* Speed against a forty-pixel ramp in red, the clamp binding in green, and
     * the share of the tap ceiling spent in blue. */
    gl_FragColor = vec4(min(speed / 40.0, 1.0),
                        speed >= uMotion.z - 0.01 ? 1.0 : 0.0,
                        float(n) / float(uTaps), 1.0);
    return;
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
`;

/* Half-resolution colour with a circle of confusion attached.
 *
 * The circle of confusion is the thin-lens formula and nothing else: a point
 * at distance z images as a disc whose diameter on the sensor is
 *
 *     c = A f |z - zf| / (z (zf - f))
 *
 * for aperture diameter A, focal length f and focus distance zf. Everything
 * the pass needs from that collapses into one constant times |z - zf| / z,
 * which is computed on the CPU in _lens() below along with the conversion from
 * sensor millimetres to pixels.
 *
 * Two things are worth saying about the numbers rather than the formula. The
 * first is that documentary lenses are not stopped all the way down — a long
 * day under a canopy is shot near wide open because there is no light, and
 * that is exactly the condition where the foreground goes soft. The specific
 * failure the brief names, a leaf thirty centimetres from the lens rendering
 * razor sharp, is not a stylistic choice that a renderer makes; it is a thing
 * no camera has ever done. The second is that the far half is deliberately
 * feeble. At a focus of a few metres the far circle of confusion tends to a
 * limit of two or three pixels however distant the subject, and that limit is
 * the whole far-field effect: enough to take the last of the aliasing off the
 * far bank, not enough to be seen as an effect.
 *
 * The depth taken for the downsampled texel is the *nearest* of the four, not
 * their average. A foreground silhouette that loses half its pixels to a box
 * filter comes back as a sharp edge inside the blur, which is the single most
 * recognisable depth-of-field artefact there is.
 */
const COC_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
` + DEPTH_GLSL + /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uTexel;       // full-resolution texel
uniform vec3 uCoC;         // pixels per unit of |z-zf|/z, focus distance, near clamp

void main(){
  vec2 o = uTexel * 0.5;
  vec3 c = textureLod(tScene, vUv + vec2(-o.x, -o.y), 0.0).rgb
         + textureLod(tScene, vUv + vec2( o.x, -o.y), 0.0).rgb
         + textureLod(tScene, vUv + vec2(-o.x,  o.y), 0.0).rgb
         + textureLod(tScene, vUv + vec2( o.x,  o.y), 0.0).rgb;
  float d = min(min(rawDepth(vUv + vec2(-o.x, -o.y)), rawDepth(vUv + vec2(o.x, -o.y))),
                min(rawDepth(vUv + vec2(-o.x,  o.y)), rawDepth(vUv + vec2(o.x,  o.y))));
  float z = -viewZ(d);
  float coc = uCoC.x * abs(z - uCoC.y) / max(z, 1e-3);
  float near = z < uCoC.y ? min(coc, uCoC.z) : 0.0;
  gl_FragColor = vec4(c * 0.25, near);
}
`;

/* The near field, gathered.
 *
 * Defocus is a scatter — every point sprays its light over a disc — and a
 * shader can only gather, so the usual inversion applies: a pixel asks which
 * of its neighbours have a disc wide enough to reach it. That test is the
 * whole pass, and it is what makes an out-of-focus foreground spread *over*
 * the background instead of being a blurred cut-out with a sharp hole behind
 * it.
 *
 * The alpha it writes out is coverage: the fraction of the gather that came
 * from something in front. For a pixel deep inside a near leaf that is one,
 * and for a background pixel a few pixels outside the leaf's silhouette it is
 * the share of that pixel's cone the leaf actually blocks — which is the right
 * quantity to blend by, and the reason the edge of a defocused foreground
 * fades out over the width of its own circle of confusion rather than ending.
 */
const NEAR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tHalf;
uniform vec2 uTexel;       // half-resolution texel
uniform vec2 uNear;        // gather radius in full-res pixels, coverage gain
uniform int uTaps;
` + SSTEP + SPIRAL_GLSL + /* glsl */ `

void main(){
  // The buffer is half resolution, so a radius in frame pixels is half as many
  // texels here.
  float Rmax = uNear.x * 0.5;
  vec4 c0 = textureLod(tHalf, vUv, 0.0);

  /* First, how big the blur around here actually is.
   *
   * The gather has to be run at the radius of whatever near-field object is
   * in reach, not at the largest radius the lens can produce, and the
   * difference is the whole effect. Gathering at the maximum and dividing the
   * hits by the tap count answers a different question — "what fraction of a
   * sixteen-pixel disc is covered" — and for a leaf with a five-pixel circle
   * of confusion that fraction is a tenth even in the middle of the leaf, so
   * the composite blends in a tenth of the blur and the foreground comes out
   * very slightly soft and obviously sharp. That was the first version, and it
   * measured as a depth of field that did nothing.
   *
   * Eight taps over the widest disc is enough to find it, because what is
   * being looked for is a large smooth quantity rather than a detail: the
   * circle of confusion is a function of depth, and depth over sixteen pixels
   * of a foreground object does not have interesting structure. */
  float mx = c0.a;
  for (int i = 1; i < ${MAX_DOF}; i += 2){
    mx = max(mx, textureLod(tHalf, vUv + SPIRAL[i] * Rmax * uTexel, 0.0).a);
  }
  float R = mx * 0.5;
  // Nothing within reach is defocused by as much as a pixel.
  if (R < 0.5){ gl_FragColor = vec4(c0.rgb, 0.0); return; }

  vec3 sum = c0.rgb * step(0.5, c0.a);
  float cover = step(0.5, c0.a);
  for (int i = 0; i < ${MAX_DOF}; i++){
    if (i >= uTaps) break;
    vec2 o = SPIRAL[i];
    vec4 s = textureLod(tHalf, vUv + o * R * uTexel, 0.0);
    /* Does that neighbour's disc reach this pixel? Its radius is s.a frame
     * pixels, this tap is length(o)*R*2 frame pixels away, and the transition
     * is softened over a pixel so the answer is not a hard edge in a buffer
     * whose entire purpose is that nothing in it has one. */
    float d = length(o) * R * 2.0;
    float w = sstep(d - 1.5, d + 1.5, s.a);
    sum += s.rgb * w;
    cover += w;
  }
  /* Coverage, and now it means something: the taps are spread over exactly
   * the disc that the near object in front of this pixel projects, so the
   * share of them that came from in front is the share of this pixel's cone
   * that object blocks. One deep inside the object, a half at its defocused
   * edge, zero a full circle of confusion away from it. */
  gl_FragColor = vec4(sum / max(cover, 1e-4),
                      clamp(cover / float(uTaps + 1) * uNear.y, 0.0, 1.0));
}
`;

/* Bloom, in three shaders: a prefilter, a downsample and an upsample.
 *
 * What is being modelled is veiling glare — light that scatters off the
 * elements and the barrel inside a lens and lands somewhere it does not
 * belong. It is a convolution of the whole image with a very wide, very low
 * point spread function, and the two properties that matter are that its
 * width spans the frame and that its total energy is a per cent or two. A
 * pyramid reproduces both: each level contributes a kernel twice as wide as
 * the one below it, so summing six of them approximates a power-law tail far
 * better than any single Gaussian, and it costs a third of a frame buffer.
 *
 * The threshold is soft and low rather than hard and high, which is the
 * physically motivated choice and also the safe one. Real glare has no
 * threshold at all — every pixel scatters in proportion to its own brightness
 * — so a knee that lets bright midtones contribute a little and white
 * contribute fully is closer to the truth than a cliff at some value. It is
 * safer because the failure the critic has already punished, a blown-out white
 * curtain, comes from a hard threshold plus a large multiplier: everything
 * above the cliff gets the same treatment, and the brightest thing in the
 * frame is exactly the thing that cannot afford it.
 *
 * All of it is added *before* the tone curve, which is the other half of why
 * the curtain survives. Bloom added after tone mapping is added to a signal
 * that has already been compressed and clipped, so it can only push pixels
 * past white. Added before, it is radiance like any other, and the same ACES
 * shoulder that was holding the curtain at 0.94 holds the curtain plus its
 * glare at 0.95.
 */
const BLOOM_PRE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform vec2 uTexel;
uniform vec3 uKnee;        // threshold, knee width, exposure

/* Karis' weighted average: each tap is weighted by the reciprocal of its own
 * brightness before being combined. Without it a single very bright pixel —
 * a specular hit on wet stone, one spray sprite catching the sun — carries the
 * whole 4x4 neighbourhood, and because it is a subpixel event it appears and
 * disappears as the camera walks. That flicker is the classic bloom tell and
 * it is far more visible than the bloom itself. */
vec3 tap(vec2 uv){ return textureLod(tScene, uv, 0.0).rgb; }
float kw(vec3 c){ return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }

void main(){
  vec2 o = uTexel;
  vec3 a = tap(vUv + vec2(-o.x, -o.y)), b = tap(vUv + vec2(o.x, -o.y));
  vec3 c = tap(vUv + vec2(-o.x,  o.y)), d = tap(vUv + vec2(o.x,  o.y));
  float wa = kw(a), wb = kw(b), wc = kw(c), wd = kw(d);
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);

  /* Thresholded on display-referred brightness — the scene value times the
   * exposure the tone map is about to apply — so that "one" here means "would
   * have come out white". A threshold in scene units is a threshold whose
   * meaning changes whenever the exposure does. */
  vec3 e = col * uKnee.z;
  float l = max(e.r, max(e.g, e.b));
  float soft = clamp(l - uKnee.x + uKnee.y, 0.0, 2.0 * uKnee.y);
  soft = soft * soft / (4.0 * uKnee.y + 1e-4);
  float w = max(soft, l - uKnee.x) / max(l, 1e-4);
  gl_FragColor = vec4(col * clamp(w, 0.0, 1.0), 1.0);
}
`;

/* The thirteen-tap downsample from Jimenez' Call of Duty presentation. A plain
 * box filter aliases badly enough at the third level that a bright leaf edge
 * turns into a crawling checkerboard; this one is a partial-overlap arrangement
 * that costs nine extra fetches on a target a quarter the size and removes it. */
const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;       // source texel

vec3 t(vec2 o){ return textureLod(tSrc, vUv + o * uTexel, 0.0).rgb; }

void main(){
  vec3 a = t(vec2(-2.0, 2.0)), b = t(vec2(0.0, 2.0)), c = t(vec2(2.0, 2.0));
  vec3 d = t(vec2(-2.0, 0.0)), e = t(vec2(0.0, 0.0)), f = t(vec2(2.0, 0.0));
  vec3 g = t(vec2(-2.0,-2.0)), h = t(vec2(0.0,-2.0)), i = t(vec2(2.0,-2.0));
  vec3 j = t(vec2(-1.0, 1.0)), k = t(vec2(1.0, 1.0));
  vec3 l = t(vec2(-1.0,-1.0)), m = t(vec2(1.0,-1.0));
  gl_FragColor = vec4(e * 0.125
                    + (a + c + g + i) * 0.03125
                    + (b + d + f + h) * 0.0625
                    + (j + k + l + m) * 0.125, 1.0);
}
`;

/* Nine-tap tent on the way back up, added onto the level below with the
 * blend unit. The radius is in texels of the *smaller* target, so the tent
 * widens with every level and the sum of them is smooth — which is the whole
 * reason for going back up the pyramid rather than reading all six levels at
 * the end. Bilinear magnification of a level a thirty-second of the frame
 * across has visible diamond facets in it, and a gradient with facets in it is
 * exactly what the eye finds.
 *
 * The gain is what shapes the point spread function, and it is applied at every
 * step of the climb, so a level's weight in the final image is the gain raised
 * to the number of steps it has to make. At 1.30 that puts the widest level of
 * six at three and a half times the narrowest, which is the difference between
 * a pyramid that sums to a tight core and one that sums to a veil.
 *
 * The first version left it at one and measured as a glow that hugged its
 * source: an addition of nine hundredths of a code value to the frame's mean,
 * with only a tenth of a per cent of the frame more than four code values
 * brighter. That is not restraint, it is absence — a lens whose brightest
 * region is thirty times the forest around it puts a visible wash across that
 * forest, and the six-level pyramid built to carry it was contributing nothing
 * the top two levels had not already done. */
const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;       // source texel
uniform float uRadius;
uniform float uGain;

vec3 t(vec2 o){ return textureLod(tSrc, vUv + o * uTexel * uRadius, 0.0).rgb; }

void main(){
  gl_FragColor = vec4(((t(vec2(-1.0, 1.0)) + t(vec2(1.0, 1.0))
                      + t(vec2(-1.0,-1.0)) + t(vec2(1.0,-1.0))) * 0.0625
                     + (t(vec2(0.0, 1.0)) + t(vec2(-1.0, 0.0))
                      + t(vec2(1.0, 0.0)) + t(vec2(0.0,-1.0))) * 0.125
                     + t(vec2(0.0, 0.0)) * 0.25) * uGain, 1.0);
}
`;

/* The last pass: assemble, tone map, grade, and put film in front of it.
 *
 * Everything that can share a fetch shares one here. The depth-of-field
 * composite, the bloom sum, the tone curve, the grade, the aberration, the
 * vignette and the grain are all one dependent chain over one set of samples,
 * and splitting them into the separate passes they conceptually are would cost
 * four more full-resolution round trips for no change to the image.
 */
const FINAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
` + DEPTH_GLSL + SSTEP + /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tHalf;
uniform sampler2D tNear;
uniform sampler2D tBloom;
uniform vec2 uTexel;
uniform vec2 uHalfTexel;
uniform float uExposure;
uniform vec3 uCoC;         // pixels per unit of |z-zf|/z, focus distance, far clamp
uniform vec3 uEnable;      // depth of field, bloom, aberration
uniform float uBloom;
uniform vec3 uAberr;       // corner offset in uv x and y, unused
uniform vec2 uVignette;    // strength, falloff power
uniform vec2 uGrain;       // amplitude, frame seed
uniform float uDebug;

/* --- grade -------------------------------------------------------------
 *
 * Two halves, on either side of the tone curve, because the two halves are
 * different physical objects. Before the curve is the *stock*: how a strip of
 * film responds to the light that fell on it, which is a per-channel affair
 * because the three emulsion layers have different speeds and because the
 * dyes bleed into each other. After the curve is the *print*: what the paper
 * or the transfer does to the developed negative, which is a shaping of
 * densities and is where the toe and the midtone contrast live.
 *
 * Doing all of it on one side is what makes a grade look like a filter. A
 * saturation change applied after the curve cannot roll off, so it clips; a
 * contrast change applied before it fights the shoulder that is already
 * there. And the specific hazard in this scene is that the palette it has been
 * praised for — warm olive, no blue anywhere — is a hue that is one careless
 * per-channel gain away from going cyan, so every coefficient here that
 * touches blue moves it *down* or leaves it alone.
 */
uniform vec3 uSlope;
uniform vec3 uOffset;
uniform vec3 uPower;
uniform vec2 uCross;       // highlight crosstalk amount, its onset rate
uniform vec4 uPrint;       // toe lift, midtone contrast, its pivot, unused
uniform vec3 uShadowTint;
uniform vec3 uHighTint;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 stock(vec3 c){
  /* Crosstalk, weighted toward the highlights.
   *
   * Colour film desaturates as it approaches its shoulder — the layers
   * saturate at slightly different rates and the dyes cross-contaminate — so
   * a bright green leaf photographs paler and yellower than its own albedo,
   * while the same leaf in shade keeps its chroma. A renderer does the exact
   * opposite by default: its brightest pixels are its most saturated ones,
   * because saturation is a property of the surface and brightness just
   * multiplies it. That inversion is a large part of why a render reads as a
   * render, and it is most visible here on the sunlit canopy, where the fully
   * lit leaves were the most violently green things in the frame.
   *
   * Halved from where it started, because it was the other half of the khaki.
   * A pull toward luminance is a pull toward grey along every axis at once,
   * including the green-red axis that says the subject is foliage, and at 0.13
   * weighted this heavily into the highlights it was taking about a code value
   * and a half of green lead off exactly the sunlit leaves that should have the
   * most. Real footage of a warm-graded jungle keeps a large green lead on lit
   * leaves; the desaturation film does to its highlights is real but it is
   * smaller than this was, and the leaves are where it is least affordable. */
  /* Measured on the exposed value rather than the scene value, because "a
   * highlight" means a pixel near the top of the *print*, and the scene is
   * two and a half stops below that by construction. Reading it off the raw
   * radiance made the term fire hardest on things that were about to be
   * middle grey. */
  float hw = 1.0 - exp(-max(luma(c), 0.0) * uCross.y * uExposure / 0.6);
  c = mix(c, vec3(luma(c)), uCross.x * hw);
  // Slope, offset, power, per channel — the ASC's three knobs, in linear.
  return pow(max(c * uSlope + uOffset, 0.0), uPower);
}

/* The print half of the grade, and it runs on *encoded* values — after the
 * transfer function, not before it.
 *
 * That is not a shortcut, it is where these three operations are defined. A
 * toe, a midtone contrast and a split tone are all shapings of density, and
 * density is logarithmic; the encoded signal is the closest thing to a
 * perceptual axis available at this point in the pass. Applying them to the
 * linear display value instead makes every one of them behave as though it had
 * been multiplied by twenty at the bottom of the range — the first version of
 * this file did exactly that, and a toe lift of 0.014 that was meant to put
 * the floor at four code values put it at thirty-two, which measured as the
 * first decile of the frame rising by four hundredths and looked like someone
 * had left a light on behind the camera.
 */
vec3 print(vec3 c){
  /* The toe. Film has no black: the base of the stock passes light, so the
   * densest part of a negative still prints at a few per cent, and the
   * approach to it is a curve rather than a corner. Digital has a corner at
   * zero, and under a canopy — where a third of the frame is within a stop of
   * black — that corner is doing visible work, clipping the deepest litter
   * shadows into a single flat value. Adding a small amount that tapers away
   * as the value rises both lifts the floor off zero and softens the slope
   * into it, which is the whole of what a toe is. */
  c += uPrint.x * pow(max(1.0 - c, 0.0), vec3(4.0));

  /* Midtone contrast, with the extremes explicitly excluded.
   *
   * The weight is a plateau rather than a parabola, and the difference is the
   * highlights. A parabola in the value is still at two thirds of its peak at
   * 0.8, so a contrast term shaped like one lifts the brightest one per cent
   * of the frame by five hundredths — and the brightest one per cent of this
   * frame is the aerated core of the waterfall, which is the single pixel
   * region the critic has already failed this scene over. A ramp up out of
   * the shadows, a flat run across the midtones and a long ramp back down
   * from just above the median is what the sentence "more contrast in the
   * midtones and less in the extremes" actually describes, and it leaves the
   * curtain where the tone curve put it.
   *
   * The pivot sits near this frame's own median rather than at the usual mid
   * grey, because a forest interior is a dark picture and pivoting a dark
   * picture at mid grey only makes it darker.
   *
   * On the luminance, with the channels carried along in proportion, rather
   * than on each channel separately. Per-channel contrast also raises
   * saturation — the channels are pushed apart wherever they already differ —
   * and while that is a real property of film it is not a property anyone can
   * control, because how much saturation it adds depends on what colour the
   * pixel happened to be. Measured across the five stops it was worth five or
   * six points of chroma on top of everything the grade was deliberately
   * doing, and in a scene whose palette is the thing that must not move, an
   * uncontrolled chroma term is not affordable. This way the only things that
   * touch colour here are the ones written down as colours. */
  float y0 = max(luma(c), 1e-4);
  float w = sstep(0.02, 0.16, y0) * sstep(0.88, 0.50, y0);
  c *= (y0 + uPrint.y * (y0 - uPrint.z) * w) / y0;

  /* Split tone. Warm in the shadows, neutral at the top. The shadows in this
   * world are lit by light that has been through two or three leaves and off
   * wet litter, so they are green-brown, and the standard cinematic move of
   * cooling the shadows toward teal would destroy the one thing about this
   * palette that has been repeatedly praised. Both tints are at or below one
   * in every channel, so this can only ever take a pixel further from white. */
  vec3 tint = mix(uShadowTint, uHighTint, smoothstep(0.0, 0.62, luma(c)));
  return clamp(c * tint, 0.0, 1.0);
}

vec3 RRTAndODTFit(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

/* three's ACES fit, unchanged and still the only tone map in the frame. The
 * grade is on either side of it rather than instead of it: this curve is what
 * every screenshot the project has ever taken was judged through, and
 * replacing it would make the whole archive incomparable. */
vec3 aces(vec3 c){
  const mat3 IN = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  c *= uExposure / 0.6;
  c = IN * c;
  c = RRTAndODTFit(c);
  c = OUT * c;
  return clamp(c, 0.0, 1.0);
}

void main(){
  /* Lateral chromatic aberration, applied to the sharp scene fetch only.
   *
   * A lens focuses short wavelengths closer to the axis than long ones, so
   * the three primaries land at slightly different image heights and the
   * error grows with distance from the centre — quadratically, near enough,
   * which is why the middle of the frame is clean and only the corners show
   * it. The scale here is under a pixel at the corner. That is roughly what a
   * decent zoom does and it is well below the threshold at which anyone would
   * name it; what it buys is that every high-contrast edge in the outer
   * quarter of the frame gets a faint warm-cool pair of fringes, and edges
   * with fringes are edges that went through glass.
   *
   * Only the sharp image is resampled. The defocus and the bloom are both
   * low-pass by construction, so shifting them by half a pixel would change
   * nothing they contain, and the two fetches saved are worth more. */
  vec2 r = vUv - 0.5;
  vec2 shift = r * dot(r, r) * uAberr.x * uEnable.z;
  vec3 c = vec3(
    textureLod(tScene, vUv + shift, 0.0).r,
    textureLod(tScene, vUv, 0.0).g,
    textureLod(tScene, vUv - shift, 0.0).b);

  if (uEnable.x > 0.5){
    float z = -viewZ(rawDepth(vUv));
    float coc = uCoC.x * abs(z - uCoC.y) / max(z, 1e-3);
    /* Far field. The circle of confusion out here tops out at a couple of
     * pixels, so the blur is four bilinear taps of the half-resolution buffer
     * spread by the pixel's own circle — which, since that buffer is already a
     * box downsample, lands within a fraction of a pixel of the right kernel
     * for anything this small. Building a second gather for two pixels of
     * softness would be most of a millisecond spent on something no one can
     * see, and the reason it is here at all is that a *completely* sharp
     * horizon is itself a tell. */
    float farC = z > uCoC.y ? min(coc, uCoC.z) : 0.0;
    float farA = smoothstep(0.6, uCoC.z, farC);
    if (farA > 0.001){
      vec2 o = uHalfTexel * farC * 0.5;
      vec3 blur = textureLod(tHalf, vUv + vec2(-o.x, -o.y), 0.0).rgb
                + textureLod(tHalf, vUv + vec2( o.x, -o.y), 0.0).rgb
                + textureLod(tHalf, vUv + vec2(-o.x,  o.y), 0.0).rgb
                + textureLod(tHalf, vUv + vec2( o.x,  o.y), 0.0).rgb;
      c = mix(c, blur * 0.25, farA);
    }
    // Near field last, because it is in front of everything including the
    // things the far field just softened.
    vec4 nf = textureLod(tNear, vUv, 0.0);
    c = mix(c, nf.rgb, nf.a);
  }

  if (uEnable.y > 0.5) c += textureLod(tBloom, vUv, 0.0).rgb * uBloom;

  if (uDebug > 0.5){
    /* Diagnostics, and deliberately not graded: a grade is a nonlinearity and
     * reading a quantity through one is how a working term gets declared
     * dead. Four is the bypass the atmosphere's own debug views ask for, where
     * the buffer already holds the number to be looked at. */
    if (uDebug < 1.5) c = textureLod(tBloom, vUv, 0.0).rgb * uBloom * 8.0;
    else if (uDebug < 2.5){
      float z = -viewZ(rawDepth(vUv));
      float coc = uCoC.x * abs(z - uCoC.y) / max(z, 1e-3);
      c = vec3(z < uCoC.y ? coc / 16.0 : 0.0, z > uCoC.y ? coc / 4.0 : 0.0, 0.0);
    } else if (uDebug < 3.5) c = vec3(textureLod(tNear, vUv, 0.0).a);
    else c = textureLod(tScene, vUv, 0.0).rgb;
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
    return;
  }

  c = aces(stock(c));

  /* Vignette. Deliberately at the bottom of what is measurable: the frame
   * already has volumetric mist doing large-scale luminance shaping, and two
   * overlapping falloffs — one of them keyed to the sun and one keyed to the
   * frame — would fight, with the sun-side corner reading as a smudge. What is
   * left is the fourth-power term, which is essentially zero across the middle
   * half of the frame and takes a few per cent out of the very corners. That
   * is the cos-fourth law, which is not a stylistic effect at all; it is what
   * happens because the corner of the frame is further from the exit pupil and
   * sees it at an angle.
   *
   * In linear, before the encode, because it is the only one of these that is
   * genuinely a loss of light rather than a shaping of density. */
  c *= 1.0 - uVignette.x * pow(clamp(length(r) * 1.42, 0.0, 1.0), uVignette.y);

  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb = print(gl_FragColor.rgb);

  /* Grain, after the transfer function rather than before it.
   *
   * Grain is not a property of the light, it is a property of the medium
   * recording it, and on a print its size in *code values* is roughly constant
   * — which is what putting it after the encode gives. Before the encode, the
   * same amplitude would be several times more visible in the shadows than in
   * the highlights, because that is what the sRGB curve does to a small
   * perturbation down there, and this frame is mostly shadows.
   *
   * The amplitude is modulated by a parabola in the encoded value for the
   * usual reason: silver halide grain is visible where some grains have been
   * developed and some have not, so it peaks in the midtones and vanishes in
   * clear film and in solid black. That curve is a quarter of the amplitude in
   * deep shadow, its full value across the 102-128 band, and two thirds of it
   * in the shoulder, which is the shape a measurement of a real stock has.
   *
   * A per-channel component on top of a shared one, because a colour negative
   * has three independently grainy layers, and grain that is purely luminance
   * reads as video noise rather than as film.
   *
   * The amplitude is set in code values so that it can be argued about, and it
   * was set by measurement rather than by eye. At the peak of the parabola the
   * noise is uniform over nine code values per channel, and because half of it
   * is shared between the channels and half is not, that comes out as a
   * luminance standard deviation of 1.6 — which is in the range a scanned
   * thirty-five millimetre frame carries rather than a third of it.
   *
   * Three versions of this number, and the arithmetic is worth writing down
   * because two of them were wrong in ways that were not visible. At 1.15 it
   * measured 0.83 against 0.80 for no grain at all: quantised away before it
   * reached the file. At 5.0 the peak sigma is 0.90 and the frame average 0.72,
   * which is present but is under the threshold at which grain does the one
   * thing it is here for — this frame is soft, and a soft frame with no grain in
   * it reads as a render however good the optics above are. The conversion from
   * amplitude to sigma is 0.180, not 0.289: a uniform variate over nine code
   * values has a standard deviation of 2.6, and then the luminance of a
   * half-shared half-independent triple takes 0.625 of that.
   *
   * Half of it is shared between the channels and half is not. All-shared is
   * luminance noise, which is what a sensor makes and not what an emulsion
   * makes; all-independent is chroma noise, which is the most visible kind per
   * unit of standard deviation and the one that reads as a bad JPEG.
   */
  vec3 g3 = fract(sin(vec3(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)),
                           dot(gl_FragCoord.xy, vec2(39.3468, 11.135)),
                           dot(gl_FragCoord.xy, vec2(63.7264, 27.951)))
                       + uGrain.y) * 43758.5453) - 0.5;
  float y = clamp(luma(gl_FragColor.rgb), 0.0, 1.0);
  float amp = uGrain.x * (0.25 + 3.0 * y * (1.0 - y)) / 255.0;
  gl_FragColor.rgb += mix(vec3(dot(g3, vec3(0.3333))), g3, 0.5) * amp;

  /* And the ordered dither that used to live at the end of the composite.
   * Grain would in fact hide the banding it exists to remove, but only at an
   * amplitude large enough to be seen, and this costs nothing. */
  float dth = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402909)));
  gl_FragColor.rgb += (dth - 0.5) / 255.0;
}
`;

function fullscreen() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const m = new THREE.Mesh(g, null);
  m.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(m);
  return { scene, mesh: m, geometry: g };
}

export class Grade {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} shared the depth/projection uniforms owned by Atmosphere
   */
  constructor(renderer, shared, tier = 'high') {
    this.renderer = renderer;
    this.shared = shared;
    this.tier = tier;
    this.enabled = true;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = fullscreen();
    this._targets = null;
    this._prevVP = new THREE.Matrix4();
    this._prevPos = new THREE.Vector3(NaN, NaN, NaN);
    this._vp = new THREE.Matrix4();
    this._frame = 0;
    /* Individually switchable, and not for the player's benefit — this is how
     * the cost of each term is measured in tools/p1cost.mjs, by timing the
     * frame with one of them off. Everything is on. */
    this.want = { motion: true, dof: true, bloom: true, grade: true, grain: true };
    this.debug = 0;
    this.bypass = false;

    /* The lens. A thirty-five millimetre prime at f/2.8 focused at five and a
     * half metres, which is a plausible rig for someone walking a trail with
     * a camera on their shoulder in bad light, and which puts the hyperfocal
     * distance far enough out that the near foreground is genuinely soft. The
     * sensor size is not a free parameter: it is derived from the render's own
     * field of view in _lens(), because a circle of confusion in millimetres
     * only converts to pixels if the frame and the sensor agree on how much
     * world they cover. */
    this.focal = 0.035;
    this.fstop = 2.8;
    this.focus = 5.5;
    this.maxNearPx = 16;
    this.maxFarPx = 2.6;
    /* The exposure time, as a multiple of the frame interval.
     *
     * The film convention is a hundred and eighty degrees — open for half the
     * interval — and at twenty-four frames that is a fiftieth of a second.
     * What is being imitated here is that exposure, not that shutter angle,
     * and the two are not the same thing at sixty frames a second: a hundred
     * and eighty degrees at sixty is a hundred-and-twentieth, less than half
     * the smear the footage this is aiming at has, and blur that is only half
     * of what the eye expects reads as an artefact rather than as motion.
     *
     * So this is one rather than a half: a sixtieth of a second at the frame
     * rate the game caps itself at, which is the commonest handheld
     * documentary exposure there is. It equals the whole frame interval, which
     * is a shutter angle no physical camera has, and it is still the right
     * number — the frame rate here is a property of the renderer and the
     * exposure is a property of the camera being imitated. Measured on a
     * fifty-degree-per-second pan it comes to about thirteen pixels of travel,
     * which is what a degree of arc is at this field of view, which is what
     * the real exposure would have integrated. */
    this.shutter = 1.0;
  }

  setTier(tier) {
    if (!TIER_GRADE[tier]) return;
    this.tier = tier;
    if (this._targets) this.setSize(this._targets.pw, this._targets.ph, true);
  }

  /** Sized in drawing-buffer pixels, matching Atmosphere. */
  setSize(pw, ph, force = false) {
    pw = Math.max(2, Math.round(pw));
    ph = Math.max(2, Math.round(ph));
    const cfg = TIER_GRADE[this.tier];
    if (!force && this._targets && this._targets.pw === pw && this._targets.ph === ph) return;
    if (this._targets) this._free(this._targets);

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    /* Clamped, and every one of these targets needs it. A blur reads outside
     * its own edge by construction, and with the default wrap a bright canopy
     * gap at the top of the frame bleeds into the litter at the bottom. */
    const mk = (w, h) => {
      const t = new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), opts);
      t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    };

    const scene = mk(pw, ph);
    // Only allocated when the tier will use it; motion blur cannot be done in
    // place and a spare full-resolution half-float buffer is 5 MB.
    const motion = cfg.motion > 0 ? mk(pw, ph) : null;
    const hw = pw >> 1, hh = ph >> 1;
    const half = cfg.dof > 0 ? mk(hw, hh) : null;
    const near = cfg.dof > 0 ? mk(hw, hh) : null;

    const bloom = [];
    for (let i = 0; i < cfg.bloom; i++) {
      const w = pw >> (i + 1), h = ph >> (i + 1);
      if (w < 4 || h < 4) break;
      bloom.push(mk(w, h));
    }

    this._targets = { scene, motion, half, near, bloom, pw, ph, hw, hh };
    return this._targets;
  }

  /** The HDR buffer Atmosphere's composite should render into. */
  target() { return this._targets.scene; }

  _free(t) {
    t.scene.dispose();
    t.motion?.dispose();
    t.half?.dispose();
    t.near?.dispose();
    for (const b of t.bloom) b.dispose();
  }

  _mat(key, frag, uniforms, blending) {
    this._mats = this._mats || {};
    if (!this._mats[key]) {
      this._mats[key] = new THREE.ShaderMaterial({
        vertexShader: FS_VERT,
        fragmentShader: frag,
        uniforms,
        depthTest: false, depthWrite: false,
        blending: blending || THREE.NoBlending,
        transparent: !!blending,
      });
    }
    return this._mats[key];
  }

  _build() {
    if (this._mats) return;
    this._mats = {};
    const shared = this.shared;
    this.motionMat = this._mat('motion', MOTION_FRAG, Object.assign({}, shared, {
      tScene: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uMotion: { value: new THREE.Vector3(1.0, 0.5, 56.0) },
      uPar: { value: new THREE.Vector3(0, 1600, 900) },
      uTaps: { value: 7 },
      uDebug: { value: 0 },
    }));
    this.cocMat = this._mat('coc', COC_FRAG, Object.assign({}, shared, {
      tScene: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uCoC: { value: new THREE.Vector3(2.0, 5.5, 16) },
    }));
    this.nearMat = this._mat('near', NEAR_FRAG, {
      tHalf: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: new THREE.Vector2(16, 1.0) },
      uTaps: { value: 12 },
    });
    this.preMat = this._mat('pre', BLOOM_PRE_FRAG, {
      tScene: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uKnee: { value: new THREE.Vector3(0.85, 0.55, 2.4667) },
    });
    this.downMat = this._mat('down', BLOOM_DOWN_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.upMat = this._mat('up', BLOOM_UP_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.4 },
      uGain: { value: 1.30 },
    }, THREE.AdditiveBlending);
    this.finalMat = this._mat('final', FINAL_FRAG, Object.assign({}, shared, {
      tScene: { value: null },
      tHalf: { value: null },
      tNear: { value: null },
      tBloom: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uHalfTexel: { value: new THREE.Vector2() },
      uExposure: { value: 1.48 },
      uCoC: { value: new THREE.Vector3(2.0, 5.5, 2.6) },
      uEnable: { value: new THREE.Vector3(0, 0, 1) },
      /* Small. This is the number the critic's blown-out curtain finding is
       * about, and the pyramid it multiplies is already normalised, so this is
       * roughly the fraction of a bright pixel's energy that the lens throws
       * elsewhere. Four per cent is a clean lens; twenty would be a dirty one
       * and would haze the frame, which is the failure mode named in the brief.
       *
       * It can be raised without endangering the curtain because of where in
       * the pass it lands. Bloom added after the tone curve is added to a signal
       * that has already been compressed against white, so it can only push
       * pixels past it; added before, it is radiance like any other, and the
       * same ACES shoulder that was holding the curtain under white holds the
       * curtain plus its glare under white. That is measured rather than
       * assumed — the standing requirement is zero blown pixels on the falls at
       * every stop and every tier, and it still reads zero at a threshold of
       * 245. */
      uBloom: { value: 0.045 },
      uAberr: { value: new THREE.Vector3(0.0018, 0, 0) },
      uVignette: { value: new THREE.Vector2(0.13, 4.0) },
      uGrain: { value: new THREE.Vector2(9.0, 0) },
      uDebug: { value: 0 },
      uSlope: { value: GRADE.slope.clone() },
      uOffset: { value: GRADE.offset.clone() },
      uPower: { value: GRADE.power.clone() },
      uCross: { value: GRADE.cross.clone() },
      uPrint: { value: GRADE.print.clone() },
      uShadowTint: { value: GRADE.shadow.clone() },
      uHighTint: { value: GRADE.high.clone() },
    }));
  }

  _draw(material, target, clear = true) {
    this.quad.mesh.material = material;
    this.renderer.setRenderTarget(target);
    if (!clear) this.renderer.autoClear = false;
    this.renderer.render(this.quad.scene, this.camera);
    if (!clear) this.renderer.autoClear = true;
  }

  /* Circle of confusion, in frame pixels per unit of |z - zf| / z.
   *
   * The sensor height comes out of the camera's own vertical field of view
   * rather than being declared, because the two have to agree: a thirty-five
   * millimetre lens covering fifty-eight degrees implies a sensor about thirty
   * nine millimetres tall, whatever a full-frame body would have. Getting this
   * from the projection every frame is also what keeps the effect correct when
   * the capture harness puts a long lens on for a detail shot.
   */
  _lens(camera, ph) {
    const f = this.focal;
    const A = f / this.fstop;
    const sensorH = 2 * f * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    return A * f * ph / (sensorH * Math.max(1e-3, this.focus - f));
  }

  /**
   * Everything after the atmospheric composite. Reads the HDR buffer this
   * object handed out through target() and leaves the finished frame on the
   * canvas.
   */
  finish(camera) {
    this._build();
    const t = this._targets;
    const cfg = TIER_GRADE[this.tier];
    const fm = this.finalMat.uniforms;
    this._frame++;

    let src = t.scene.texture;

    /* --- shutter --- */
    const doMotion = this.enabled && this.want.motion && cfg.motion > 0 && t.motion;
    if (doMotion) {
      this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      /* A first frame, a teleport between capture stops, or a resize has no
       * meaningful previous view, and reconstructing one produces a single
       * frame smeared across half the screen. Detecting it on the camera's own
       * translation is exact and costs nothing: nobody walks two metres in one
       * sixtieth of a second. */
      const jump = !Number.isFinite(this._prevPos.x)
                 || this._prevPos.distanceToSquared(camera.position) > 4;
      const mu = this.motionMat.uniforms;
      mu.tScene.value = src;
      mu.uInvViewProj.value.copy(this._vp).invert();
      mu.uPrevViewProj.value.copy(jump ? this._vp : this._prevVP);
      mu.uMotion.value.x = this.shutter;
      /* Parallax, in pixels per dioptre: how far the image of a surface one
       * metre away slid across the sensor because the camera itself moved,
       * which is what separates a translation from a rotation for the gather.
       * Isotropic in pixels — the projection's vertical scale times the frame
       * height is the same quantity as the horizontal pair — so it needs one
       * number rather than one per axis. */
      const tr = jump ? 0 : this._prevPos.distanceTo(camera.position);
      mu.uPar.value.set(tr * camera.projectionMatrix.elements[5] * 0.5 * t.ph * this.shutter,
                        t.pw, t.ph);
      mu.uTaps.value = cfg.motion;
      mu.uDebug.value = this.debug === 5 ? 1 : 0;
      this._draw(this.motionMat, t.motion);
      src = t.motion.texture;
      this._prevVP.copy(this._vp);
      this._prevPos.copy(camera.position);
    }

    /* --- defocus --- */
    const doDof = this.enabled && this.want.dof && cfg.dof > 0 && t.half;
    const cocScale = this._lens(camera, t.ph);
    if (doDof) {
      const cu = this.cocMat.uniforms;
      cu.tScene.value = src;
      cu.uTexel.value.set(1 / t.pw, 1 / t.ph);
      cu.uCoC.value.set(cocScale, this.focus, this.maxNearPx);
      this._draw(this.cocMat, t.half);

      const nu = this.nearMat.uniforms;
      nu.tHalf.value = t.half.texture;
      nu.uTexel.value.set(1 / t.hw, 1 / t.hh);
      nu.uNear.value.x = this.maxNearPx;
      nu.uTaps.value = cfg.dof;
      this._draw(this.nearMat, t.near);

      fm.tHalf.value = t.half.texture;
      fm.tNear.value = t.near.texture;
      fm.uHalfTexel.value.set(1 / t.hw, 1 / t.hh);
    }

    /* --- glare --- */
    const doBloom = this.enabled && this.want.bloom && t.bloom.length > 0;
    if (doBloom) {
      const pu = this.preMat.uniforms;
      pu.tScene.value = src;
      pu.uTexel.value.set(1 / t.pw, 1 / t.ph);
      pu.uKnee.value.z = fm.uExposure.value / 0.6;
      this._draw(this.preMat, t.bloom[0]);
      for (let i = 1; i < t.bloom.length; i++) {
        const du = this.downMat.uniforms;
        du.tSrc.value = t.bloom[i - 1].texture;
        du.uTexel.value.set(1 / t.bloom[i - 1].width, 1 / t.bloom[i - 1].height);
        this._draw(this.downMat, t.bloom[i]);
      }
      for (let i = t.bloom.length - 1; i > 0; i--) {
        const uu = this.upMat.uniforms;
        uu.tSrc.value = t.bloom[i].texture;
        uu.uTexel.value.set(1 / t.bloom[i].width, 1 / t.bloom[i].height);
        // Added onto what is already in the level below rather than replacing
        // it, so the pyramid sums as it collapses.
        this._draw(this.upMat, t.bloom[i - 1], false);
      }
      fm.tBloom.value = t.bloom[0].texture;
    }

    /* --- film --- */
    fm.tScene.value = src;
    fm.uTexel.value.set(1 / t.pw, 1 / t.ph);
    fm.uCoC.value.set(cocScale, this.focus, this.maxFarPx);
    fm.uEnable.value.set(doDof ? 1 : 0, doBloom ? 1 : 0, this.want.grade ? 1 : 0);
    fm.uGrain.value.x = this.want.grain ? 9.0 : 0;
    /* Advanced per frame so the grain moves. A static pattern over a moving
     * image is fixed-pattern sensor noise, which is a different and much more
     * synthetic-looking thing than film grain — and the eye locks onto it
     * immediately because it is the only part of the picture not parallaxing.
     * The counter is deterministic per capture sequence, so two builds shot by
     * the same harness still get the same pattern in the same shot. */
    fm.uGrain.value.y = (this._frame % 64) * 1.7;
    fm.uDebug.value = this.bypass ? 4 : this.debug;
    /* Switched by swapping whole coefficient sets rather than by a branch in
     * the shader, so that "grade off" is genuinely the pre-grade image and the
     * cost measured against it is the cost of the arithmetic. It is also the
     * only way back to the exact curve the project's screenshot archive was
     * judged through, which is worth being able to reach. */
    const G = this.want.grade ? GRADE : NEUTRAL;
    fm.uSlope.value.copy(G.slope);
    fm.uOffset.value.copy(G.offset);
    fm.uPower.value.copy(G.power);
    fm.uCross.value.copy(G.cross);
    fm.uPrint.value.copy(G.print);
    fm.uShadowTint.value.copy(G.shadow);
    fm.uHighTint.value.copy(G.high);
    fm.uVignette.value.x = G.vignette;
    this._draw(this.finalMat, null);
  }

  dispose() {
    if (this._targets) this._free(this._targets);
    this.quad.geometry.dispose();
    for (const k in (this._mats || {})) this._mats[k].dispose();
  }
}
