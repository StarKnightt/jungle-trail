/* Procedural maps for the water.
 *
 * Four textures, and the division between them is by *what the water is
 * doing*, not by which mesh they end up on. Water has a small number of
 * distinct visual states and each one has its own statistics: an undisturbed
 * surface is smooth with long-wavelength swell, an agitated one is white and
 * cellular, a falling sheet is fibrous along one axis only, and an airborne
 * droplet is a point. Trying to serve two of those from one map is how you
 * get a river that looks like crumpled foil.
 *
 * Everything tiles, because all four are read with coordinates that run for
 * tens of metres or accumulate without bound over time. Two consequences of
 * that are worth stating because getting either wrong is silent:
 *
 *  - `pnoise`, `pfbm` and `pworley` all take a period, and the contract is
 *    that if the shader computes p = uv * K then the period must be exactly
 *    K. The first version of this file passed p = uv with a period of 9,
 *    which means floor(p) is zero over the whole tile: every one of these
 *    maps degenerated to a single cell of noise and baked out as a smooth
 *    gradient. It is invisible in the code and unmistakable in the render —
 *    the waterfall came out as a featureless grey cone.
 *
 *  - `pfbm` is a sum of gradient noise and is therefore *signed*, roughly
 *    -0.7 to 0.7 about zero, not 0 to 1. Feeding it straight into a
 *    smoothstep whose edges are in 0..1 throws away half the range.
 */
import * as THREE from 'three';
import { bakeImage } from '../gfx/bake.js';

/* pfbm remapped to 0..1. Not a scale-and-bias by exactly 0.5, because the sum
 * is bell-shaped and rarely reaches its bounds; 0.9 opens it up enough that a
 * threshold in the middle of the range still selects a useful fraction. */
const PF01 = /* glsl */ `
float pf01(vec2 p, vec2 per, int oct){
  return clamp(pfbm(p, per, oct) * 0.9 + 0.5, 0.0, 1.0);
}
`;

/* Capillary ripple, as a normal map.
 *
 * Two bands, because a water surface has two. The long one is the swell the
 * flow itself carries — wavelengths of a metre or so, which is what actually
 * bends the reflection of the cliff and the canopy and is therefore the term
 * doing all of the visual work. The short one is capillary chop at a few
 * centimetres, too fine to resolve as shape at any distance and there
 * entirely to keep the specular from being a clean mirror.
 *
 * Built from a small directional spectrum rather than from fbm. Plain fbm has
 * no preferred direction, and the one thing a moving water surface always has
 * is a direction — its waves are stretched across the flow and packed along
 * it. The material rotates this map into flow space per fragment, so the
 * anisotropy baked in here becomes anisotropy that follows the river.
 *
 * The wave vectors are integer pairs, which is what makes a directional wave
 * tile at all: the phase across the tile is 2*pi*(a*u + b*v), so it returns to
 * itself at u = 1 and v = 1 exactly when a and b are whole numbers. A wave at
 * an arbitrary angle cannot tile, and the seam it leaves runs the full height
 * of a fifty-metre pool.
 */
export function bakeRipple(renderer, size = 512) {
  return bakeImage(renderer, PF01 + /* glsl */ `
    float waveH(vec2 uv, vec2 k, float ph, float warp){
      // Crests rounded and troughs flattened, which is the shape of a real
      // gravity wave and, more to the point here, the shape that breaks a
      // specular highlight into separate glints instead of one long band.
      return pow(0.5 + 0.5 * sin(6.2831853 * dot(uv, k) + ph + warp), 1.5);
    }

    float surfH(vec2 uv){
      // A slow phase warp, so the spectrum never resolves into a visible
      // interference grid the way a sum of pure sinusoids does.
      float w = pfbm(uv * 3.0, vec2(3.0), 2) * 2.6;
      float h = 0.34 * waveH(uv, vec2( 2.0,  3.0), 0.0, w)
              + 0.26 * waveH(uv, vec2(-3.0,  2.0), 1.7, w * 0.8)
              + 0.17 * waveH(uv, vec2( 5.0, -1.0), 3.1, w * 1.3)
              + 0.11 * waveH(uv, vec2( 1.0,  7.0), 4.4, w * 0.6);
      return h + 0.09 * pf01(uv * 17.0, vec2(17.0), 3);
    }

    void main(){
      float e = 1.0 / ${size}.0;
      float hL = surfH(vUv - vec2(e, 0.0)), hR = surfH(vUv + vec2(e, 0.0));
      float hD = surfH(vUv - vec2(0.0, e)), hU = surfH(vUv + vec2(0.0, e));
      vec3 n = heightToNormal(hL, hR, hD, hU, 1.5);
      // Height rides in alpha. The surface shader wants it to wobble the
      // waterline, which a normal map alone cannot do.
      gl_FragColor = vec4(n, surfH(vUv));
    }
  `, { size, colorSpace: THREE.NoColorSpace, wrap: THREE.RepeatWrapping });
}

