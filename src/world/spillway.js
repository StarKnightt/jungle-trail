/* The spillway: the shape the water cut for itself.
 *
 * System 1 left two things for the falls — a notch in the cliff's top edge and
 * a basin in the clearing — and measuring them showed they do not meet. Three
 * facts, all of them from the heightfield rather than from the drawing:
 *
 *  - The notch's face is a ramp, not a wall. It rises thirty metres from
 *    z = -380 to z = -398, which is about sixty-three degrees. Water on that
 *    slides the whole way down and never leaves the rock, and a sheet running
 *    over rock is a wet cliff, not a waterfall. The single feature that makes
 *    a fall a fall is a length of *air*, and there was nowhere for it.
 *  - The foot of that ramp is twenty metres south of the basin's far lip, so
 *    water arriving there lands on dry ground and stops.
 *  - The trail runs straight through the middle of the basin. At t = 0.92 the
 *    tread is at y = -2.9 and the basin fills to y = 0.05, which would put the
 *    camera nearly three metres underwater at the two frames the whole level
 *    is built to arrive at.
 *
 * So this file cuts the geometry that reconciles them, and every part of it is
 * something falling water genuinely does to rock:
 *
 *   the chute      A groove down the upper face. Without it the stream arrives
 *                  at the lip spread over twelve metres of rock and there is
 *                  no fall, only a stain.
 *   the undercut   Sixteen metres of near-vertical face directly under the
 *                  lip. This is the whole point of the file. A plunging fall
 *                  excavates the softer rock *behind* its own curtain — the
 *                  water never touches the face it is cutting, the spray and
 *                  the freeze-thaw do it — and what is left is an overhanging
 *                  lip with an alcove under it. That alcove is the air the
 *                  sheet needs in order to break up.
 *   the alcove     The floor the fall lands on, three metres above the
 *                  clearing and held under half a metre of water.
 *   the outwash    A channel from the alcove north to the basin, passing
 *                  between the revetment wings, which is what those wings are
 *                  revetting.
 *   the causeway   The trail's own corridor, held above the water everywhere
 *                  it crosses it. See `causeway()` below.
 *
 * The numbers live here rather than in terrain.js because the water surface
 * has to agree with them to the centimetre: world/water.js reads the same
 * tables to decide where its meshes go and how deep the water over them is.
 * Two copies of this profile that disagree by ten centimetres is a river
 * flowing along the inside of a rock.
 */
import { sinkDepth } from './brook.js';

/* Interpolated with a smoothstep rather than linearly, and it is not
 * cosmetic. A piecewise-linear profile puts a crease at every table row, and
 * a crease across a cliff face catches the light as a hard band the width of
 * one terrain cell — the same faceting the height noise was cut back to avoid.
 * The S-curve also gives the undercut a rounded foot and a slightly
 * overhanging lip for free, which is exactly the section a plunge pool cuts.
 */
function tableAt(tab, z) {
  if (z >= tab[0][0]) return tab[0][1];
  const n = tab.length;
  if (z <= tab[n - 1][0]) return tab[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (z >= tab[i][0]) {
      const a = tab[i - 1], b = tab[i];
      let f = (z - a[0]) / (b[0] - a[0]);
      f = f * f * (3 - 2 * f);
      return a[1] + (b[1] - a[1]) * f;
    }
  }
  return tab[n - 1][1];
}

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Surface of the plunge pool. Everything downstream of the alcove ends here. */
export const POOL_Y = 0.05;

/** The plunge basin. terrain.js cuts it; ruins.js keeps its own copy of the plan. */
export const POOL = { x: 0, z: -356, r: 12.5, depth: 3.4, rim: 5.2 };

/* The shape of the basin's bed, and the two numbers in it that matter.
 *
 * The first build subtracted a smoothstep bowl from the surrounding ground.
 * Both halves of that are wrong. Subtracting inherits every bump of the height
 * noise, so the bed under a level surface is not level and the depth-driven
 * clip in the water material carves the sheet into islands; and a smoothstep
 * has zero gradient at both ends, so the bed *approaches the waterline
 * tangentially* and the shoreline is wherever the noise happens to cross it —
 * which measured out as an eight-by-six-metre puddle inside a basin drawn
 * twenty-five metres across, with dry leaf litter over the rest of it.
 *
 * This authors the bed as an absolute height instead, and gives it a profile
 * whose gradient is *infinite* at the rim: depth goes as the 0.55 power of the
 * distance in from the edge, so twenty centimetres inside the waterline there
 * is already half a metre of water. That is what a plunge pool is — the fall
 * excavates a steep-sided pit and the bank stands over it — and a steep bank
 * is the only thing that makes a waterline a line rather than a gradient.
 *
 * The rim itself is not a circle. A perfectly round shore is the loudest tell
 * a procedural lake has, and two low harmonics of the bearing are enough to
 * take it off: they cost nothing and no part of the outline repeats.
 */
