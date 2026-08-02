/* Vegetation: materials, placement and instancing.
 *
 * Three problems have to be solved together here, and solving any one of them
 * in isolation breaks the other two.
 *
 * 1. Leaves are not opaque. A leaf lit from behind glows, and a canopy seen
 *    from underneath is mostly backlit — so a forest rendered with a normal
 *    opaque BRDF is a forest of black cutouts, which is exactly what most
 *    real-time foliage looks like. The transmission term below is the single
 *    largest visual difference in this file.
 *
 * 2. Everything moves. Not much, and not fast — the understory of a rainforest
 *    is nearly still — but a completely static frame reads as a photograph of
 *    a diorama. The wind is deliberately small in amplitude and long in period.
 *
 * 3. There are tens of thousands of plants and they must cost almost nothing
 *    when off screen. Instancing alone does not do this: one InstancedMesh
 *    spanning the level has a bounding sphere the size of the level, so it is
 *    never frustum-culled and every instance is submitted every frame. The
 *    instances are therefore bucketed into ground tiles, which gives the
 *    culler something the size of a room to reject.
 *
 * A fourth arrived with the fifth pass and turned out to be the loudest: the
 * mid distance was dissolving into a speckled grey wall. That is a
 * minification failure, not a lighting one, and it is fought here on three
 * fronts — coverage-preserving mips in the baker, a roughness and normal clamp
 * that rises with mip level so a leaf a pixel across stops throwing a
 * full-strength mirror lobe, and a floor on the projected width of anything
 * thin so grass blades and vines cannot fall below the sample grid.
 */
import * as THREE from 'three';
import { bakeImage, bakeSurface } from '../gfx/bake.js';
import { LEAF_FRAG, BARK } from './plantTex.js';
import { makeRng, fern, broadleaf, palm, sprig, tussock, vine, tree, canopyPatch, thicket, sapling, log, deadVine, litterMat, rootRun } from './plants.js';
import { BOUNDS } from './terrain.js';
import { standingWater } from './spillway.js';

const ATLAS_PX = 2048;

/* Per-species bucket size, cull radius, whether it casts, and how many
 * structural variants get built.
 *
 * The first three numbers are the entire performance story of the forest, and
 * they trade against each other. Tiles that are too small multiply draw calls
 * (every tile carries one mesh per variant per material); tiles that are too
 * large stop being cullable. So the bucket is sized to the species: a canopy
 * tree is 30 m of geometry and belongs in a 64 m bucket, a sprig is 20 cm and
 * belongs in a 32 m one.
 *
 * Cull radii are set from what the fog actually lets through — about 40 m at
 * ground level — with a longer leash for anything whose crown sits above it.
 * Shadow casting is off for the two smallest species: they are dense enough to
 * double the shadow pass on their own, and at 20 cm tall neither of them casts
 * a shadow anyone can identify.
 *
 * `v` is where the repetition budget is spent, and it is spent unevenly on
 * purpose. Three variants of everything meant three umbrella palms and three
 * broadleaf clumps repeating across forty metres of understory, which is
 * exactly the range at which the eye starts matching silhouettes. The species
 * that get more are the ones at eye level in the near field; the canopy and
 * the distant thicket keep three, because a shape twenty metres up or sixty
 * metres out is never resolved well enough to be recognised twice. Each extra
 * variant is another InstancedMesh in every tile it appears in, so the tiles
 * for the crowded ground species were widened to pay for it.
 */
/* `near`, where it is present, is the radius inside which the high-detail
 * build of a species is drawn; outside it the tile switches to a coarser
 * tessellation of the same plant. It is what pays for the close-range
 * geometry added in the tenth pass — cupped leaflets, tapered blades, curled
 * litter — none of which is resolvable past about twenty metres and all of
 * which would otherwise be multiplied by the whole forest.
 *
 * A species with `near` also needs a smaller tile, and that is the cost of
 * the scheme: the switch is per tile, so a 40 m bucket straddling the
 * boundary would either hold coarse plants at arm's length or fine ones out
 * at the fog line. Halving the tile roughly doubles that species' draw calls,
 * which is affordable here — the frame runs at about 400 calls — and would
 * not be if the buckets were not already per variant.
 */
/* The three canopy storeys and the vines hanging off them stopped casting into
 * the shadow map when the atmosphere system landed, and the change is a
 * correction rather than an optimisation — though it is also worth around a
 * third of the depth pass, because the roof was the heaviest thing in it.
 *
 * A shadow map asks one question: is the straight line to the light blocked.
 * Under three overlapping storeys of canopy patches the answer at ground level
 * is always yes, measurably — with every other light source switched off and
 * the sun at double strength, the forest floor rendered completely black. So
 * the map was spending most of its resolution and most of its fill rate to
 * produce a constant, and the constant it produced was the reason the frame
 * had no direct light in it anywhere.
 *
 * The roof's occlusion is modelled analytically instead (render/canopy.js),
 * which is the only way to get the thing a shadow map cannot represent: a
 * penumbra that widens with the distance to the occluder. Everything near the
 * ground — trunks, logs, ferns, saplings, the player — still casts, because
 * down there the hard contact shadow is exactly right and the shadow map is
 * now big enough to give it properly. */
const SPECIES_LOD = {
  tree:      { tile: 64, cull: 105, cast: true,  v: 4 },
  canopy:    { tile: 48, cull: 68,  cast: false, v: 3 },
  canopy2:   { tile: 48, cull: 78,  cast: false, v: 3 },
  subcanopy: { tile: 48, cull: 62,  cast: false, v: 3 },
  vine:      { tile: 64, cull: 70,  cast: false, v: 3 },
  palm:      { tile: 40, cull: 72,  cast: true,  v: 4, near: 26 },
  broadleaf: { tile: 28, cull: 52,  cast: true,  v: 5, near: 24 },
  fern:      { tile: 26, cull: 50,  cast: true,  v: 5, near: 24 },
  tussock:   { tile: 40, cull: 36,  cast: false, v: 4 },
  sprig:     { tile: 40, cull: 32,  cast: false, v: 3 },
  // The far wall is deliberately darker than the plants in front of it, which
  // is the cheapest available answer to the mid distance flattening into one
  // sage veil: fog lifts everything toward its own colour, so anything meant
  // to sit behind that lift has to start below it.
  thicket:   { tile: 64, cull: 130, cast: false, v: 3, shade: 0.74 },
  sapling:   { tile: 32, cull: 58,  cast: true,  v: 4, near: 26 },
  litterMat: { tile: 24, cull: 34,  cast: false, v: 4, near: 17 },
  /* Roots only exist where the eye is already looking — the near trail margin
   * — so this culls at half the distance of anything else on the floor and
   * has no far build at all. Three variants and a 32 m tile keeps it to a
   * handful of extra draw calls, which is what a species this local is worth. */
  rootRun:   { tile: 32, cull: 24,  cast: false, v: 3 },
  log:       { tile: 32, cull: 48,  cast: true,  v: 4, near: 26 },
  deadVine:  { tile: 64, cull: 66,  cast: false, v: 3 },
};

/* How far back from the brook's waterline each species has to stand, in metres.
 *
 * Absent means "no rule", which is right for the canopy — a tree leaning over a
 * stream is the whole character of a jungle creek and its crown is twenty
 * metres up in any case. The rule is for the understory, and the numbers are
 * roughly the plant's own radius: what is being asserted is that nothing broad
 * gets established in the scour zone, which is true of a channel with running
 * water in it and undercut banks.
 *
 * It exists because of a measurement rather than a preference. The channel is
 * correctly incised and the water in it is correctly placed, and the frame a
 * player actually gets at eye height on the trail was still solid foliage with
 * a dark slot behind it: a two-metre stream cannot survive a two-metre
 * understory closing over it. Everything else in the brook is downstream of
 * being able to see it.
 *
 * `litterMat` is here for a different reason — a scoured bank has no leaf mat
 * on it, and a mat of flat leaves running to the water's edge is exactly what
 * made the channel read as a dry gully floored with debris.
 */
const BANK_CLEAR = {
  thicket: 1.5, tussock: 1.15, palm: 1.25, broadleaf: 1.0,
  sapling: 0.95, vine: 1.0, fern: 0.40, litterMat: 0.55, log: 0.7,
};

/* Ragged, and stable across builds. A margin of constant width reads as mown,
 * and using the scatter's own rng for the jitter would make the whole forest
 * depend on the brook — this is the position hash the scatter grids already
 * lean on elsewhere for the same reason. */
const bankJitter = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/* Vertex-stage wind, and the two geometric corrections that ride with it.
 *
 * Displacing in world space rather than object space matters: instances are
 * randomly yawed, so an object-space push sends every plant a different
 * direction and the result is a shimmer instead of a breeze. The gust term is
 * a slow wave travelling across the world, so a gust visibly arrives, crosses
 * the frame and passes — which is what makes it read as air moving rather than
 * as a vertex animation.
 *
 * Amplitude goes as flex squared. Real bending is a cantilever: a frond's tip
 * moves several centimetres while its base moves none, and the quadratic is a
 * close enough approximation to that to be free.
 */
const WIND_GLSL = /* glsl */ `
attribute float aFlex;
attribute float aDead;
attribute vec3 aRib;
attribute vec2 aSurf;
varying float vDead;
varying vec2 vSurf;
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uRibMin;
uniform float uProj;

vec3 windOffset(vec3 wp, float flex){
  float ph = wp.x * 0.24 + wp.z * 0.31;
  float gust = 0.5 + 0.5 * sin(uTime * 0.21 - wp.x * 0.030 - wp.z * 0.024);
  gust *= gust;
  float sway = sin(uTime * 0.95 + ph) * 0.60
             + sin(uTime * 2.13 + ph * 1.7) * 0.26
             + sin(uTime * 4.60 + ph * 3.1) * 0.11;
  float amp = flex * flex * uWind * (0.22 + 0.90 * gust);
  vec3 o = vec3(uWindDir.x, 0.0, uWindDir.y) * sway * amp;
  // A stem that bends also gets shorter, and skipping this is what makes
  // cheap foliage wind look like it is sliding rather than flexing.
  o.y -= abs(sway) * amp * 0.30;
  return o;
}

/* A floor on how narrow anything is allowed to get on screen.
 *
 * A grass blade three centimetres wide is under a pixel at fifteen metres and
 * a hanging vine is under a pixel at thirty, and below that width an
 * alpha-tested surface does not get thinner — it gets *intermittent*, because
 * whether any given pixel centre lands on it is a coin toss. That is the
 * sparkle in the middle of the frame, and it cannot be filtered away
 * afterwards because the information is gone before shading starts.
 *
 * Widening the geometry instead keeps the same silhouette present at a size
 * the sample grid can actually hold. The offset is measured from the rib
 * attribute — the midrib of a leaf, the centreline of a tube — so a blade gets
 * broader without getting longer, which is the only version of this that does
 * not visibly grow the plant. It is clamped, and at any distance where the
 * plant is properly resolved it does nothing at all. */
vec3 widenThin(vec3 wp, vec3 rib){
  if(uRibMin <= 0.0) return wp;
  vec3 off = wp - rib;
  float w = length(off);
  if(w < 1e-5) return wp;
  float need = uRibMin * distance(cameraPosition, rib) / uProj;
  return rib + off * clamp(need / w, 1.0, 2.4);
}
`;

