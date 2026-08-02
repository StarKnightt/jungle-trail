/* Scenario registry.
 *
 * The same world-builder spine — trail, heightfield, vegetation, atmosphere —
 * serves different biomes by swapping a few authored layers: which ground
 * surfaces bake, which leaf palette the atlas uses, how the species weights
 * lean, and how the atmosphere is tuned. `jungle` reproduces the original
 * values exactly; `forest` is a temperate deciduous autumn variant.
 *
 * Selecting: use the opening picker, or append `#forest` (or
 * `#scenario=forest`) to the URL. The capture harness and the browser read the
 * same hash, so `#scenario=forest&manual` is the deterministic way to drive
 * the tools against the forest.
 *
 * The vegetation block is the one partial knob in this version: palmScale and
 * broadleafScale scale the placement accept probabilities for those species,
 * and the tint/senescence values nudge the per-instance colour variation.
 * A conifer species (evergreen) is the planned extension; the flag exists so
 * the contract does not have to change when it lands.
 */

export const SCENARIOS = {
  jungle: {
    id: 'jungle',
    title: 'Jungle Trail',
    /* The original tuning, kept verbatim so the default frame is unchanged. */
    atmosphere: {
      sunEl: 38, sunAz: 152,
      fogColor: 0x323c2c, fogDensity: 0.038,
      hemiSky: 0x82a081, hemiGround: 0x63513a, hemiIntensity: 0.55,
      envIntensity: 0.34,
      skyGround: 0x4d5a41, skyHaze: 0x475538,
      mistAmbient: 0x11170f,
    },
    groundSet: 'jungle',
    leafPalette: 'jungle',
    vegetation: {
      palmScale: 1, broadleafScale: 1, conifer: false,
      tint: { rMul: 0.90, rSway: 0.16, bMul: 0.84, bSway: 0.20 },
      senescent: { yellow: 0.93, olive: 0.84 },
      woodTint: 0xffffff,
    },
    audio: null,   // no overrides — the rainforest score as tuned
  },

  forest: {
    id: 'forest',
    title: 'Temperate Forest — Autumn',
    atmosphere: {
      /* A lower, later-in-the-day autumn sun, greyer haze, and a warm soil
       * bounce replacing the green litter bounce. The hemi steps back a
       * little: the deciduous roof is thinner than three storeys of canopy,
       * so more of the frame is carried by the sun and the environment. */
      sunEl: 30, sunAz: 150,
      fogColor: 0x46463a, fogDensity: 0.030,
      hemiSky: 0x9c9c88, hemiGround: 0x5a4530, hemiIntensity: 0.50,
      envIntensity: 0.38,
      skyGround: 0x5a5a4e, skyHaze: 0x4b4b40,
      mistAmbient: 0x171813,
    },
    groundSet: 'forest',
    leafPalette: 'autumn',
    vegetation: {
      /* Palms are the single loudest tropical tell; at 0.05 they are gone.
       * Broadleaf understory carries the deciduous look, so it is pushed up.
       * Tints lean warm and slightly more plants read as senescing, which is
       * what an autumn floor is actually doing. Wood gets a browner coat:
       * the tropical bark is pale and smooth on purpose, and temperate bark
       * reads wrong at that value. */
      palmScale: 0.05, broadleafScale: 1.35, conifer: false,
      tint: { rMul: 0.98, rSway: 0.10, bMul: 0.66, bSway: 0.14 },
      senescent: { yellow: 0.85, olive: 0.76 },
      woodTint: 0x8f8066,
    },
    audio: {
      /* A temperate wood is birds and wind; the tropical beds step back.
       * Falls and brook stay — a forest with a waterfall is the point. */
      cicada: -33, crickets: -35,
      birds: -16, rustle: -19, wash: -31,
    },
  },
};

/**
 * Return the explicitly requested scenario, or null when the hash does not
 * select one. Keeping this distinct from scenarioFor lets the app show its
 * picker on a clean launch while retaining jungle as the runtime fallback.
 *
 * @param {string} hash  location.hash, with or without the leading '#'
 * @returns {string|null}
 */
export function explicitScenarioFor(hash = '') {
  const raw = String(hash).replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const bare = raw.split('&', 1)[0];
  const requested = params.get('scenario') || bare;
  return requested && Object.hasOwn(SCENARIOS, requested) ? requested : null;
}

/**
 * @param {string} hash  location.hash, with or without the leading '#'
 * @returns {string} scenario id, always one of SCENARIOS
 */
export function scenarioFor(hash = '') {
  /* A bare scenario may be followed by the same flags used by the harness,
   * e.g. `#forest&tier=low`. Never use `in` here: location.hash is public
   * input and inherited Object.prototype names are not scenarios. */
  return explicitScenarioFor(hash) || 'jungle';
}
