/* CPU noise.
 *
 * The heightfield is authoritative on the CPU rather than displaced in a vertex
 * shader, because the player walks on it, trees are planted on it and the river
 * has to find the bottom of it. Any of those reading a different surface than
 * the one being drawn shows up immediately as feet sinking into the ground or
 * trunks hovering, so there is exactly one copy of the terrain height and it
 * lives here.
 */

/** Small, fast, well-distributed integer hash → seeded RNG. */
export function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/** Classic Perlin permutation table, shuffled by the seed. */
function permTable(seed) {
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const full = new Uint8Array(512);
  for (let i = 0; i < 512; i++) full[i] = p[i & 255];
  return full;
}

const G2 = [
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
];

export class Noise2D {
  constructor(seed = 1337) { this.p = permTable(seed); }

  /** Perlin noise, roughly [-1, 1]. */
  n(x, y) {
    const p = this.p;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    const grad = (hash, dx, dy) => {
      const h = (hash & 7) * 2;
      return G2[h] * dx + G2[h + 1] * dy;
    };
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];

    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 1.4;
  }

  /** Sum of octaves. `gain` < 0.5 gives smooth rolling ground, > 0.5 gets rocky. */
  fbm(x, y, oct = 5, gain = 0.5, lac = 2.0) {
    let s = 0, a = 0.5, fx = x, fy = y, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * this.n(fx, fy);
      norm += a;
      fx *= lac; fy *= lac; a *= gain;
    }
    return s / norm;
  }

  /* Absolute value flips the noise's zero crossings into creases, and
   * inverting turns them into ridges. This is what gives the cliff and the
   * valley shoulders their eroded look — plain fbm only ever makes blobs. */
  ridged(x, y, oct = 5, gain = 0.5, lac = 2.0) {
    let s = 0, a = 0.5, fx = x, fy = y, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * (1 - Math.abs(this.n(fx, fy)));
      norm += a;
      fx *= lac; fy *= lac; a *= gain;
    }
    return (s / norm) * 2 - 1;
  }
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