export function poolBed(x, z) {
  const dx = x - POOL.x, dz = z - POOL.z;
  const pd = Math.hypot(dx, dz);
  if (pd > POOL.r * 1.16) return Infinity;
  const ang = Math.atan2(dz, dx);
  const r = POOL.r * (1 + 0.075 * Math.sin(ang * 3.0 + 0.7)
                        + 0.045 * Math.sin(ang * 5.0 - 1.9));
  if (pd >= r) return Infinity;
  const k = Math.min(1, (r - pd) / POOL.rim);
  return POOL_Y - POOL.depth * Math.pow(k, 0.55);
}

/* Where the spillway cut is allowed to touch the ground at all. The southern
 * end is past the crest and the northern end is inside the basin, where the
 * pool's own excavation is deeper than anything here and the min() below
 * therefore does nothing. */
export const SPILL_Z0 = -358;
export const SPILL_Z1 = -403;

/* Floor of the spillway on its own axis, in metres of world height.
 *
 * Read it from the bottom up and it is the water's route: down a chute at
 * about two metres of drop per metre of run, easing onto a short shelf at
 * -391, over the lip, then nothing at all until the alcove floor sixteen
 * metres below. The rows either side of the drop are 1.9 m apart because that
 * is as tight as a 0.5 m heightfield can hold a vertical face without the
 * smoothstep between them turning into a single enormous triangle.
 */
const FLOOR = [
  [-360.0, -0.50],
  [-366.0, -0.55],
  [-370.0, -0.35],
  [-373.0, -0.10],
  [-375.5, 0.10],
  [-377.5, 0.42],
  [-379.5, 0.72],
  [-381.5, 0.86],   // the sill the rapids run over
  [-384.0, 0.50],
  [-386.0, -0.20],
  [-388.0, -0.55],
  [-389.5, -0.60],  // floor of the plunge basin, 2.2 m under its own water
  [-390.9, 19.40],  // the lip
  [-392.0, 20.90],
  [-394.0, 25.20],
  [-397.0, 30.40],
  [-400.0, 34.50],
];

/* Half-width of the cut. Narrow in the chute, because that is a watercourse;
 * widest at the alcove, because a plunge pool is always wider than the fall
 * that made it — the spray works sideways as well as back. */
const HALF = [
  [-360.0, 3.6],
  [-366.0, 4.0],
  [-372.0, 4.2],
  [-376.0, 4.6],
  [-380.0, 5.4],
  [-383.0, 6.4],
  [-386.0, 7.2],
  [-389.0, 7.2],
  [-391.0, 3.6],
  [-394.0, 2.8],
  [-400.0, 2.4],
];

/* The channel's centreline, and the reason it wanders.
 *
 * It has to. The trail's last stretch runs down x = 0 to z = -378, which is
 * where the outwash would otherwise be, and a walker cannot use a streambed.
 * Swinging the channel five metres east through that stretch puts the water
 * beside the path instead of under it, and it is also what a stream leaving a
 * plunge pool does: it takes the outside of the basin rather than the middle.
 * It comes back to the axis at both ends because both ends are fixed — the
 * alcove at one and the pool at the other.
 */
const CENTRE = [
  [-360.0, 0.8],
  [-364.0, 1.2],
  [-368.0, 2.0],
  [-372.0, 2.4],
  [-375.0, 2.2],
  [-378.0, 1.8],
  [-382.0, 1.3],
  [-386.0, 1.0],
  [-400.0, 1.0],
];

