/* Ground surface definitions.
 *
 * Three tiling PBR sets cover the whole level: the worn dirt of the trail, the
 * leaf litter of the forest floor, and wet rock for the cliff and anything
 * steep. Moss is deliberately *not* a fourth set — real moss is a film that
 * grows over whatever is underneath, following moisture rather than replacing
 * the surface, so it is applied as a tint and roughness change in the terrain
 * shader instead of as its own texture.
 *
 * Each export is the body of a `surf()` as described in gfx/bake.js.
 *
 * TILING CONTRACT — every one of these has to repeat across a hillside, so:
 * all three work in a common cell space `p = uv * 8`, and every noise call
 * passes a period exactly equal to the scale applied to p. Anisotropic scales
 * pass a vec2 period. Get this wrong and the map still looks fine in
 * isolation, then seams visibly the moment it repeats.
 */

const HELP = /* glsl */ `
float contrast(float x, float k){
  x = clamp(x, 0.0, 1.0);
  return x <= 0.5 ? 0.5 * pow(2.0 * x, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), k);
}
float unit(float x){ return x * 0.5 + 0.5; }
`;

/* ── Trail dirt ─────────────────────────────────────────────────────────────
 * A jungle trail is not soil, it is soil that has had the soil walked off it:
 * compacted clay with the loose material pushed to the sides, gravel and root
 * lifted proud by rain, and water standing in the low spots for most of the
 * year. The puddles are the important part — they are what makes ground look
 * wet rather than just dark, because they are smooth where everything around
 * them is rough, and that roughness contrast is what the eye actually reads.
 */
