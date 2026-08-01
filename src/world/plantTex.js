/* Foliage and bark textures.
 *
 * Everything a plant is made of comes from two bakes: a leaf atlas and a bark
 * surface. The atlas is the important one — a jungle is overwhelmingly leaves,
 * so almost every pixel on screen is one of these shapes seen at some angle,
 * and any tell in them is a tell in the whole image.
 *
 * The atlas is a grid of four shape families across by four individuals down.
 *
 *   column 0  broad ovate    aroids, philodendron, the big understory blades
 *   column 1  lanceolate     narrow strap leaves, sedges, grass
 *   column 2  pinnate half   one side of a palm or fern frond, rachis at left
 *   column 3  small ovate    vine leaves, seedlings, ground sprigs
 *
 * Column 2 earns its place: a palm frond built from one card per leaflet is
 * ~40 draw-triangles and looks correct, but there are thousands of fronds in
 * frame. Rendering an entire frond side as one alpha-tested card is two
 * triangles for the same silhouette, and the gaps between leaflets — which is
 * where the sky and the god rays come through, and the single most
 * recognisable thing about a palm — are cut by the alpha channel for free.
 *
 * The rows exist because four cells was not enough. With one cell per family
 * every broad leaf in the forest carried the same outline, the same holes and
 * the same orange necrosis blotch in the same place, and at understory density
 * that repeat is legible from right across the frame: it reads as a rubber
 * stamp, which is exactly what it was. Each row is a different individual —
 * a different margin profile, a different herbivory pattern, and a different
 * *amount* of it, running from a nearly intact young blade in row 0 to a
 * shredded old one in row 3. Litter and senescing fronds draw from the damaged
 * rows and a fresh canopy flush from the clean ones, so the damage is not just
 * varied, it is where damage belongs.
 *
 * Three maps come out of the atlas rather than the usual two. The third is
 * roughness and translucency, and it is not optional here: a leaf is a thin
 * waxy sheet, and the two things that say so are a sharp specular highlight
 * and light coming *through* it from behind. Constant roughness makes plastic;
 * no transmission makes cardboard.
 */
import { SSTEP } from '../gfx/glsl.js';

/** Cells per side of the leaf atlas. plants.js indexes it with this. */
export const ATLAS_N = 4;

/* Damage is worth the instructions it costs.
 *
 * Every leaf in a real rainforest understory is chewed, holed, blotched or
 * torn — herbivory pressure there is about as high as it gets on land, and a
 * mature leaf with an intact margin is the exception. Perfect leaves are the
 * fastest way to make foliage read as CG, and no amount of lighting work
 * recovers from it, because the eye is reading silhouette rather than shading.
 */
/* The per-cell shape knob, and the reason it is a smooth formula rather than
 * a hash.
 *
 * plants.js now cuts leaf geometry to the outline this file bakes, so both
 * sides have to agree on that outline to within a fraction of a texel — a
 * geometric card narrower than the blade slices the tip off with a straight
 * edge, which is far worse than the untapered rectangle it replaced. The
 * obvious `fract(sin(p * 127.1) * 43758)` cannot be replicated on the CPU at
 * all: the argument runs to tens of thousands, a highp float has nine bits of
 * fraction left at that magnitude, and the multiply by 43758 turns that error
 * into a completely different number. Keeping the argument under about twelve
 * and skipping the amplification makes the two evaluations agree to 1e-7,
 * which is all that is required. The coefficients are picked so no two rows
 * of the same column land on a similar value — that would spend a row of the
 * atlas on a leaf already in it.
 */
export const SHAPE_K = /* glsl */ `
float shapeK(float col, float row){
  return 0.5 + 0.5 * sin(col * 2.399 + row * 1.611 + 0.37);
}
`;

/** CPU twin of shapeK above; plants.js sizes its geometry from it. */
export const shapeK = (col, row) => 0.5 + 0.5 * Math.sin(col * 2.399 + row * 1.611 + 0.37);

const LEAF_COMMON = /* glsl */ `
const float PI = 3.14159265359;

float unit(float v){ return v * 0.5 + 0.5; }
float hash11(float p){ return fract(sin(p * 127.1) * 43758.5453123); }
${SHAPE_K}

/* Half-width along the leaf, t = 0 at the petiole and 1 at the tip.
 * sin(pi * t^a) is an ellipse when a = 1; pushing a below 1 slides the widest
 * point toward the base, which is the difference between an ovate leaf and a
 * lens shape. The outer exponent controls how bluntly it meets the tip.
 *
 * The k argument is the per-row shape knob and it moves both, so the four
 * individuals in
 * a column are not the same outline at four sizes — one is a broad blunt
 * blade, another a narrow acuminate one. Silhouette is what survives being
 * twelve pixels tall, so this is the variation that actually pays.
 *
 * Column 2 never reaches here — the pinnate cell builds its own outline out
 * of leaflets — so the fallthrough serves column 2's *envelope* only, and the
 * CPU twin below returns that envelope for it. */
float wProfile(int id, float t, float k){
  if(id == 0) return pow(sin(PI * pow(t, 0.50 + 0.22 * k)), 0.56 + 0.24 * k) * (0.86 + 0.18 * k);
  if(id == 1) return pow(sin(PI * pow(t, 0.68 + 0.26 * k)), 1.02 + 0.36 * k) * (0.39 + 0.14 * k);
  /* Column 3 used to fall through to column 0's curve and baked as a visible
   * duplicate of it — a quarter of the atlas spent on a leaf already in it.
   * Obovate instead: widest well past halfway and drawn down to a narrow
   * cuneate base, which is a different silhouette at any size rather than the
   * same one at a different width. */
  if(id == 3) return pow(sin(PI * pow(t, 1.30 + 0.45 * k)), 0.62 + 0.26 * k) * (0.72 + 0.22 * k);
  return pow(sin(PI * pow(t, 0.36 + 0.20 * k)), 0.70 + 0.24 * k) * (0.64 + 0.20 * k);
}
`;

/**
 * Where the blade's margin is, as a fraction of the card's half-width.
 *
 * The atlas draws a leaf inside a square cell and the geometry used to be the
 * whole square, with the alpha channel doing all the shaping. That is the
 * single reason close foliage read as cards: the cupping, the drooping arc
 * and the edge curl were all applied to the *card*, so on a blade that only
 * fills half its cell the curvature happened out in the transparent margin
 * and the visible part of the leaf was the flat middle of the dish. Handing
 * plants.js the outline lets it put the curvature where the leaf actually is,
 * and it stops paying for alpha-tested fragments that were never covered.
 *
 * @param {number} cell atlas column, CELL.* in plants.js
 * @param {number} vary atlas row
 * @param {number} t    0 at the petiole, 1 at the tip
 * @returns {number} 0..1
 */