/* The water surface from the plunge basin down to the pool.
 *
 * Authored as the *surface*, with the bed above authored to match, rather than
 * the surface being derived by adding a depth to the bed. The surface is the
 * thing with constraints on it: it has to descend monotonically all the way,
 * it has to arrive at exactly POOL_Y where it meets the basin, and it has to
 * stay clear of the tread at every station where the trail is alongside.
 *
 * The height of the whole run is the number that was got wrong first and it is
 * worth recording why. The obvious reading of the terrain puts the catch basin
 * at about y = 3, level with the clearing floor at the foot of the cliff — and
 * that is roughly two thirds of a metre above the player's eye at the two
 * stops the level exists to arrive at. The result was a fall that landed on a
 * shelf the camera was looking at edge-on and could not see into, with the
 * rising apron in front of it occluding the impact: from the trail there was
 * no waterfall at all, only a wet slot. Water has to land *below* the eye that
 * is watching it. At 1.65 m the impact sits two thirds of a metre under eye
 * height from t = 0.98, the sightline clears the intervening ground by nearly
 * a metre, and the extra 1.6 m of fall buys a genuine 16% cascade between the
 * basin and the pool where there had been a nearly level ditch.
 */
const LEVEL = [
  [-366.0, POOL_Y],
  [-370.0, 0.10],
  [-373.0, 0.22],
  [-375.5, 0.42],
  [-377.5, 0.72],
  [-379.5, 1.08],
  [-381.5, 1.36],
  [-384.0, 1.56],
  [-387.0, 1.64],
  [-390.0, 1.66],
];

export const spillFloor = (z) => tableAt(FLOOR, z);
export const spillHalf = (z) => tableAt(HALF, z);
export const spillCentre = (z) => tableAt(CENTRE, z);

/* The stretch of channel above the lip that has water running down it.
 *
 * The downstream end is the upstream end of the curtain's own geometry, and the
 * upstream end is where the authored floor stops being below the ground the
 * noise put there — past about -399 the table's last row sits *above* the
 * hillside, so anything keyed to it up there would be water in mid-air.
 *
 * It exists as a pair of exported numbers because three files need the same
 * answer to "is this point in the feed": water.js lays the tongue in it,
 * standingWater() has to keep plants out of it, and the terrain's wetness
 * field has to soak it. The lip shot before this existed showed the fall
 * emerging from a strip of dry sunlit dirt with a seedling growing in it,
 * which is a stronger tell than anything the curtain itself was doing wrong:
 * water arrives from somewhere, and the somewhere has to look used.
 */
export const CHUTE_Z0 = -399.0;
export const CHUTE_Z1 = -391.3;

/** Surface of the tongue in the chute, matching what water.js lays there. */
export function chuteLevel(z) {
  return spillFloor(z) + 0.30;
}

/** 0..1 soak along the feeding channel above the lip, for the wetness field. */
export function chuteWet(x, z) {
  if (z > CHUTE_Z1 + 1.0 || z < CHUTE_Z0 - 3.0) return 0;
  const a = Math.abs(x - spillCentre(z));
  /* Wider than the wetted width, because the corridor a fall keeps wet is
   * wider than the water in it — spray off the lip, and the channel's own
   * banks. Feathered at both ends so it does not terminate on a contour. */
  return smoothstep(Math.min(spillHalf(z), 3.4) + 2.2, 1.2, a)
       * smoothstep(CHUTE_Z1 + 1.0, CHUTE_Z1 - 0.4, z)
       * smoothstep(CHUTE_Z0 - 3.0, CHUTE_Z0 + 0.6, z);
}

/** Height of the free water surface between the alcove and the pool. */
export function runLevel(z) {
  return z > -366 ? POOL_Y : tableAt(LEVEL, z);
}

/* Water level in the plunge basin — the surface the falling water actually
 * hits, and therefore where the impact, the splash and the audio's base
 * source all go. */
export const ALCOVE_Y = tableAt(LEVEL, -387.6);

/**
 * How much of the water's excavation survives this close to the trail, 0..1.
 *
 * This is the causeway, and it is the answer to the trail running through the
 * middle of the basin. Multiplying every cut — the pool's and the channel's —
 * by the trail's own distance field leaves a bar of untouched ground along the
 * tread with the water lapping at its edges, and that is a better frame than
 * either of the alternatives: moving the basin would put it under the ruins,
 * and lowering the water level cannot help because the trail crosses the
 * deepest part of the bowl at every level.
 *
 * It also earns its keep twice. The bank it leaves is 3.4 m of drop over 3 m
 * of run, which is fifty degrees — steeper than the walker's climb limit — so
 * the player is physically prevented from walking into the water rather than
 * being trusted not to. And the ruins already carry the reading: this complex
 * has a causeway over the stream at the gate, a revetment at the spillway and
 * steps down into the basin, so an approach running out across the water to
 * the falls is the thing that was always there.
 */
