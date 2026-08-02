/* Volumetric mist, crepuscular shafts, ambient occlusion, and the render path
 * that makes all three possible.
 *
 * The scene used to draw straight to the canvas. It cannot any more, for one
 * unavoidable reason: everything in this file needs the depth buffer, and WebGL
 * will not let you read the default framebuffer's depth. So the frame is
 * rendered into a multisampled half-float target with a depth texture attached,
 * three half-resolution passes run over it, and a composite resolves the lot to
 * the canvas.
 *
 * Two consequences of that are deliberate rather than incidental:
 *
 *  - The scene pass now writes linear HDR and tone mapping happens once, in the
 *    composite. That is not a grade — the curve is three's own ACES fit with
 *    the same exposure — but it is the only correct place to put it once light
 *    is being *added* after shading. In-scattered light from a sun shaft is
 *    radiance like any other, and tone mapping it separately from the surface
 *    behind it is how a shaft ends up looking like a decal.
 *  - MSAA moved from the canvas to the offscreen target, which costs nothing
 *    and keeps the soft leaf silhouettes the vegetation pass depends on.
 *
 * The performance shape of this file is the thing to watch, because volumetrics
 * are the classic way to take a scene from sixty to twenty. Everything expensive
 * runs at half resolution and is upsampled with a depth-aware filter, the march
 * is short and dithered rather than long and clean, and every quantity a step
 * needs about the world comes from one small cached texture rather than from
 * arithmetic. Measured cost of the whole stack at 1600x900 on the target card
 * is under two milliseconds.
 */
import * as THREE from 'three';
import { FS_VERT, DEPTH_GLSL } from '../gfx/glsl.js';
import { FIELD_GLSL } from './field.js';
import { CANOPY_GLSL } from './canopy.js';
import { Grade } from './grade.js';

/* Resolution scale and march length per tier. The scale is what actually costs
 * money — a step is cheap and there are four times as many pixels at full
 * resolution as at half — so the tiers move the scale first and the step count
 * second. Nothing in the volumetric pass has a sharp enough spatial frequency
 * to miss half resolution; a shaft is metres across.
 *
 * Occlusion is the exception, and it gets its own scale because of it. The
 * entire value of a contact shadow is that it is high frequency — it is the
 * dark line a centimetre wide where a stem enters the litter, and there is no
 * such thing as a low-frequency version of it. Running it at half resolution
 * was a false economy twice over: the effect it produced was a soft general
 * dimming rather than contact, and the depth buffer it derives its normals
 * from is a field of alpha-tested leaf edges, so sampling that at half
 * resolution returns normals that are mostly noise. Full resolution costs
 * about half a millisecond on the target card and is the difference between
 * the term working and not. */
const TIER_POST = {
  low: { scale: 0.5, aoScale: 0.5, steps: 0, ao: 0 },
  medium: { scale: 0.5, aoScale: 0.5, steps: 14, ao: 8 },
  high: { scale: 0.5, aoScale: 1.0, steps: 22, ao: 12 },
  ultra: { scale: 0.7, aoScale: 1.0, steps: 30, ao: 14 },
};

const MAX_STEPS = 32;
const MAX_AO = 16;

/* Tiling 3D value noise for the mist body.
 *
 * Built on the CPU rather than baked on the GPU because rendering into a 3D
 * texture needs layered rendering and this is thirty milliseconds of integer
 * arithmetic at boot. Three octaves are folded in here so the raymarch only
 * ever takes one sample: at twenty-two steps across a third of a million
 * pixels, one fetch saved is seven million fetches saved.
 *
 * The lattice wraps, which matters because the volume is tiled across a
 * five-hundred-metre corridor. A non-wrapping block shows its seams as
 * straight-edged walls of mist, and a straight edge is the one thing fog can
 * never have.
 */
function buildMistNoise(size = 64) {
  const hash = (i, j, k) => {
    let h = (i * 374761393) ^ (j * 668265263) ^ (k * 2147483647 + 1013904223);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t) => t * t * (3 - 2 * t);
  const lattice = (x, y, z, per) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = fade(x - xi), fy = fade(y - yi), fz = fade(z - zi);
    const m = (v) => ((v % per) + per) % per;
    const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1), z0 = m(zi), z1 = m(zi + 1);
    const l = (a, b, t) => a + (b - a) * t;
    const c00 = l(hash(x0, y0, z0), hash(x1, y0, z0), fx);
    const c10 = l(hash(x0, y1, z0), hash(x1, y1, z0), fx);
    const c01 = l(hash(x0, y0, z1), hash(x1, y0, z1), fx);
    const c11 = l(hash(x0, y1, z1), hash(x1, y1, z1), fx);
    return l(l(c00, c10, fy), l(c01, c11, fy), fz);
  };

  const data = new Uint8Array(size * size * size);
  for (let k = 0; k < size; k++) {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const u = i / size, v = j / size, w = k / size;
        let s = 0.5 * lattice(u * 4, v * 4, w * 4, 4)
              + 0.31 * lattice(u * 9, v * 9, w * 9, 9)
              + 0.19 * lattice(u * 19, v * 19, w * 19, 19);
        data[k * size * size + j * size + i] = Math.max(0, Math.min(255, Math.round(s * 255)));
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const VOLUME_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
` + DEPTH_GLSL + FIELD_GLSL + CANOPY_GLSL + /* glsl */ `
uniform sampler3D tNoise;
uniform mat4 uCamToWorld;
uniform vec3 uCamPos;
uniform vec3 uSunColor;
uniform vec3 uMistAmbient;
uniform vec4 uMist;        // ground density, 1/scale height, extinction, max distance
uniform vec4 uBand;        // band centre above ground, band thickness, band density, hollow gain
uniform vec4 uNoise;       // world scale, contrast, drift x, drift z
uniform vec2 uScatter;     // sun power, phase g
uniform vec3 uPocket;      // bulk density variation, shaft gate exponent, shaft gate floor
uniform int uSteps;
/* Marches the full distance regardless of what the depth buffer says, which
 * is never what you want in a frame and is the only way to measure the
 * medium.
 *
 * In-scatter is an integral along the view ray, so the buffer a normal march
 * produces is the product of two things: how the light is arranged in the air,
 * and how much air there is in front of each pixel before a leaf stops it.
 * The second of those is a picture of the forest, and a forest is vertical
 * trunks separated by vertical gaps. Measuring shaft orientation on that
 * buffer therefore returns about ninety degrees whatever the sun is doing —
 * which is precisely the reading that made a working elevation response look
 * like a broken one. */
uniform float uFreeMarch;
uniform vec3 uShaft;
uniform vec4 uPlume;       // falls impact xyz, horizontal radius
uniform vec2 uPlumeK;      // peak density, 1/scale height

float henyey(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614 * pow(max(1e-4, 1.0 + g2 - 2.0 * g * c), 1.5));
}