const PROJECT_WIND = /* glsl */ `
vDead = aDead;
vSurf = aSurf;
vec4 mvPosition = vec4( transformed, 1.0 );
vec4 ribPosition = vec4( aRib, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  ribPosition = instanceMatrix * ribPosition;
#endif
vec4 wPos = modelMatrix * mvPosition;
wPos.xyz = widenThin( wPos.xyz, ( modelMatrix * ribPosition ).xyz );
wPos.xyz += windOffset( wPos.xyz, aFlex );
mvPosition = viewMatrix * wPos;
gl_Position = projectionMatrix * mvPosition;
`;

/* Subsurface transmission, Dice's cheap approximation.
 *
 * Bending the light vector by the surface normal before testing it against the
 * view is what makes this better than a plain dot(V, -L): a leaf edge-on to the
 * sun still transmits along its thin axis, and the distortion term is what
 * lets that happen. Multiplying by the albedo is not a shortcut — light that
 * has passed through a leaf has been filtered by its chlorophyll, so it comes
 * out green, and that green glow is the thing the eye recognises.
 */
const TRANS_GLSL = /* glsl */ `
uniform vec3 uSunView;
uniform vec3 uSunColor;
uniform float uTrans;
uniform vec3 uSkyColor;
uniform float uAtlasPx;
varying float vDead;
varying vec2 vSurf;
`;

/* Senescence, applied to the one green atlas.
 *
 * The ramp goes green to yellow to tan to near-black rather than straight to
 * brown, because that is the sequence a leaf actually goes through and the
 * yellow stage is the one that reads: a litter layer that is uniformly brown
 * looks like a texture, whereas one with a few bright yellow leaves in it
 * looks like leaves that fell on different days.
 */
const DEAD_APPLY = /* glsl */ `
if( vDead > 0.001 ){
  float d = clamp( vDead, 0.0, 1.0 );
  float lum = dot( diffuseColor.rgb, vec3( 0.35, 0.5, 0.15 ) );
  /* Muted, and much less saturated than the ramp wants to be. A drying leaf
   * does go yellow, but it is a dusty ochre, not a highlighter — and because
   * these are the only warm notes in an otherwise entirely green frame the eye
   * goes straight to them. At full chroma the litter layer read as a scatter
   * of plastic chips lying on the forest floor rather than part of it. */
  vec3 yellow = vec3( 0.278, 0.240, 0.112 ) * ( 0.55 + 1.05 * lum );
  vec3 tan    = vec3( 0.178, 0.132, 0.078 ) * ( 0.55 + 1.05 * lum );
  vec3 rot    = vec3( 0.092, 0.076, 0.054 ) * ( 0.55 + 1.05 * lum );
  vec3 dcol = d < 0.45 ? mix( diffuseColor.rgb, yellow, d / 0.45 )
            : d < 0.78 ? mix( yellow, tan, ( d - 0.45 ) / 0.33 )
                       : mix( tan, rot, ( d - 0.78 ) / 0.22 );
  diffuseColor.rgb = dcol;
}
// Baked occlusion: litter buried in a drift, a leaf pressed against bark.
diffuseColor.rgb *= mix( 1.0, vSurf.x, 0.45 );
`;

/* The underside of a leaf, and why it cannot be the top of one seen from
 * behind.
 *
 * With one atlas and a double-sided material, an abaxial surface was getting
 * exactly the adaxial albedo — so every downward-facing blade in the frame was
 * the same green multiplied by the same warm ground bounce and the same
 * transmission lobe, and the result was a flat, identical ochre panel on every
 * one of them. A constant underside colour is an unusually strong tell because
 * undersides are most of what a walker sees: the understory is below eye level
 * and the canopy above it, so half the foliage in any frame is showing its
 * back.
 *
 * Real undersides differ by species more than tops do. Three are worth having,
 * and which one a leaf gets comes from the per-leaf random the geometry packs
 * into aSurf.y: a waxy blue-grey bloom, a plain paler green, and the rufous
 * felt of a leaf with brown hairs on the back. They differ in transmission as
 * much as in colour — a hairy underside barely passes light and a thin
 * glaucous one passes a great deal — which is the variation that stops a
 * backlit canopy reading as one sheet of stained glass.
 *
 * All three are matte. There is no cuticle on the underside of a leaf; the
 * stomata are there and the surface is rough, so the specular that makes the
 * top of a blade read as waxed has to come off the back of it.
 */
const ABAXIAL = /* glsl */ `
if( !gl_FrontFacing ){
  float lid = vSurf.y;
  float alum = dot( diffuseColor.rgb, vec3( 0.34, 0.50, 0.16 ) );
  vec3 glaucous = vec3( 0.112, 0.142, 0.118 );
  vec3 paleGreen = vec3( 0.144, 0.166, 0.086 );
  vec3 rufous = vec3( 0.132, 0.090, 0.056 );
  vec3 ab = lid < 0.44 ? mix( glaucous, paleGreen, lid / 0.44 )
          : lid < 0.78 ? paleGreen
                       : mix( paleGreen, rufous, ( lid - 0.78 ) / 0.22 );
  // Scaled by the blade's own luminance so a leaf that is pale on top stays
  // pale underneath: this is a different surface of the same organ, not a
  // different plant painted on the back.
  // Faded out on dead tissue. A brown leaf is brown on both sides — the
  // pigments and the hairs have gone with everything else — and letting the
  // abaxial tint survive senescence would put blue-grey backs on the litter.
  float abK = ( 0.52 + 0.30 * sin( lid * 17.3 ) * sin( lid * 4.1 ) )
            * ( 1.0 - clamp( vDead * 1.6, 0.0, 1.0 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, ab * ( 0.60 + 1.05 * alum ), abK );
}
`;

/* Mip-driven damping, and it is doing more for the mid distance than anything
 * else in this file.
 *
 * Three things go wrong at once when a leaf minifies, and together they are
 * what turns the centre of the frame into a speckled grey wall.
 *
 * The alpha channel loses its meaning first. A leaf card five pixels tall is
 * reading a mip level where its whole 512-pixel atlas cell has collapsed to
 * about four texels, so the holes, the leaflet slots and the chewed margin are
 * all averaged into a handful of mid-range alpha values. Every one of those is
 * below the alpha test, so the card is eroded from every edge at once — and
 * because the thing directly behind the mid distance is bright fog, each leaf
 * ends up outlined in a hard pale rim where the fog shows through the gap
 * between it and the leaf it should be touching. That rim, repeated across a
 * few thousand cards, is the speckled grey wall in the middle of the frame;
 * it is not the leaves that are visible out there, it is the sky between them.
 *
 * So alpha has to be pushed up rather than merely sharpened. Dilating it with
 * mip level closes the gaps and lets many small blades merge into one larger
 * silhouette, which is what real foliage does at that distance anyway, and at
 * mip zero the remap is the identity so nothing in the foreground moves.
 *
 * Then the specular. A card's normal *map* averages to flat but its geometric
 * normal does not, so a thousand randomly oriented sub-pixel cards each hold a
 * full-strength mirror lobe and a random subset catches the sky on any given
 * frame. That is aliasing, not noise, so it does not average away — it
 * sparkles. Raising roughness and flattening the normal with the footprint
 * removes it, and at mip zero both are the identity.
 */
const LOD_DAMP = /* glsl */ `
vec2 fw = fwidth( vMapUv ) * uAtlasPx;
vFar = clamp( ( log2( max( max( fw.x, fw.y ), 1.0 ) ) - 0.8 ) / 2.4, 0.0, 1.0 );
diffuseColor.a = mix( diffuseColor.a,
                      smoothstep( 0.06, 0.26, diffuseColor.a ), vFar );
`;

const TRANS_APPLY = /* glsl */ `
{
  vec3 Nv = normalize( normal );
  /* three's vViewPosition is already -mvPosition, i.e. it points from the
   * surface back toward the camera — the same convention its own lighting
   * uses. Negating it here inverted the whole term, so leaves lit from the
   * front glowed as if the sun were behind them and backlit ones went flat:
   * the effect was present, at full strength, and applied to exactly the
   * wrong half of the scene. */
  vec3 Vv = normalize( vViewPosition );
  vec3 Hs = normalize( uSunView + Nv * 0.60 );
  float I = pow( clamp( dot( Vv, -Hs ), 0.0, 1.0 ), 3.2 );
  /* Gated on whether the sun actually reached the back of this leaf, which is
   * the same canopy transmittance the floor's sunflecks are made of.
   *
   * Ungated — which is how this started — the term is a constant glow over
   * every leaf in the frame, and a constant glow is the exact opposite of what
   * it is for. Real mid-ground jungle is a stack of overlapping dark holes with
   * a few vividly backlit leaves among them, at half a dozen scales; that
   * contrast is what carries depth, and an even wash across all of it is a
   * large part of why everything past eight metres was reading as one flat
   * khaki wall lit one way. With the gate the variance goes where the light is:
   * a leaf under a gap glows hard and the leaf beside it under two metres of
   * crown stays dark, so the layers separate by their own luminance instead of
   * by fog.
   *
   * The gain is raised to pay for the gate, which passes about a sixth of the
   * frame at this canopy density. The floor is what an unlit leaf still passes:
   * skylight gets through a canopy from everywhere at once, so even a leaf with
   * no sun on it is not opaque — it is just not glowing.
   *
   * gCanopyMask comes from render/canopy.js, which is patched onto this
   * material afterwards by main.js and inserts before the directive this block
   * is appended to. The ordering is a contract between those two files.
   */
  vec3 through = uSunColor * I * uTrans * mix( 0.22, 1.0, gCanopyMask.x );
  /* Skylight comes through the canopy from every direction at once, so it has
   * no lobe — but it is the only thing lighting the undersides in shade, and
   * it is what keeps the understory from separating into lit greens and black
   * holes. Raised in the eighth pass: the frame was reading as two exposures
   * fighting rather than as one space full of soft green light.
   *
   * Trimmed here and the directional half raised to match, which is the whole
   * of this pass's answer to "no sense of light direction". This term has no
   * lobe at all, so every watt of it is a watt that makes the understory
   * flatter; the sun-driven term above has one. Moving a fifth of the budget
   * from the first to the second costs nothing in overall exposure and gives
   * the leaves a side to be lit from. Building the actual dappled sunlight is
   * a later system and is deliberately not attempted here. */
  through += uSkyColor * 0.25;

  /* And the light comes out green, harder than the albedo says.
   *
   * A leaf's reflectance and its transmittance are different spectra, and the
   * transmitted one is far more selective: chlorophyll absorbs red and blue in
   * a single pass through the mesophyll, so a leaf passes something like a fifth
   * of the green landing on it and a fortieth of the red. Reflectance is
   * partly specular and partly scatter off the cuticle, so it is much closer to
   * neutral. Multiplying the transmitted light by the albedo once — which is
   * what this did — filters it as though the light had bounced off the leaf
   * rather than gone through it, and understates the green by about a factor of
   * two.
   *
   * Squaring the albedo and renormalising by its own luminance is that second
   * pass: the same amount of light comes out, with twice the hue in it. That is
   * the single largest reason this frame reads khaki rather than green, and it
   * is a physical statement rather than a colour preference — the place to put
   * green back into a jungle is the light that has been through a leaf, because
   * that is the light that is green.
   */
  vec3 lam = diffuseColor.rgb;
  vec3 filt = lam * lam / max( dot( lam, vec3( 0.34, 0.50, 0.16 ) ), 1e-3 );
  reflectedLight.indirectDiffuse += through * vLeafTrans * filt * 2.0;
}
`;