export function causeway(dist) {
  /* Narrow, and the width is a composition decision as much as a hydrological
   * one. At the five-metre half-width this first had, the bar was wider than
   * the frame is deep at the two arrival stops: the lower half of both shots
   * was unbroken dry dirt with the river squeezed off to one side, which is a
   * path across a building site rather than an approach to a waterfall. A
   * metre and a half of tread with the water inside three puts the surface on
   * both sides of the player and inside the near half of the frame, and it is
   * still far more than the walker's capsule needs. */
  return smoothstep(1.5, 3.4, dist);
}

/**
 * Apply the spillway to a raw terrain height.
 *
 * Expressed as `min(h, floor)`, so it can only ever remove rock. A cut that
 * could also add would be fighting the ridged noise on the cliff face, and the
 * failure mode of that is a lip standing higher in some columns than others —
 * which puts the fall in three places at once and is invisible until you look
 * at the finished mesh.
 *
 * @param {number} guard 0..1 from `causeway()`, already faded in over the
 *   stretch where the trail exists. Passed in rather than computed here
 *   because the caller already has the trail distance and this runs a quarter
 *   of a million times.
 */
export function spillwayCut(x, z, h, guard) {
  if (z > SPILL_Z0 || z < SPILL_Z1) return h;
  const hw = spillHalf(z);
  const a = Math.abs(x - spillCentre(z));
  // Two metres of feather. Wider and the channel has no banks; narrower and
  // the terrain's 0.5 m grid renders the transition as a step.
  const m = smoothstep(hw + 2.0, hw, a) * guard;
  if (m <= 0.001) return h;
  const f = spillFloor(z);
  return f < h ? h + (f - h) * m : h;
}

/**
 * Depth of standing water over a point of ground, in metres, or 0 if it is dry.
 *
 * The one authority on "is this underwater", so that the vegetation, the
 * scatter and anything else that has to keep out of the river are asking the
 * same question the water meshes answer. Before this existed the scatter knew
 * only the terrain height, and the terrain under a river is perfectly good
 * ground: the result was ferns standing in the middle of the plunge basin and
 * one growing straight out of the falling curtain, which is the single most
 * expensive-looking mistake in the whole clearing.
 *
 * @param {number} h ground height at (x, z), which the caller always has.
 */
export function standingWater(x, z, h, brook = null, q = null) {
  let surf = -1e9;
  if (z <= SPILL_Z0 && z >= SPILL_Z1) {
    const hw = spillHalf(z);
    // No feather: this is a containment test, and a soft edge here would leave
    // a band of half-rejected plants paddling along both banks.
    if (Math.abs(x - spillCentre(z)) < hw) surf = runLevel(z);
    /* Above the lip the run level means nothing — it is the level of the water
     * sixteen metres *below* — so a point in the chute measured against it is
     * dry by twenty-five metres and the scatter was free to root a seedling in
     * the middle of the feed. The tongue's own surface is the right question
     * there, and it is the same expression water.js builds the mesh from. */
    if (z <= CHUTE_Z1 && z >= CHUTE_Z0
        && Math.abs(x - spillCentre(z)) < Math.min(hw, 3.4)) {
      surf = Math.max(surf, chuteLevel(z));
    }
  }
  if (poolBed(x, z) < POOL_Y) surf = Math.max(surf, POOL_Y);
  let d = Math.max(0, surf - h);
  /* The brook and the basin's outflow, which the first version of this did not
   * know about — so every plant grid happily rooted a fern in the middle of
   * the stream, and the only reason nobody saw it was that the stream itself
   * was not drawing. Both are asked through the same authority the meshes are
   * built from. */
  if (brook && q) d = Math.max(d, brook.depthAt(h, q));
  return Math.max(d, sinkDepth(x, z, h));
}

/** True inside the wetted channel, used by the terrain's wetness field. */
export function spillwayWet(x, z) {
  if (z > SPILL_Z0 || z < SPILL_Z1) return 0;
  const hw = spillHalf(z);
  return smoothstep(hw + 3.5, hw - 1.0, Math.abs(x - spillCentre(z)));
}