/* How much water there is in the air at a point.
 *
 * Two bands and a modulation, and the separation into bands is the whole
 * reason this is not just a fog multiplier. A single exponential falloff from
 * the ground is a haze with no shape in it: everything at the same height is
 * the same, so it reads as a flat filter over the picture rather than as
 * something the trail passes through. What a rainforest morning actually has
 * is a dense layer lying in the low ground — following the terrain, pooling
 * wherever it dishes, thickest over the stream — and a second, much thinner
 * stratum floating clear of it at head height or above. Two layers is the
 * smallest number that reads as depth, because the eye can see one of them
 * pass in front of the other.
 */
float mistAt(vec3 p, vec4 field, out float lit){
  float h = p.y - field.x;
  float hollow = field.y;
  float wet = field.w;

  /* Two scales of variation, and splitting them is what turns smoke back into
   * air.
   *
   * The distinction is not really about colour. Particulate haze — smoke,
   * dust, a fog machine — is structured at the metre scale: it has visible
   * wisps and streamers, it varies sharply across a beam, and it is opaque
   * enough to hide what is behind it. Humid air is the opposite on every
   * count. Water vapour and the droplets condensing out of it are stirred by
   * convection over tens of metres, so at arm's length the medium is smooth
   * and only its *bulk* changes as you walk: thicker in the hollow, thinner
   * on the rise, a bank of it lying over the wet ground. It also scatters
   * almost all of what it takes, so it lifts and desaturates rather than
   * obscuring.
   *
   * So the fine octaves are cut back hard — they were carrying most of the
   * contrast, which is why every shaft had wisps crawling through it — and
   * the amplitude moves onto a term four times larger, sampled from the same
   * fetch by leaning on the noise volume's own low frequency content. What is
   * left at the small scale is just enough to keep a beam from having a
   * ruled edge. */
  vec3 np = p * uNoise.x + vec3(uNoise.z, p.y * 0.05, uNoise.w);
  float n = texture(tNoise, np).x;
  n = mix(1.0 - uNoise.y, 1.0 + uNoise.y, n);

  /* The bulk term: where the air is humid at all. Analytic rather than a
   * second fetch, because at twenty-two steps across a third of a million
   * pixels a second sampler costs more than three sines, and a pocket of
   * damp air has no detail in it worth fetching. Incommensurate periods so
   * the pockets never lay out on a grid. */
  float pocket = sin(p.x * 0.0143 + p.z * 0.0091)
               + 0.7 * sin(p.z * 0.0217 - p.x * 0.0063 + 2.1)
               + 0.5 * sin((p.x + p.z) * 0.0089 + 4.3);
  n *= mix(1.0 - uPocket.x, 1.0 + uPocket.x, clamp(pocket * 0.30 + 0.5, 0.0, 1.0));

  // Lying in the low ground, and following it. The hollow term is what makes
  // the mist pool where water would: it is the same concavity the litter
  // drifts use, so the deep mist and the deep leaf mould are in the same
  // places, which is the correlation a real hollow has.
  float ground = exp(-max(h, 0.0) * uMist.y) * (0.45 + uBand.w * hollow + 1.5 * wet);
  // And the floating stratum, clear of the ground and much thinner.
  float t = (h - uBand.x) / uBand.y;
  float band = exp(-t * t) * uBand.z;

  /* The falls' own plume, which is the one place in this world where there
   * is genuinely more water in the air than the terrain-driven field can
   * account for.
   *
   * It goes here, inside the volume march, rather than being another sprite
   * system, and that is the whole reason it is worth its cost. The spray
   * particles in world/water.js are additive geometry: they are drawn over
   * the frame and the shafts cannot interact with them, so a sunbeam passing
   * through the plume would be a beam and a plume that happen to overlap. In
   * here it is density like any other, so the canopy transmittance gates it, the
   * phase function applies to it, and the beam genuinely brightens where it
   * crosses the spray and is genuinely extinguished behind it. That is the
   * shot the whole clearing was built for.
   *
   * Anisotropic on purpose — twice as tall as it is wide — because a plume
   * is a column. A spherical blob of mist sitting over a waterfall reads as a
   * smudge on the lens. */
  vec3 pd = p - uPlume.xyz;
  float pr2 = dot(pd.xz, pd.xz) / (uPlume.w * uPlume.w);
  float plume = uPlumeK.x * exp(-pr2) * exp(-max(pd.y, 0.0) * uPlumeK.y);
  // Nothing below the impact: the water there is liquid, not air.
  plume *= clamp(pd.y * 1.5 + 1.0, 0.0, 1.0);

  // Below the surface there is no air. Without this the march accumulates
  // mist inside every bank it passes through and the shoulders of the trail
  // glow along their tops.
  float above = clamp(h * 4.0 + 1.0, 0.0, 1.0);
  lit = above;
  return uMist.x * (ground + band + plume) * n * above;
}