/* Foam.
 *
 * Worley, not fbm, and that is the entire point. Foam is a packed raft of
 * bubbles: it is *cellular*, with visible boundaries between lumps and a
 * characteristic size that does not vary much. An fbm has no characteristic
 * size at all — it is scale-free by construction — so foam made from one
 * always reads as smoke or as a stain rather than as a mass of bubbles.
 *
 * Three octaves of it combined with a max rather than a sum. Summing cell
 * noise averages the boundaries away and gives back the cloudy field the
 * Worley was chosen to avoid; taking the strongest cell at each point keeps
 * every octave's edges intact, so a big lump of foam has small lumps on its
 * rim.
 */
export function bakeFoam(renderer, size = 512) {
  return bakeImage(renderer, PF01 + /* glsl */ `
    float blobs(vec2 uv, float K, vec2 off){
      vec2 w = pworley(uv * K + off, vec2(K));
      return 1.0 - sstep(0.12, 0.60, w.x);
    }

    void main(){
      float f = max(max(blobs(vUv, 7.0, vec2(0.0)),
                        blobs(vUv, 16.0, vec2(3.0, 1.0)) * 0.82),
                    blobs(vUv, 33.0, vec2(1.0, 5.0)) * 0.64);

      // Warped before it is thresholded, so the raft has a torn outline
      // rather than a set of circular clumps. Foam is dragged by the flow
      // that made it and its edges are always sheared.
      float warp = pf01(vUv * 6.0, vec2(6.0), 4);
      float mask = sstep(0.30, 0.78, f * 0.72 + warp * 0.42);

      // A finer field in .g for the bubble-scale sparkle that has to survive
      // close inspection at the impact, where the camera can get within a
      // couple of metres of it.
      float fine = max(blobs(vUv, 54.0, vec2(2.0, 2.0)),
                       blobs(vUv, 96.0, vec2(7.0, 3.0)) * 0.7);

      gl_FragColor = vec4(f, fine, mask, mask);
    }
  `, { size, colorSpace: THREE.NoColorSpace, wrap: THREE.RepeatWrapping });
}

/* The falling sheet.
 *
 * Strongly anisotropic on purpose: a curtain of water is organised into
 * vertical filaments and has essentially no horizontal structure beyond where
 * one filament ends and the next begins.
 *
 * The anisotropy is in the *cell aspect*, and that is a different thing from
 * squashing the input coordinate. Worley measures distance in cell space, so
 * a round blob in a lattice that is 26 cells across and 2 cells tall comes out
 * thirteen times taller than it is wide in UV — which is a filament. The first
 * attempt scaled the coordinate instead and left the lattice square, which
 * produces the same blobs rotated the wrong way: short wide dashes running
 * across the fall rather than strands running down it.
 *
 * The channels are the *ingredients of breakup* rather than three finished
 * looks, because the curtain material blends between them continuously as a
 * function of how long a parcel has been in the air and can only do that if
 * it has the pieces separately:
 *
 *   .r  the filaments — where the water is concentrated across the sheet
 *   .g  a coarser band, the surges that travel down a real fall
 *   .b  droplet speckle, for the far end where the sheet has become spray
 *   .a  a tearing threshold: a per-texel field the material compares a
 *       falling cutoff against, so the sheet perforates progressively
 *       instead of fading out uniformly. Fading a curtain out with a scalar
 *       alpha is the most obvious way to make it look like a decal.
 */
