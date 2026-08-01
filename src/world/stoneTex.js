/* Stone surface definitions for the ruins.
 *
 * Three bakes, and they are split the way they are because the three questions
 * they answer live at three different scales:
 *
 *   STONE       the face of one dressed block — grain, pitting, the weathering
 *               rind, cracks. Tiles at roughly 1.6 m of world.
 *   STONE_MASK  where the *tenants* can live at that same scale: crustose
 *               lichen thalli, and the crevices that hold water and dust.
 *               Kept out of the albedo so the runtime can decide, per face and
 *               per orientation, whether this stone has lichen on it at all —
 *               a mask painted into the colour can only ever be added to.
 *   STONE_MACRO one field over tens of metres, so that a wall is mossy along
 *               its shaded end and bare at the other. Without it every block
 *               in the complex carries the same average amount of everything,
 *               which is the tiling failure one level up from texel repeat.
 *
 * Each of the first is the body of a `surf()` as described in gfx/bake.js; the
 * other two are raw fragment bodies for bakeImage, because neither is a PBR
 * surface and an albedo/normal/ORM triple for them would be meaningless.
 *
 * TILING CONTRACT — as in groundTex.js. Everything works in `p = uv * 8` and
 * every noise call passes a period exactly equal to the scale applied to p.
 * One extra rule bites here: `pnoise` wraps with mod() on the integer lattice,
 * so 8 * scale has to be a whole number. A scale of 2.2 gives a period of 17.6
 * and the map seams down one edge — visible only once it repeats, which on a
 * wall of forty blocks is immediately.
 */

const HELP = /* glsl */ `
float unit(float x){ return x * 0.5 + 0.5; }
float contrast(float x, float k){
  x = clamp(x, 0.0, 1.0);
  return x <= 0.5 ? 0.5 * pow(2.0 * x, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), k);
}
`;

/* The fields shared by the albedo bake and the mask bake.
 *
 * They have to be the same function rather than two similar ones: the mask's
 * crevice channel is the runtime's answer to "where does water sit on this
 * stone", and if its cracks are not the cracks in the albedo then the moss
 * grows in a network of grooves that are not there.
 */
const FIELDS = /* glsl */ `
void stoneFields(vec2 p, out float bed, out float grain, out float crystal,
                 out float pit, out float crack){
  /* Bedding, and it is deliberately faint. This is dressed stone: the mason
   * took the quarry face off it, so what is left of the sedimentary banding is
   * a slight difference in how hard each band weathers rather than a stripe.
   * The domain warp tiles on the same lattice as the noise it warps, so the
   * seam still closes — at the wrap both the coordinate and the warp repeat. */
  float warp = pfbm(p, 8.0, 4) * 0.8;
  bed = pfbm(vec2(p.x * 0.75, p.y * 2.5 + warp), vec2(6.0, 20.0), 4);

  /* Aggregate. Second-nearest minus nearest is the boundary between crystals;
   * the nearest distance alone gives blobs, which is sand rather than rock. */
  vec2 ag = pworley(p * 10.0, 80.0);
  grain = sstep(0.26, 0.0, ag.y - ag.x);
  crystal = unit(pfbm(p * 20.0, 160.0, 2));

  /* Pitting: vesicles, and the holes left where a softer inclusion has
   * weathered out. The threshold radius is itself noise-driven so cells
   * produce holes of different sizes and most produce none — a constant radius
   * is a lattice, and a lattice of identical dots is the loudest tell a
   * procedural stone has. */
  float sizeVar = unit(pfbm(p * 2.5, 20.0, 3));
  vec2 pw = pworley(p * 5.0, 40.0);
  pit = sstep(0.05 + 0.24 * sizeVar * sizeVar, 0.005, pw.x)
      * sstep(0.40, 0.68, unit(pfbm(p * 1.5, 12.0, 3)));

  /* Cracks, and the interesting part is what stops them.
   *
   * A Worley cell border is a complete tessellation by construction: every
   * crack meets its neighbours and encloses a cell, which is exactly right for
   * cracked mud, a crazed glaze or the joints between masonry courses — and
   * exactly wrong for weathering on a stone face, where a crack starts at a
   * flaw, runs a hand's width and stops. Two masks break the network. The
   * first is a patchy field at a larger scale than the cells, so whole regions
   * of the face have no cracking at all; the second runs at a smaller scale
   * than the cells, so the cracks that do exist are interrupted along their
   * own length. What survives is a set of segments with free ends.
   */
  vec2 cwl = pworley(p * 3.0, 24.0);
  float net = sstep(0.070, 0.004, cwl.y - cwl.x);
  float region = sstep(0.46, 0.62, unit(pfbm(p * 1.0, 8.0, 3)));
  float breaker = sstep(0.32, 0.54, unit(pfbm(p * 6.0, 48.0, 2)));
  crack = net * region * breaker;
}
`;