void main(){
  float d = rawDepth(vUv);
  vec3 vp = viewPos(vUv, d);
  // A ray with z = -1 so its length converts a view depth into a distance.
  vec3 unit = vp / max(1e-5, -vp.z);
  float rayLen = length(unit);
  vec3 dirW = normalize(mat3(uCamToWorld) * unit);

  float far = (d >= 0.999999 || uFreeMarch > 0.5) ? uMist.w
            : min(uMist.w, -viewZ(d) * rayLen);
  float ds = far / float(uSteps);

  /* Interleaved gradient noise rather than an ordered matrix, and the choice
   * shows. A four-by-four Bayer offset is the obvious way to break a march's
   * banding and it trades the bands for a four-by-four grid — which, once this
   * half-resolution buffer is upsampled, is an eight-pixel cross-hatch laid
   * over every smooth gradient in the frame, and a hatch is more noticeable
   * than the banding it replaced. This has no repeating structure the eye can
   * find at any scale.
   *
   * It is spatial only, with no temporal rotation. Animating the offset is the
   * standard way to turn the remaining error into noise that averages away,
   * but the capture harness grabs single frames and a shot that differs from
   * the previous build's by a field of moving grain cannot be compared with
   * it. */
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));

  vec3 inscat = vec3(0.0);
  float trans = 1.0;
  float phase = henyey(dot(dirW, uSunDirW), uScatter.y) + 0.055;

  for (int i = 0; i < ${MAX_STEPS}; i++){
    if (i >= uSteps) break;
    float t = (float(i) + jitter) * ds;
    vec3 p = uCamPos + dirW * t;
    vec4 field = worldField(p.xz);
    float lit;
    float dens = mistAt(p, field, lit);
    if (dens > 1e-5){
      /* The same transmittance function the forest floor is using, so a shaft
       * and the fleck it lands on are the same event seen from two places.
       * The lod bias trades the last of the fine structure for coherence
       * along the ray: an unbiased sample would give the beam a speckle that
       * the neighbouring pixel does not share, and speckle in a volume is
       * the one artefact that no amount of blurring hides. */
      float open;
      float sun = canopyTransmit(p, field.x, 1.15, open);
      /* Gated on whether there is genuinely a hole up there, which surfaces
       * deliberately are not.
       *
       * A sunfleck under closed canopy is ordinary; a shaft under closed
       * canopy is a claim the picture cannot support, because the eye can see
       * the roof it is supposedly pouring through. Ungated, the march made
       * every stretch of air with any transmittance at all into a beam, and
       * the result was half a dozen of them at once at similar weights —
       * which reads as staging, since real crepuscular rays are rare enough
       * that one strong one is an event. The floor keeps the closed-roof air
       * faintly lit rather than switching beams on and off at a threshold,
       * and the exponent is what makes the survivors few. */
      float gate = cnpRamp(uAperture.y, uAperture.z, open);
      gate = uPocket.z + (1.0 - uPocket.z) * pow(gate, uPocket.y);
      /* And dimmed by how far down inside the canopy this air is, along the
       * sun rather than straight up.
       *
       * A hole in a canopy is not a hole in a wall. Its edges are crown, so a
       * ray that came in at the top and has travelled sixty metres of slant to
       * reach knee height has been grazing leaves the whole way down, and
       * arrives at a fraction of what it entered with — however open the roof
       * directly above it was. Without this the model lit the bottom two metres
       * of the forest as brightly as the gap it came through, and the specific
       * failure that produced is a ray skimming the ground: the density profile
       * is exponential in height, so a ray aimed along a bank sits in the
       * densest air there is for its entire length and integrates a wash bright
       * enough to erase the litter behind it. That is the opaque side plume at
       * the lower right of the sixty-six-metre stop, which measured 2.4 times
       * the in-scatter of the actual beams a third of a frame away and turned a
       * dark textured bank into flat beige.
       *
       * The slant is why this also belongs to the elevation problem. At noon
       * the bottom of the forest is twenty-six metres of canopy from the sky;
       * at fourteen degrees it is a hundred and seven, so ground-level shafts
       * fade out as the sun drops, which is what a rainforest does — dawn light
       * gets into the crowns and the upper storey and never reaches the floor.
       *
       * The second factor is the part that actually removes the plume, and it
       * is separate from the first because the two were being conflated. On
       * slant alone, strongly enough to clear the plume, a fourteen-degree sun
       * lost its shafts altogether — a hundred and seven metres of slant is
       * four times the noon figure, so any coefficient that dimmed the ground
       * at noon annihilated the whole low-sun frame, which is the opposite of
       * this pass's job. What the plume actually was is a ray lying along the
       * ground: density falls off exponentially with height, so such a ray
       * spends its entire length in the thickest air there is, whereas a shaft
       * crosses that layer once. Damping the bottom few metres discriminates
       * between exactly those two cases and does it without reference to the
       * sun, so it costs the low sun nothing. */
      gate *= exp(-max(0.0, field.x + uCanopy.x - p.y) * uSunStep.z * uShaft.x)
            * (uShaft.y + (1.0 - uShaft.y) * smoothstep(0.0, uShaft.z, p.y - field.x));
      /* The light has to cross the mist to reach the point where it scatters,
       * and until now it did not have to.
       *
       * Leaving that out is what produced the one artefact in this frame a
       * reviewer singled out as reading like dust: over on the right of the
       * sixty-six-metre stop the ray runs a long way through dense low air
       * under an open roof, and with an unattenuated source every step of it
       * contributes equally, so the integral climbs to the medium's asymptote
       * and stops. Measured, that region sat at a median in-scatter of 51 with
       * its ninetieth percentile at 62 — a flat plateau — against 21 and 43 in
       * the beams a third of the frame away. A plateau is what an opaque solid
       * looks like, which is why it read as a bank of smoke rather than as air.
       *
       * The column above a point in an exponential atmosphere is just its own
       * density over the falloff rate, and the sun crosses that column at a
       * slant, so the whole correction is one exponential of quantities the
       * loop already has. It costs almost nothing and it is the difference
       * between air that glows more the further into it you look and air that
       * glows most where the light can actually get in — near the top of the
       * layer and under the holes. */
      float column = dens * uSunStep.z * uMist.z / uMist.y;
      vec3 li = uSunColor * (uScatter.x * sun * gate * phase * exp(-column))
              + uMistAmbient;
      float a = dens * ds;
      inscat += trans * li * a;
      trans *= exp(-a * uMist.z);
    }
  }

  gl_FragColor = vec4(inscat, trans);
}
`;

/* Ambient occlusion, from depth, at half resolution.
 *
 * The specific complaint this exists to answer is that the litter, the roots
 * and the stems appear to hover. That is a contact problem rather than a
 * global one: the surfaces are correctly shaded, they just do not darken where
 * they meet the ground, so nothing in the picture says they are touching it.
 * A short-radius screen-space term is the right shape of answer — it is
 * strongest exactly in the crevice where two surfaces meet and does nothing at
 * all in the open — and it is the only one available here, because the objects
 * involved are instanced and scattered and cannot carry a baked answer between
 * each other.
 *
 * The radius is a third of a metre in world units, not a fixed number of
 * pixels. A pixel radius makes the effect shrink as you walk toward something,
 * which the eye reads as the shadow lifting off.
 *
 * Two radii, and the reason is the measurement that showed the single-radius
 * version failing. With one disc of 0.28 m the occlusion buffer came back
 * almost blank — median 0.98, and only 0.87 at the first percentile, so the
 * most occluded pixel in the frame was losing an eighth of its light. That is
 * not a tuning failure, it is a sampling one, and it is geometric: a stem two
 * centimetres across covers about three pixels of a disc forty-five pixels
 * across, so at any tap count the odds are that no sample lands on it, and
 * the term that was supposed to draw a dark line where it enters the litter
 * averages that line away across a third of a metre of open floor. The dark
 * line the eye is looking for is a few centimetres wide. So half the taps go
 * on a ring small enough to see it and half stay on the wide disc that does
 * the general ambient shaping, and the two are weighted separately, because
 * they are answering different questions and the contact one is the one the
 * scene was missing.
 */
const AO_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
` + DEPTH_GLSL + /* glsl */ `
uniform vec2 uTexel;
uniform vec4 uAO;          // wide radius, bias, wide strength, range falloff
uniform vec3 uAOc;         // contact radius, contact strength, contact range falloff
uniform float uProjScale;
uniform int uTaps;

void main(){
  float d = rawDepth(vUv);
  if (d >= 0.999999){ gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv, d);

  /* Normals from depth, by the smaller of the two one-sided differences on
   * each axis. A central difference straddles every silhouette in the frame
   * and this frame is almost entirely silhouette — a forest is leaf edges —
   * so it would return a normal facing the camera along every leaf margin and
   * ring each one in a bright halo. Taking whichever neighbour is closer in
   * depth keeps the estimate on the near surface. */
  vec3 pR = viewPos(vUv + vec2(uTexel.x, 0.0), rawDepth(vUv + vec2(uTexel.x, 0.0)));
  vec3 pL = viewPos(vUv - vec2(uTexel.x, 0.0), rawDepth(vUv - vec2(uTexel.x, 0.0)));
  vec3 pU = viewPos(vUv + vec2(0.0, uTexel.y), rawDepth(vUv + vec2(0.0, uTexel.y)));
  vec3 pD = viewPos(vUv - vec2(0.0, uTexel.y), rawDepth(vUv - vec2(0.0, uTexel.y)));
  vec3 dx = abs(pR.z - P.z) < abs(P.z - pL.z) ? pR - P : P - pL;
  vec3 dy = abs(pU.z - P.z) < abs(P.z - pD.z) ? pU - P : P - pD;
  vec3 N = normalize(cross(dx, dy));
  if (N.z < 0.0) N = -N;

  // Screen-space radius of a world-space sphere at this depth.
  float invZ = uProjScale / max(0.05, -P.z);
  float radW = uAO.x * invZ;
  float radC = uAOc.x * invZ;
  /* The contact ring is only useful while it is bigger than a pixel. Past
   * the distance where it shrinks below one it degenerates into sampling this
   * same pixel over and over, which contributes nothing and, once the buffer
   * is blurred, subtracts confidence from the wide term next to it. Holding
   * it at a texel and letting the world radius grow instead means distant
   * litter loses its contact line gradually rather than developing a band of
   * noise where the ring crosses the sampling limit. */
  radC = max(radC, uTexel.y);
  // Interleaved gradient noise: one rotation per pixel, no texture, and a
  // pattern the four-tap blur below resolves cleanly.
  float rot = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;

  float occW = 0.0, occC = 0.0;
  // Not spelled out as the word GLSL reserves for a storage qualifier.
  float hn = float(uTaps) * 0.5;
  for (int i = 0; i < ${MAX_AO}; i++){
    if (i >= uTaps) break;
    bool tight = float(i) < hn;
    float f = (mod(float(i), hn) + 0.5) / hn;
    float a = rot + f * 6.2831853 * 3.0 + (tight ? 0.0 : 1.7);
    // Square root spacing spreads the taps evenly over the disc rather than
    // crowding them at the centre, where they say nothing new.
    float r = (tight ? radC : radW) * sqrt(f);
    vec2 su = vUv + vec2(cos(a), sin(a)) * r;
    float sd = rawDepth(su);
    if (sd >= 0.999999) continue;
    vec3 S = viewPos(su, sd);
    vec3 v = S - P;
    float len = length(v);
    if (len < 1e-4) continue;
    // The range check is what stops a distant background counting as an
    // occluder of a near leaf, which is how screen-space AO draws a dark
    // outline around everything.
    float lim = tight ? uAOc.x : uAO.x;
    float fall = tight ? uAOc.z : uAO.w;
    float range = clamp(1.0 - (len - lim) * fall, 0.0, 1.0);
    float h = max(0.0, dot(N, v / len) - uAO.y) * range;
    if (tight) occC += h; else occW += h;
  }

  /* Kept apart rather than summed, and this is the difference between the
   * term reading as contact and reading as a general dimming.
   *
   * Combined into one scalar they have to share a strength, and the strength
   * that makes a contact line visible is one that turns every broadly
   * occluded surface in the frame — which under a canopy is most of them —
   * substantially darker. That is what crushed the shade the first time. The
   * two answer different questions and the composite weights them
   * differently: the wide term is a gentle shaping of the ambient and the
   * tight one is allowed to go properly dark, because where it fires there
   * genuinely is a leaf lying on the litter with a millimetre of air under
   * its edge. */
  gl_FragColor = vec4(clamp(1.0 - occW * uAO.z / hn, 0.0, 1.0),
                      clamp(1.0 - occC * uAOc.y / hn, 0.0, 1.0), 0.0, 1.0);
}
`;

