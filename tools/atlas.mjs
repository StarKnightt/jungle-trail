/* Dump a baked texture to a PNG.
 *
 * Every map in this project is generated on the GPU at boot and never touches
 * the disk, which is the point — but it also means there is no file to open
 * when a material looks wrong, and the only view of it is whatever the scene
 * happens to show. That is a bad way to judge a texture: detail that is
 * obvious in the map can be invisible on a leaf twelve metres away, and the
 * two failures — "the detail is not there" and "the detail is there and too
 * small to matter" — call for opposite fixes.
 *
 *   node tools/atlas.mjs leafMap [--size 1024] [--alpha] [--rgb]
 *   node tools/atlas.mjs terrain.litter.map
 *
 * `--rgb` ignores the alpha channel entirely and shows what colour is actually
 * stored in the transparent region. That is not idle curiosity: bilinear taps
 * and every mip level mix those texels into the visible ones, so a cutout whose
 * "invisible" side is black wears a dark rim at every distance — and the
 * default composite hides exactly that, because it multiplies the same alpha
 * back in before you look at it.
 *
 * The pixels are read back out of a render target rather than screenshotted.
 * The first version drew the texture to the default framebuffer and let
 * Playwright grab the canvas, which raced the render loop and reliably
 * returned a picture of the game instead — the one thing this tool exists to
 * avoid looking at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const which = args[0] && !args[0].startsWith('--') ? args[0] : 'leafMap';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SIZE = +flag('size', 1024);
const SHOW_ALPHA = args.includes('--alpha');
const SHOW_RGB = args.includes('--rgb');

await run({ width: 640, height: 400, hash: 'manual&tier=high' }, async ({ page }) => {
  const res = await page.evaluate(([which, showAlpha, size, showRgb]) => {
    const g = window.__game, THREE = window.THREE;
    const dig = (root) => which.split('.').reduce((o, k) => o && o[k], root);
    const src = dig(g.veg) || dig(g.terrainMat?.userData?.maps) || dig(g);
    if (!src || !src.isTexture) return { err: 'no such texture: ' + which };

    const rt = new THREE.WebGLRenderTarget(size, size, {
      colorSpace: THREE.SRGBColorSpace,
      type: THREE.UnsignedByteType,
    });
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: {
        t: { value: src },
        a: { value: showAlpha ? 1 : 0 },
        raw: { value: showRgb ? 1 : 0 },
      },
      vertexShader: 'varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D t; uniform float a; uniform float raw; varying vec2 v;
        void main(){
          vec4 c = texture2D(t, v);
          // Checkerboard behind the cutout, so an alpha edge is legible
          // against it rather than dissolving into a black background.
          float ch = mod(floor(v.x * 32.0) + floor(v.y * 32.0), 2.0) * 0.22 + 0.10;
          vec3 rgb = a > 0.5 ? vec3(c.a)
                   : raw > 0.5 ? c.rgb
                   : mix(vec3(ch), c.rgb, c.a);
          gl_FragColor = vec4(rgb, 1.0);
        }`,
      depthTest: false,
    })));

    const prev = g.renderer.getRenderTarget();
    g.renderer.setRenderTarget(rt);
    g.renderer.render(scene, cam);
    const buf = new Uint8Array(size * size * 4);
    g.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    g.renderer.setRenderTarget(prev);
    rt.dispose();

    // Render targets are bottom-up; flip into image order on the way out.
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      const s = (size - 1 - y) * size * 4, d = y * size * 4;
      img.data.set(buf.subarray(s, s + size * 4), d);
    }
    ctx.putImageData(img, 0, 0);
    return { url: cv.toDataURL('image/png') };
  }, [which, SHOW_ALPHA, SIZE, SHOW_RGB]);

  if (res.err) { console.error(res.err); process.exitCode = 1; return; }
  const out = path.join(ROOT, 'shots',
    `atlas-${which}${SHOW_ALPHA ? '-a' : SHOW_RGB ? '-rgb' : ''}.png`);
  fs.writeFileSync(out, Buffer.from(res.url.split(',')[1], 'base64'));
  console.log('  → ' + path.relative(ROOT, out));
});

finish(process.exitCode || 0);
