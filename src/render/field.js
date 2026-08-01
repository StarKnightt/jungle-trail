/* The world, sampled onto one small texture so that a shader can ask about it.
 *
 * Everything in the atmosphere system needs to know things about a point in the
 * world that only the CPU-side world model knows: how high the ground is under
 * it, whether it is sitting in a hollow, whether there is water nearby, and how
 * much roof there is overhead. A raymarch through mist needs all four at twenty
 * points along every ray, and a surface shader needs them at every fragment, so
 * none of it can be a per-object attribute or a uniform.
 *
 * A single texture covering the whole corridor at one metre answers all of it
 * for four fetches, and one metre is the right resolution because none of these
 * quantities has anything to say below that scale — the ground shape under a
 * metre is the normal maps' business and the roof is tens of metres across.
 * At 181x493 texels the whole thing is 700 kB and lives in cache.
 *
 * Half float rather than bytes, because the height channel is metres of world
 * and quantising it to 1/255 of the terrain's forty-metre range would put a
 * 16 cm staircase into the mist's ground layer, which is precisely the layer
 * the eye is looking at.
 */
import * as THREE from 'three';
import { BOUNDS } from '../world/terrain.js';

export const FIELD_STEP = 1.0;

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* How much roof there is over a point, 0 for open sky and 1 for closed canopy.
 *
 * This is not a guess at the canopy; it is the *same* pair of gap functions
 * that vegetation.js uses to decide where to place the two canopy storeys,
 * evaluated as a continuous field instead of as an acceptance probability.
 * That matters more than it might look: the whole point of the dappled light
 * is that the shafts land where the roof actually has holes in it, and a
 * shaft arriving somewhere the geometry above is solid is the kind of error
 * that is not noticeable frame by frame and is deeply wrong when you walk
 * through it. If those constants ever move in vegetation.js they have to move
 * here as well.
 */
function roofDensity(x, z, t, dist) {
  const gap1 = smoothstep(0.12, 0.52,
    Math.abs(Math.sin(x * 0.058) * Math.cos(z * 0.046)
           + 0.55 * Math.sin(x * 0.023 + z * 0.019)));
  const gap2 = smoothstep(0.10, 0.50,
    Math.abs(Math.sin(x * 0.037 + 2.1) * Math.cos(z * 0.029 - 1.3)
           + 0.6 * Math.sin(z * 0.019 - x * 0.014)));
  // The two storeys multiply: light has to find a hole in both to get down.
  let d = (0.52 + 0.48 * gap1) * (0.58 + 0.42 * gap2);
  /* The light well over the path. Only the subcanopy layer thins here, so the
   * effect is modest by design — the roof above a jungle trail is not open,
   * it is merely thinner, and a corridor of bright sky over the path would
   * read as a fire break rather than as a footpath. */
  d *= 1 - 0.20 * (1 - smoothstep(2.5, 13.0, dist));
  // And the clearing at the end of the walk genuinely has no canopy over it.
  d *= 1 - 0.90 * smoothstep(0.79, 0.93, t);
  return d;
}

/**
 * @param {import('../world/terrain.js').Terrain} terrain
 * @returns {{texture: THREE.DataTexture, map: THREE.Vector4, width:number, height:number}}
 *   `map` is (x0, z0, 1/spanX, 1/spanZ) — everything a shader needs to turn a
 *   world xz into a uv, packed into the one uniform it will already be reading.
 */
export function buildWorldField(terrain) {
  const x0 = BOUNDS.x0, z0 = BOUNDS.z0;
  const spanX = BOUNDS.x1 - BOUNDS.x0;
  const spanZ = BOUNDS.z0 - BOUNDS.z1;
  const W = Math.round(spanX / FIELD_STEP) + 1;
  const H = Math.round(spanZ / FIELD_STEP) + 1;

  const half = THREE.DataUtils.toHalfFloat;
  const data = new Uint16Array(W * H * 4);
  const q = {};
  for (let j = 0; j < H; j++) {
    const z = z0 - j * FIELD_STEP;
    for (let i = 0; i < W; i++) {
      const x = x0 + i * FIELD_STEP;
      terrain.sampleField(x, z, q);
      const k = (j * W + i) * 4;
      data[k] = half(terrain.height(x, z));
      data[k + 1] = half(terrain.hollowAt(x, z));
      data[k + 2] = half(roofDensity(x, z, q.t, q.dist));
      data[k + 3] = half(terrain.wetAt(x, z));
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  /* Clamped, and every consumer relies on it. A sightline that leaves the
   * corridor still wants a plausible ground height and a closed roof rather
   * than the field wrapping round to the far end of the level, which would
   * put a hole in the canopy at the edge of the world. */
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  /* readPixels order, matching the row order written above: v = 0 is j = 0,
   * which is z = z0. The uv mapping below is written to agree. */
  tex.flipY = false;
  tex.needsUpdate = true;

  return {
    texture: tex,
    map: new THREE.Vector4(x0, z0, 1 / spanX, 1 / spanZ),
    width: W, height: H,
  };
}

/* The uv mapping, as GLSL, kept next to the code that lays the texels out so
 * the two cannot drift apart. z runs negative down the trail, which is why the
 * second component subtracts rather than adds.
 *
 * The roof is also available analytically, and one caller needs it that way.
 * The texture is clamped at the corridor's edge, which is right for a sightline
 * that wanders off the level and wrong for the question "how much roof is there
 * between this point and the sun" — at a fifteen-degree sun that point is a
 * hundred and twenty metres up-sun, well outside a corridor a hundred and
 * eighty metres wide, and the clamp answers every such query with the same edge
 * texel. Capping the reach to keep it inside was worse than the disease: the
 * whole value of that lookup is that it is *constant along a sun ray*, which is
 * what makes the light it gates a beam rather than a column, and a capped
 * offset stops tracking height and so stops being constant along anything. It
 * turned every low-angle shaft into a vertical shaft, which is exactly the
 * failure the slant distance had been introduced to fix.
 *
 * This is the same pair of gap functions the bake uses, so the two agree
 * wherever both are defined, and it is unbounded. It leaves out the trail's
 * light well and the clearing, which are the two local corrections the bake
 * applies afterwards — both are features of where you are standing rather than
 * of the roof a hundred metres up-sun, and neither is worth a trail-curve
 * evaluation per raymarch step.
 */
export const FIELD_GLSL = /* glsl */ `
uniform sampler2D tField;
uniform vec4 uFieldMap;

vec4 worldField(vec2 xz){
  vec2 uv = vec2((xz.x - uFieldMap.x) * uFieldMap.z,
                 (uFieldMap.y - xz.y) * uFieldMap.w);
  return textureLod(tField, clamp(uv, 0.0, 1.0), 0.0);
}

float fieldSStep(float e0, float e1, float x){
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float roofAnalytic(vec2 p){
  float gap1 = fieldSStep(0.12, 0.52,
    abs(sin(p.x * 0.058) * cos(p.y * 0.046)
      + 0.55 * sin(p.x * 0.023 + p.y * 0.019)));
  float gap2 = fieldSStep(0.10, 0.50,
    abs(sin(p.x * 0.037 + 2.1) * cos(p.y * 0.029 - 1.3)
      + 0.6 * sin(p.y * 0.019 - p.x * 0.014)));
  return (0.52 + 0.48 * gap1) * (0.58 + 0.42 * gap2);
}
`;
