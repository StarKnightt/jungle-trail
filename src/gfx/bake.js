/* GPU texture baker.
 *
 * Every material map in this project is generated at boot instead of loaded.
 * The obvious way to do that is to write pixels into a 2D canvas on the CPU,
 * and it is far too slow: a 1024x1024 map with six octaves of noise is ~50M
 * scalar ops in JS, about a second each, and this scene wants a dozen of them.
 * The same work as a fragment shader is one draw call and sub-millisecond, and
 * it can share the exact GLSL the runtime materials use.
 *
 * A texture is described by one GLSL function:
 *
 *   void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao)
 *
 * The baker calls it once per output map. `height` is never uploaded on its
 * own — it exists so the normal map can be derived from it by sampling `surf`
 * four times around each texel, which keeps albedo and normal describing the
 * same surface. Authoring them separately is how you get bumps that don't line
 * up with the colour they are supposed to belong to.
 */
import * as THREE from 'three';
import { TILEABLE, WORLEY, SIMPLEX2D, HEIGHT_TO_NORMAL, FS_VERT, SSTEP } from './glsl.js';

const CH_ALBEDO = 0, CH_NORMAL = 1, CH_ORM = 2;

const PRELUDE = SSTEP + SIMPLEX2D + TILEABLE + WORLEY + HEIGHT_TO_NORMAL;

/* One scene reused for every bake. Creating a scene, camera and quad per
 * texture would allocate ~40 short-lived objects during a boot that is already
 * doing a lot of GC-visible work. */
const bakeScene = new THREE.Scene();
const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
bakeQuad.frustumCulled = false;
bakeScene.add(bakeQuad);

