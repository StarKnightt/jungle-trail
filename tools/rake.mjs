/* How steeply does the light in this frame run?
 *
 * "The shafts do not lean with the sun" is a claim about the orientation of a
 * gradient, and orientation is the one property of an image that two people
 * looking at it will confidently disagree about — particularly when the
 * structure is a fan, where every angle is present somewhere and which one you
 * see depends on where you happen to look. This measures it instead.
 *
 * The estimator is the structure tensor. For each pixel the image gradient is
 * perpendicular to whatever edge or ridge runs through it, so accumulating the
 * outer product of the gradient over a region and taking the eigenvector of
 * the *smaller* eigenvalue gives the direction the structure runs along. It is
 * accumulated as a doubled angle, because a ridge at ten degrees and one at a
 * hundred and seventy are the same ridge and averaging them naively gives
 * ninety.
 *
 * Weighted by brightness, and that matters here: an in-scatter buffer is
 * mostly empty, and the orientation of the noise floor is not the thing being
 * asked about. Only pixels above a share of the frame's peak vote.
 *
 *   node tools/rake.mjs shots/s3r2sun/low/34.png
 *   node tools/rake.mjs shots/s3r2sun/low/34.png --crop 200,0,1200,700 --min 0.25
 *
 * Reports the dominant angle in degrees from horizontal, where 0 is a beam
 * lying flat across the frame and 90 is one falling straight down, together
 * with a coherence in nought to one saying how much the structure agrees with
 * itself. A fan has low coherence by construction, which is itself the answer
 * to why a fan does not read as raking.
 */
import { readPng } from './px.mjs';

function main() {
  const args = process.argv.slice(2);
  const src = args[0];
  const flag = (k, dv) => { const i = args.indexOf('--' + k); return i < 0 ? dv : args[i + 1]; };
  const img = readPng(src);
  const [cx, cy, cw, ch] = (flag('crop', `0,0,${img.w},${img.h}`)).split(',').map(Number);
  const minRel = +flag('min', 0.20);

  const L = new Float64Array(cw * ch);
  let peak = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((cy + y) * img.w + (cx + x)) * 4;
      const v = 0.2126 * img.d[i] + 0.7152 * img.d[i + 1] + 0.0722 * img.d[i + 2];
      L[y * cw + x] = v;
      if (v > peak) peak = v;
    }
  }
  const cut = peak * minRel;

  /* The brightness that decides which pixels vote is the original; the
   * gradients they vote with come from a high-passed copy.
   *
   * Without the high pass this measures the wrong thing, convincingly. Any
   * frame with a horizon in it — the terrain silhouette, the boundary between
   * the lit band and the dark floor — contains one enormous horizontal edge,
   * and one edge a thousand pixels long outweighs every beam in the picture.
   * The first version of this tool reported a field of unmistakably vertical
   * striations as running four degrees off horizontal for exactly that reason.
   * Subtracting a blurred copy leaves the texture and removes the ramp. */
  const hp = +flag('hp', 16);
  const S = new Float64Array(cw * ch);
  if (hp > 0) {
    const tmp = new Float64Array(cw * ch);
    const box = (src, dst, w, h, horiz) => {
      const n = horiz ? w : h;
      for (let a = 0; a < (horiz ? h : w); a++) {
        let acc = 0;
        const get = (b) => src[horiz ? a * w + b : b * w + a];
        for (let b = -hp; b <= hp; b++) acc += get(Math.min(n - 1, Math.max(0, b)));
        for (let b = 0; b < n; b++) {
          if (horiz) dst[a * w + b] = acc / (2 * hp + 1);
          else dst[b * w + a] = acc / (2 * hp + 1);
          acc += get(Math.min(n - 1, b + hp + 1)) - get(Math.max(0, b - hp));
        }
      }
    };
    box(L, tmp, cw, ch, true);
    box(tmp, S, cw, ch, false);
    for (let i = 0; i < S.length; i++) S[i] = L[i] - S[i];
  } else {
    S.set(L);
  }

  /* Sobel rather than a one-pixel difference. The buffer this is usually
   * pointed at has been upsampled from half resolution, so its finest real
   * structure is two pixels across and a tighter kernel would mostly measure
   * the orientation of the upsampling filter. */
  let sxx = 0, syy = 0, sxy = 0, wsum = 0, n = 0;
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const at = (dx, dy) => S[(y + dy) * cw + (x + dx)];
      if (L[y * cw + x] < cut) continue;
      const gx = (at(1, -1) + 2 * at(1, 0) + at(1, 1)) - (at(-1, -1) + 2 * at(-1, 0) + at(-1, 1));
      // Screen y runs down the buffer; negated so the reported angle is the
      // one a person looking at the picture would describe.
      const gy = -((at(-1, 1) + 2 * at(0, 1) + at(1, 1)) - (at(-1, -1) + 2 * at(0, -1) + at(1, -1)));
      const w = L[y * cw + x] / peak;
      sxx += w * gx * gx; syy += w * gy * gy; sxy += w * gx * gy;
      wsum += w; n++;
    }
  }
  if (!n) { console.log(`${src}: nothing above ${(minRel * 100) | 0}% of peak`); return; }
  sxx /= wsum; syy /= wsum; sxy /= wsum;

  // Dominant gradient direction, then rotate a quarter turn onto the ridge.
  const gradAngle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ridge = (gradAngle * 180 / Math.PI) + 90;
  while (ridge > 90) ridge -= 180;
  while (ridge < -90) ridge += 180;
  const coh = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy) / Math.max(1e-9, sxx + syy);

  console.log(`${src} crop ${cx},${cy} ${cw}x${ch}`);
  console.log(`  ridge angle ${ridge >= 0 ? ' ' : ''}${ridge.toFixed(1)}deg from horizontal` +
              `   |angle| ${Math.abs(ridge).toFixed(1)}   coherence ${coh.toFixed(3)}` +
              `   pixels ${n} (${(100 * n / (cw * ch)).toFixed(1)}%)`);
}

main();