export function leafSpan(cell, vary, t) {
  const k = shapeK(cell, vary);
  const P = Math.pow, S = Math.sin, PI = Math.PI;
  // The pinnate cell's outline is the reach of its longest leaflets, which is
  // set where `ext` is computed in the fragment shader rather than in wProfile.
  if (cell === 2) return S(PI * P(t, 0.62 + 0.18 * k));
  let w;
  if (cell === 0) w = P(S(PI * P(t, 0.50 + 0.22 * k)), 0.56 + 0.24 * k) * (0.86 + 0.18 * k);
  else if (cell === 1) w = P(S(PI * P(t, 0.68 + 0.26 * k)), 1.02 + 0.36 * k) * (0.39 + 0.14 * k);
  else w = P(S(PI * P(t, 1.30 + 0.45 * k)), 0.62 + 0.26 * k) * (0.72 + 0.22 * k);
  // The cell's x runs to 1.08 half-widths, so that is what a span of 1 means.
  return Math.min(1, w / 1.08);
}

/* uChannel: 0 albedo+alpha, 1 normal, 2 rough/translucency/alpha. */
export const LEAF_FRAG = /* glsl */ `
uniform int uChannel;
uniform float uTexel;
uniform float uNormalStrength;
${LEAF_COMMON}

void leafSurf(vec2 uv, out vec3 alb, out float a, out float h, out float rough, out float trans){
  vec2 g = uv * ${ATLAS_N}.0;
  vec2 cellIdx = floor(g);
  int id = int(cellIdx.x + 0.5);          // column: which shape family
  int row = int(cellIdx.y + 0.5);         // row: which individual of it
  vec2 f = fract(g);
  float seed = float(id) * 13.77 + float(row) * 47.13 + 4.1;
  float shape = shapeK(cellIdx.x, cellIdx.y);
  /* Damage climbs down the column. Row 0 is a young blade a herbivore has
   * barely found; row 3 has been in the understory for a year. */
  float wear = 0.18 + 1.05 * (float(row) / ${ATLAS_N - 1}.0);

  alb = vec3(0.0); a = 0.0; h = 0.5; rough = 0.6; trans = 0.0;

  /* A margin inside each cell. The atlas is mipped and bilinear, and a leaf
   * that runs to the cell border reads its neighbour on every edge tap —
   * which shows up as a halo of the wrong shape around distant foliage. */
  float t = clamp((f.y - 0.035) / 0.93, 0.0, 1.0);

  float cov = 0.0, midrib = 0.0, vein = 0.0, retic = 0.0, r = 1.0, puff = 0.0;
  float x = 0.0;

  if(id == 2){
    /* Pinnate frond half. u runs from the rachis at the left edge out to the
     * leaflet tips; t runs along the frond. */
    float u = clamp((f.x - 0.05) / 0.90, 0.0, 1.0);
    x = u;
    // Everything is clamped at u = 0, so without this the leftmost leaflet
    // smears flat to the cell border and bleeds into its neighbour in the mips.
    float inset = sstep(0.030, 0.052, f.x);

    // Leaflets rake toward the frond tip rather than standing square to the
    // rachis, which is what stops a frond reading as a comb.
    /* Leaflet count, and it varies per row because a frond's pinna pitch is
     * the most recognisable thing about it. Twenty-six leaflets across a
     * 512-pixel cell put each one at about four pixels once the rake and the
     * taper had eaten into it, and a frond made of four-pixel spikes is a
     * bottle brush, not a plant. Real understory pinnae are broad and overlap
     * their neighbours for most of their length; the frond reads as a single
     * serrated blade that light comes through in slots. */
    /* Fewer and broader than before. This cell now only ever serves the
     * distant thicket and trunk epiphytes, and out there coverage held in a
     * few wide shapes survives minification where the same coverage in many
     * narrow ones turns into stipple. */
    float k = t * (9.0 + 5.0 * shape) + u * 1.15;
    float kf = fract(k), ki = floor(k);
    float rnd = hash11(ki + seed);

    // How far out this leaflet reaches: short at both ends of the frond.
    float ext = sin(PI * pow(t, 0.62 + 0.18 * shape)) * (0.70 + 0.30 * rnd);
    float d = abs(kf - 0.5) * 2.0;
    /* Leaflets touch near the rachis and separate outboard, so the gaps widen
     * with u — that taper is what lets light through in the right pattern.
     * Per-leaflet width jitter matters as much as the taper: identical
     * leaflets make a comb, and a comb is what a stencilled frond looks like.
     *
     * The ceiling below is the whole point of this line. d only reaches 1 at
     * the midpoint between two leaflets, so any half-width at or above 1 means
     * the leaflet never ends — it merges into its neighbours and the frond
     * bakes as a solid wedge with no slots in it at all. The previous
     * coefficients peaked at 1.39 and left the inner two thirds of every frond
     * fused, which is why fronds read as green triangles and why their only
     * remaining detail was the row of leaflet midribs crossing them. */
    float hw = min(0.93, (0.98 - 0.34 * u * u) * (0.82 + 0.38 * rnd));
    float lam = sstep(hw, hw - 0.10, d) * sstep(ext, ext - 0.10, u);
    // Torn and missing leaflets. An old frond is never complete, and the gaps
    // where one has gone are a large part of why a real one reads as grown
    // rather than drawn.
    lam *= 1.0 - sstep(0.86 - 0.18 * wear, 0.94 - 0.14 * wear, rnd) * sstep(0.20, 0.45, u);
    lam *= 1.0 - sstep(0.74 - 0.20 * wear, 0.86 - 0.12 * wear, hash11(ki * 3.1 + seed))
                 * sstep(0.55, 0.95, u);

    float rachis = sstep(0.048, 0.026, u) * sstep(0.995, 0.97, t);
    cov = max(lam, rachis) * inset;
    /* A leaflet midrib is a thread, not the pale rib of a broad leaf, and
     * there are fifteen of them stacked up the cell. At full strength they
     * turned every frond into a pale-striped flag, and at mid distance the
     * stripe pitch fell near the pixel pitch and the whole frond boiled into
     * white speckle — this one term was most of the mid-ground crackle. The
     * rachis keeps full strength because there is only ever one of it.
     *
     * Cut again, to a tenth, and the striations that ran out along each
     * leaflet are gone entirely. This cell is no longer what a fern or a palm
     * in the near field is made of — those grow real per-leaflet geometry now
     * — so all it has to survive is the distant thicket and the epiphytes up
     * a bole, where any stripe running across it at a few pixels' pitch is
     * pure aliasing and the banded-ribbon read the critique named. */
    midrib = max(sstep(0.048, 0.0, d) * lam * 0.10, rachis);
    r = clamp(d / max(0.05, hw), 0.0, 1.0);
    puff = (1.0 - r) * lam;
  } else {
    x = (f.x * 2.0 - 1.0) * 1.08;
    float w = wProfile(id, t, shape);
    /* A leaf margin is never a clean curve: it undulates, and larger leaves
     * buckle between the secondary veins. Three scales rather than two,
     * because the coarse one is the one that reads — a blade whose outline
     * only wobbles at the ripple scale is still an ellipse from four metres
     * away, and an ellipse is what "card" looks like. The total stays inside
     * ten per cent, which is the headroom plants.js leaves when it cuts the
     * geometry to the leafSpan outline. */
    w *= 1.0 + 0.030 * sin(t * 47.0 + seed * 3.3)
             + 0.024 * snoise(vec2(t * 8.0, seed))
             + 0.034 * snoise(vec2(t * 2.3, seed * 1.7));

    r = abs(x) / max(1e-3, w);
    cov = sstep(1.0, 0.93, r) * sstep(0.0, 0.03, t) * sstep(1.0, 0.975, t);

    midrib = sstep(0.080 * (1.0 - 0.55 * t), 0.0, abs(x)) * cov;

    /* Secondary veins, and the thing that had to change here is that they
     * were *ruled*. A perfectly periodic fract() puts every secondary at the
     * same pitch and the same angle down the whole blade, which is a printed
     * pattern rather than a grown one — it is most of why the close-ups read
     * as illustration. A real blade's secondaries are irregularly spaced,
     * they bow rather than run straight, and each one thins as it approaches
     * the margin because it is dividing as it goes.
     *
     * Two noise terms buy all three: one warps the phase so the spacing
     * wanders and the veins bow, the other drifts the pitch slowly along the
     * leaf so the base and the tip do not share a rhythm. */
    float vWarp = 0.17 * snoise(vec2(t * 3.1, seed * 2.7))
                + 0.07 * snoise(vec2(t * 9.4, r * 2.2 + seed));
    float pitch = (9.0 + 5.0 * shape) * (1.0 + 0.16 * snoise(vec2(t * 1.4, seed * 5.1)));
    float chev = fract(t * pitch - r * (1.55 + 0.55 * shape) + vWarp + 0.5);
    float rib = min(chev, 1.0 - chev);
    float vw = 0.125 * (1.0 - 0.52 * r);
    vein = sstep(vw, 0.0, rib) * cov * sstep(0.05, 0.20, r) * sstep(1.0, 0.90, r);

    /* Tertiaries: the short cross-links that ladder between one secondary and
     * the next. They are the finest thing on a leaf that is still a line
     * rather than a texture, and at reading distance they are the difference
     * between a drawn leaf and a photographed one. Gated to the space between
     * the secondaries so they read as connecting them. */
    float tert = sstep(0.055, 0.0, min(fract(r * 15.0 + vWarp * 2.0),
                                       1.0 - fract(r * 15.0 + vWarp * 2.0)))
               * sstep(0.16, 0.34, rib) * cov * sstep(0.10, 0.30, r) * 0.45;
    vein = max(vein, tert);

    // Areolae — the polygonal mesh the tertiaries enclose. Far too small to
    // resolve as lines, but it is what gives the surface its grain.
    vec2 wr = pworley(vec2(x * 30.0, t * 30.0) + seed, 60.0);
    retic = sstep(0.10, 0.01, wr.y - wr.x) * cov * 0.5;
    // The blade domes upward between each pair of secondary veins.
    puff = (0.5 - rib) * cov * sstep(1.0, 0.75, r);
  }

  /* Micro-relief. Nothing on a leaf is smooth at a millimetre: the epidermis
   * is puckered between the veinlets and the whole blade is slightly crumpled
   * from having unfurled. It is invisible in the albedo and it is most of what
   * the normal map has to say in a close-up — without it the highlight slides
   * across the blade as one clean sheet, which is the plastic read. */
  float crinkle = snoise(vec2(x * 26.0, t * 31.0) + seed * 3.0) * 0.5
                + snoise(vec2(x * 61.0, t * 74.0) - seed) * 0.25;

  float mott = unit(pfbm(vec2(x * 2.4, t * 3.2) + seed * 5.0, 16.0, 4));

  /* Herbivory. Cells of a coarse Worley field become holes, gated by a
   * low-frequency mask so damage clusters on part of the leaf instead of
   * peppering all of it, and weighted toward the margin where a caterpillar
   * starts. The wear factor scales the whole thing, so the top row of the
   * atlas is a nearly clean blade and the bottom row is lace. */
  vec2 hv = pworley(vec2(x * 2.6, t * 3.0) + seed * 2.0, 12.0);
  float holeR = 0.20 + 0.30 * unit(pfbm(vec2(x * 2.0, t * 2.0) + seed, 8.0, 3));
  float dmg = sstep(holeR, holeR * 0.50, hv.x)
            * sstep(0.30, 0.78, unit(pfbm(vec2(x, t) * 1.25 + seed * 7.0, 8.0, 2)))
            * sstep(0.12, 0.60, r) * wear;
  float hole = sstep(0.30, 0.54, dmg);
  // Tissue browns and dies back in a ring around every hole.
  float necro = sstep(0.03, 0.28, dmg) * (1.0 - sstep(0.30, 0.50, dmg));

  /* A margin bitten clean off. Chewing starts at the edge far more often than
   * in the middle of a blade, and a leaf missing a bite out of its outline is
   * far more legible at distance than a hole in the middle of one — the
   * silhouette is what survives being three pixels tall. */
  float bite = sstep(0.42, 0.10, pworley(vec2(x * 1.5, t * 2.2) + seed * 5.0, 8.0).x)
             * sstep(0.55, 1.00, r)
             * step(0.62 - 0.30 * wear, hash11(seed * 2.3 + floor(t * 3.0)))
             * wear;
  cov *= 1.0 - sstep(0.25, 0.55, bite);
  necro = max(necro, sstep(0.10, 0.30, bite) * (1.0 - sstep(0.30, 0.52, bite)));

  /* Epiphylls — the crust of algae, lichen and liverwort that grows on the
   * upper surface of any leaf that has been in a rainforest for a few months.
   * Almost nothing else produces the mottled, dirty, unevenly glossy look that
   * separates a real understory leaf from a rendered one, and its absence is
   * most of what reads as "moulded plastic". An old blade carries far more of
   * it than a new one, so it tracks the row as well. */
  float epi = sstep(0.60 - 0.14 * wear, 0.92, unit(pfbm(vec2(x * 5.0, t * 6.0) + seed * 11.0, 40.0, 4)));
  vec2 ew = pworley(vec2(x * 9.0, t * 11.0) + seed * 3.0, 22.0);
  float epiSpot = sstep(0.26, 0.05, ew.x) * sstep(0.40, 0.75,
    unit(pfbm(vec2(x * 1.8, t * 2.4) + seed * 13.0, 8.0, 2)));

  /* The silhouette before anything was eaten out of it, kept because the
   * colour outside it still matters — see the mix at the end of the block
   * below. */
  float blade = cov;

  cov *= 1.0 - hole;
  a = cov;

  /* Pulled off yellow, and the reason is that this frame has no other hue in
   * it to balance against. A single leaf at 0.144/0.212/0.096 is a perfectly
   * plausible sunlit blade; ten thousand of them filling the frame average to
   * a mustard wash, and the trunks between them then read as black by
   * comparison because there is nothing warm left for them to be. Real
   * understory foliage is a restrained blue-green — the yellow-greens belong
   * to new flushes and to the canopy where there is light to make them. */
  vec3 deep = vec3(0.034, 0.077, 0.042);
  vec3 midC = vec3(0.070, 0.137, 0.072);
  vec3 lite = vec3(0.126, 0.188, 0.104);
  vec3 body = mix(deep, midC, mott);
  body = mix(body, lite, sstep(0.62, 1.0, mott) * 0.55);
  vec3 col = body;
  col = mix(col, vec3(0.155, 0.184, 0.082), vein * 0.50 + retic * 0.14);
  col = mix(col, vec3(0.186, 0.206, 0.102), midrib * 0.70);

  /* The margin, and getting this wrong was half of the ringed-leaf problem.
   *
   * What used to be here faded the blade to sixty per cent of its own colour
   * across the outer fifth of every leaf. A soft dark band following the
   * silhouette of every leaf in frame is an outline, however it is arrived
   * at, and it was being painted into the atlas by hand.
   *
   * What a leaf actually has at its edge is one fine collecting vein and,
   * inboard of it, lamina thin enough that it passes light and reads paler
   * than the body rather than darker. The vein sits deliberately inside the
   * alpha ramp at r = 0.93 so no part of it is ever in a texel that filtering
   * can smear outward past the silhouette. */
  col = mix(col, vec3(0.058, 0.094, 0.046),
            sstep(0.84, 0.905, r) * sstep(0.945, 0.900, r) * 0.55);
  col = mix(col, vec3(0.158, 0.182, 0.096),
            sstep(0.56, 0.83, r) * sstep(0.92, 0.82, r) * 0.30);
  /* Chlorosis: the yellowing halo that spreads well beyond the dead tissue.
   * Held down in chroma on purpose. These blotches are the only warm marks in
   * an otherwise entirely green frame, so the eye finds every one of them, and
   * at full saturation a stand of understory leaves reads as a scatter of
   * orange stickers rather than as damage. */
  col = mix(col, vec3(0.228, 0.208, 0.100), sstep(0.0, 0.22, dmg + bite) * 0.30);
  col = mix(col, vec3(0.130, 0.084, 0.044), necro * 0.95);  // brown where chewed
  col = mix(col, vec3(0.124, 0.142, 0.108), epi * 0.36);    // grey-green crust
  col = mix(col, vec3(0.086, 0.100, 0.062), epiSpot * 0.55);
  /* The pucker shows in the albedo as well as the normal, faintly. Relief that
   * exists only in the normal map disappears the moment a surface faces away
   * from every light, which under this canopy is most of them — and a blade
   * whose colour is perfectly smooth between its veins is the last thing here
   * that still says "painted". */
  col *= 1.0 + crinkle * 0.055 + (retic - 0.25) * 0.05;
  // Roughly a third of the individuals carry a pale flush of new growth.
  float flush = step(0.66, fract(seed * 0.371));
  col = mix(col, vec3(0.174, 0.164, 0.100), sstep(0.78, 1.0, t) * 0.24 * flush);

  /* Colour outside the blade is not "don't care", and assuming it was is what
   * put a hard pale rim on every leaf in the frame.
   *
   * The damage terms are driven by r, the distance from the midrib in
   * half-widths, and r saturates at 1 everywhere off the leaf — so the whole
   * transparent region of every cell was baking at maximum chlorosis and
   * maximum bite, a light tan around 0.5 sRGB. Alpha hides it in the atlas
   * dump, but it is still there in the RGB, and every bilinear tap across the
   * silhouette mixes it into the visible texels. Against a leaf that sits near
   * 0.05 that tan is a ten-to-one step, which is why it read as white and why
   * it survived turning every light in the scene off. Mip generation weights
   * colour by alpha and so never saw it; the base level is where it lives.
   *
   * Flooding the outside with the blade's own body colour makes the bleed a
   * no-op instead of a highlight. Hole interiors get it too, which is what we
   * want — their necrotic rims are inside the silhouette and survive. */
  col = mix(body, col, blade);

  alb = col;

  h = 0.5 + midrib * 0.38 + vein * 0.13 + retic * 0.06 + puff * 0.16
    - necro * 0.10 + (mott - 0.5) * 0.04 + crinkle * 0.055;

  /* Cuticle. A healthy leaf is waxed and reflects hard; dead tissue and the
   * dusty older blades do not, and that contrast is most of what separates a
   * living plant from a fake one under a moving light. */
  /* Gloss is per leaf type, not global.
   *
   * A broad aroid blade has a thick waxy cuticle and throws a sharp, oily
   * highlight; a fern frond and a grass blade do not, they are matte and
   * slightly hairy. Setting one roughness for all of them means choosing
   * between plastic aroids and mirror-finish ferns, and the mirror ferns are
   * worse — a dense mass of small facets at low roughness catches the sky on
   * every one of them and the whole plant goes white.
   *
   * The floor came up from 0.26 after the mid-distance was found to be full of
   * hard white sparkle: a leaf a pixel across still gets a full-strength
   * mirror lobe, and thousands of them at random orientations is specular
   * aliasing, not foliage. The material clamps roughness upward with mip level
   * as well, but starting from a slightly duller cuticle costs nothing in the
   * foreground and removes most of it. */
  /* Tightened for the waxy blades only. The highlight on the near aroids was
   * a broad soft sheen spread over most of a leaf, which is the response of a
   * matte dielectric, not of a cuticle — a real waxed blade throws a small
   * hard spot and is dark everywhere else, and that concentration is what
   * makes the surface read as coated rather than as painted. The matte end
   * (ferns, grass) is untouched: those genuinely are hairy and diffuse, and
   * dragging them down with the aroids is how a frond mass turns into a sheet
   * of white sparkle. The mid-distance guard is elsewhere and unchanged —
   * LOD_DAMP forces roughness toward 0.94 with the mip footprint — so buying
   * a tighter lobe here costs nothing beyond the near field. */
  float wax = (id == 0 || id == 3) ? 0.0 : (id == 1 ? 0.5 : 1.0);
  rough = mix(mix(0.25, 0.45, mott * mott), mix(0.51, 0.77, mott), wax);
  rough = mix(rough, 0.88, necro);
  rough = mix(rough, 0.64, midrib * 0.5);
  /* The epiphyll crust is the thing that breaks up the highlight. A uniform
   * cuticle gives one broad even sheen across the whole blade — gloss paint —
   * whereas a real leaf's highlight is torn into patches by whatever is
   * growing on it. */
  rough = mix(rough, 0.92, epi * 0.75 + epiSpot * 0.6);
  rough = mix(rough, rough * 0.82, sstep(0.55, 1.0, mott) * (1.0 - wax) * 0.8);
  // The pucker between the veinlets tears the highlight up at grazing angles,
  // which is the difference between a wet leaf and a wet sheet of plastic.
  rough = clamp(rough * (1.0 + crinkle * 0.16), 0.05, 1.0);

  /* Thin tissue between the veins is what glows when backlit — and the
   * thinnest tissue on a leaf is the last few millimetres before the margin,
   * so that is where it glows hardest. Worth stating explicitly because it is
   * the exact inverse of the artefact this pass removed: a backlit leaf
   * should be ringed in light, not in shadow, and once the edge stops being
   * darkened it may as well carry the cue that belongs there. */
  // The base level is held so the margin boost cannot drive the byte channel
  // into its ceiling, where the gradient this line exists to create would be
  // flattened straight back out; the material's uTrans carries the scale.
  trans = cov * (0.71 - 0.49 * midrib - 0.27 * vein) * (0.55 + 0.45 * (1.0 - mott))
        * (1.0 + 0.40 * sstep(0.55, 0.94, r));
}

void main(){
  vec3 alb; float a, h, rough, trans;
  leafSurf(vUv, alb, a, h, rough, trans);
  if(uChannel == 0){
    gl_FragColor = vec4(alb, a);
  } else if(uChannel == 1){
    vec3 dA; float aA, hL, hR, hD, hU, dR, dT;
    leafSurf(vUv - vec2(uTexel, 0.0), dA, aA, hL, dR, dT);
    leafSurf(vUv + vec2(uTexel, 0.0), dA, aA, hR, dR, dT);
    leafSurf(vUv - vec2(0.0, uTexel), dA, aA, hD, dR, dT);
    leafSurf(vUv + vec2(0.0, uTexel), dA, aA, hU, dR, dT);
    gl_FragColor = vec4(heightToNormal(hL, hR, hD, hU, uNormalStrength), 1.0);
  } else {
    // Roughness lands in .g so three's own roughnessMap path reads it with no
    // patching; .r is translucency, picked up by the injected transmission.
    gl_FragColor = vec4(trans, rough, 0.0, a);
  }
}
`;