export function bakeStrands(renderer, size = 512) {
  return bakeImage(renderer, PF01 + /* glsl */ `
    void main(){
      /* Filaments. Worley rather than a ridged fbm, and the reason is worth
       * keeping: a normalised fbm is roughly Gaussian, so its ridge transform
       * piles against 1 and no threshold selects a sensible fraction of it.
       * That cost three rounds on the bark and would cost more here, where
       * the fraction of the sheet that is still water is the entire read.
       * Cell noise has an explicit characteristic size, so a threshold on it
       * selects a predictable coverage. */
      vec2 w1 = pworley(vUv * vec2(26.0, 2.0), vec2(26.0, 2.0));
      float fil = 1.0 - sstep(0.10, 0.60, w1.x);
      vec2 w2 = pworley(vUv * vec2(57.0, 3.0) + vec2(4.0, 1.0), vec2(57.0, 3.0));
      fil = max(fil, (1.0 - sstep(0.08, 0.44, w2.x)) * 0.82);

      /* Surges: long, slow swells travelling down the sheet. These are what
       * give the fall its sense of *rate* — without something moving at a
       * visible speed a curtain reads as a static ribbon however finely it is
       * detailed. Three cells across and one along, so they are broad bands
       * rather than strands. */
      float surge = pf01(vUv * vec2(3.0, 1.0), vec2(3.0, 1.0), 3);

      // Speckle for the spray end. Nearly isotropic, because by the time the
      // sheet has come apart the droplets have lost the vertical organisation
      // and are just a cloud.
      float spec = sstep(0.44, 0.78, pf01(vUv * vec2(34.0, 26.0),
                                          vec2(34.0, 26.0), 2));

      /* Tearing threshold, correlated with the filaments rather than
       * independent of them: a sheet tears in the thin places *between*
       * strands first, so this has to be high there and low on the strand
       * cores. A white-noise threshold perforates the strands themselves,
       * which is a photographic negative of a waterfall. */
      float tear = pf01(vUv * vec2(9.0, 2.0), vec2(9.0, 2.0), 3) * 0.62
                 + (1.0 - fil) * 0.45;

      gl_FragColor = vec4(fil, surge, spec, clamp(tear, 0.0, 1.0));
    }
  `, { size, colorSpace: THREE.NoColorSpace, wrap: THREE.RepeatWrapping });
}

/* One airborne droplet cluster, for the spray point sprites.
 *
 * Streaked, not round, and that is the whole content of this texture.
 *
 * The first version was a soft radial envelope with a few resolved droplets
 * inside it, on the reasoning that a plain Gaussian blob has no scale to it.
 * The reasoning was right and the result was still wrong: what came out was a
 * field of separately countable bright discs hanging in front of the fall —
 * bokeh, or fireflies. Two things cause that and this file can fix one of
 * them. A radial sprite is the shape of a *stationary* point light, and spray
 * is never stationary; a droplet thrown out of a plunge pool crosses several
 * of its own diameters during any exposure a camera or an eye integrates
 * over, so what is actually seen is a short streak with soft ends and no
 * defined boundary anywhere. Streaks overlap into a continuous veil at a
 * density where discs are still visibly discs, because a streak has far more
 * perimeter for its area and its long axis is shared with its neighbours.
 *
 * Elongation is along v, which is the sprite's screen-vertical: point sprites
 * cannot be rotated, and near the impact the velocity is dominated by gravity
 * at both ends of the arc, so vertical is right for most of the plume and
 * wrong only for the brief apex of the highest ejecta.
 *
 * White with the shape in alpha, because the material tints it: the same
 * sprite serves the sunlit top of the plume and the shaded bottom.
 */
export function bakeDroplets(renderer, size = 128) {
  return bakeImage(renderer, /* glsl */ `
    void main(){
      vec2 p = vUv * 2.0 - 1.0;
      /* Three to one, and the tail along v is deliberately much longer than
       * the Gaussian's nominal width: the ends of a motion streak fade out
       * over a distance comparable to the streak itself, which is what stops
       * the sprite having a findable end. */
      float env = exp(-(p.x * p.x * 7.0 + p.y * p.y * 1.05));

      /* One streak per sprite, and the count is the point.
       *
       * The first attempt at this put four or five resolved filaments inside
       * each sprite, on the theory that droplets travel in company. What it
       * produced was worse than the discs it replaced: a sprite eighteen
       * pixels across showing five bright sub-features is a little
       * constellation, and six hundred identical constellations scattered
       * over the fall is a far stranger object than six hundred dots. A
       * sprite is a *droplet*, not a cloud of them; the cloud is made by
       * having a lot of sprites. Nothing is left inside the envelope at all:
       * an intermediate version kept a faint sinusoidal beading along the
       * streak and that was still too much structure, because a periodic
       * modulation of a streak is a row of dots and the eye finds rows of
       * dots immediately. */
      float a = clamp(env, 0.0, 1.0);
      // Squared falloff at the rim. These are additive and overlap heavily; a
      // linear rim leaves a visible boundary wherever two of them cross, and
      // squaring pushes it below where the eye can find it.
      a *= a;
      gl_FragColor = vec4(1.0, 1.0, 1.0, a);
    }
  `, { size, colorSpace: THREE.NoColorSpace, wrap: THREE.ClampToEdgeWrapping });
}