export const DIRT = HELP + /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;

  /* Broad tonal masses first, detail second.
   *
   * Compacted trail soil varies over half a metre or more — a dry pale lane
   * here, a dark damp patch there, a smear of clay pushed sideways. Detail
   * noise scattered evenly over a constant base colour is what makes CG dirt
   * look like sandpaper: the grain is fine but the *masses* are missing, and
   * the masses are what the eye reads first.
   */
  float mass   = unit(pfbm(p * 0.5, 4.0,  3));
  float clay   = unit(pfbm(p,       8.0,  5));
  float coarse = unit(pfbm(p * 4.0, 32.0, 4));

  // Gravel. Second-nearest minus nearest is the cell border; the nearest
  // distance on its own gives blobs, not stones. Density is modulated by the
  // mass field so the stone is exposed in patches rather than everywhere,
  // which is how a worn surface actually wears.
  /* Gravel has to be sparse and clumped, and the size has to vary.
   *
   * A Worley cell field thresholded at a constant radius puts one stone of one
   * size in every cell, and even with jitter that is a lattice: the eye reads
   * it as evenly-spaced pepper, which is the single loudest tell a procedural
   * dirt texture has. Two things fix it. The exposure mask is narrow, so grit
   * shows through in a few worn patches instead of over the whole surface. And
   * the threshold radius is itself noise-driven, so cells produce stones of
   * different sizes and many produce none at all.
   */
  float gravelly = sstep(0.58, 0.86, mass);
  float sizeVar = unit(pfbm(p * 3.0, 24.0, 3));
  vec2 w1 = pworley(p * 6.0, 48.0);
  float pebble = sstep(0.16 + 0.26 * sizeVar, 0.04, w1.x) * gravelly;
  vec2 w2 = pworley(p * 2.0, 16.0);
  float pebbleBig = sstep(0.10 + 0.20 * (1.0 - sizeVar), 0.02, w2.x) * gravelly;

  /* Roots crossing the trail. Long across the path, thin along it — hence the
   * 6:1 anisotropy, and hence the vec2 period that keeps it tiling. Two bands
   * at different thicknesses, because a root system is a few thick runners
   * with many thin ones branching off, not one uniform width. */
  float rootA = unit(pfbm(vec2(p.x * 0.5, p.y * 3.0), vec2(4.0, 24.0), 3));
  float rootB = unit(pfbm(vec2(p.x * 1.0, p.y * 8.0), vec2(8.0, 64.0), 3));
  float root = max(sstep(0.56, 0.80, rootA), sstep(0.68, 0.88, rootB) * 0.6);

  height = clay * 0.34 + coarse * 0.12 + pebble * 0.22 + pebbleBig * 0.30 + root * 0.62;

  // Standing water sits in whatever is lowest, so the puddle mask is derived
  // from the height field rather than an independent noise. That correlation
  // is most of why it reads as water and not as a stain.
  float basin = unit(pfbm(p * 0.5, 4.0, 4));
  float wet = contrast(sstep(0.58, 0.26, height + basin * 0.5), 1.7);

  /* Tropical trail soil is dark. It is lateritic clay that is damp essentially
   * all the time under closed canopy, and it reads as a deep red-brown, not as
   * the pale dust of a temperate footpath. Getting this value wrong is what
   * makes the trail look like poured concrete running through the forest.
   */
  vec3 dry   = vec3(0.232, 0.160, 0.104);
  vec3 damp  = vec3(0.128, 0.086, 0.058);
  vec3 soak  = vec3(0.052, 0.040, 0.032);
  vec3 stone = vec3(0.255, 0.244, 0.222);

  albedo = mix(dry, damp, contrast(clay, 1.4));
  // The mass field again, this time as tone: drier compacted lanes against
  // darker, wetter, looser ground.
  albedo *= 0.74 + 0.52 * mass;
  albedo = mix(albedo, stone, pebble * 0.55 + pebbleBig * 0.35);
  albedo = mix(albedo, vec3(0.186, 0.124, 0.072), root * 0.85);
  albedo = mix(albedo, soak, wet * 0.88);

  // Organic debris trodden into the surface.
  float bits = sstep(0.70, 0.90, unit(pfbm(p * 8.0, 64.0, 3)));
  albedo = mix(albedo, vec3(0.204, 0.148, 0.070), bits * 0.28);

  /* Burnish.
   *
   * Where boots land repeatedly the clay is not just compacted, it is
   * polished: the fine particles are smeared into a continuous skin with the
   * grit pressed below the surface. Those patches are smooth and slightly
   * glossy while everything around them is rough, and that patchwork of sheen
   * is what a photograph of a used trail actually shows. Flattening the height
   * here as well means the normal map loses its grain in the same places.
   */
  float burnish = sstep(0.62, 0.88, unit(pfbm(p * 1.5, 12.0, 3))) * (1.0 - wet);
  height = mix(height, mix(height, 0.45, 0.7), burnish);

  rough = mix(0.94, 0.12, wet);
  rough = mix(rough, 0.66, burnish * 0.8);
  albedo = mix(albedo, albedo * 0.82, burnish * 0.5);
  rough = mix(rough, 0.68, pebble * 0.45);
  // Roots are bark, not soil: smoother than the ground they interrupt, and
  // polished where boots have crossed them for years.
  rough = mix(rough, 0.52, root * 0.7);
  ao = 1.0 - wet * 0.30 - (1.0 - height) * 0.35;
}
`;

/* ── Leaf litter ────────────────────────────────────────────────────────────
 * The forest floor is not brown noise. It is a layer of individually visible
 * dead leaves, most of them large, lying at every angle and overlapping, with
 * near-black gaps where the layer is deep. Three scattered-leaf layers at
 * different sizes give the overlap; the leaves that have been down longest are
 * darkest and greyest, so age is tied to the layer.
 */
export const LITTER = HELP + /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;

  /* Five layers, and the size spread between them is the point.
   *
   * A drift of litter is not one population of leaves — it is whole blades on
   * top, half-rotted pieces under them, and a mush of unrecognisable fragments
   * below that. Sampling one leaf size at one density produces a carpet whose
   * every square looks like every other square, which the eye reads as
   * wallpaper no matter how good an individual leaf is. */
  vec4 l0 = leafField(p * 0.5,  vec2(4.0),  41.0, 0.55, 0.46);   // rare big blade
  vec4 l1 = leafField(p,        vec2(8.0),  0.0,  0.60, 0.40);
  vec4 l2 = leafField(p * 1.5,  vec2(12.0), 7.3,  0.58, 0.34);
  vec4 l3 = leafField(p * 2.5,  vec2(20.0), 3.1,  0.66, 0.28);   // fragments
  // The same primitive at extreme aspect ratio gives twigs and leaf stalks.
  vec4 tw = leafField(p * 1.5,  vec2(12.0), 23.9, 0.95, 0.050);

  float soil = unit(pfbm(p * 2.0, 16.0, 5));
  float rot  = unit(pfbm(p * 4.0, 32.0, 4));   // how far gone this patch is

  // Deep humus showing through the gaps between blades.
  vec3 humus = mix(vec3(0.052, 0.042, 0.032), vec3(0.105, 0.084, 0.056), soil);

  /* Palette. The critical entry is the near-charcoal one: leaves that have
   * been wet and down
   * for months go almost to charcoal, and having nothing that dark in the mix
   * is what makes procedural litter read as uniformly tan. */
  vec3 black = vec3(0.078, 0.064, 0.048);
  vec3 old   = vec3(0.176, 0.138, 0.096);
  vec3 mid   = vec3(0.300, 0.214, 0.114);
  vec3 fresh = vec3(0.470, 0.342, 0.156);
  vec3 rust  = vec3(0.404, 0.186, 0.076);
  vec3 olive = vec3(0.214, 0.216, 0.112);

  vec3 col = humus;
  height = soil * 0.18;

  // Oldest and lowest first; each layer paints over the one below.
  col = mix(col, mix(black, old, l3.z * rot),      l3.x);
  height = mix(height, 0.28 + l3.y * 0.08,         l3.x);

  col = mix(col, mix(old, mid, l2.z),              l2.x);
  height = mix(height, 0.44 + l2.y * 0.10,         l2.x);

  col = mix(col, mix(mix(black, mid, rot), rust, l1.z), l1.x);
  height = mix(height, 0.60 + l1.y * 0.12,         l1.x);

  col = mix(col, mix(olive, fresh, l0.z),          l0.x);
  height = mix(height, 0.76 + l0.y * 0.14,         l0.x);

  col = mix(col, vec3(0.132, 0.098, 0.064),        tw.x);
  height = mix(height, 0.90,                       tw.x);

  /* Curl.
   *
   * A dead leaf does not lie flat — it dries unevenly and lifts at the edges,
   * and the raised rim is what catches the light and casts the small hard
   * shadow that says "separate object lying on top of other objects". Pushing
   * the height up near each blade's outline fakes exactly that: the normal map
   * derived from this height then produces a lit rim and a dark line just
   * inside it, all around every leaf.
   */
  float rim = max(max(l1.x - l1.w, l2.x - l2.w), l0.x - l0.w);
  float edge = sstep(0.35, 0.85, rim) * sstep(1.0, 0.55, rim);
  height += edge * 0.22;

  // Midribs catch the light along the blade and are one of the clearest
  // give-aways that these are leaves and not gravel.
  float ribs = max(max(l0.w, l1.w), max(l2.w, l3.w));
  col = mix(col, col * 1.5 + 0.015, ribs * 0.55);
  height += ribs * 0.05;

  // Seedlings and moss finding the light in the gaps.
  float green = sstep(0.62, 0.88, unit(pfbm(p * 3.0, 24.0, 4))) * (1.0 - l0.x * 0.6);
  col = mix(col, vec3(0.080, 0.142, 0.046), green * 0.72);

  albedo = col;
  // Dead leaves keep their waxy cuticle after they fall, so litter is never
  // fully matte — the sheen along the blades is real and quite visible, and it
  // is stronger on the fresher material.
  float blade = max(max(l0.x, l1.x), l2.x);
  rough = mix(0.94, 0.60, blade * 0.85 * (1.0 - rot * 0.5));
  rough = mix(rough, 0.42, green * 0.5);
  // Cavity occlusion. The gaps between blades receive almost no skylight, and
  // the terrain shader leans on this hard — it is what stops the drift from
  // reading as a printed pattern on a flat surface.
  ao = 1.0 - (1.0 - height) * 0.78;
}
`;