function wrap(surfGlsl) {
  return /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform int uChannel;
uniform float uTexel;
uniform float uNormalStrength;
${PRELUDE}
${surfGlsl}
void main(){
  vec3 albedo; float height, rough, ao;
  surf(vUv, albedo, height, rough, ao);
  if(uChannel == ${CH_ALBEDO}){
    gl_FragColor = vec4(albedo, 1.0);
  } else if(uChannel == ${CH_NORMAL}){
    vec3 aL; float hL, rL, oL; surf(vUv - vec2(uTexel, 0.0), aL, hL, rL, oL);
    vec3 aR; float hR, rR, oR; surf(vUv + vec2(uTexel, 0.0), aR, hR, rR, oR);
    vec3 aD; float hD, rD, oD; surf(vUv - vec2(0.0, uTexel), aD, hD, rD, oD);
    vec3 aU; float hU, rU, oU; surf(vUv + vec2(0.0, uTexel), aU, hU, rU, oU);
    gl_FragColor = vec4(heightToNormal(hL, hR, hD, hU, uNormalStrength), 1.0);
  } else {
    // three reads roughness from .g and AO from .r; .b (metalness) stays 0.
    gl_FragColor = vec4(ao, rough, 0.0, 1.0);
  }
}`;
}

/**
 * Bake one surface description into a set of GPU textures.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {string} surfGlsl        GLSL defining `surf(...)`, plus any helpers.
 * @param {object} [opts]
 * @param {number} [opts.size=1024]
 * @param {number} [opts.repeat=1]        wrapped into the returned textures
 * @param {number} [opts.normalStrength=2]
 * @param {boolean} [opts.normal=true]
 * @param {boolean} [opts.orm=true]       AO in .r, roughness in .g
 * @param {Object<string, THREE.IUniform>} [opts.uniforms]
 * @returns {{map:THREE.Texture, normalMap?:THREE.Texture, ormMap?:THREE.Texture, dispose():void}}
 */
export function bakeSurface(renderer, surfGlsl, opts = {}) {
  const {
    size = 1024, repeat = 1, normalStrength = 2.0,
    normal = true, orm = true, uniforms = {},
  } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: wrap(surfGlsl),
    uniforms: {
      uChannel: { value: 0 },
      uTexel: { value: 1 / size },
      uNormalStrength: { value: normalStrength },
      ...uniforms,
    },
    depthTest: false, depthWrite: false,
  });
  bakeQuad.material = mat;

  const prevTarget = renderer.getRenderTarget();
  const targets = [];

  const draw = (channel, colorSpace) => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: true, colorSpace,
      // Anisotropy matters more here than anywhere: these maps are all seen at
      // grazing angles on the ground plane, where isotropic filtering turns
      // them to grey mush a few metres out.
      anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
      depthBuffer: false, stencilBuffer: false,
    });
    mat.uniforms.uChannel.value = channel;
    renderer.setRenderTarget(rt);
    renderer.render(bakeScene, bakeCam);
    rt.texture.repeat.set(repeat, repeat);
    rt.texture.needsUpdate = true;
    targets.push(rt);
    return rt.texture;
  };

  // Albedo is authored as colour, so it must round-trip through sRGB. Normal
  // and ORM are data — encoding them as sRGB is the classic way to get washed
  // out lighting that no amount of exposure tuning fixes.
  const out = { map: draw(CH_ALBEDO, THREE.SRGBColorSpace) };
  if (normal) out.normalMap = draw(CH_NORMAL, THREE.NoColorSpace);
  if (orm) out.ormMap = draw(CH_ORM, THREE.NoColorSpace);

  renderer.setRenderTarget(prevTarget);
  mat.dispose();
  bakeQuad.material = null;

  out.dispose = () => targets.forEach(t => t.dispose());
  return out;
}

/* sRGB round trip, as a table on the way in.
 *
 * Mip levels have to be averaged in linear light. A box filter over sRGB bytes
 * is the classic way to get foliage that darkens as it recedes — every mip
 * step pulls the mean toward the encoding's midpoint, and a canopy that is
 * two stops darker at forty metres than at four reads as fog that is not
 * there. */
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const l2s = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c < 0 ? 0 : c > 1 ? 255 : Math.round(c * 255);
};

function alphaCoverage(buf, ref, scale) {
  let hit = 0;
  const n = buf.length >> 2;
  for (let i = 3; i < buf.length; i += 4) {
    if (buf[i] * scale >= ref) hit++;
  }
  return hit / n;
}

/** One box step, averaging colour in linear light and weighting it by alpha. */
function halve(src, w, h) {
  const w2 = w >> 1, h2 = h >> 1;
  const dst = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0, a = 0, fr = 0, fg = 0, fb = 0;
      for (let dy = 0; dy < 2; dy++) {
        const row = ((y * 2 + dy) * w + x * 2) * 4;
        for (let dx = 0; dx < 2; dx++) {
          const k = row + dx * 4;
          const al = src[k + 3] / 255;
          const cr = S2L[src[k]], cg = S2L[src[k + 1]], cb = S2L[src[k + 2]];
          r += cr * al; g += cg * al; b += cb * al;
          fr += cr; fg += cg; fb += cb;
          a += al;
        }
      }
      const o = (y * w2 + x) * 4;
      /* Weighting the colour by alpha is what stops the transparent side of a
       * leaf edge bleeding its own colour into the visible side — but when
       * nothing in the block is opaque there is no weighted answer, and
       * leaving the texel at zero writes black into the level. That black is
       * then one bilinear tap away from every leaf edge at that mip, which is
       * exactly the dark rim this file exists to avoid. The source level
       * carries a sensible leaf green in its transparent region, so falling
       * back to the flat mean carries it on up the chain. */
      const k = a > 1e-4 ? 1 / a : 0;
      dst[o] = l2s(a > 1e-4 ? r * k : fr / 4);
      dst[o + 1] = l2s(a > 1e-4 ? g * k : fg / 4);
      dst[o + 2] = l2s(a > 1e-4 ? b * k : fb / 4);
      dst[o + 3] = Math.round((a / 4) * 255);
    }
  }
  return dst;
}

/**
 * Build a mip chain on the CPU that preserves alpha-test coverage.
 *
 * This is the fix for the single worst artefact in a forest: the mid distance
 * dissolving into a speckled grey wall. A leaf cutout is mostly edge — holes,
 * leaflet slots, a serrated margin — and a plain box filter averages all of
 * that toward the middle of the alpha range. By the third mip level most of
 * the texture sits near the alpha threshold rather than clearly either side of
 * it, so the test starts flipping on noise: coverage collapses, silhouettes
 * come apart, and with alpha-to-coverage on top the leftovers are dithered
 * into literal stipple. It is not a lighting problem and no amount of grading
 * touches it.
 *
 * The standard remedy, and the one used here, is to rescale each level's alpha
 * until the fraction of texels passing the test matches the fraction at level
 * zero. The texture then represents the same amount of leaf at every distance,
 * which is the property the alpha test needed all along. GPU `generateMipmap`
 * cannot do this — it has no idea what the threshold is — so the chain has to
 * be read back and rebuilt here.
 */
function coverageMipTexture(renderer, rt, size, alphaTest, colorSpace, aniso) {
  const level0 = new Uint8Array(size * size * 4);
  /* readRenderTargetPixels hands back rows in GL order, v = 0 first, and a
   * DataTexture uploads them the same way as long as flipY stays off — so the
   * whole chain stays in the orientation the render target was sampled in and
   * no flip is needed anywhere. */
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, level0);

  const ref = alphaTest * 255;
  const target = alphaCoverage(level0, ref, 1);
  const levels = [level0];

  let cur = level0, w = size;
  while (w > 1) {
    cur = halve(cur, w, w);
    w >>= 1;
    /* Below about 8x8 the coverage statistic is a handful of texels and the
     * search starts chasing quantisation noise, which can push alpha to the
     * rails and make a distant plant flash opaque. Nothing is ever sampled
     * from those levels at any size that matters anyway. */
    if (w >= 8 && target > 0.001 && target < 0.999) {
      let lo = 0.05, hi = 12;
      for (let it = 0; it < 12; it++) {
        const k = 0.5 * (lo + hi);
        if (alphaCoverage(cur, ref, k) < target) lo = k; else hi = k;
      }
      const k = 0.5 * (lo + hi);
      for (let i = 3; i < cur.length; i += 4) {
        const a = cur[i] * k;
        cur[i] = a > 255 ? 255 : Math.round(a);
      }
    }
    levels.push(cur);
  }

  const tex = new THREE.DataTexture(levels[0], size, size,
                                    THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = levels.map((data, i) => ({ data, width: size >> i, height: size >> i }));
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = colorSpace;
  tex.anisotropy = aniso;
  tex.flipY = false;
  tex.needsUpdate = true;
  rt.dispose();
  return tex;
}

/**
 * Bake a single RGBA image from a raw fragment shader body.
 * For things that are not a PBR surface — leaf cutouts, gradient ramps, the
 * splash sprite — where the albedo/normal/ORM triple would be meaningless.
 *
 * @param {object} [opts]
 * @param {number} [opts.coverageMips] alpha-test threshold the mip chain must
 *        keep coverage at; omit to let the GPU box-filter it as usual.
 */
export function bakeImage(renderer, fragBody, opts = {}) {
  const {
    size = 512, uniforms = {}, colorSpace = THREE.SRGBColorSpace,
    wrap: wrapMode = THREE.ClampToEdgeWrapping, transparent = true,
    coverageMips = 0,
  } = opts;

  const mat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: `precision highp float;\nvarying vec2 vUv;\n${PRELUDE}\n${fragBody}`,
    uniforms, depthTest: false, depthWrite: false, transparent,
    /* Blending off, and this one line was the cause of the dark ring around
     * every leaf in the game.
     *
     * `transparent: true` gets three to enable NormalBlending, which is
     * SRC_ALPHA / ONE_MINUS_SRC_ALPHA — so every texel written into the bake
     * target is multiplied by its own alpha on the way in. That is right for
     * compositing and completely wrong for authoring a texture: the shader
     * takes care to flood the whole transparent region of each atlas cell
     * with the leaf's own colour precisely so that filtering across the
     * silhouette is a no-op, and the blend then multiplied all of it back to
     * black. Every partially covered edge texel was darkened in proportion to
     * its own coverage on top of that, and the mip chain — which weights
     * colour by alpha a second time — squared the effect.
     *
     * The visible result is a leaf whose outer few texels shade toward black
     * at every distance, which is a hard dark outline, which is the single
     * loudest "stylised game" tell there is. It also silently zeroed the
     * roughness and translucency channels outside the blade, so leaf margins
     * got a mirror lobe and lost their backlight glow at the same time.
     *
     * There is nothing to blend against here — one opaque full-screen
     * triangle over a cleared target — so writing the shader's output
     * verbatim is both correct and what every consumer of these maps assumes. */
    blending: THREE.NoBlending,
  });
  bakeQuad.material = mat;

  const rt = new THREE.WebGLRenderTarget(size, size, {
    wrapS: wrapMode, wrapT: wrapMode,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, colorSpace,
    anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
    depthBuffer: false, stencilBuffer: false,
  });

  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  // Only reaches anything the shader declines to cover, which for a
  // full-screen triangle is nothing — but a stale clear colour from the
  // previous bake showing up in a corner is a nasty thing to chase.
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.render(bakeScene, bakeCam);
  renderer.setRenderTarget(prev);

  mat.dispose();
  bakeQuad.material = null;

  // readRenderTargetPixels binds and unbinds on its own, so the target above
  // is already back where the caller left it.
  if (coverageMips) {
    return coverageMipTexture(renderer, rt, size, coverageMips, colorSpace,
                              Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  }

  rt.texture.userData.rt = rt;
  return rt.texture;
}
