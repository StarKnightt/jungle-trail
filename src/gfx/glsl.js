/* Shared GLSL building blocks.
 *
 * Everything visible in this project is generated from these functions, so they
 * are written once here and pasted into shaders as strings rather than being
 * re-derived per material. Keeping one copy also means a texture baked on the
 * GPU and a height sampled on the CPU can be made to agree — see world/noise.js
 * for the CPU twin of `snoise`.
 */

/* Descending ramp.
 *
 * GLSL leaves `smoothstep(e0, e1, x)` undefined when e0 >= e1, and D3D11 —
 * which is what ANGLE compiles to on Windows — implements the literal spec
 * wording: it returns 0 below `min` and 1 above `max`, so a reversed call
 * collapses to a constant instead of ramping the other way. It is a silent
 * failure; the shader compiles and every affected mask reads 0 or 1 forever.
 *
 * Every ramp in this project goes through this instead, in both directions, so
 * there is no edge order to get wrong.
 */
export const SSTEP = /* glsl */ `
float sstep(float e0, float e1, float x){
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;

/* Ashima's simplex noise. Chosen over value noise because the gradient
 * construction has no axis-aligned bias, which value noise shows as a visible
 * square lattice the moment you use it for terrain or bark. */
export const SIMPLEX2D = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 permute289(vec3 x){ return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute289( permute289( i.y + vec3(0.0, i1.y, 1.0))
                                 + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x  = 2.0 * fract(p * C.www) - 1.0;
  vec3 h  = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;

export const SIMPLEX3D = /* glsl */ `
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute289(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise3(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(vec4(i,0.0)).xyz;
  vec4 p = permute289( permute289( permute289(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/* Every texture in the project tiles, so the noise feeding it has to as well.
 * The standard trick — sample a 3D noise around a torus — costs four times as
 * much as plain 2D and still bands. Instead the domain is wrapped explicitly:
 * `pnoise` mods the lattice at `period`, so opposite edges read the same
 * gradients and the seam disappears exactly rather than approximately. */
export const TILEABLE = /* glsl */ `
vec2 hash22(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

/* The period is a vec2, not a scalar, and that is the whole point.
 *
 * Stretching noise along one axis is how you get roots, twigs, wood grain and
 * leaf blades — but a scalar period can only wrap a square lattice, so the
 * moment the two axes are scaled differently the wrap no longer lands on a
 * cell boundary and the texture stops tiling. The seam is subtle enough to
 * miss in a bake preview and glaring once it repeats across a hillside.
 *
 * The contract: if the shader computes p = uv * K, the period must be exactly
 * K on each axis. Doubling the frequency doubles the period alongside it,
 * which is why the lacunarity here is fixed at 2 — a fractional lacunarity
 * makes the period non-integral and mod() stops landing on lattice points.
 */
float pnoise(vec2 p, vec2 period){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 a = mod(i + vec2(0,0), period);
  vec2 b = mod(i + vec2(1,0), period);
  vec2 c = mod(i + vec2(0,1), period);
  vec2 d = mod(i + vec2(1,1), period);
  return mix(mix(dot(hash22(a), f - vec2(0,0)), dot(hash22(b), f - vec2(1,0)), u.x),
             mix(dot(hash22(c), f - vec2(0,1)), dot(hash22(d), f - vec2(1,1)), u.x), u.y);
}
float pnoise(vec2 p, float period){ return pnoise(p, vec2(period)); }

float pfbm(vec2 p, vec2 period, int oct){
  float s = 0.0, a = 0.5, norm = 0.0;
  vec2 per = period;
  for(int i = 0; i < 8; i++){
    if(i >= oct) break;
    s += a * pnoise(p, per);
    norm += a;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s / norm;
}
float pfbm(vec2 p, float period, int oct){ return pfbm(p, vec2(period), oct); }
`;

/* Worley / cellular. Pebbles, cracked mud, stone aggregate, leaf cell structure.
 * Returns x = distance to nearest feature point, y = distance to second
 * nearest; y-x is the ridge between cells, which is what reads as a crack. */
export const WORLEY = /* glsl */ `
vec2 pworley(vec2 p, vec2 period){
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for(int y = -1; y <= 1; y++){
    for(int x = -1; x <= 1; x++){
      vec2 o = vec2(float(x), float(y));
      vec2 cell = mod(ip + o, period);
      vec2 fpt = o + (hash22(cell) * 0.5 + 0.5) - fp;
      float d = dot(fpt, fpt);
      if(d < d1){ d2 = d1; d1 = d; } else if(d < d2){ d2 = d; }
    }
  }
  return vec2(sqrt(d1), sqrt(d2));
}
vec2 pworley(vec2 p, float period){ return pworley(p, vec2(period)); }

/* Scattered leaves.
 *
 * The reason a leaf-litter texture usually fails is that it is made by
 * stretching and rotating a noise field, and rotating the domain destroys
 * tileability — the lattice no longer wraps, so the map seams. This keeps the
 * lattice axis-aligned and wrapping, and rotates each leaf *inside* its own
 * cell instead, using a hash of the wrapped cell index. Orientation is then
 * fully random and the texture still tiles exactly.
 *
 * Leaves also have to occlude each other rather than blend, so the winning
 * leaf at a texel is the one with the highest stacking key, not the average.
 *
 * @returns x coverage 0..1, y height above the floor, z per-leaf random
 *          (drives age/colour), w midrib mask
 */
vec4 leafField(vec2 p, vec2 period, float seed, float lenBase, float widRatio){
  vec2 ip = floor(p), fp = fract(p);
  vec4 best = vec4(0.0);
  float bestZ = -1.0;
  for(int y = -1; y <= 1; y++){
    for(int x = -1; x <= 1; x++){
      vec2 o = vec2(float(x), float(y));
      vec2 cell = mod(ip + o, period);
      vec2 h1 = hash22(cell + seed);
      vec2 h2 = hash22(cell + seed + 19.7);
      vec2 d = fp - (o + 0.5 + h1 * 0.42);

      float ang = (h2.x * 0.5 + 0.5) * 6.28318;
      float s = sin(ang), c = cos(ang);
      vec2 lq = vec2(c * d.x - s * d.y, s * d.x + c * d.y);

      float len = lenBase * (0.72 + 0.55 * (h2.y * 0.5 + 0.5));
      float u = lq.x / len;
      if(abs(u) >= 1.0) continue;
      // Ellipse pulled toward a point at each end: a leaf, not a pebble.
      float taper = sqrt(max(0.0, 1.0 - u * u)) * (1.0 - 0.32 * abs(u));
      float wid = max(1e-4, len * widRatio * taper);
      float r = abs(lq.y) / wid;
      float cov = sstep(1.0, 0.80, r);
      if(cov <= 0.0) continue;

      float z = h1.x * 0.5 + 0.5;
      if(z > bestZ){
        bestZ = z;
        float rib = sstep(0.22, 0.0, r) * cov;
        best = vec4(cov, (1.0 - r * 0.6) * cov, h2.y * 0.5 + 0.5, rib);
      }
    }
  }
  return best;
}
`;

/* Turn a bumpy height field into a tangent-space normal map.
 * Sobel rather than a two-tap forward difference: the diagonal taps stop the
 * ridges from looking faceted along the axes, which forward differencing does
 * visibly on anything with fine detail like bark or leaf veins. */
export const HEIGHT_TO_NORMAL = /* glsl */ `
vec3 heightToNormal(float hL, float hR, float hD, float hU, float strength){
  vec3 n = normalize(vec3((hL - hR) * strength, (hD - hU) * strength, 1.0));
  return n * 0.5 + 0.5;
}
`;

/* Turn a screen uv and a depth texture back into a view-space position, and
 * know when the pixel is sky.
 *
 * Every full-screen pass in the render/ directory needs this and they all need
 * it to agree, because they are layered on top of each other: the volumetric
 * march, the occlusion term, the depth-of-field circle and the motion vector
 * are four different readings of the same buffer, and a pass that reconstructs
 * depth even slightly differently from the one it composites with produces a
 * one-pixel misregistration at every silhouette — which, in a frame that is
 * almost entirely silhouette, is a fringe around everything.
 *
 * The uniforms are part of the contract. Passes that use this share one
 * uniform object by reference so that there is exactly one place the depth
 * texture and the projection are set per frame.
 */
export const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uNearFar;

float rawDepth(vec2 uv){ return textureLod(tDepth, uv, 0.0).x; }

// Negative, metres, the way view space runs.
float viewZ(float d){
  return (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y);
}

vec3 viewPos(vec2 uv, float d){
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
`;

/* Full-screen triangle. A quad's diagonal seam makes interpolated varyings
 * discontinuous down the middle of the target; one oversized triangle has no
 * seam and rasterises fewer helper pixels. */
export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