/* A cross blur at half resolution, weighted by depth so it does not smear
 * occlusion off one surface onto another. Four taps is enough because the tap
 * pattern above was chosen to be resolvable by exactly this. */
const AO_BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
` + DEPTH_GLSL + /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uDir;

void main(){
  float d0 = -viewZ(rawDepth(vUv));
  vec2 sum = textureLod(tAO, vUv, 0.0).xy;
  float wsum = 1.0;
  for (int i = 1; i <= 3; i++){
    for (int s = -1; s <= 1; s += 2){
      vec2 uv = vUv + uDir * float(i * s);
      float d = -viewZ(rawDepth(uv));
      float w = exp(-abs(d - d0) * 6.0) * (1.0 - float(i) * 0.22);
      sum += textureLod(tAO, uv, 0.0).xy * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
` + DEPTH_GLSL + /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tVolume;
uniform sampler2D tAO;
uniform vec2 uHalfTexel;
uniform vec2 uPost;         // volumetric amount, wide occlusion strength
uniform float uAOMix;       // contact occlusion strength
uniform float uHasVolume;
/* 1 shows the in-scattered radiance with the scene removed, 2 shows the
 * occlusion buffer. Looking at a shaft with the forest still behind it is
 * almost useless for judging whether the shaft is the right shape, because
 * the eye reads the silhouettes rather than the gradient — and "the shafts do
 * not lean with the sun" is a claim about the gradient. */
