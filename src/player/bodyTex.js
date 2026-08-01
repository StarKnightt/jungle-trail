/* Player material atlas.
 *
 * The body sits closer to the camera than anything else in the forest, so a
 * flat colour here would be more conspicuous than a low-detail silhouette.
 * These six surfaces are baked together to keep the body at three textures
 * rather than spending a colour, normal and ORM map on every piece of clothing.
 * Geometry maps its UVs into the padded interior of one cell; the padding is
 * important because a normal bake samples either side of every texel, and a
 * sample that crossed directly from skin into boot leather would emboss the
 * atlas boundary into the material.
 */

export const BODY_ATLAS = Object.freeze({
  columns: 4,
  rows: 2,
  skin: 0,
  shirt: 1,
  trousers: 2,
  leather: 3,
  hair: 4,
  rubber: 5,
});

export const BODY_SURFACE = /* glsl */ `
float bodyUnit(float v){ return v * 0.5 + 0.5; }

void skinSurface(vec2 p, out vec3 albedo, out float height, out float rough, out float ao){
  float tone = bodyUnit(pfbm(p * vec2(4.0, 5.0), vec2(4.0, 5.0), 4));
  float warm = bodyUnit(pfbm(p * vec2(9.0, 7.0) + 2.7, vec2(9.0, 7.0), 3));
  float pores = bodyUnit(pnoise(p * vec2(72.0, 80.0), vec2(72.0, 80.0)));
  vec2 fw = pworley(p * vec2(18.0, 20.0) + 5.0, vec2(18.0, 20.0));
  float freckle = sstep(0.105, 0.018, fw.x)
                * sstep(0.47, 0.78, bodyUnit(pnoise(p * vec2(7.0, 8.0) + 11.0,
                                                   vec2(7.0, 8.0))));

  /* The colour is deliberately warm enough to survive the canopy's green
   * fill. Neutral pale skin under that light becomes grey-green and reads as
   * rubber; the small red variation is the cheaper and more stable cue than a
   * subsurface-scattering shader for two forearms. */
  vec3 cool = vec3(0.435, 0.245, 0.178);
  vec3 sun = vec3(0.655, 0.405, 0.292);
  albedo = mix(cool, sun, 0.28 + tone * 0.58);
  albedo *= vec3(0.94 + warm * 0.10, 0.92 + warm * 0.06, 0.94 - warm * 0.03);
  albedo = mix(albedo, vec3(0.225, 0.105, 0.066), freckle * 0.46);

  height = 0.50 + (pores - 0.5) * 0.055 + freckle * 0.018;
  rough = 0.48 + (1.0 - tone) * 0.16 + pores * 0.05;
  ao = 1.0;
}

void shirtSurface(vec2 p, out vec3 albedo, out float height, out float rough, out float ao){
  float broad = bodyUnit(pfbm(p * vec2(3.0, 4.0), vec2(3.0, 4.0), 4));
  float warp = 1.0 - abs(pnoise(p * vec2(58.0, 5.0), vec2(58.0, 5.0)));
  float weft = 1.0 - abs(pnoise(p * vec2(5.0, 64.0) + 17.0, vec2(5.0, 64.0)));
  float thread = max(pow(warp, 8.0), pow(weft, 8.0));
  float crease = bodyUnit(pnoise(p * vec2(7.0, 3.0) + 31.0, vec2(7.0, 3.0)));

  vec3 deep = vec3(0.075, 0.105, 0.052);
  vec3 light = vec3(0.175, 0.215, 0.108);
  albedo = mix(deep, light, 0.20 + broad * 0.62);
  albedo *= 0.91 + thread * 0.13 + (crease - 0.5) * 0.08;
  height = 0.48 + thread * 0.17 + (crease - 0.5) * 0.05;
  rough = 0.82 + broad * 0.10 - thread * 0.04;
  ao = 0.95 + broad * 0.05;
}

void trouserSurface(vec2 p, out vec3 albedo, out float height, out float rough, out float ao){
  float broad = bodyUnit(pfbm(p * vec2(4.0, 5.0) + 7.0, vec2(4.0, 5.0), 4));
  float fine = bodyUnit(pnoise(p * vec2(54.0, 58.0), vec2(54.0, 58.0)));
  vec2 q = abs(fract(p * vec2(18.0, 20.0)) - 0.5);
  float ripstop = sstep(0.49, 0.445, max(q.x, q.y));
  float soil = sstep(0.54, 0.82,
    bodyUnit(pfbm(p * vec2(6.0, 7.0) + 43.0, vec2(6.0, 7.0), 3)));

  vec3 khaki = mix(vec3(0.128, 0.102, 0.061), vec3(0.275, 0.226, 0.132), broad);
  albedo = mix(khaki, vec3(0.080, 0.064, 0.036), soil * 0.32);
  albedo *= 0.94 + fine * 0.10 + ripstop * 0.08;
  height = 0.48 + (fine - 0.5) * 0.07 + ripstop * 0.13;
  rough = 0.78 + broad * 0.12 + soil * 0.07;
  ao = 0.94 + broad * 0.06;
}

void leatherSurface(vec2 p, out vec3 albedo, out float height, out float rough, out float ao){
  float grain = bodyUnit(pfbm(p * vec2(18.0, 9.0), vec2(18.0, 9.0), 4));
  float fold = abs(pnoise(p * vec2(4.0, 12.0) + 9.0, vec2(4.0, 12.0)));
  float scuff = sstep(0.63, 0.89,
    bodyUnit(pfbm(p * vec2(9.0, 11.0) + 25.0, vec2(9.0, 11.0), 3)));

  vec3 dark = vec3(0.030, 0.016, 0.009);
  vec3 brown = vec3(0.120, 0.061, 0.027);
  albedo = mix(dark, brown, 0.28 + grain * 0.54);
  albedo = mix(albedo, vec3(0.205, 0.130, 0.073), scuff * 0.36);
  height = 0.46 + (grain - 0.5) * 0.17 - fold * 0.07 + scuff * 0.035;
  rough = 0.54 + grain * 0.24 + scuff * 0.17;
  ao = 0.93 + grain * 0.07;
}

void hairSurface(vec2 p, out vec3 albedo, out float height, out float rough, out float ao){
  float mass = bodyUnit(pfbm(p * vec2(4.0, 3.0), vec2(4.0, 3.0), 3));
  float strand = 1.0 - abs(pnoise(p * vec2(74.0, 5.0) + 3.0, vec2(74.0, 5.0)));
  float shine = pow(strand, 6.0);
  albedo = mix(vec3(0.012, 0.006, 0.004), vec3(0.090, 0.040, 0.018),
               0.18 + mass * 0.56 + shine * 0.18);
  height = 0.46 + strand * 0.15 + (mass - 0.5) * 0.05;
  rough = 0.56 + (1.0 - mass) * 0.18 - shine * 0.08;
  ao = 0.93 + mass * 0.07;
}

void rubberSurface(vec2 p, out vec3 albedo, out float height, out float rough, out float ao){
  float grain = bodyUnit(pnoise(p * vec2(48.0, 52.0), vec2(48.0, 52.0)));
  float worn = bodyUnit(pfbm(p * vec2(5.0, 6.0) + 19.0, vec2(5.0, 6.0), 3));
  albedo = mix(vec3(0.007, 0.008, 0.007), vec3(0.032, 0.029, 0.022),
               0.20 + worn * 0.58);
  height = 0.47 + (grain - 0.5) * 0.09;
  rough = 0.88 + worn * 0.10;
  ao = 0.94 + worn * 0.06;
}

void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 grid = vec2(4.0, 2.0);
  vec2 cell = floor(uv * grid);
  vec2 p = fract(uv * grid);
  int id = int(cell.x + cell.y * 4.0 + 0.5);

  if(id == 0) skinSurface(p, albedo, height, rough, ao);
  else if(id == 1) shirtSurface(p, albedo, height, rough, ao);
  else if(id == 2) trouserSurface(p, albedo, height, rough, ao);
  else if(id == 3) leatherSurface(p, albedo, height, rough, ao);
  else if(id == 4) hairSurface(p, albedo, height, rough, ao);
  else rubberSurface(p, albedo, height, rough, ao);
}
`;