/* Bark.
 *
 * Tiles vertically around a trunk, so the period is anisotropic: fissures run
 * along the trunk and must wrap in the round, which means the u period is the
 * number of times the map goes around and the v period is set independently.
 * The callers scale their UVs so one wrap of this map is roughly a metre and
 * a half of real bark in both directions, whatever the trunk's actual girth —
 * a fixed span stretched a two-metre bole's texture to four times the size of
 * a sapling's, and a trunk with metre-wide fissures reads as a redwood.
 *
 * Tropical bark is mostly thin, smooth and pale — the deeply furrowed oak-bark
 * default is a temperate look and reads wrong here — but it is never clean.
 * Lichen crusts, algal green film on the wet side, and moss in every crevice
 * are what actually cover it.
 */
export const BARK = /* glsl */ `
float unit(float v){ return v * 0.5 + 0.5; }

/* The crack distance field, factored out of surf() because the mask needs its
 * *gradient* as well as its value.
 *
 * A Worley border is a complete polygonal tessellation: every cell is closed,
 * so every vertical border is joined to the next by a roughly horizontal one.
 * That is the whole difference between bark and crazed glaze, and no amount of
 * stretching removes it — a ten-to-one cell is still a closed cell, it is just
 * a tall one. The horizontal joins have to be deleted specifically, which
 * means knowing which way the border is running at each point, which means
 * differencing this field. Both scales come back together so one set of taps
 * serves both.
 *
 * x = the primary split network, y = the finer net that branches off it.
 */
vec2 crackD(vec2 p){
  vec2 wob = vec2(pnoise(p * vec2(2.0, 0.5), vec2(16.0, 12.0)),
                  pnoise(p * vec2(3.0, 0.75) + 17.0, vec2(24.0, 18.0)));
  /* Nine to one along the grain, up from four. Bark splits because the trunk
   * is growing in girth, so a split runs along the fibre and essentially never
   * across it. */
  vec2 cp = vec2(p.x * 2.25, p.y * 0.0833333) + wob * vec2(0.42, 0.05);
  vec2 c1 = pworley(cp, vec2(18.0, 2.0));
  vec2 c2 = pworley(cp * 2.0 + 11.0, vec2(36.0, 4.0));
  return vec2(c1.y - c1.x, c2.y - c2.x);
}

/* Fibre, which is a different thing from the streak field below and is the
 * thing that went missing.
 *
 * The round that sharpened the fissure network and gave the bole its
 * half-metre weathering patches left a surface made entirely of *soft*
 * fields — broad, tone, streak and fine are all fbm, and fbm at low amplitude
 * is airbrush. The verdict came back "airbrushed or putty-like", which is
 * precisely what a surface with no hard, narrow, parallel features on it
 * looks like however much low-frequency variation it carries. Wood is bundles
 * of cells a few millimetres across running the whole length of the trunk,
 * and bark carries that structure whether it is fissured or smooth; the eye
 * identifies wood from it before it identifies anything else.
 *
 * Three octaves rather than one, and they are chosen by *what survives at
 * what distance* rather than for the usual fractal reasons. Something on this
 * surface has to still be fibrous at every range a trunk is seen from, and a
 * single pitch is fibre at one distance and either mush or aliasing at the
 * others. The coarse band runs at about seven centimetres of real bark, which
 * is a strand still several pixels wide from across the clearing; the finest
 * is a centimetre and a half, for when a walker is standing at the tree. A
 * previous attempt at bark structure lived entirely at six centimetres and
 * was gone from the mip chain by three metres, which is the failure this
 * ladder exists to avoid.
 *
 * Ridged rather than plain, because the point is *narrow* features. A Perlin
 * octave taken straight is a smooth swell and stacking three of them gives
 * more airbrush; folding each at zero turns every zero crossing into a crease
 * and makes the field a set of thin lines with wide flats between, which is
 * what a grained surface is. Folding is safe here where it is not safe for a
 * coverage mask: nothing is being thresholded, so the pile-up against 1 that
 * makes a ridged fbm useless as a selector is simply where the flats of the
 * grain live.
 */
float fibGrain(vec2 p){
  return 0.52 * (1.0 - abs(pnoise(vec2(p.x *  3.0, p.y * 0.125), vec2( 24.0,  3.0))))
       + 0.30 * (1.0 - abs(pnoise(vec2(p.x *  7.0, p.y * 0.25) + 13.0, vec2( 56.0,  6.0))))
       + 0.18 * (1.0 - abs(pnoise(vec2(p.x * 15.0, p.y * 0.50) + 29.0, vec2(120.0, 12.0))));
}

void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  // u wraps once, v repeats along the length. Both are scaled by the caller.
  vec2 p = uv * vec2(8.0, 24.0);

  /* Weathering at the scale of the trunk itself, and its absence is what the
   * word "noisy" in the critique was pointing at.
   *
   * Everything else on this surface lives between one and ten centimetres:
   * the fissure network, the plates, the grit. That is the band the eye
   * discards first, so a bole covered in it has plenty of variance and no
   * *form* — at three metres it averages back to one swatch with a fizz on
   * it. Real bark carries half-metre patches that differ in value because
   * they were wetted, shaded, scarred or colonised at different times, and
   * those patches are what a trunk's roundness and its history are read
   * from. This field is deliberately the coarsest thing in the map, and it is
   * computed first because the crack network is gated on it as well. */
  float broad = unit(pfbm(p * vec2(0.5, 0.125), vec2(4.0, 3.0), 3));
  float fib = fibGrain(p);

  /* The crease network is cut from a Worley cell border rather than from
   * ridged fbm, and the reason is distributional, not aesthetic.
   *
   * One-minus-abs of an fbm peaks wherever the underlying field crosses zero, and a
   * normalised multi-octave fbm is a sum of independent terms, so it is
   * roughly Gaussian and spends nearly all of its time close to its mean. The
   * ridge value therefore piles up hard against 1 with a very thin tail below,
   * and *any* threshold on it selects either almost none of the surface or
   * almost all of it — there is no setting that yields "a fifth". Two
   * successive passes moved that ramp and both landed on the same plateau,
   * with a mask covering most of the bole and dragging it toward the dark end
   * of the palette; the bake read back as one flat mid-grey with no crease
   * structure in it at all.
   *
   * A Worley border has no pile-up. The fraction of the plane within distance
   * d of a cell boundary is proportional to d, so the threshold below is a
   * direct dial on what share of the bark is crease and it stays where it is
   * put. That property is worth keeping and everything below is built around
   * it — but a cell border on its own is a *closed* diagram, and closure is
   * what made the last bake read as cracked stone rather than as wood. Three
   * separate things are done to open it up. */
  vec2 d0 = crackD(p);
  /* Forward differences, not central ones, and the distinction matters here.
   * This field is a distance to the border, so it has a minimum *on* the
   * border and a central difference straddling one cancels to nothing — the
   * measurement would vanish at exactly the points it is needed. A forward
   * difference climbs out of the valley in each direction instead, so a
   * vertical crack returns a large x and a near-zero y. The offsets are both
   * about eight millimetres of real bark, which is what makes the two
   * components comparable despite p itself being three to one. */
  vec2 dX = crackD(p + vec2(0.042, 0.0));
  vec2 dY = crackD(p + vec2(0.0, 0.128));
  vec2 gx = abs(dX - d0), gy = abs(dY - d0);
  /* How vertically the border is running at this point, per scale. */
  float vC = gx.x / (gx.x + gy.x + 1e-6);
  float vF = gx.y / (gx.y + gy.y + 1e-6);
  /* And here the polygons are deleted. Every closed cell is closed by a
   * roughly horizontal border, and those borders are the entire crazed-glaze,
   * reptile-skin, dried-mud signature — a real bark fissure runs with the
   * fibre and terminates, it does not turn ninety degrees to meet its
   * neighbour. Weighting the mask by verticality keeps the long splits and
   * removes the joins between them, which is what turns a tessellation into a
   * set of separate cracks. It is also self-reinforcing at the ends: a crack
   * that curves away toward the horizontal fades out as it does so, which is
   * exactly how a split peters out in life. */
  float dirC = sstep(0.34, 0.74, vC);
  float dirF = sstep(0.30, 0.68, vF);

  /* Width that varies along the crack. A constant-width line is a drawn one;
   * a split opens and closes along its length as it follows the grain. */
  float wid = 0.058 + 0.130 * unit(pfbm(vec2(p.x * 1.5, p.y * 0.25) + 23.0,
                                        vec2(12.0, 6.0), 3));
  float f1 = sstep(wid, wid * 0.06, d0.x);
  float f2 = sstep(0.052, 0.004, d0.y);

  /* Termination. Even after the horizontal joins are gone the verticals still
   * run the full height of a cell, and a set of full-length parallel lines is
   * its own kind of pattern. This knocks quarter-metre holes in the network so
   * cracks start and stop without reference to where the lattice thinks they
   * should. */
  float brk = sstep(0.24, 0.62, unit(pfbm(vec2(p.x * 0.75, p.y * 0.25) + 43.0,
                                          vec2(6.0, 6.0), 3)));

  /* Gated on the coarse weathering field so the net is not equally strong
   * everywhere. Real fissuring is regional: it opens up where the trunk has
   * grown fastest or stayed wettest and fades to nearly smooth elsewhere, and
   * letting whole areas go quiet is what stops the pattern from being read as
   * a pattern. */
  float fissure = max(f1 * dirC * brk,
                      f2 * dirF * 0.55 * sstep(0.40, 0.86, brk));
  fissure = min(1.0, fissure * (0.26 + 1.00 * sstep(0.18, 0.80, broad)));

  /* The lip either side of a split, and it is the single most wood-like thing
   * on this surface. Bark does not crack like a glaze — it is a living tissue
   * being torn apart from underneath, so the material each side of a fissure
   * is lifted, worn and *paler* than the flat of the plate. Painting only the
   * dark line leaves a mark drawn on a smooth surface, which is a crack in
   * rock; painting the pale shoulder with it makes the same line read as two
   * pieces of a split shell, and it doubles the apparent grain direction for
   * nothing because it inherits the verticality weight. */
  float shoulder = sstep(wid * 3.6, wid * 1.30, d0.x) * dirC * brk * (1.0 - f1);

  // Plates that shed. Worley stretched the same way, so the flakes are long.
  vec2 wp = pworley(vec2(p.x * 0.9, p.y * 0.30), vec2(7.0, 7.0));
  float plate = sstep(0.02, 0.16, wp.y - wp.x);
  // The edge of a shed plate is a step, not a slope, and those hard little
  // shadow lines are most of what says "bark" at three metres.
  float plateEdge = sstep(0.10, 0.0, wp.y - wp.x);

  float fine = unit(pfbm(p * vec2(3.0, 1.2), vec2(24.0, 29.0), 4));
  /* The tone the bark's base colour rides on, and its period is the whole
   * point of it.
   *
   * The base mix used to be driven by the fine field, which runs at twenty-four
   * cycles across a metre and a half — a six-centimetre feature. That is
   * below the resolution a trunk is ever seen at: by three metres it is a
   * couple of pixels and the mip chain has averaged the entire pale-to-grey
   * interval back to its own mean. So the largest tonal range in the map was
   * being spent at a scale where none of it survived, and what reached the
   * eye was one flat value with the crack network drawn on it — which is not
   * only the featureless-bole complaint, it is half of why the cracks read as
   * lines scored into a smooth material. Something has to be varying at the
   * scale of a hand for the fissures to look like they belong to a surface.
   * Twice as tall as it is wide, because everything on a bole is. */
  float tone = unit(pfbm(vec2(p.x * 1.5, p.y * 0.25) + 5.0, vec2(12.0, 6.0), 4));
  float grit = unit(pfbm(p * vec2(11.0, 5.0), vec2(88.0, 120.0), 3));
  // Horizontal lenticel scars, a strong tell for smooth tropical bark.
  float lent = sstep(0.86, 1.0, unit(pnoise(vec2(p.x * 6.0, p.y * 30.0), vec2(48.0, 720.0))));

  /* Now that the mask genuinely selects the crack and not the bark, the sign
   * of its contribution has to flip: a fissure is a groove. It read as a
   * ridge before and nobody could tell, because it covered everything. */
  height = (1.0 - fissure) * 0.62 + (1.0 - plate) * 0.18 + fine * 0.14
         + grit * 0.06 - plateEdge * 0.22 - lent * 0.10;
  /* Grain relief. On a standing bole this does nothing — see the note beside
   * the albedo term — but the same map is on every fallen log, root and
   * branch in the forest, and those are horizontal, so their normals do have
   * a y component for the hemisphere to work on. Free on the trunks and worth
   * having everywhere else. */
  height += (fib - 0.5) * 0.11;

  /* Tropical bark is pale, and this map was pale and *neutral*, which turned
   * out to be the other half of the stone problem.
   *
   * Measuring the last bake settled an argument that was being had in the
   * abstract. Its albedo ran from 105 to 150 out of 255 across the entire
   * map — a flatter surface than anything in this project — so the theory
   * that near-black fissures were fighting pale bark was simply not true;
   * there was no tonal contrast to remove. What the map had instead was a
   * mean saturation under ten per cent and, more tellingly, the *same* hue
   * everywhere: the darkest tenth of the surface, the median and the lightest
   * tenth all sat within two points of the same red-minus-blue. A surface
   * whose light and dark differ only in value is a surface whose pattern is
   * shading, and shading-shaped pigment on a smooth field is what stone is.
   * By the time it reached the screen even that trace of warmth was gone —
   * the buttress plates measured *blue* of neutral.
   *
   * So the fix is chromatic rather than tonal. The tonal range is left shallow
   * and is in fact narrowed slightly; what widens is the hue interval. The
   * flat of a plate is a weathered buff-grey, and the inside of a split is
   * inner bark — sheltered from the sun and the rain, so it keeps the warm
   * saturated ochre that the exposed face has lost. That difference in
   * *colour* between the crack and the field, rather than merely in darkness,
   * is what no rock does and every tree does. */
  vec3 pale = vec3(0.372, 0.312, 0.212);
  vec3 grey = vec3(0.224, 0.176, 0.110);
  vec3 dark = vec3(0.122, 0.075, 0.038);
  /* The ramp is here because the raw noise spends nearly all of its range in
   * the middle third, so without it the bole comes out as one value with a
   * suggestion of marbling in it. Spreading the field across the whole
   * pale-to-grey interval is what makes this the large-scale value break that
   * still exists at three metres — now that the field it is spreading is one
   * that still exists at three metres. */
  vec3 col = mix(grey, pale, sstep(0.28, 0.78, tone));
  // and the six-centimetre field it used to ride on, kept as what it is
  col *= 0.90 + 0.20 * fine;
  /* Pointed at a warmer dark rather than a deeper one. The split is still the
   * darkest thing on the bark, but it is now also the most saturated thing on
   * it, and the second half of that pair is what carries the read — the same
   * depth of mix against a neutral dark was stone and against this one is not.
   *
   * The depth itself went down and then came back up. Cutting it alongside
   * every other change at once overshot into the *previous* failure: the
   * fissures stopped being legible at three metres and the bole went back to
   * being a featureless wall, which is the fault this whole sequence started
   * from. Contrast was never the thing that made it stone. */
  col = mix(col, dark, fissure * 0.72);
  /* The torn lip either side of the split — see the shoulder mask above. This
   * is where the contrast that was taken out of the dark end is spent
   * instead, and it buys more legibility per unit of it, because a light line
   * against a mid field beside a dark one is two edges rather than one. */
  col = mix(col, pale * vec3(1.20, 1.15, 1.04), shoulder * 0.42);

  col *= 0.76 + 0.50 * sstep(0.18, 0.86, broad);

  /* Plate-to-plate tone. Bark sheds in scales and the freshly exposed surface
   * under one is lighter than the weathered scale beside it; without this the
   * plates only ever differ by their edge shadow, which is the one part of
   * them that minifies away first. Kept far below the value it used to carry:
   * a pale plate against dark bark at forty per cent is not a plate, it is a
   * dot, and a field of dots at one pitch is the "uniform pale speckling" the
   * critique found on every trunk in frame. */
  float plateTone = unit(pfbm(vec2(p.x * 0.9, p.y * 0.30) + 53.0, vec2(7.0, 7.0), 2));
  col = mix(col, pale * 1.06, sstep(0.58, 0.96, plateTone) * plate * 0.16);
  /* Long grain running up the bole, independent of the crease network.
   *
   * Sharpening the fissures into a thin network left the trunk with blotches
   * and creases and no *direction* at all, which is a surprisingly large loss:
   * the thing that says "vertical wooden column" before any detail resolves is
   * that all of its value variation is stretched along one axis. This is the
   * same field the fissures are cut from, at a much lower amplitude and a much
   * longer stretch, so the two agree about which way is up. */
  float streak = unit(pfbm(vec2(p.x * 2.25, p.y * 0.125), vec2(18.0, 3.0), 4));
  col *= 0.84 + 0.34 * streak;

  /* The fibre stack, spent where it can actually be seen — and putting it in
   * albedo is not a stylistic choice.
   *
   * The obvious home for grain is the normal map, and it was tried and it is
   * provably invisible: zeroing normalScale on the wood material produced a
   * pixel-identical frame. The dominant light on a trunk here is a
   * hemisphere, whose contribution depends only on the normal's y component,
   * and a vertical trunk's surface normals lie in the xz plane — so
   * perturbing them moves the two axes the light cannot see. Any structure on
   * a bole has to be pigment. */
  col *= 0.82 + 0.36 * fib;
  /* And the grain is warmer in the grooves for the same reason the fissures
   * are: the flat of a fibre bundle is the weathered outside and the crease
   * between two of them is sheltered. Doing it in hue as well as value is
   * what keeps a striped surface from reading as striped stone. */
  col = mix(col * vec3(1.05, 0.99, 0.90), col, sstep(0.34, 0.80, fib));
  /* And the grain carries hue as well as value, which is the part that was
   * missing. Value-only striping is a greyscale pattern multiplied over a
   * surface — it survives on marble and slate perfectly well. Wood's long
   * streaks are differences in *what the material is*: older, drier, more
   * weathered fibre beside fresher fibre, so the pale runs go cooler and
   * greyer while the sheltered ones stay ochre. Swinging the hue on the same
   * field the value uses costs nothing and it is the difference between a
   * striped stone and a grained one. */
  col = mix(col * vec3(1.06, 1.00, 0.88), col * vec3(0.94, 0.98, 1.06),
            sstep(0.30, 0.78, streak));
  col *= 0.90 + 0.20 * grit;

  /* Epiphytes, and the thing that had to change is that they were *evenly
   * distributed*.
   *
   * Both previous lichen terms were a single ramp on a single fbm, which puts
   * a patch every wavelength over the entire trunk with nothing like a bare
   * area anywhere. At the pitch the finer of the two was running — about ten
   * centimetres — that is not a colony of anything, it is a stipple, and it
   * was the "uniform pale speckling covering dark cylinders" in the critique.
   * The pattern is also wrong in kind: crustose lichen spreads outward from
   * where a spore happened to land, so a trunk carries a few colonies tens of
   * centimetres across with hard irregular rims, and long stretches of bare
   * bark between them.
   *
   * Two fields do that: a coarse mask that decides *where there is a colony
   * at all*, and a fine one that gives the crust inside it its texture and
   * its ragged edge. Multiplying them means the fine field can no longer put
   * anything on the four fifths of the bole the coarse one has excluded. */
  /* Colonies about a third of a metre across. The first attempt at this ran
   * the coarse mask at the same period as the bark's own weathering field,
   * which put single lichen patches nearly two metres wide on a bole — from
   * six metres away that is not a colony, it is a differently coloured tree.
   * The scale that reads as "colonised" is the one where several patches fit
   * across the visible face of a trunk with bare bark between them. */
  float colony = sstep(0.44, 0.74, unit(pfbm(p * vec2(0.5, 0.25) + 31.0, vec2(4.0, 6.0), 3)));
  float crust = unit(pfbm(p * vec2(1.5, 0.5) + 7.0, vec2(12.0, 12.0), 4));
  float lichen = sstep(0.48, 0.62, crust) * colony;
  /* Foliose lichen and moss-cushion rosettes: bigger, rarer, and sitting on
   * the rim of a crust colony rather than scattered independently of it,
   * which is where they actually grow. */
  vec2 lw = pworley(p * vec2(0.75, 0.25) + 5.0, vec2(6.0, 6.0));
  float foliose = sstep(0.34, 0.12, lw.x)
                * sstep(0.30, 0.62, unit(pfbm(p * vec2(0.25, 0.125) + 71.0, vec2(2.0, 3.0), 2)));
  /* Distinctly paler than the bark under it, which is the opposite of the
   * instinct after a round spent removing pale speckle. Crustose lichen really
   * is much lighter than wet bark, and hiding it by matching its value simply
   * deletes it. What made the old version read as noise was its *pitch* — a
   * patch every ten centimetres over the whole bole — not its brightness. At
   * half-metre colonies with bare bark between them the same contrast reads as
   * a colonised trunk, and it is the only thing on this surface that varies at
   * a scale still legible from across the trail. */
  /* Pulled off neutral. The value was right and the hue was not: a pale patch
   * at 0.428 in all three channels is the brightest thing on the trunk and it
   * was perfectly achromatic, so it was setting the white point of the whole
   * bole to grey and dragging everything else toward stone by comparison.
   * Crustose lichen is not grey — it is a chalky sulphur-celadon, and the
   * greenish cast is what keeps it reading as something growing on wood. */
  col = mix(col, vec3(0.408, 0.404, 0.298) * (0.72 + 0.52 * crust), lichen * 0.58);
  col = mix(col, vec3(0.286, 0.310, 0.222) * (0.80 + 0.40 * fine), foliose * 0.38);

  /* Algal film. Unlike the lichen this genuinely is a wash — it is a
   * single-celled layer that grows anywhere that stays wet — so a soft,
   * low-frequency mask is the right shape for it. It is the term that keeps
   * the bark from reading as grey stone. */
  /* Trimmed a little and warmed. The premise stands — algal film is what
   * keeps damp bark from reading as stone — but the previous strength was set
   * while the bark under it was neutral, and a green wash over a neutral field
   * makes green-grey, which is a rock colour too. Over a surface that is now
   * genuinely ochre it can afford to do less. */
  float algae = sstep(0.42, 0.80, unit(pfbm(p * vec2(0.375, 0.875) + 61.0, vec2(3.0, 21.0), 3)));
  col = mix(col, vec3(0.132, 0.150, 0.078), algae * 0.28);

  float moss = sstep(0.46, 0.86, unit(pfbm(p * vec2(0.875, 0.833) + 91.0, vec2(7.0, 20.0), 4)))
             * sstep(0.30, 0.80, fissure);
  float mossFine = unit(pfbm(p * vec2(7.0, 7.0), vec2(56.0, 168.0), 3));
  col = mix(col, vec3(0.060, 0.118, 0.040) * (0.65 + 0.70 * mossFine), moss * 0.88);
  height += moss * 0.26 * mossFine + lichen * 0.10 * crust + foliose * 0.14;

  albedo = col;
  /* Bark under a rainforest canopy is damp, and damp is not matte.
   *
   * This surface was 0.90 to 0.99 everywhere, which is a chalk finish — it has
   * no specular response at all, so the only thing that could vary across a
   * bole was its albedo, and a surface whose entire appearance is its albedo
   * is a surface with no material to it. Bringing the flat of the plate down
   * to a soft broad sheen gives the trunk a way to respond to where the light
   * is coming from without adding any light, which is most of the answer to
   * "the image is flat" that is available inside a material.
   *
   * The ordering is deliberate: bark sheens, the split inside it does not
   * (it is rotten fibre and shadow), the torn lip does not (it is frayed),
   * moss does not, and lichen is the most matte thing on the tree because it
   * is literally chalk. Separating them by *response* as well as by value is
   * the other half of what stops a trunk reading as one carved object. */
  rough = mix(0.78, 0.97, fissure);
  /* The grain again, in the one channel besides albedo that a hemisphere
   * light can still see. Roughness changes how broad the sheen on a damp
   * trunk is, and broadening it along the creases between fibre bundles gives
   * the grain a second, view-dependent existence that the albedo term alone
   * cannot — so the structure does not vanish the moment a trunk is lit flat.
   * Small, because this surface is damp bark and not a polished board. */
  rough -= 0.11 * (fib - 0.5);
  rough = mix(rough, 0.95, shoulder * 0.7);
  rough = mix(rough, 1.0, moss);
  rough = mix(rough, 0.94, lichen * 0.7);
  ao = 1.0 - fissure * 0.46 - moss * 0.16 - plateEdge * 0.16;
}
`;

export const LEAF_PRELUDE = SSTEP;