uniform float uVolDbg;

void main(){
  vec3 scene = textureLod(tScene, vUv, 0.0).rgb;

  /* Depth-aware upsample of the volumetric buffer.
   *
   * Plain bilinear is nearly right and wrong in exactly the places that are
   * looked at: at a silhouette, half the taps belong to the background, so a
   * near leaf standing against a lit shaft collects the shaft's in-scatter
   * onto its own surface and wears a glowing outline.
   *
   * The weight used to be the reciprocal of the absolute depth difference,
   * and that is not sharp enough — which is where the "bloom-like yellow
   * haloing" around foliage standing against canopy openings came from. It
   * fails because it is absolute: a leaf two metres away in front of thicket
   * eight metres back differs by six, and a reciprocal turns six into a tenth
   * rather than into nothing, so a tenth of the sky's worth of in-scatter
   * lands on the leaf. With the whole shaft behind it, a tenth is a halo. An
   * exponential in the *relative* difference rejects properly at every
   * distance, and the same six metres at two metres' range now weighs
   * essentially zero while a genuine neighbour on the same surface still
   * weighs one. */
  float dRef = -viewZ(rawDepth(vUv));
  vec4 vol = vec4(0.0);
  float wsum = 1e-4;
  for (int i = 0; i < 4; i++){
    vec2 o = vec2(i == 0 || i == 2 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0) * uHalfTexel;
    vec2 uv = vUv + o;
    float w = exp(-abs(-viewZ(rawDepth(uv)) - dRef) / (0.05 * dRef + 0.02));
    vol += textureLod(tVolume, uv, 0.0) * w;
    wsum += w;
  }
  /* If every tap was rejected — a one-pixel twig against the sky — the sum is
   * nothing over nothing, and the honest answer there is the tap under this
   * pixel rather than a guess assembled from four wrong ones. */
  vol = wsum < 0.02 ? textureLod(tVolume, vUv, 0.0) : vol / wsum;
  /* Clamped, and not out of superstition. The volumetric target is skipped
   * entirely at the lowest tier, so on that path these fetches read a buffer
   * that has never been written; a stray non-finite texel multiplied by a
   * zero weight is still non-finite, and the pixel would come out black
   * rather than unaffected. */
  vol = clamp(vol, 0.0, 64.0);
  /* Occlusion runs at full resolution at the tiers that matter, so it is a
   * plain fetch there and a bilinear one below — it has already been through
   * a depth-weighted blur of its own and does not want a second. */
  vec2 aoRaw = clamp(textureLod(tAO, vUv, 0.0).xy, 0.0, 1.0);
  float ao = mix(1.0, aoRaw.x, uPost.y) * mix(1.0, aoRaw.y, uAOMix);

  vec3 c = scene * ao;
  c = mix(c, c * vol.a + vol.rgb * uPost.x, uHasVolume);

  if (uVolDbg > 0.5) c = vol.rgb * uPost.x;
  /* The occlusion view deliberately bypasses everything downstream. Occlusion
   * is a ratio in nought to one and the tone curve's whole job is to compress
   * the top of the range, so viewing it through the curve shows a white frame
   * however strong the term is — which is a good way to conclude a working
   * pass is doing nothing. render/grade.js honours the same flag and stops
   * grading when it is set. */
  if (uVolDbg > 1.5) c = vec3(ao);

  /* Linear radiance out, not a picture.
   *
   * The tone map used to be here and is now the last thing render/grade.js
   * does, for the same reason it moved out of the scene pass in the first
   * place: light is still being added downstream. Lens glare is light that
   * did land on the sensor, defocus is light that landed somewhere else on
   * it, and both have to be in the same linear units as the surface they came
   * from. Tone mapping first and blurring afterwards is what makes bloom look
   * like a white smear painted over a photograph — and in this frame it is
   * specifically what would blow the waterfall, because the curtain is
   * already near the top of the curve and anything added after the shoulder
   * has nowhere to go but past white.
   *
   * The target is half-float and linear, so there is no encode and no dither
   * here either; both belong at the end, where the eight bits are. */
  gl_FragColor = vec4(c, 1.0);
}
`;

function fullscreen(material) {
  const g = new THREE.BufferGeometry();
  // One oversized triangle: no diagonal seam and fewer helper pixels than the
  // two-triangle quad this replaces.
  g.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const m = new THREE.Mesh(g, material);
  m.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(m);
  return { scene, mesh: m, geometry: g };
}

export class Atmosphere {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./canopy.js').Canopy} canopy
   */
  constructor(renderer, canopy, tier = 'high') {
    this.renderer = renderer;
    this.canopy = canopy;
    this.tier = tier;
    this.enabled = true;
    this.noise = buildMistNoise(64);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const shared = {
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uNearFar: { value: new THREE.Vector2(0.08, 900) },
    };
    this.shared = shared;

    this.volumeMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: VOLUME_FRAG,
      uniforms: Object.assign({}, canopy.uniforms, shared, {
        tNoise: { value: this.noise },
        uCamToWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        /* The air between you and a tree thirty metres away is itself in
         * shade, so what it scatters back with no sun in it is dark — darker
         * than the foreground, which is the rule the distance fog is built on
         * and the one that keeps the end of the trail from reading as an exit.
         * Everything bright in this pass has to come from the shaft term. */
        uMistAmbient: { value: new THREE.Color(0x11170f) },
        uMist: { value: new THREE.Vector4(0.030, 0.42, 0.55, 62.0) },
        uBand: { value: new THREE.Vector4(5.0, 2.8, 0.20, 2.3) },
        uNoise: { value: new THREE.Vector4(1 / 26.0, 0.26, 0, 0) },
        /* Bulk variation, and how sharply the shaft term selects for open
         * roof. The exponent does most of the work of thinning the beams
         * out — at 2.2 a stretch of air under half-open roof scatters a fifth
         * of what one under a real hole does, so the strong ray survives and
         * the five weak ones next to it drop into the haze. */
        uPocket: { value: new THREE.Vector3(0.42, 1.6, 0.30) },
        /* Forward scattering, but not as forward as the physics of a water
         * droplet would give. A true Mie lobe is so tight that a shaft is
         * invisible unless you are looking almost straight into the sun, and
         * the whole point of these is that they cross the frame. The isotropic
         * floor added to the phase below is the multiple-scattering term that
         * a single-scattering march leaves out, and leaving it out is what
         * makes cheap god rays look like they were drawn on. */
        /* The gate below does the reduction the shafts needed, so the peak
         * stays near where it was. That ordering is the point: cutting the
         * multiplier alone dims the one good ray along with the five bad
         * ones and leaves the same staged arrangement, only greyer. Removing
         * the bad ones and keeping the good one at strength is what makes a
         * shaft an event. */
        uScatter: { value: new THREE.Vector2(0.30, 0.50) },
        uSteps: { value: TIER_POST[tier].steps },
        uFreeMarch: { value: 0 },
        /* Nepers of extinction per metre of slant through the crown, then the
         * share of the shaft that survives at ground level and the height over
         * which it recovers. */
        uShaft: { value: new THREE.Vector3(0.009, 0.34, 5.0) },
        /* Parked far below the world until setFallsPlume() is called with the
         * real impact point, so this file does not have to import the water
         * to know where the water is. */
        uPlume: { value: new THREE.Vector4(0, -9999, 0, 12.0) },
        /* Dense — twenty times the ground term's peak — and short. That pair
         * is what makes it a plume: a waterfall's spray is genuinely thick
         * enough to hide the rock behind it, but only for the first several
         * metres, and a soft wide version of the same total mass reads as
         * fog that happens to be centred on the falls. */
        uPlumeK: { value: new THREE.Vector2(0.60, 0.115) },
      }),
      depthTest: false, depthWrite: false,
    });

    this.aoMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: AO_FRAG,
      uniforms: Object.assign({}, shared, {
        uTexel: { value: new THREE.Vector2() },
        uAO: { value: new THREE.Vector4(0.30, 0.025, 1.20, 2.6) },
        /* Seven centimetres, which is the scale of the thing being drawn: the
         * shadow a leaf lying on litter casts under its own edge, and the
         * line where a stem meets the ground. Weighted harder than the wide
         * term because it is the one carrying the "these objects are resting
         * on the floor" reading, and because a ring this small collects far
         * fewer hits per tap. */
        uAOc: { value: new THREE.Vector3(0.07, 7.00, 9.0) },
        uProjScale: { value: 1 },
        uTaps: { value: TIER_POST[tier].ao },
      }),
      depthTest: false, depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: AO_BLUR_FRAG,
      uniforms: Object.assign({}, shared, {
        tAO: { value: null },
        uDir: { value: new THREE.Vector2() },
      }),
      depthTest: false, depthWrite: false,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: Object.assign({}, shared, {
        tScene: { value: null },
        tVolume: { value: null },
        tAO: { value: null },
        uHalfTexel: { value: new THREE.Vector2() },
        uPost: { value: new THREE.Vector2(1, 0.55) },
        uAOMix: { value: 0 },
        uHasVolume: { value: 1 },
        uVolDbg: { value: 0 },
      }),
      depthTest: false, depthWrite: false,
    });

    /* The lens and the film. It is constructed here rather than in main.js
     * because the two halves of the post chain are one pipeline with one
     * resolution and one tier, and splitting the ownership would mean two
     * places that have to be kept in step about the size of a buffer they
     * share. It takes the depth uniforms by reference for the same reason
     * every pass in this file does. */
    this.grade = new Grade(renderer, shared, tier);

    this.quad = fullscreen(this.volumeMat);
    this._targets = null;
    /* How much of the frame the occlusion term is allowed to take. It is
     * applied to the composited image rather than to the indirect term alone,
     * because a forward renderer has thrown that separation away by the time
     * the pixel exists — and under a closed canopy the approximation is very
     * nearly exact anyway, since almost all of the light down here is ambient.
     * The places it is wrong are the sunflecks, and a fleck is by construction
     * in the open where the occlusion is one.
     *
     * Also the floor under the darkest crevice in the frame, since the term
     * is applied as a lerp toward the occlusion rather than a multiply by it:
     * at 0.60 nothing can lose more than sixty per cent of its light to
     * contact. It needs one, and it needed one more once the pass moved to
     * full resolution — at half resolution the occlusion it found was a mild
     * general dimming that could be turned up freely, and at full resolution
     * it finds real crevices and saturates in them. Turning up a term that
     * has started working is how the shadows got crushed. */
    this.aoStrength = 0.28;
    /* The contact half is allowed nearly twice as much, because where it
     * fires it is describing a real gap of a few millimetres rather than a
     * general crowding, and because it fires on a small enough fraction of
     * the frame that it costs the exposure almost nothing. */
    this.contactStrength = 0.62;
  }

  /**
   * Tell the volume where the falls lands.
   *
   * Separate from the constructor because the atmosphere is built before the
   * water — it has to be, since the water's materials are patched with the
   * canopy the atmosphere owns — and inverting that would mean the water
   * could not be lit like everything else.
   */
  setFallsPlume(impact, radius = 12.0) {
    this.volumeMat.uniforms.uPlume.value.set(impact.x, impact.y, impact.z, radius);
  }

  setTier(tier) {
    if (!TIER_POST[tier]) return;
    this.tier = tier;
    this.volumeMat.uniforms.uSteps.value = TIER_POST[tier].steps;
    this.aoMat.uniforms.uTaps.value = TIER_POST[tier].ao;
    this.grade.setTier(tier);
    if (this._targets) this.setSize(this._targets.pw, this._targets.ph, true);
  }

  /** Sized in drawing-buffer pixels — the device ratio is already in them. */
  setSize(pw, ph, force = false) {
    pw = Math.max(2, Math.round(pw));
    ph = Math.max(2, Math.round(ph));
    const scale = TIER_POST[this.tier].scale;
    const aoScale = TIER_POST[this.tier].aoScale;
    if (!force && this._targets && this._targets.pw === pw && this._targets.ph === ph
        && this._targets.scale === scale) return;
    const hw = Math.max(2, Math.round(pw * scale));
    const hh = Math.max(2, Math.round(ph * scale));
    const aw = Math.max(2, Math.round(pw * aoScale));
    const ah = Math.max(2, Math.round(ph * aoScale));

    if (this._targets) this._free(this._targets);

    const depth = new THREE.DepthTexture(pw, ph);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = depth.magFilter = THREE.NearestFilter;

    const hdr = new THREE.WebGLRenderTarget(pw, ph, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false,
      depthTexture: depth,
      /* MSAA lives here now instead of on the canvas. Nearly every silhouette
       * in this scene is an alpha-tested leaf edge and the geometric edge is
       * all that multisampling can help with, but that geometric edge is the
       * one the eye follows. Resolving it costs a blit of a half-float target
       * and buys back everything the canvas context used to provide. */
      samples: 4,
    });
    const halfOpts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    const vol = new THREE.WebGLRenderTarget(hw, hh, halfOpts);
    /* Occlusion is a single scalar in nought to one and it is about to be
     * blurred twice, so eight bits per channel is more than it can carry
     * information at. The two ping-pong targets are the third and fourth
     * full-resolution buffers in the frame at the top tiers and halving their
     * footprint is worth the one line. */
    const aoOpts = Object.assign({}, halfOpts, { type: THREE.UnsignedByteType });
    const ao = new THREE.WebGLRenderTarget(aw, ah, aoOpts);
    const aoB = new THREE.WebGLRenderTarget(aw, ah, aoOpts);

    /* The blur is specified in texels and wants to cover a fixed distance in
     * the world, so doubling the occlusion buffer's resolution has to double
     * its stride or the smoothing halves and the tap noise comes back. */
    const aoBlur = aoScale >= 1 ? 3 : 1;
    this._targets = { hdr, vol, ao, aoB, depth, pw, ph, hw, hh, aw, ah, aoBlur, scale };
    this.shared.tDepth.value = depth;
    this.aoMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
    this.blurMat.uniforms.uDir.value.set(1 / aw, 0);
    this.compositeMat.uniforms.uHalfTexel.value.set(0.5 / hw, 0.5 / hh);
    this.compositeMat.uniforms.tScene.value = hdr.texture;
    this.compositeMat.uniforms.tVolume.value = vol.texture;
    this.compositeMat.uniforms.tAO.value = aoB.texture;
    this.grade.setSize(pw, ph, force);
  }

  _free(t) {
    t.hdr.dispose(); t.vol.dispose(); t.ao.dispose(); t.aoB.dispose();
    t.depth.dispose();
  }

  _draw(material, target) {
    this.quad.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad.scene, this.camera);
  }

  /** Point the renderer at the HDR target. Call immediately before the scene. */
  beginScene() {
    this.renderer.setRenderTarget(this._targets.hdr);
  }

  /**
   * Everything after the scene pass. Leaves the renderer pointing at the
   * canvas with the finished frame on it.
   */
  finish(camera, sunColor, sunIntensity = 1) {
    const t = this._targets;
    const cfg = TIER_POST[this.tier];

    this.shared.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.shared.uNearFar.value.set(camera.near, camera.far);

    const vu = this.volumeMat.uniforms;
    vu.uCamToWorld.value.copy(camera.matrixWorld);
    vu.uCamPos.value.copy(camera.position);
    /* Radiance, so the light's intensity has to be folded in — the surface
     * shaders get it multiplied in for free and this march does not, and the
     * failure mode if it is forgotten is a shaft that stays the same
     * brightness as the sun sets, which is precisely backwards. */
    if (sunColor) vu.uSunColor.value.copy(sunColor).multiplyScalar(sunIntensity);

    const hasVolume = this.enabled && cfg.steps > 0;
    if (hasVolume) this._draw(this.volumeMat, t.vol);

    const hasAO = this.enabled && cfg.ao > 0;
    if (hasAO) {
      /* Pixels per unit at unit distance, which is what turns a world radius
       * into a screen radius. Read from the projection every frame because the
       * capture harness changes the lens between shots. */
      this.aoMat.uniforms.uProjScale.value = camera.projectionMatrix.elements[5] * 0.5;
      this._draw(this.aoMat, t.ao);
      this.blurMat.uniforms.tAO.value = t.ao.texture;
      this.blurMat.uniforms.uDir.value.set(t.aoBlur / t.aw, 0);
      this._draw(this.blurMat, t.aoB);
      this.blurMat.uniforms.tAO.value = t.aoB.texture;
      this.blurMat.uniforms.uDir.value.set(0, t.aoBlur / t.ah);
      this._draw(this.blurMat, t.ao);
      this.compositeMat.uniforms.tAO.value = t.ao.texture;
    }

    const cu = this.compositeMat.uniforms;
    cu.uHasVolume.value = hasVolume ? 1 : 0;
    cu.uPost.value.y = hasAO ? this.aoStrength : 0;
    cu.uAOMix.value = hasAO ? this.contactStrength : 0;
    /* Into the grade's own HDR buffer rather than onto the canvas. This is the
     * hand-off: everything up to here is radiometry and everything after it is
     * a camera. */
    this._draw(this.compositeMat, this.grade.target());
    /* The volumetric and occlusion debug views are measurements, so the grade
     * gets out of their way rather than being applied to them. */
    this.grade.bypass = cu.uVolDbg.value > 0.5;
    this.grade.finish(camera);
  }

  dispose() {
    this.grade.dispose();
    if (this._targets) this._free(this._targets);
    this.noise.dispose();
    this.quad.geometry.dispose();
    for (const m of [this.volumeMat, this.aoMat, this.blurMat, this.compositeMat]) m.dispose();
  }
}