/* Bark surface, over and above what the texture says.
 *
 * The bark map is one square metre of generic tropical bark, and a trunk needs
 * three things it cannot supply because they depend on where you are on the
 * tree rather than on the bark itself: moss, which only grows low down and on
 * the damp side; exposed heartwood, which only appears where a fallen log has
 * lost its bark; and contact occlusion, which is what puts a tree *in* the
 * ground instead of on it. All three arrive per vertex in aSurf — occlusion in
 * x, and a signed moss/rot term in y, since no square centimetre of a trunk is
 * both mossy and freshly broken.
 */
const WOOD_APPLY = /* glsl */ `
{
  float lum = dot( diffuseColor.rgb, vec3( 0.34, 0.50, 0.16 ) );
  float moss = max( 0.0, vSurf.y );
  float rot  = max( 0.0, -vSurf.y );
  /* Moss replaces the bark rather than tinting it. A green multiply leaves the
   * fissure pattern reading straight through the moss, which is the giveaway:
   * real moss is a few millimetres of pile and it hides whatever it is
   * growing on completely. */
  /* Moss reads brighter than the bark it grows on, not darker.
   *
   * The first version of this was a dark forest green at ninety per cent
   * strength, and because the moss mask is heaviest exactly where a trunk
   * meets the litter — which is the part of a tree that a walker on the trail
   * has closest to camera — it was painting the whole near bole a near-black
   * green and undoing the point of the bark map. Live moss on a wet trunk is a
   * bright yellow-green with a high albedo; it is a lighter patch, and it is a
   * patch rather than a coat. */
  /* Raised again, and the strength cut. The colour was still being multiplied
   * by a luminance factor derived from bark that is itself dark under this
   * canopy, so the "bright yellow-green" the comment above describes was
   * arriving on screen at about a third of the value it names. Live moss on a
   * wet bole is one of the lighter things in a rainforest understory — it is
   * frequently brighter than the litter — and a moss term that darkens what
   * it lands on is doing the opposite of its job. */
  diffuseColor.rgb = mix( diffuseColor.rgb,
                          vec3( 0.150, 0.208, 0.086 ) * ( 0.80 + 1.1 * lum ),
                          moss * 0.62 );
  // Weathered sapwood where the bark has come away — pale, dry and noticeably
  // lighter than anything around it, which is what makes deadwood read as
  // dead rather than just as a darker log.
  diffuseColor.rgb = mix( diffuseColor.rgb,
                          vec3( 0.186, 0.150, 0.100 ) * ( 0.60 + 1.5 * lum ),
                          rot * 0.85 );
  /* Applied to albedo and not only to the indirect term, because the places
   * this describes — a buttress crotch, the underside of a log, the last
   * hand's width of trunk before the litter — are geometrically closed. No
   * direct sun reaches into them either, and occluding only the ambient left
   * every trunk looking like it was standing on a clean floor. Kept to a
   * fraction, though: under a closed canopy the ambient is nearly all the
   * light there is, and occluding it twice — here and through the bark map's
   * own AO — is how a trunk ends up as a black column with the shape of a
   * trunk, which is the thing this pass exists to stop doing.
   *
   * Cut again to under a third. There are three separate occlusion multiplies
   * on a trunk — this one, the bark map's AO through aoMapIntensity, and the
   * indirect term below — and stacking them is how the near boles lost the
   * contrast that would have let their bark read. */
  diffuseColor.rgb *= mix( 1.0, vSurf.x, 0.28 );
}
`;

function patchWind(mat, uniforms, { transmission = false, wood = false } = {}) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = WIND_GLSL + shader.vertexShader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <project_vertex>', PROJECT_WIND)
      // Shadow and env lookups must use the same displaced position, or leaves
      // cast shadows from where they were before the wind moved them.
      .replace('#include <worldpos_vertex>', 'vec4 worldPosition = wPos;');

    if (transmission) {
      shader.fragmentShader = TRANS_GLSL
        + 'float vLeafTrans = 0.0;\nfloat vFar = 0.0;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader
        // Before the alpha test rather than after it: the alpha contrast term
        // in LOD_DAMP has to run while there is still an alpha to sharpen.
        .replace('#include <map_fragment>',
                 '#include <map_fragment>\n' + LOD_DAMP + DEAD_APPLY + ABAXIAL)
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
          float roughnessFactor = roughness;
          #ifdef USE_ROUGHNESSMAP
            vec4 auxTexel = texture2D( roughnessMap, vRoughnessMapUv );
            roughnessFactor *= auxTexel.g;
            vLeafTrans = auxTexel.r;
          #endif
          // Dead tissue has lost its cuticle and most of its ability to pass
          // light: it is dry, matte and opaque, and leaving it glossy and
          // glowing is what makes CG litter look like painted plastic chips.
          roughnessFactor = mix( roughnessFactor, 0.97, vDead * 0.9 );
          roughnessFactor = mix( roughnessFactor, 0.94, vFar );
          vLeafTrans *= 1.0 - 0.72 * vDead;
          /* How much light this individual leaf passes, which used to be one
           * number for the whole forest. A thin young aroid blade and a
           * leathery old one differ by a factor of three in transmission, and
           * with every leaf on the same value a backlit canopy is a single
           * even glow — the eye reads it as a lit surface rather than as
           * thousands of separate translucent objects. The mean is held at
           * one so the overall exposure of the frame does not move. */
          vLeafTrans *= 0.55 + 0.90 * vSurf.y;
          if( !gl_FrontFacing ){
            // No cuticle on the back of a blade, and the hairier the
            // underside the less it passes: the rufous end of the abaxial
            // range is felt, and felt is opaque.
            roughnessFactor = mix( roughnessFactor, 0.95, 0.75 );
            vLeafTrans *= 1.0 - 0.55 * smoothstep( 0.70, 1.0, vSurf.y );
          }
        `)
        .replace('#include <normal_fragment_maps>', /* glsl */ `
          #include <normal_fragment_maps>
          normal = normalize( mix( normal, nonPerturbedNormal, vFar * 0.92 ) );
        `)
        .replace('#include <lights_fragment_end>',
                 '#include <lights_fragment_end>\n' + TRANS_APPLY);
    }

    if (wood) {
      shader.fragmentShader = 'varying vec2 vSurf;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + WOOD_APPLY)
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
          #include <roughnessmap_fragment>
          roughnessFactor = mix( roughnessFactor, 1.0, max( 0.0, vSurf.y ) * 0.9 );
        `)
        .replace('#include <lights_fragment_end>', /* glsl */ `
          #include <lights_fragment_end>
          reflectedLight.indirectDiffuse *= mix( 1.0, vSurf.x, 0.55 );
        `);
    }
  };
  // Distinguishes the patched program from an unpatched MeshStandardMaterial
  // with the same parameters, which three would otherwise let share a cache
  // entry and hand back the wrong shader.
  mat.customProgramCacheKey = () => (transmission ? 'leafwind' : wood ? 'woodwind' : 'plainwind');
  return mat;
}

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Orientation for something growing out of the ground.
 *
 * Everything used to be yawed about world up with a little random tilt, which
 * is right on the flat and wrong everywhere else — and the terrain here is
 * deliberately embanked, so "everywhere else" is most of the frame. On a slope
 * a vertically-planted litter leaf stands on its edge and a mat of them fans
 * out of the hillside like a card index, which is a large part of why the
 * floor read as scattered paper. Conforming to the terrain normal fixes it,
 * but only litter should conform *fully*: a plant grows toward the light, not
 * perpendicular to the soil, so a tree on a bank stands nearly upright and a
 * fern splits the difference.
 */
function stand(c, conform, tilt) {
  _n.set(c.nx, c.ny, c.nz).lerp(UP, 1 - conform).normalize();
  _q.setFromUnitVectors(UP, _n);
  _e.set((c.rng() - 0.5) * tilt, c.rng() * 6.283, (c.rng() - 0.5) * tilt, 'YXZ');
  return _q.multiply(_qy.setFromEuler(_e));
}

/* Instance scale, deliberately not uniform.
 *
 * A stand of one shape at twelve sizes still reads as one shape, because the
 * eye normalises for scale before it compares outlines. Fifteen per cent of
 * independent stretch in each axis is invisible as distortion and turns every
 * instance into a squat or a leggy version of its variant, which is another
 * multiplier on the variant count for no draw calls at all.
 */
function bulk(rng, s, k = 0.15) {
  return _s.set(s * (1 + (rng() - 0.5) * 2 * k),
                s * (1 + (rng() - 0.5) * 2 * k * 1.4),
                s * (1 + (rng() - 0.5) * 2 * k));
}