/* ── The block face ────────────────────────────────────────────────────────
 * A hard volcanic-sedimentary stone, of the kind that gets used for this sort
 * of building because it is what the valley is made of.
 *
 * The colour is the part that took the most thought, and the trap is the
 * inverse of the one the bark fell into. Bark spent a pass reading as cracked
 * grey rock because its light and dark differed only in value; the same rule
 * run the other way says that a stone whose entire pattern is value — one grey
 * lightened and darkened by noise — reads as untextured CG rather than as
 * stone, because real stone has *hue* between its states. The three states
 * here are a cool grey core, a warm buff weathering rind that has been open to
 * the rain for centuries, and iron oxide standing in the pits. A block face
 * shows all three at once and the eye reads the difference between them as
 * age, which is the entire subject of this system.
 */
export const STONE = HELP + FIELDS + /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 8.0;

  float bed, grain, crystal, pit, crack;
  stoneFields(p, bed, grain, crystal, pit, crack);

  /* How deeply weathered this patch is. It follows the bedding because the
   * softer bands take the weather first, which is why an old wall has a
   * horizontal grain to its colour that has nothing to do with its courses. */
  float rind = contrast(unit(bed * 1.5), 1.25);

  vec3 core = vec3(0.148, 0.154, 0.152);   // fresh, faintly cool
  vec3 buff = vec3(0.236, 0.198, 0.140);   // the weathered rind, warm
  vec3 iron = vec3(0.172, 0.100, 0.055);   // oxide standing in the holes
  vec3 soot = vec3(0.044, 0.041, 0.036);   // crack shadow and mineral black
  vec3 calc = vec3(0.292, 0.284, 0.252);   // a pale mineral in the aggregate

  albedo = mix(core, buff, rind * 0.88);
  // Individual pale crystals. Small, and the reason the surface does not go
  // dead the moment the eye gets close enough to resolve a centimetre.
  albedo = mix(albedo, calc, sstep(0.60, 0.90, crystal) * 0.40 * (1.0 - pit));
  albedo = mix(albedo, iron, pit * 0.60);
  albedo = mix(albedo, soot, crack * 0.80);

  /* Two tonal masses over the whole face. A block quarried out of a bed is not
   * one colour: it has a lighter end and a darker one, and that half-metre
   * variation is what stops a wall of forty of them looking like forty copies. */
  albedo *= 0.84 + 0.34 * unit(pfbm(p * 0.5, 4.0, 3));
  albedo *= 1.0 - grain * 0.20;

  height = 0.52 + bed * 0.16 - pit * 0.46 - crack * 0.50
         + crystal * 0.06 - grain * 0.06;

  /* Rough, but not uniformly so, and the variation is not decorative. A
   * weathered rind is sugary and scatters everything; the fresh core under it
   * is close-grained and holds a faint sheen, and it is that difference in
   * sheen across one block that says the surface is decaying rather than
   * merely dirty. */
  rough = mix(0.80, 0.95, rind);
  rough = mix(rough, 0.98, pit * 0.7);
  rough = mix(rough, 0.99, crack * 0.5);
  ao = 1.0 - pit * 0.62 - crack * 0.48 - grain * 0.12;
}
`;

/* ── Tenants and crevices ──────────────────────────────────────────────────
 * r  crustose lichen, 1 in the thallus and about half in its margin
 * g  crevice: where water stands and dust collects, so where moss starts
 * b  a slow field for seeding runoff staining
 *
 * Lichen gets its own channel rather than being painted into the albedo
 * because presence and pattern are different questions. The pattern — a
 * scatter of flat discs of assorted sizes — is a property of the organism and
 * belongs at texture scale. Whether there is any on *this* face depends on how
 * much light and how much rain it gets, and the shader knows that and the bake
 * cannot.
 */
export const STONE_MASK = HELP + FIELDS + /* glsl */ `
void main(){
  vec2 p = vUv * 8.0;

  float bed, grain, crystal, pit, crack;
  stoneFields(p, bed, grain, crystal, pit, crack);

  /* Thalli. The radius is squared noise so the distribution is heavy at the
   * small end with a few large colonies, and so that a good fraction of the
   * cells produce a radius under the smallest distance in them and stay bare.
   * That last part is what makes it a scatter rather than a tiling. */
  float sizeA = unit(pfbm(p * 2.5, 20.0, 3));
  vec2 la = pworley(p * 4.0, 32.0);
  /* Radius against a unit-cell Worley, so a disc of radius r covers about
   * pi*r^2 of the face. The first pass used a mean radius of 0.12, which is
   * four per cent coverage — real, correct, and completely gone by the second
   * mip. A quarter of the surface is what an old wall in this climate carries.
   */
  float radA = 0.12 + 0.60 * sizeA * sizeA;
  float lich = sstep(radA, radA * 0.60, la.x) * 0.55
             + sstep(radA * 0.72, radA * 0.44, la.x) * 0.45;

  /* A second, much finer species, restricted to its own patches. Two sizes of
   * colony on one wall is the difference between lichen and polka dots. */
  vec2 lb = pworley(p * 10.0, 80.0);
  float radB = 0.08 + 0.26 * unit(pfbm(p * 3.0, 24.0, 2));
  float fine = sstep(radB, radB * 0.5, lb.x)
             * sstep(0.52, 0.74, unit(pfbm(p * 1.5, 12.0, 3)));
  lich = clamp(max(lich, fine * 0.85), 0.0, 1.0);
  // Nothing grows in a live crack — the surface there is still moving.
  lich *= 1.0 - crack * 0.85;

  /* The crevice field is the crack and pit network dilated and smoothed. Its
   * job at runtime is to bias moss into the places water cannot run out of, so
   * it wants to be wider than the features it comes from, not equal to them. */
  float crev = clamp(crack * 0.9 + pit * 0.7
                   + sstep(0.55, 0.05, unit(bed)) * 0.20, 0.0, 1.0);
  crev = mix(crev, sstep(0.10, 0.60, crev), 0.6);

  float seed = unit(pfbm(p * 0.5, 4.0, 4));

  gl_FragColor = vec4(lich, crev, seed, 1.0);
}
`;

/* ── The field over the whole complex ──────────────────────────────────────
 * Sampled in world space at tens of metres, so it never repeats within sight
 * of itself and so that neighbouring walls disagree about how overgrown they
 * are. All three channels are plain fbm: what matters here is that they are
 * decorrelated from each other and smooth, because each one is going into a
 * threshold and a threshold on a smooth field has a coverage that responds
 * linearly to where it is placed. Anything with structure in it — a ridge
 * transform in particular, whose histogram piles up against one — takes that
 * control away.
 */
export const STONE_MACRO = HELP + /* glsl */ `
void main(){
  vec2 p = vUv * 8.0;
  float moss   = unit(pfbm(p,       8.0,  4));
  float lichen = unit(pfbm(p * 0.5, 4.0,  3) + pfbm(p * 2.0, 16.0, 2) * 0.35);
  float stain  = unit(pfbm(p * 1.5, 12.0, 4));
  gl_FragColor = vec4(moss, lichen, stain, 1.0);
}
`;
