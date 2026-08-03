/* Look at the pixels a capture actually produced.
 *
 * Judging a material from a 1600x900 frame is judging it at the size the
 * artefact is smallest. "The trunk reads as stone" is a claim about a few
 * hundred pixels on the right of one shot, and the only way to settle it —
 * rather than trade impressions about it — is to cut those pixels out, blow
 * them up, and read their statistics.
 *
 *   node tools/px.mjs shots/s2r10/18.png --crop 740,0,290,420 --zoom 2
 *   node tools/px.mjs shots/s2r10/18.png --crop 740,0,290,420 --stats
 *   node tools/px.mjs a.png --diff b.png
 *
 * The --diff mode is the one that keeps an evidence pair honest. Two captures
 * that were meant to differ only by one shader term will in fact differ by
 * everything the simulation did between them, and the difference between "this
 * is what bloom does" and "this is what two seconds of falling water does" is
 * not visible by eye in a pair of thumbnails — it is a range of a hundred and
 * forty code values in the delta, which this prints.
 *
 * There is no image library in this project and there is not going to be one,
 * so the PNG codec is here. It only has to handle what Chromium's toDataURL
 * emits: 8-bit truecolour with alpha, one IDAT stream, no interlacing.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

/** @returns {{w:number,h:number,d:Buffer}} RGBA8, row-major, no padding. */
export function readPng(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const tag = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; ctype = body[9];
      if (depth !== 8 || (ctype !== 6 && ctype !== 2)) {
        throw new Error(`unsupported png: depth=${depth} colour=${ctype}`);
      }
    } else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    // Paeth and friends are defined on the reconstructed bytes of this row, so
    // this has to run left to right in place.
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (ft === 1) add = a;
      else if (ft === 2) add = b;
      else if (ft === 3) add = (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4 + 0] = line[x * bpp + 0];
      out[(y * w + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * w + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { w, h, d: out };
}

const crc32 = (() => {
  const T = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    T[n] = c;
  }
  return (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

export function writePng(file, w, h, d) {
  const chunk = (tag, body) => {
    const c = Buffer.concat([Buffer.from(tag, 'ascii'), body]);
    const out = Buffer.alloc(c.length + 8);
    out.writeUInt32BE(body.length, 0);
    c.copy(out, 4);
    out.writeUInt32BE(crc32(c), c.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    d.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* What actually changed between two frames.
 *
 * Reported as a signed distribution rather than a mean absolute error, because
 * the two failure modes look nothing alike. An effect that was added to the
 * whole frame has a delta with a non-zero mean and a small spread; a pair that
 * drifted out of sync has a delta with a mean near zero and a spread of tens of
 * code values, because half the moving detail went one way and half the other.
 * The percentage past a threshold is the one number that separates them.
 */
function diff(a, b, [cx, cy, cw, ch], an, bn) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('size mismatch');
  const d = [];
  let dr = 0, dg = 0, db = 0, n = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((cy + y) * a.w + cx + x) * 4;
      dr += a.d[i] - b.d[i];
      dg += a.d[i + 1] - b.d[i + 1];
      db += a.d[i + 2] - b.d[i + 2];
      n++;
      d.push(0.2126 * (a.d[i] - b.d[i]) + 0.7152 * (a.d[i + 1] - b.d[i + 1])
           + 0.0722 * (a.d[i + 2] - b.d[i + 2]));
    }
  }
  const abs = d.map(Math.abs).sort((p, q) => p - q);
  const pc = (t) => (100 * abs.filter(v => v > t).length / n).toFixed(2);
  const s = [...d].sort((p, q) => p - q);
  console.log(`  diff vs ${bn}`);
  console.log(`    dLuma mean=${(d.reduce((p, q) => p + q, 0) / n).toFixed(2)}` +
              `  p01=${s[(0.01 * n) | 0].toFixed(1)}  p50=${s[(0.5 * n) | 0].toFixed(1)}` +
              `  p99=${s[(0.99 * n) | 0].toFixed(1)}  range=${s[0].toFixed(0)}..${s[n - 1].toFixed(0)}`);
  console.log(`    |dLuma| >1=${pc(1)}%  >4=${pc(4)}%  >8=${pc(8)}%  >16=${pc(16)}%`);
  console.log(`    dRGB=${(dr / n).toFixed(2)},${(dg / n).toFixed(2)},${(db / n).toFixed(2)}`);

  /* Standard deviation, and then standard deviation bucketed by the level of the
   * pixel it sits on. This is the pair of numbers a grain claim lives or dies
   * on, and neither of the ones above can stand in for them: a mean is zero for
   * anything zero-mean by construction, and a percentile of the absolute value
   * mixes the effect's own strength with the level dependence that is supposed
   * to be the point.
   *
   * Film grain is not a uniform dither. Its density rises off the toe, peaks
   * somewhere in the midtones where the largest number of silver crystals are on
   * the fence about developing, and falls again in the shoulder where nearly all
   * of them have. A dither that measures the same at every level is a screen
   * door in front of the picture; the shape below is what makes it read as
   * stock instead, and it is the reason the amplitude can be raised without the
   * grain becoming a thing anyone looks at. */
  const sd = (a) => {
    if (a.length < 2) return NaN;
    const m = a.reduce((p, q) => p + q, 0) / a.length;
    return Math.sqrt(a.reduce((p, q) => p + (q - m) * (q - m), 0) / a.length);
  };
  const bins = [[0, 32], [32, 64], [64, 102], [102, 128], [128, 179], [179, 230], [230, 256]];
  const buck = bins.map(() => []);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((cy + y) * b.w + cx + x) * 4;
      const L = 0.2126 * b.d[i] + 0.7152 * b.d[i + 1] + 0.0722 * b.d[i + 2];
      const k = bins.findIndex(([lo, hi]) => L >= lo && L < hi);
      if (k >= 0) buck[k].push(d[y * cw + x]);
    }
  }
  console.log(`    sigma dLuma=${sd(d).toFixed(2)}  by level: ` +
              bins.map(([lo, hi], k) => `${lo}-${hi - 1}:${sd(buck[k]).toFixed(2)}`).join(' '));
}

function main() {
  const args = process.argv.slice(2);
  const src = args[0];
  const flag = (k, dv) => { const i = args.indexOf('--' + k); return i < 0 ? dv : args[i + 1]; };
  const img = readPng(src);
  const [cx, cy, cw, ch] = (flag('crop', `0,0,${img.w},${img.h}`)).split(',').map(Number);
  const zoom = +flag('zoom', 1);

  const px = [];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((cy + y) * img.w + (cx + x)) * 4;
      px.push([img.d[i], img.d[i + 1], img.d[i + 2]]);
    }
  }

  /* Luma percentiles rather than min and max. What separates cracked rock from
   * bark is not whether a dark pixel exists somewhere, it is how much of the
   * surface sits at each end — and a handful of outliers, which every render
   * has, move the extremes without moving the look at all. */
  const lum = px.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b).sort((a, b) => a - b);
  const q = (f) => Math.round(lum[Math.floor(f * (lum.length - 1))]);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mr = mean(px.map(p => p[0])), mg = mean(px.map(p => p[1])), mb = mean(px.map(p => p[2]));
  /* Chroma as a share of value. Under a green canopy everything picks up a
   * green cast, so the number that matters for "is this wood or stone" is not
   * the hue but how far the channels are apart at all: a neutral surface is
   * stone however it is lit. */
  const mx = Math.max(mr, mg, mb), mn = Math.min(mr, mg, mb);
  console.log(`${src} crop ${cx},${cy} ${cw}x${ch}`);
  console.log(`  luma p01=${q(0.01)} p10=${q(0.10)} p50=${q(0.50)} p90=${q(0.90)} p99=${q(0.99)}`);
  console.log(`  spread p90-p10=${q(0.90) - q(0.10)}  p99-p01=${q(0.99) - q(0.01)}`);
  /* r-b is the warm/cool axis and the one the palette is judged on; g-r is the
   * foliage axis. They are not the same question and a grade can move one
   * without the other: a warm print that has quietly collapsed g-r is exactly
   * how a jungle turns khaki, which is a thing that happened here. */
  console.log(`  mean rgb=${mr.toFixed(1)},${mg.toFixed(1)},${mb.toFixed(1)}` +
              `  sat=${((mx - mn) / Math.max(1, mx) * 100).toFixed(1)}%` +
              `  warm(r-b)=${(mr - mb).toFixed(1)}  leaf(g-r)=${(mg - mr).toFixed(1)}`);

  /* The highlight tail, which the percentiles above deliberately hide and which
   * is the one place an outlier is the whole question. Clipping is not a
   * proportion of a surface, it is a binary property of a pixel: one blown pixel
   * on a waterfall is a hole in the picture where the water stopped having a
   * shape. So this reports the largest channel value present and the share at or
   * above two thresholds — 250 for genuine clipping, and 245 for the band where
   * the ACES shoulder has flattened enough that the detail has gone whether or
   * not the encoder has run out of numbers to describe it with. */
  let top = 0, n250 = 0, n245 = 0;
  for (const [r, g, b] of px) {
    const m = Math.max(r, g, b);
    if (m > top) top = m;
    if (m >= 250) n250++;
    if (m >= 245) n245++;
  }
  console.log(`  highlight max=${top}  >=250 ${(n250 / px.length * 100).toFixed(3)}%` +
              `  >=245 ${(n245 / px.length * 100).toFixed(3)}%`);

  /* Laplacian energy, which is the one number that settles an argument about
   * defocus. "Is this blurred" is not answerable from a mean or a percentile — a
   * blur preserves both almost exactly — and it is not reliably answerable by
   * eye at the size a leaf occupies in a 1600-pixel frame. The mean absolute
   * second difference is: it is proportional to the amount of detail at the
   * pixel scale and to nothing else, so a pass that claims to soften the near
   * field either lowers it or does not. */
  let lap = 0, lapN = 0;
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const L = (dx, dy) => {
        const i = ((cy + y + dy) * img.w + cx + x + dx) * 4;
        return 0.2126 * img.d[i] + 0.7152 * img.d[i + 1] + 0.0722 * img.d[i + 2];
      };
      lap += Math.abs(4 * L(0, 0) - L(-1, 0) - L(1, 0) - L(0, -1) - L(0, 1));
      lapN++;
    }
  }
  if (lapN) console.log(`  sharpness=${(lap / lapN).toFixed(2)}`);

  const other = flag('diff', null);
  if (other) { diff(img, readPng(other), [cx, cy, cw, ch], src, other); return; }

  if (!args.includes('--stats')) {
    const zw = cw * zoom, zh = ch * zoom;
    const out = Buffer.alloc(zw * zh * 4);
    for (let y = 0; y < zh; y++) {
      for (let x = 0; x < zw; x++) {
        const s = ((cy + (y / zoom | 0)) * img.w + cx + (x / zoom | 0)) * 4;
        img.d.copy(out, (y * zw + x) * 4, s, s + 4);
      }
    }
    const dst = flag('out', src.replace(/\.png$/, '.crop.png'));
    writePng(dst, zw, zh, out);
    console.log('  → ' + dst);
  }
}

if (process.argv[1] && process.argv[1].endsWith('px.mjs')) main();