export class Vegetation {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./terrain.js').Terrain} terrain
   * @param {import('./path.js').Trail} trail
   * @param {number} seed
   * @param {import('./ruins.js').Ruins} [ruins] so that plants grow *on* the
   *   stone rather than through it, and so that the wall feet get the extra
   *   density every real ruin has along them.
   * @param {import('../player/collision.js').CollisionWorld} [collision]
   */
  constructor(renderer, terrain, trail, seed = 7717, ruins = null, collision = null) {
    this.renderer = renderer;
    this.terrain = terrain;
    this.trail = trail;
    this.ruins = ruins;
    this.collision = collision;
    this.root = new THREE.Group();
    this.root.name = 'vegetation';
    this.time = 0;
    this.cells = [];

    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 0.13 },
      uWindDir: { value: new THREE.Vector2(0.86, 0.51) },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSkyColor: { value: new THREE.Color(0.35, 0.45, 0.5) },
      // Raised alongside the cut to the flat skylight term in TRANS_APPLY, and
      // again to make up for the lower ceiling the translucency channel is now
      // baked at so its new margin gradient survives the byte quantisation.
      // Raised a third time when the term was gated on canopy transmittance:
      // the gate passes about a sixth of the frame, so the same total glow has
      // to arrive through fewer leaves, and the point of the exercise is that
      // those leaves are much brighter than the average was.
      uTrans: { value: 9.5 },
      uAtlasPx: { value: ATLAS_PX },
      // Half-width in pixels below which thin geometry gets widened.
      uRibMin: { value: 1.15 },
      uProj: { value: 800 },
    };
    /* The depth pass shares every uniform except the widening, which has to be
     * off there. `cameraPosition` during a shadow render is the light's
     * position and the projection is orthographic, so the same code would
     * measure a distance that means nothing and inflate every leaf in the
     * shadow map. Spreading the object aliases the live uniforms and replaces
     * only that one. */
    this.depthUniforms = { ...this.uniforms, uRibMin: { value: 0 } };

    this._bake(renderer);
    this._buildSpecies(seed);
    this._place(seed);
  }

  _bake(renderer) {
    const size = ATLAS_PX;
    const uniforms = {
      uChannel: { value: 0 },
      uTexel: { value: 1 / size },
      uNormalStrength: { value: 2.6 },
    };
    const shot = (ch, colorSpace, coverageMips = 0) => {
      uniforms.uChannel.value = ch;
      return bakeImage(renderer, LEAF_FRAG, { size, uniforms, colorSpace, coverageMips });
    };
    /* Only the albedo gets a hand-built mip chain, because only its alpha is
     * ever tested. The other two are sampled, not thresholded, so the GPU's
     * box filter is the right answer for them and a megabyte of readback is
     * not worth spending twice. */
    this.leafMap = shot(0, THREE.SRGBColorSpace, 0.42);
    this.leafNrm = shot(1, THREE.NoColorSpace);
    this.leafAux = shot(2, THREE.NoColorSpace);

    this.barkTex = bakeSurface(renderer, BARK, { size: 1024, normalStrength: 3.8 });

    const leaf = new THREE.MeshStandardMaterial({
      map: this.leafMap,
      normalMap: this.leafNrm,
      roughnessMap: this.leafAux,
      roughness: 1.0,
      metalness: 0.0,
      // Alpha *test*, not blend. Blended foliage needs back-to-front sorting
      // that instancing cannot do, and gets it wrong on every overlapping leaf.
      transparent: false,
      alphaTest: 0.42,
      /* Alpha-to-coverage is off, and turning it off is what fixed the
       * speckled grey wall in the middle of the frame.
       *
       * A2C is the standard recommendation for alpha-tested foliage and it is
       * the wrong call here, for a reason specific to how much of this scene
       * is foliage. It converts a fragment's alpha into a fraction of the MSAA
       * samples the fragment may write, so a texel at alpha 0.5 leaves half
       * the samples holding whatever was behind it. On an isolated leaf
       * against a backdrop that is the edge blend you want. In the mid
       * distance here, a leaf is almost entirely margin, several leaf edges
       * stack in depth within a single pixel, and the thing ultimately behind
       * all of them is bright fog — so the fog leaks through a fraction of the
       * samples at nearly every pixel of the canopy and the resolve turns the
       * leak into hard pale sparkle. The canopy stops reading as a surface and
       * reads as a screen door, which is exactly the reported symptom.
       *
       * The obvious repair — rescaling alpha by its own screen-space
       * derivative so coverage tracks the analytic silhouette — was tried and
       * does not work at the distances that matter: under minification the
       * alpha signal is itself noisy from pixel to pixel, so the derivative is
       * large everywhere and the rescale leaves coverage partial everywhere.
       * A hard test plus plain MSAA on the geometric edge costs some crispness
       * on near silhouettes and removes the artefact completely. The
       * coverage-preserving mip chain and the distance dilation below are what
       * keep the far silhouettes from going ragged without it. */
      alphaToCoverage: false,
      side: THREE.DoubleSide,
      // Raised with the micro-relief added to the atlas in the ninth pass; the
      // mip-driven flattening in LOD_DAMP is what keeps this from turning into
      // sparkle in the mid distance, so the near field can afford more of it.
      normalScale: new THREE.Vector2(0.98, 0.98),
      /* A leaf under a closed canopy sees a few square metres of broken sky,
       * not a hemisphere of it, and handing it the whole environment map put
       * a hard even sheen across every blade in frame — the specific look of
       * injection-moulded plastic. What makes a real leaf read as waxy is a
       * small sharp highlight in one place and light coming through it
       * everywhere else, so the reflection goes down and the transmission
       * goes up together. The environment here is open blue sky, so this is
       * also the dial that decides how cyan the understory goes. */
      envMapIntensity: 0.11,
    });
    this.leafMat = patchWind(leaf, this.uniforms, { transmission: true });

    const wood = new THREE.MeshStandardMaterial({
      map: this.barkTex.map,
      normalMap: this.barkTex.normalMap,
      roughnessMap: this.barkTex.ormMap,
      aoMap: this.barkTex.ormMap,
      /* The bark map's own AO runs down to about 0.2 in the fissures, and
       * under a closed canopy a trunk's *entire* light budget is the ambient
       * that AO multiplies — so at full strength it was taking four fifths of
       * the only illumination the bark ever gets and handing back a black
       * column. It is a crevice-shading cue, not an exposure control, and half
       * of it is plenty to read as one. */
      aoMapIntensity: 0.5,
      roughness: 1.0,
      metalness: 0.0,
      /* Cut again, and this time against a measurement rather than an
       * impression. The environment here is open blue sky and a bole is
       * vertical, so this dial is what decides how cold the trunks go. The
       * bark map leaves the bake carrying a red-minus-blue of about +13 out
       * of 255; by the time it reached the screen the boles measured +1.6 and
       * the buttress plates measured *minus* 4.3 — that is, blue of neutral,
       * on wood. A closed canopy is exactly the situation where a trunk sees
       * almost none of the open sky, so the physical argument and the
       * measurement agree: this was far too much, and it was cancelling every
       * bit of warmth the map was putting in.
       *
       * The first cut to 0.16 recovered the boles but left the buttress plates
       * at +1.6 — still, in effect, neutral. Roughly: the hemisphere fill
       * lands about (0.060, 0.081, 0.036) of linear irradiance on a vertical
       * bole, and even a sixth of the open sky was adding about (0.012, 0.020,
       * 0.036) on top, which is enough blue on its own to bring red and blue
       * level. Landed at the same value the leaves settled on, for the same
       * reason and by the same argument. */
      envMapIntensity: 0.10,
    });
    this.woodMat = patchWind(wood, this.uniforms, { wood: true });

    /* Shadow casters need the wind too. Without this the leaf is displaced in
     * the colour pass but not in the depth pass, so every plant is lit through
     * a shadow of its own resting position and appears to detach from it. */
    this.leafDepth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.leafMap, alphaTest: 0.45, side: THREE.DoubleSide,
    });
    patchWind(this.leafDepth, this.depthUniforms);
    this.leafDepth.customProgramCacheKey = () => 'leafdepthwind';

    this.woodDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchWind(this.woodDepth, this.depthUniforms);
    this.woodDepth.customProgramCacheKey = () => 'wooddepthwind';
  }

  /* Variants exist so the eye cannot lock onto a repeated silhouette. The
   * count per species lives in SPECIES_LOD, next to the tile size that pays
   * for it — the cost is draw calls, not memory, and draw calls are the budget
   * that actually binds here. */
  _buildSpecies(seed) {
    const mk = (fn, scale, key) => {
      const out = [];
      const twoLevel = SPECIES_LOD[key].near > 0;
      for (let i = 0; i < SPECIES_LOD[key].v; i++) {
        const s = seed + fn.name.length * 977 + i * 7919 + key.length * 131;
        /* The two levels are the same seed run twice, not one build reduced.
         * Every builder is written so that the detail flag reaches only the
         * segment counts, so the second pass draws exactly the same random
         * numbers in the same order and produces the same plant with fewer
         * vertices in it. Building the coarse one by decimating the fine one
         * would be the obvious alternative and is much worse: a decimator has
         * no idea which of a leaf's rows is the one carrying its silhouette. */
        /* The variant index is passed as well as the seed, and it means
         * something different from the seed: the builders use it to select a
         * growth architecture. Two variants of a species are no longer the
         * same plant grown from different random numbers — one is a rosette
         * and the next is a leafy cane — which is the only kind of variation
         * that survives the eye normalising for scale before it compares
         * outlines. It has to be the index rather than another draw from the
         * stream so that a species with four variants gets each architecture
         * exactly once instead of three rosettes and a cane. */
        const hi = fn(makeRng(s), scale, 0, i);
        out.push({ hi, lo: twoLevel ? fn(makeRng(s), scale, 1, i) : hi });
      }
      return out;
    };
    this.species = {
      tree: mk(tree, 1, 'tree'),
      canopy: mk(canopyPatch, 1, 'canopy'),
      canopy2: mk(canopyPatch, 1.35, 'canopy2'),
      subcanopy: mk(canopyPatch, 0.62, 'subcanopy'),
      thicket: mk(thicket, 1, 'thicket'),
      sapling: mk(sapling, 1, 'sapling'),
      litterMat: mk(litterMat, 1, 'litterMat'),
      rootRun: mk(rootRun, 1, 'rootRun'),
      log: mk(log, 1, 'log'),
      deadVine: mk(deadVine, 1, 'deadVine'),
      palm: mk(palm, 1, 'palm'),
      broadleaf: mk(broadleaf, 1, 'broadleaf'),
      fern: mk(fern, 1, 'fern'),
      tussock: mk(tussock, 1, 'tussock'),
      sprig: mk(sprig, 1, 'sprig'),
      vine: mk(vine, 1, 'vine'),
    };
  }

  /* ---------------------------------------------------------------- placing */

  /**
   * Scan a jittered grid over the corridor and decide what grows where.
   *
   * The grid is per-species and its spacing is that species' typical spacing,
   * so a fern is tested against a 1.7 m lattice and a canopy tree against a
   * 13 m one. Jittering inside the cell removes the lattice; without it the
   * forest is planted in rows, which is visible from thirty metres away even
   * through fog.
   *
   * `accept` returns a probability rather than a boolean so density can vary
   * continuously with distance from the trail, terrain wetness and slope —
   * a hard cutoff produces a band of vegetation with a visible edge.
   */
  _scatter(name, spacing, accept, place, seed) {
    const rng = makeRng(seed);
    const t = this.terrain;
    const nrm = new THREE.Vector3();
    const out = [];
    const q = {};
    /* The ground-cover grids are the expensive ones — a 0.9 m lattice over the
     * whole corridor is ~110k candidates — and almost all of them are rejected
     * for being too far from the trail. Testing that first, before the height,
     * normal and mask lookups, is the difference between a boot that takes a
     * second and one that takes ten. */
    const maxDist = SPECIES_LOD[name].cull;
    for (let z = BOUNDS.z0; z > BOUNDS.z1; z -= spacing) {
      for (let x = BOUNDS.x0; x < BOUNDS.x1; x += spacing) {
        const px = x + (rng() - 0.5) * spacing * 1.7;
        const pz = z + (rng() - 0.5) * spacing * 1.7;
        if (px < BOUNDS.x0 || px > BOUNDS.x1 || pz > BOUNDS.z0 || pz < BOUNDS.z1) continue;
        this.trail.nearest(px, pz, q);
        if (q.dist > maxDist) continue;
        let y = t.height(px, pz);
        /* Nothing here is an emergent aquatic, so anything with its crown
         * under the surface is refused outright. The tolerance is generous
         * because the causeway's banks are steep and a plant rooted in the
         * last few centimetres of dry margin is exactly the sedge-on-the-
         * waterline detail worth keeping. */
        /* Loose debris is held to a much tighter tolerance than anything
         * rooted, and the reason is that the two failures do not look alike.
         *
         * A sedge standing in three centimetres of water at the margin is a
         * detail worth having. A patch of the litter mat in three centimetres
         * of water is a sheet of flat leaves lying *coplanar with the surface*,
         * which both z-fights with it and reads as a carpet across open water —
         * which is what the critique found across the alcove basin, where the
         * shelf is genuinely only a few centimetres deep in places and so
         * passed the generous test above. Debris also conforms fully to the
         * ground, so it has no vertical extent to lift it clear the way a plant
         * does; there is nothing for the tolerance to buy. */
        const wd = standingWater(px, pz, y, t.brook, q);
        if (wd > (name === 'litterMat' ? 0.005 : 0.06)) continue;
        // The scour zone along the brook — see BANK_CLEAR.
        const bc = BANK_CLEAR[name];
        if (bc !== undefined
            && t.brook.clearAt(q) < bc * (0.45 + 1.1 * bankJitter(px, pz))) continue;
        t.normal(px, pz, nrm);

        /* Stone under this candidate.
         *
         * Three cases, and they are genuinely different ecologies. On top of a
         * block the plant is growing in a few centimetres of leaf mould caught
         * on a level surface, so it stands plumb, it stays small and there is
         * nothing bigger than a fern up there. Beside a block it is growing in
         * the drift banked against the wall, which is the deepest, dampest
         * soil in the clearing and is where the understory is thickest. And a
         * candidate inside a standing wall has to be refused outright, because
         * a fern sprouting from the middle of a metre of masonry is the single
         * most obviously wrong thing this system could produce.
         */
        let stone = 0, nearStone = 0;
        if (this.ruins) {
          const top = this.ruins.topAt(px, pz);
          if (top > y - 0.05) {
            /* Over stone. Whether that is a foothold or a wall is a separate
             * question and this code used to skip it, lifting the candidate to
             * whatever masonry stood above it — which planted ferns halfway up
             * the face of every standing wall in the complex, in a line,
             * because a wall head is level along its length. Only a perch will
             * do; over a face the candidate is dropped, which is what the
             * comment above has always claimed happened. */
            const p = this.ruins.perchAt(px, pz);
            if (p < -1e8) continue;
            stone = 1;
            y = p;
            // A block top is flat and it is not soil; nothing conforms to the
            // terrain up here and nothing is walked on.
            nrm.set(0, 1, 0);
          }
          if (this.ruins.nearAt(px, pz)) nearStone = 1;
        }
        /* Three scales of patchiness on top of whatever the species asks for:
         * stands and clearings, the clumps within them, and the knots within
         * those. Two was not enough — the field it produced still had a
         * recognisable mean everywhere, so the understory came out as an even
         * sprinkle with soft density variation, which is the jittered grid it
         * was supposed to hide. A third octave makes the product properly
         * heavy-tailed: most of the floor sits well below the mean and a small
         * fraction of it saturates, which is what gives near-impassable knots
         * with open shaded floor between them. */
        const c1 = clumpNoise(px, pz, 21.0, seed * 0.013);
        const c2 = clumpNoise(px, pz, 7.0, seed * 0.041 + 9);
        const c3 = clumpNoise(px, pz, 2.6, seed * 0.077 + 23);
        const clump = c1 * (0.30 + 0.70 * c2) * (0.55 + 0.45 * c3);
        const ctx = {
          x: px, z: pz, y, dist: q.dist, t: q.t, side: q.side,
          slope: 1 - nrm.y, nx: nrm.x, ny: nrm.y, nz: nrm.z,
          mud: stone ? 0 : t.mudAt(px, pz), wet: t.wetAt(px, pz),
          hollow: stone ? 0.1 : t.hollowAt(px, pz), rng,
          stone, nearStone,
          clr: this.trail.clearing(q.t),
          hard: this.ruins ? this.ruins.plan.hardGround(px, pz) : 0,
          /* How far into a clump this candidate sits, 0 at the ragged edge and
           * 1 in the middle. Species use it to size themselves: the biggest
           * individuals are in the middle of the thicket and the seedlings are
           * around the outside, which is how a real cohort grows and is a
           * whole extra axis of variation for one multiply. */
          dens: Math.min(1, clump / 0.34),
        };
        /* Renormalised so the field redistributes density rather than
         * removing it: squaring a value whose mean is about a third drops the
         * mean of the product to a sixth, and the first version of this
         * quietly halved the whole forest. The gain is set so the expectation
         * comes back above one — probabilities over one simply always accept,
         * which is what makes the dense knots saturate. */
        const p = accept(ctx) * (0.08 + 10.9 * clump * clump);
        if (p <= 0 || rng() > p) continue;
        out.push(place(ctx));
      }
    }
    return out;
  }

  _place(seed) {
    const M = () => new THREE.Matrix4();

    /* Understory density is not uniform and the variation is the whole point.
     * Light reaching the floor is what decides where anything grows, so growth
     * is heaviest exactly where the canopy is broken: along the trail itself,
     * where the gap in the roof is a permanent light well and the vegetation
     * closes in on it from both sides. Two metres off the path it is
     * impenetrable; twenty metres in it is open shaded floor with almost
     * nothing on it. Getting that gradient right is most of why a trail reads
     * as a trail rather than as a gap in a hedge. */
    /* The first version of this decayed over 7 m, which produced a ribbon of
     * planting along the trail and open floor behind it — and you could see
     * straight out to the horizon between the trunks, which is the one thing a
     * jungle never lets you do. Sightlines are the whole feeling of the place:
     * it is claustrophobic because there is no line of sight longer than about
     * twenty metres in any direction. The gradient is still there, because the
     * light well over the trail is real and the verge genuinely is thicker,
     * but the floor beyond it has to stay closed. */
    const edgeLight = (d) => 0.52 + 0.48 * Math.exp(-Math.pow(Math.max(0, d - 1.4) / 15.0, 1.4));

    const bank = (c, min, max) => {
      if (c.dist < min || c.dist > max) return 0;
      if (c.mud > 0.32) return 0;
      return 1;
    };

    const treeSpots = [];

    /* How much a species likes the foot of a wall. The drift that banks
     * against masonry is the deepest and dampest soil anywhere in the
     * clearing, and a ruin whose understory density is the same as the open
     * floor twenty metres away reads as a model placed on a landscape. */
    const wallFoot = (c, k) => (c.nearStone ? 1 + k : 1);

    /* What the big-rooted understory loses over made ground and in the open
     * clearing. Two separate causes: `hard` is the terrace, the berms and the
     * causeway, which are stone under a skin of mould; `clr` is the clearing
     * itself, which has always been in the model as a canopy gap and has never
     * been allowed to affect anything below head height. Without the second
     * term the "clearing" is a forest with more sky over it. */
    const rooting = (c, hard, open) => (1 - hard * c.hard) * (1 - open * c.clr);

    this._add('tree', this._scatter('tree', 7.0, (c) => {
      if (c.stone) return 0;
      if (!bank(c, 4.0, 90)) return 0;
      if (c.slope > 0.55) return 0;
      // The clearing is a clearing because the big trees are not in it.
      const open = 1 - 0.75 * smoothstep(0.80, 0.94, c.t);
      return 0.55 * open * (c.wet > 0.5 ? 0.4 : 1) * rooting(c, 0.98, 0);
    }, (c) => {
      const v = (c.rng() * SPECIES_LOD.tree.v) | 0;
      const s = 0.76 + c.rng() * 0.52 + c.dens * 0.16;
      const m = M().compose(_p.set(c.x, c.y - 0.42, c.z),
                            stand(c, 0.18, 0.05), bulk(c.rng, s, 0.07));
      if (c.rng() < 0.55) treeSpots.push({ x: c.x, y: c.y, z: c.z, s, v });
      return { v, m };
    }, seed + 1));

    /* The roof. Placed on its own grid rather than grown from the trunks
     * because the crown of a rainforest is continuous and a viewer under it
     * cannot resolve which tree any given patch belongs to — but they can
     * instantly tell whether the sky is broken or whole. */
    this._add('canopy', this._scatter('canopy', 5.2, (c) => {
      if (c.dist > 75) return 0;
      const open = 1 - 0.90 * smoothstep(0.79, 0.93, c.t);
      /* Deliberate holes, and they are the reason this scene has any drama in
       * it: every shaft of light that reaches the floor comes through one.
       * The scale is set so the gaps are five to ten metres across — small
       * enough that the roof still reads as closed, large enough that a beam
       * through one is a beam and not a speckle. */
      const gap = smoothstep(0.12, 0.52,
        Math.abs(Math.sin(c.x * 0.058) * Math.cos(c.z * 0.046)
               + 0.55 * Math.sin(c.x * 0.023 + c.z * 0.019)));
      return 0.98 * open * (0.52 + 0.48 * gap);
    }, (c) => {
      const s = 0.85 + c.rng() * 0.8;
      const hh = 12 + c.rng() * 8;
      return {
        v: (c.rng() * SPECIES_LOD.canopy.v) | 0,
        m: M().compose(_p.set(c.x, c.y + hh, c.z),
                       _q.setFromEuler(_e.set(0, c.rng() * 6.283, 0)),
                       _s.set(s * (0.86 + c.rng() * 0.3), s * 0.8, s * (0.86 + c.rng() * 0.3))),
      };
    }, seed + 2));

    /* A second, higher storey.
     *
     * One layer of canopy cannot both close the sky and let shafts through:
     * turn its coverage up and the roof goes solid and dead, turn it down and
     * you are looking at blue through the gaps, which is the single most
     * damaging thing that can happen to a jungle shot. A real forest solves
     * this by having several storeys at different heights whose gaps rarely
     * line up, so the sky is almost never visible but the light still comes
     * through in broken columns. This layer uses a different gap phase from
     * the one below it for exactly that reason.
     */
    this._add('canopy2', this._scatter('canopy2', 6.4, (c) => {
      if (c.dist > 80) return 0;
      const open = 1 - 0.92 * smoothstep(0.78, 0.92, c.t);
      const gap = smoothstep(0.10, 0.50,
        Math.abs(Math.sin(c.x * 0.037 + 2.1) * Math.cos(c.z * 0.029 - 1.3)
               + 0.6 * Math.sin(c.z * 0.019 - c.x * 0.014)));
      /* Weighted far more toward coverage than the storey below it. The lower
       * roof is where the shafts are shaped; this one is the thing that has to
       * make sure that when you look up between them you are still looking at
       * leaves and not at blue. */
      return 0.88 * open * (0.58 + 0.42 * gap);
    }, (c) => {
      const s = 0.9 + c.rng() * 0.9;
      const hh = 21 + c.rng() * 10;
      return {
        v: (c.rng() * SPECIES_LOD.canopy2.v) | 0,
        m: M().compose(_p.set(c.x, c.y + hh, c.z),
                       _q.setFromEuler(_e.set(0, c.rng() * 6.283, 0)),
                       _s.set(s * (0.86 + c.rng() * 0.3), s * 0.75, s * (0.86 + c.rng() * 0.3))),
      };
    }, seed + 9));

    this._add('palm', this._scatter('palm', 3.6, (c) => {
      if (c.stone) return 0;
      if (!bank(c, 2.0, 62)) return 0;
      if (c.slope > 0.75) return 0;
      return 0.42 * edgeLight(c.dist) * wallFoot(c, 0.35) * rooting(c, 0.92, 0.72);
    }, (c) => {
      // Palms come up in cohorts under a parent, so a clump centre is where
      // the tall ones are and the rim is all suckers.
      const s = 0.62 + c.rng() * 0.62 + c.dens * 0.42;
      return {
        v: (c.rng() * SPECIES_LOD.palm.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.05, c.z),
                       stand(c, 0.35, 0.22), bulk(c.rng, s, 0.12)),
      };
    }, seed + 3));

    this._add('broadleaf', this._scatter('broadleaf', 1.6, (c) => {
      if (!bank(c, 1.0, 48)) return 0;
      if (c.slope > 0.85) return 0;
      return 0.62 * edgeLight(c.dist) * (0.7 + 0.5 * c.wet)
           * wallFoot(c, 0.55) * (c.stone ? 0.28 : 1) * rooting(c, 0.85, 0.58);
    }, (c) => {
      const s = 0.58 + c.rng() * 0.72 + c.dens * 0.40;
      return {
        v: (c.rng() * SPECIES_LOD.broadleaf.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.04, c.z),
                       stand(c, 0.55, 0.30), bulk(c.rng, s, 0.17)),
      };
    }, seed + 4));

    this._add('fern', this._scatter('fern', 1.05, (c) => {
      if (c.mud > 0.30 || c.dist > 46) return 0;
      if (c.slope > 0.9) return 0;
      /* Ferns want shade and damp, so they take the hollows and the stream —
       * and, more than any other species here, the ruins. A fern is what
       * actually colonises a joint: it needs almost no soil, it tolerates the
       * shade a wall throws, and it is the plant a viewer expects to see
       * growing out of masonry. */
      return 0.66 * edgeLight(c.dist) * (0.55 + 0.6 * c.hollow + 0.5 * c.wet)
           * wallFoot(c, 0.85) * (c.stone ? 0.60 : 1);
    }, (c) => {
      const s = 0.50 + c.rng() * 0.78 + c.dens * 0.32;
      return {
        v: (c.rng() * SPECIES_LOD.fern.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.03, c.z),
                       stand(c, 0.70, 0.32), bulk(c.rng, s, 0.16)),
      };
    }, seed + 5));

    this._add('tussock', this._scatter('tussock', 1.0, (c) => {
      if (c.mud > 0.42 || c.dist > 32) return 0;
      return 0.5 * edgeLight(c.dist) * wallFoot(c, 0.5) * (c.stone ? 0.55 : 1);
    }, (c) => {
      const s = 0.55 + c.rng() * 0.8 + c.dens * 0.25;
      return {
        v: (c.rng() * SPECIES_LOD.tussock.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.02, c.z),
                       stand(c, 0.85, 0.10), bulk(c.rng, s, 0.18)),
      };
    }, seed + 6));

    /* Sprigs are allowed onto the trail edge. A path with a clean vegetation
     * boundary is a path someone mowed; a real one is invaded from both sides
     * and only the trodden centre stays bare. */
    this._add('sprig', this._scatter('sprig', 0.55, (c) => {
      if (c.dist > 30) return 0;
      const onTrail = 1 - smoothstep(0.15, 0.6, c.mud);
      return 0.55 * edgeLight(c.dist) * onTrail * wallFoot(c, 0.6);
    }, (c) => {
      const s = 0.6 + c.rng() * 0.9;
      return {
        v: (c.rng() * SPECIES_LOD.sprig.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.01, c.z),
                       stand(c, 0.90, 0.36), bulk(c.rng, s, 0.18)),
      };
    }, seed + 7));

    /* Loose litter, and the thing that changed here is that it is no longer
     * *everywhere*.
     *
     * The previous field was a near-constant 0.55 with a mild bonus in the
     * hollows, which spreads debris at one density over flat ground, banks
     * and the lips of banks alike; the critique's phrase was "similarly sized
     * leaf fragments cover every slope evenly". Even coverage is the tell,
     * because litter is not deposited, it is *transported*. It falls
     * everywhere and is then moved by water and gravity, so a real floor is
     * bare mineral soil on the steep pitches and forty centimetres of packed
     * leaf mould twenty metres downslope in the hollow. Getting that right
     * costs nothing here — the terrain already knows its own slope, wetness
     * and concavity — and it buys the single largest change in how the floor
     * reads, because it makes the floor a *consequence* of the ground shape
     * rather than a texture laid over it. */
    this._add('litterMat', this._scatter('litterMat', 0.95, (c) => {
      if (c.dist > 34) return 0;
      /* Thinned over the trodden strip, not removed from it.
       *
       * The previous version went to zero wherever the path material took
       * over, which drew a line: on one side a mat of three-dimensional
       * debris casting its own shadows, on the other a smooth painted ribbon,
       * and the boundary between them exactly following an analytic mask. A
       * real path through litter has no boundary at all — traffic sweeps and
       * crushes the leaves rather than deleting them, so the density falls
       * off over a metre or so and there is always something lying in the
       * middle of it. */
      const trodden = 1 - smoothstep(0.10, 0.55, c.mud);
      /* Shed. Above about twenty degrees a fallen leaf does not stay put: the
       * next storm takes it, and what is left is a thin scatter caught behind
       * roots and stems on otherwise bare, root-laced soil. Cubed rather than
       * linear because the transition in life is abrupt — a slope either
       * holds its litter or it does not, and a gentle ramp between the two
       * reproduces exactly the even wash this is meant to replace. */
      const held = Math.pow(1 - smoothstep(0.16, 0.62, c.slope), 3);
      /* And caught. A concavity is where everything that came off the slopes
       * above it ends up, so drifts are deep, continuous and much larger in
       * plan than anything on the open floor. Squared for the same reason the
       * shed term is cubed: the eye is looking for the *contrast* between a
       * scoured pitch and a packed hollow, and any monotonic function with a
       * healthy value in the middle erases it. */
      const caught = Math.pow(c.hollow, 2) * 2.6 + 0.30 * c.wet;
      /* A block top is a shelf that catches everything the canopy drops and
       * has nowhere to shed it, so it holds litter better than the floor does
       * — and that drift of leaves lying across the stone is most of what
       * makes the ruin look abandoned rather than swept. */
      if (c.stone) return 1.4;
      return 1.5 * (0.16 + 0.84 * trodden) * (0.10 + held * (0.55 + caught))
           * wallFoot(c, 0.7);
    }, (c) => {
      /* Scale, over a range four times wider than before and heavily skewed.
       *
       * A patch was 0.75 to 1.5, which is a factor of two — and a factor of
       * two in a scatter of overlapping patches is invisible, because the
       * union of them has no scale at all. So every fragment on the floor
       * came out within a whisker of the same size, which is the other half
       * of the critique. The fourth power puts most patches at the small end
       * with an occasional very large one: those are the deep drifts, and
       * because the mat is a self-similar scatter of debris, scaling the
       * patch scales the individual leaves in it too. One multiply therefore
       * buys the "mixed scales" the floor was missing — a big drift is made
       * of big whole blades and a small one of crumbs.
       *
       * The ceiling is where it is because everything inside the patch is
       * multiplied by this, and the patch is not made only of leaves. The
       * first attempt ran to four and turned the woody debris in the biggest
       * drifts into metre-scale objects with the bark map stretched across
       * them; the root that used to live in this species had to be moved out
       * for the same reason. Two and a half is a whole leaf the size of a
       * hand at the top end, which is as large as litter gets. */
      const s = 0.42 + Math.pow(c.rng(), 3.2) * 2.05 + 0.55 * c.dens * c.dens;
      /* How far into the humus it has gone, and this is what "embedded rather
       * than laid on top" means geometrically. Litter does not sit on the
       * soil; it *becomes* the soil from the bottom up, so at any moment a
       * floor holds recent falls proud of the surface and older ones sunk to
       * their margins with only a curled edge showing. Sinking a whole patch
       * rather than a single leaf is deliberate: burial is regional, the same
       * way rot is, and the wet hollows swallow their drifts fastest. */
      const sink = (0.012 + c.rng() * 0.075 * (0.5 + c.wet)) * Math.min(1.6, s);
      return {
        v: (c.rng() * SPECIES_LOD.litterMat.v) | 0,
        // Conformed all the way. Litter has no opinion about which way is up;
        // it lies on whatever it landed on, and a mat of it standing plumb on
        // a bank is the most obvious floating in the whole scene.
        m: M().compose(_p.set(c.x, c.y - sink, c.z),
                       stand(c, 1.0, 0.06), _s.set(s, 1, s)),
      };
    }, seed + 14));

    /* Exposed roots along the trail margin.
     *
     * The critique's third point had two halves and the density gradient only
     * answered one of them: the trail is still "a smooth dark ribbon with
     * abrupt, tidy borders", and a gradient cannot fix a border because a
     * gradient is still a function of distance from the centreline and so is
     * still, at every point, smooth and parallel to the path. What breaks an
     * edge is something lying *across* it. Roots are the correct object —
     * they are what a worn path in a forest actually exposes — and they carry
     * their own banked litter with them, so one species answers "break the
     * edge with roots" and "displaced litter" together.
     *
     * Placed at the shoulder rather than on the tread or in the undergrowth:
     * the tread is scoured and the undergrowth has forty centimetres of mould
     * over everything. The shoulder is the only band where soil is thin
     * enough to expose a root and undisturbed enough to keep one. */
    this._add('rootRun', this._scatter('rootRun', 4.2, (c) => {
      if (c.dist > 22 || c.stone) return 0;
      const shoulder = smoothstep(0.06, 0.30, c.mud) * (1 - smoothstep(0.52, 0.86, c.mud));
      // And on the steeper banks anywhere near the path, where runoff has
      // taken the topsoil off regardless of whether anyone walks there.
      const scoured = smoothstep(0.30, 0.70, c.slope) * (1 - smoothstep(12, 22, c.dist));
      return 1.15 * Math.max(shoulder, 0.55 * scoured);
    }, (c) => {
      /* Aligned to the fall line rather than yawed at random, because that is
       * what exposed them. A root is bared by water running over it, so the
       * ones still showing are the ones lying across the flow — and on a
       * banked trail the flow runs off the shoulder, which means these end up
       * crossing the edge, which is the entire purpose of the species. The
       * spread keeps it from being a combed field. */
      const fall = Math.atan2(-c.nz, c.nx) + (c.rng() - 0.5) * 1.5;
      _n.set(c.nx, c.ny, c.nz).normalize();
      _q.setFromUnitVectors(UP, _n);
      _e.set((c.rng() - 0.5) * 0.10, fall, (c.rng() - 0.5) * 0.10, 'YXZ');
      const s = 0.65 + c.rng() * 0.85;
      return {
        v: (c.rng() * SPECIES_LOD.rootRun.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.02, c.z),
                       _q.multiply(_qy.setFromEuler(_e)),
                       _s.set(s, s * (0.7 + c.rng() * 0.5), s)),
      };
    }, seed + 21));

    /* Saplings. These are the plants that actually block the view at head
     * height, and their scale range is wide on purpose: everything from a
     * knee-high seedling to a seven-metre pole waiting for a treefall gap. */
    this._add('sapling', this._scatter('sapling', 3.1, (c) => {
      if (c.dist < 1.6 || c.dist > 55) return 0;
      if (c.slope > 0.8) return 0;
      /* Kept, but rare, on stone. A seedling rooted in a joint is the whole
       * story of an abandoned building in one object, and it is also what
       * eventually takes the wall apart — but they are individuals, not a
       * crop, so a wall carrying a dozen of them would read as a hedge. */
      return 0.34 * edgeLight(c.dist) * wallFoot(c, 0.4) * (c.stone ? 0.22 : 1)
           * rooting(c, 0.70, 0.35);
    }, (c) => {
      const s = 0.5 + c.rng() * 0.7 + c.dens * 0.28;
      return {
        v: (c.rng() * SPECIES_LOD.sapling.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.05, c.z),
                       stand(c, 0.30, 0.28), bulk(c.rng, s, 0.14)),
      };
    }, seed + 12));

    /* Deadfall. Sparse, because a floor carpeted in logs looks staged, but
     * present, because a floor with none looks swept. */
    this._add('log', this._scatter('log', 9.0, (c) => {
      if (c.mud > 0.25 || c.dist > 45 || c.stone) return 0;
      if (c.slope > 0.6) return 0;
      return 0.42;
    }, (c) => {
      const s = 0.7 + c.rng() * 1.0;
      return {
        v: (c.rng() * SPECIES_LOD.log.v) | 0,
        /* Lying on the ground, so it follows the ground: a log is the one
         * thing in the scene long enough that a two-degree mismatch with the
         * slope leaves one end buried and the other in mid-air. Sunk another
         * few centimetres as well, because a fallen trunk settles into the
         * litter rather than resting on top of it. */
        m: M().compose(_p.set(c.x, c.y - 0.16, c.z),
                       stand(c, 0.92, 0.16), bulk(c.rng, s, 0.10)),
      };
    }, seed + 13));

    /* The storey between the ferns and the roof.
     *
     * With only an understory and a canopy there is a band from about five to
     * fifteen metres up with nothing in it, and because that band is at eye
     * level for anything more than twenty metres away, it is precisely where
     * the sky was still getting through. Filling it is what finally closes the
     * forest: sightlines out are blocked at head height rather than at knee
     * height, which is the difference between standing in a wood and standing
     * in a jungle.
     */
    this._add('subcanopy', this._scatter('subcanopy', 4.4, (c) => {
      if (c.dist < 3.0 || c.dist > 66 || c.stone) return 0;
      const open = 1 - 0.85 * smoothstep(0.78, 0.92, c.t);
      // Thinner directly over the trail, so the light well above the path
      // survives all three storeys.
      const lane = smoothstep(3.0, 11.0, c.dist);
      return 0.80 * open * (0.30 + 0.70 * lane) * rooting(c, 0.95, 0);
    }, (c) => {
      const s = 0.8 + c.rng() * 0.9;
      const hh = 4.5 + c.rng() * 8.0;
      return {
        v: (c.rng() * SPECIES_LOD.subcanopy.v) | 0,
        m: M().compose(_p.set(c.x, c.y + hh, c.z),
                       _q.setFromEuler(_e.set(0, c.rng() * 6.283, 0)),
                       _s.set(s * (0.85 + c.rng() * 0.32), s * 0.85, s * (0.85 + c.rng() * 0.32))),
      };
    }, seed + 11));

    /* The far wall. Starts where the real understory is thinning out and runs
     * well past anything the fog lets through, so there is no distance at
     * which the eye finds a way out of the forest. */
    this._add('thicket', this._scatter('thicket', 3.4, (c) => {
      if (c.dist < 16 || c.dist > 125 || c.stone) return 0;
      if (c.slope > 0.85) return 0;
      return 0.80 * (1 - 0.7 * smoothstep(0.82, 0.95, c.t)) * rooting(c, 0.95, 0.3);
    }, (c) => {
      /* Banded by distance instead of one size everywhere. A wall built from
       * a single scale distribution has no recession in it: the far members
       * subtend fewer pixels but describe the same plant, so the eye reads the
       * whole thing as one surface at one depth and the middle distance goes
       * flat. Growing them with range keeps the apparent size of a clump
       * roughly constant while its detail drops away, which is the cue that
       * says the frame continues behind what is in it. */
      const far = smoothstep(20, 95, c.dist);
      const s = (0.8 + c.rng() * 1.1) * (1 + 0.85 * far);
      return {
        v: (c.rng() * SPECIES_LOD.thicket.v) | 0,
        m: M().compose(_p.set(c.x, c.y - 0.2 - 0.5 * far, c.z),
                       stand(c, 0.5, 0.06), bulk(c.rng, s, 0.16)),
      };
    }, seed + 10));

    /* Lianas hang off the trees they climbed, so they are placed from the tree
     * list rather than scattered — a vine ending in mid-air is one of the more
     * obvious ways to break the illusion. */
    const rng = makeRng(seed + 8);
    const vines = [], dead = [];
    for (const s of treeSpots) {
      const n = 2 + ((rng() * 4) | 0);
      for (let i = 0; i < n; i++) {
        const a = rng() * 6.283;
        const rr = (2.0 + rng() * 5.5) * s.s;
        const hh = (10 + rng() * 14) * s.s;
        const sc = 0.7 + rng() * 0.8;
        vines.push({
          v: (rng() * SPECIES_LOD.vine.v) | 0,
          m: M().compose(
            _p.set(s.x + Math.cos(a) * rr, s.y + hh, s.z + Math.sin(a) * rr),
            _q.setFromEuler(_e.set(0, rng() * 6.283, 0)),
            _s.set(sc, sc, sc)),
        });
      }
      /* Bare strands, and there are more of these than leafy ones because a
       * liana puts all its foliage up in the canopy where the light is — what
       * hangs down at eye level is rope. They are close to free (a four-sided
       * tube) and they are the most effective thing in the whole system at
       * breaking a long sightline, because a vertical line crossing the view
       * at six metres reads as depth in a way that more leaves do not. */
      const nd = 2 + ((rng() * 5) | 0);
      for (let i = 0; i < nd; i++) {
        const a = rng() * 6.283;
        const rr = (1.5 + rng() * 7.0) * s.s;
        const hh = (7 + rng() * 17) * s.s;
        const sc = 0.7 + rng() * 0.9;
        dead.push({
          v: (rng() * SPECIES_LOD.deadVine.v) | 0,
          m: M().compose(
            _p.set(s.x + Math.cos(a) * rr, s.y + hh, s.z + Math.sin(a) * rr),
            _q.setFromEuler(_e.set(0, rng() * 6.283, 0)),
            _s.set(sc, sc, sc)),
        });
      }
    }
    /* And off the ruins, from anchors the stone system worked out for itself.
     *
     * Hanging these from wall tops rather than scattering them near the ruins
     * matters for the same reason it matters in the canopy: a liana is a thing
     * that got somewhere by climbing, so its top end has to be attached to
     * something. On masonry the effect is stronger than on a tree, because a
     * curtain of growth spilling over a wall head is the single image that
     * says "abandoned" — a clean coping edge says "maintained" no matter how
     * much moss is on it.
     *
     * They are shorter than the canopy lianas. A wall top is three metres up,
     * not twenty, and a strand scaled for a tree would pool on the ground.
     */
    if (this.ruins) {
      for (const a of this.ruins.vineAnchors) {
        const sc = 0.26 + rng() * 0.20;
        const leafy = rng() < 0.45;
        (leafy ? vines : dead).push({
          v: (rng() * SPECIES_LOD[leafy ? 'vine' : 'deadVine'].v) | 0,
          m: M().compose(
            _p.set(a.x + (rng() - 0.5) * 0.5, a.y + 0.10, a.z + (rng() - 0.5) * 0.5),
            _q.setFromEuler(_e.set(0, rng() * 6.283, 0)),
            _s.set(sc * a.s, sc * a.s * 1.35, sc * a.s)),
        });
      }
    }

    this._add('vine', vines);
    this._add('deadVine', dead);
  }

  /**
   * Bucket instances into ground tiles and build one InstancedMesh per
   * (tile, variant), so the frustum has something small to reject.
   */
  _add(name, list) {
    if (!list.length) return;
    const { tile, cull, cast, near = 0, shade = 1 } = SPECIES_LOD[name];
    const variants = this.species[name];
    const buckets = new Map();
    const rng = makeRng(0xbeef ^ (name.length * 2654435761));

    for (const it of list) {
      /* The instance transform is the last point at which a trunk still has
       * an identity. Once it enters a draw bucket, the scene graph knows only
       * about one merged species variant and recovering solids would mean
       * scanning every leaf card as well as the wood. Builders therefore keep
       * a tiny local proxy beside the geometry and placement turns it into a
       * world-space registry entry exactly once. */
      if (this.collision) {
        const solid = variants[it.v].hi.solid;
        if (solid) this._registerSolid(solid, it.m);
      }
      const p = new THREE.Vector3().setFromMatrixPosition(it.m);
      const ti = Math.floor(p.x / tile), tj = Math.floor(p.z / tile);
      const key = `${ti},${tj},${it.v}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, b = { ti, tj, v: it.v, items: [] });
      b.items.push(it);
    }

    for (const b of buckets.values()) {
      const geo = variants[b.v];
      const group = new THREE.Group();
      const hiG = new THREE.Group();
      const loG = near ? new THREE.Group() : null;
      group.add(hiG);
      if (loG) group.add(loG);

      /* Per-instance tint. A stand where every plant of a species is the
       * same green is the most reliable giveaway there is; real ones vary by
       * age, by species, by light history and by how wet they are.
       *
       * Drawn once per bucket rather than once per mesh, because the two
       * detail levels have to agree: they are the same plant, and a tile that
       * changed hue as it crossed the switch radius would turn an invisible
       * change of resolution into an obvious one. */
      const cols = [];
      for (let i = 0; i < b.items.length; i++) {
        const v = (0.60 + rng() * 0.46) * shade;
        /* Held closer to neutral than it was. The chroma spread here is
         * multiplied by an already yellow-green atlas, so its warm end was
         * landing on screen as cream — which is what put the pale, almost
         * unrelated-looking leaves through the middle of the frame. */
        const col = new THREE.Color(
          v * (0.90 + rng() * 0.16), v, v * (0.84 + rng() * 0.20));
        /* Roughly one plant in nine is dying, and it is the most valuable
         * one in the frame. Uniform health is a strong CG tell: a real
         * understory always has senescing fronds going yellow and dead ones
         * hanging brown, and those warm notes are what stop the green mass
         * reading as a single flat colour. Kept well off full chroma,
         * though — at the strength the first version used the yellowing
         * plants read as separate objects painted a different colour rather
         * than as the same species in worse condition. */
        const age = rng();
        if (age > 0.93) col.lerp(new THREE.Color(0.58, 0.47, 0.28), 0.22 + rng() * 0.22);
        else if (age > 0.84) col.lerp(new THREE.Color(0.60, 0.57, 0.38), 0.14 + rng() * 0.14);
        cols.push(col);
      }

      const mk = (parent, g, mat, depth) => {
        const im = new THREE.InstancedMesh(g, mat, b.items.length);
        b.items.forEach((it, i) => im.setMatrixAt(i, it.m));
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = cast;
        im.receiveShadow = true;
        im.customDepthMaterial = depth;
        for (let i = 0; i < cols.length; i++) im.setColorAt(i, cols[i]);
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        parent.add(im);
        return im;
      };

      if (geo.hi.leaf) mk(hiG, geo.hi.leaf, this.leafMat, this.leafDepth);
      if (geo.hi.wood) mk(hiG, geo.hi.wood, this.woodMat, this.woodDepth);
      if (loG) {
        if (geo.lo.leaf) mk(loG, geo.lo.leaf, this.leafMat, this.leafDepth);
        if (geo.lo.wood) mk(loG, geo.lo.wood, this.woodMat, this.woodDepth);
        loG.visible = false;
      }

      group.updateMatrixWorld(true);
      this.root.add(group);
      this.cells.push({
        group, hi: hiG, lo: loG,
        x: (b.ti + 0.5) * tile, z: (b.tj + 0.5) * tile, cull, near,
      });
    }
  }

  _registerSolid(solid, matrix) {
    const e = matrix.elements;
    const px = e[12], py = e[13], pz = e[14];
    const sx = Math.hypot(e[0], e[2]);
    const sy = Math.hypot(e[4], e[6]);
    const sz = Math.hypot(e[8], e[10]);
    const planScale = Math.max(sx, sz);
    const point = (p) => ({
      x: e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + px,
      y: e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + py,
      z: e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + pz,
    });

    if (solid.type === 'palm' || solid.type === 'tree') {
      const radius = solid.radius * planScale;
      const topY = py + solid.height * e[5];
      this.collision.addCircle({
        x: px, z: pz, radius,
        minY: Math.min(py, topY) - radius * 0.15,
        maxY: Math.max(py, topY) + radius * 0.15,
        kind: solid.type,
      });

      if (solid.buttresses) {
        for (const b of solid.buttresses) {
          const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
          const a = point([ca * b.start, 0, sa * b.start]);
          const z = point([ca * b.end, 0, sa * b.end]);
          const top = py + b.height * e[5];
          this.collision.addCapsule({
            ax: a.x, az: a.z, bx: z.x, bz: z.z,
            radius: b.radius * planScale,
            minY: Math.min(py, top) - b.radius * planScale,
            maxY: Math.max(py, top) + b.radius * planScale,
            kind: 'buttress',
          });
        }
      }
      return;
    }

    if (solid.type === 'log') {
      const a = point(solid.a), b = point(solid.b);
      /* A log can lie across a bank, so its local up axis may contribute to
       * plan-space width. Using the largest projected basis keeps the proxy
       * conservative without turning its splintered ends into a box. */
      const radius = solid.radius * Math.max(sx, sy, sz);
      this.collision.addCapsule({
        ax: a.x, az: a.z, bx: b.x, bz: b.z, radius,
        minY: Math.min(a.y, b.y) - radius,
        maxY: Math.max(a.y, b.y) + radius,
        kind: 'log',
      });
    }
  }

  /* ---------------------------------------------------------------- runtime */

  /**
   * Per-tile distance culling on top of the frustum test.
   *
   * The fog closes visibility at around 40 m, so a tile 80 m away contributes
   * nothing but is still inside the frustum and still submitted. Testing tile
   * centres is a few hundred distance comparisons per frame and removes most
   * of the draw calls in the scene. Tall species get a longer leash because
   * their crowns are above the fog and are legitimately visible further out.
   */
  update(dt, camera, sun, sunColor, skyColor) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;

    if (sun) {
      // The transmission lobe is evaluated in view space, so the sun direction
      // has to be rotated into it every frame the camera moves.
      this.uniforms.uSunView.value
        .copy(sun)
        .transformDirection(camera.matrixWorldInverse);
    }
    if (sunColor) this.uniforms.uSunColor.value.copy(sunColor);
    if (skyColor) this.uniforms.uSkyColor.value.copy(skyColor);

    /* Pixels per radian at the centre of the frame, which is what turns a
     * world-space width into a screen-space one. Recomputed every frame
     * because the FOV and the drawing buffer both move — the capture harness
     * changes the lens between shots, and a stale value would silently stop
     * the thin-geometry floor from doing anything. */
    this.uniforms.uProj.value =
      camera.projectionMatrix.elements[5] * 0.5 * this.renderer.domElement.height;

    const cx = camera.position.x, cz = camera.position.z;
    for (const c of this.cells) {
      const dx = c.x - cx, dz = c.z - cz;
      const d2 = dx * dx + dz * dz;
      c.group.visible = d2 < c.cull * c.cull;
      if (c.lo) {
        // Measured to the tile centre, like the cull, so a tile is entirely
        // one level or entirely the other — which is what keeps this to two
        // draw calls per bucket instead of a per-instance sort.
        const fine = d2 < c.near * c.near;
        c.hi.visible = fine;
        c.lo.visible = !fine;
      }
    }
  }

  /* Counts the fine build only. The coarse copies are alternatives to it,
   * never drawn alongside, and adding them in would report a forest half
   * again as heavy as the one that exists. */
  stats() {
    let n = 0, tris = 0;
    for (const c of this.cells) {
      for (const m of c.hi.children) {
        n += m.count;
        tris += (m.geometry.index.count / 3) * m.count;
      }
    }
    return { meshes: this.cells.length, instances: n, tris: Math.round(tris) };
  }
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function vhash(i, j, s) {
  const n = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Smooth 2D value noise, used to clump the scattering.
 *
 * A per-candidate probability produces a statistically even spread — Poisson
 * disc by another name — and evenness is the thing that gives a procedural
 * forest away even when every individual plant is convincing. Real vegetation
 * is patchy at every scale, because it is competing for light and water that
 * are themselves patchy: a treefall gap grows a near-impassable thicket, and
 * fifteen metres away under closed canopy the floor is almost bare. Modulating
 * the acceptance probability by a slow noise field buys that structure for
 * three lookups per candidate.
 */
export function clumpNoise(x, z, scale, seed) {
  const u = x / scale, v = z / scale;
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const a = vhash(i, j, seed), b = vhash(i + 1, j, seed);
  const c = vhash(i, j + 1, seed), d = vhash(i + 1, j + 1, seed);
  return (a + (b - a) * su) + ((c + (d - c) * su) - (a + (b - a) * su)) * sv;
}