/* ── Wet rock ───────────────────────────────────────────────────────────────
 * The cliff and every steep face. Bedding planes give it direction and scale,
 * the aggregate gives it grain up close, and the cracks are where the water
 * runs and therefore where the moss and the dark staining go. Keeping those
 * three correlated is what stops procedural rock from looking like grey noise.
 */
export const ROCK = HELP + /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;

  // Bedding: near-horizontal bands, domain-warped so they are not ruled lines.
  // The warp field tiles on the same lattice, so warping does not break the
  // wrap — at the seam both the coordinate and the warp repeat together.
  float warp = pfbm(p, 8.0, 4) * 1.6;
  float strata = pfbm(vec2(p.x * 0.5, p.y * 3.0 + warp), vec2(4.0, 24.0), 4);
  float bed = abs(strata);

  vec2 agg = pworley(p * 8.0, 64.0);
  float grain = sstep(0.30, 0.0, agg.y - agg.x);

  vec2 blk = pworley(p * 2.0, 16.0);
  float blocks = sstep(0.26, 0.03, blk.y - blk.x);   // joints between blocks

  float chip = unit(pfbm(p * 12.0, 96.0, 3));

  height = 0.5 + strata * 0.26 - blocks * 0.40 - grain * 0.08 + chip * 0.08;

  vec3 pale = vec3(0.400, 0.392, 0.360);
  vec3 dark = vec3(0.150, 0.148, 0.142);
  vec3 warm = vec3(0.300, 0.252, 0.196);

  albedo = mix(dark, pale, contrast(bed, 1.5));
  albedo = mix(albedo, warm, chip * 0.30);
  albedo *= 1.0 - blocks * 0.42;

  // Water tracks down the joints, so the seep follows the crack mask with a
  // vertically-stretched noise on top rather than being independent of it.
  float drip = unit(pfbm(vec2(p.x * 2.0, p.y * 0.5), vec2(16.0, 4.0), 4));
  float seep = sstep(0.35, 0.85, blocks * 0.6 + drip * 0.7);
  albedo *= 1.0 - seep * 0.38;

  // Lichen: pale mineral crust, patchy, only on faces that are not running.
  float lichen = sstep(0.58, 0.82, unit(pfbm(p * 3.0, 24.0, 4))) * (1.0 - blocks);
  albedo = mix(albedo, vec3(0.470, 0.482, 0.395), lichen * 0.45);

  rough = mix(0.88, 0.26, seep);
  rough = mix(rough, 0.95, lichen * 0.6);
  ao = 1.0 - blocks * 0.55 - grain * 0.15;
}
`;

/* Macro variation.
 * Tiling is not defeated by better tiles. However good a 1024 map is, the eye
 * finds the repeat within a couple of periods because the *average* colour of
 * every tile is identical. This map is stretched over hundreds of metres so it
 * never repeats within sight, and multiplying it over the blended albedo makes
 * the large-scale colour vary even where the small-scale detail does not.
 */
export const MACRO = HELP + /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;
  float a = unit(pfbm(p,       8.0,  5));
  float b = unit(pfbm(p * 2.0, 16.0, 4));
  float c = unit(pfbm(p * 0.5, 4.0,  3));
  albedo = vec3(a, b, c);
  height = a; rough = b; ao = c;
}
`;
