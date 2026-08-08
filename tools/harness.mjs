/* Headless capture plumbing.
 *
 * Two rendering backends, and which one is used matters a great deal on this
 * machine:
 *
 *   gpu   (default) — headless Chromium on the real GPU through ANGLE/D3D11.
 *                     A frame costs the 4060 a millisecond or two and almost
 *                     no CPU. This is the polite option and the fast one.
 *   cpu   (--cpu)   — SwiftShader. Correct everywhere, but it is a software
 *                     rasteriser: it will take every thread it can reach and
 *                     hold it at 100%, which is unusable on a machine someone
 *                     is playing a game on. Only for when the GPU path can't
 *                     initialise.
 *
 * Either way node and every Chromium child is pinned to a subset of cores at
 * low priority, and teardown is installed before anything is started — see
 * tools/tame.mjs. A headless browser left behind is the worst outcome here, so
 * the cleanup path is not optional politeness either.
 */
import { chromium } from 'playwright';
import './tame.mjs';
import { exec } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AFFINITY = 0xF00;   // top four of twelve logical cores

const PIN = 'powershell -NoProfile -Command "' +
  "Get-Process chrome-headless-shell,chrome,headless_shell -ErrorAction SilentlyContinue | " +
  `ForEach-Object { try { $_.PriorityClass = 'Idle'; $_.ProcessorAffinity = ${AFFINITY} } catch {} }"`;

function pinChildren() {
  const go = () => exec(PIN, () => {});
  go();
  const t = setInterval(go, 2500);
  t.unref();
  return () => clearInterval(t);
}

const COMMON = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
  '--disable-features=CalculateNativeWinOcclusion,site-per-process',
  '--disable-background-timer-throttling',
  '--renderer-process-limit=1',
];

const GPU_ARGS = [
  ...COMMON,
  // Headless Chromium defaults to SwiftShader even when a GPU is present; each
  // of these is needed to get it onto the real adapter.
  '--use-angle=d3d11',
  '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist',
  '--enable-zero-copy',
];

const CPU_ARGS = [
  ...COMMON,
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-lcd-text',
  '--js-flags=--single-threaded-gc',
];

export function serve(root = ROOT) {
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png',
  };
  return http.createServer((rq, rs) => {
    const rel = decodeURI(rq.url.split('?')[0].split('#')[0]);
    const f = path.join(root, rel === '/' ? 'index.html' : rel);
    if (!f.startsWith(root)) { rs.writeHead(403); return rs.end(); }
    fs.readFile(f, (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('not found'); }
      rs.writeHead(200, {
        'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      rs.end(d);
    });
  });
}

/**
 * Capture one frame deterministically.
 *
 * `page.screenshot()` waits for the compositor to produce a frame, racing the
 * game's own loop for the GL context. Pausing the loop and reading the canvas
 * back in a single evaluate is both faster and reproducible — and it has to be
 * one evaluate, because the drawing buffer is not preserved and is gone by the
 * next task.
 */
export async function capture(page, file) {
  const url = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    g.renderOnce();
    const data = g.renderer.domElement.toDataURL('image/png');
    g.setPaused(false);
    return data;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

/**
 * Boot server + browser + page, run `body`, and guarantee teardown.
 *
 * `device` is handed straight to Playwright's newPage. It exists for the one
 * question a desktop viewport cannot answer — what a phone gets — and it is
 * emulation, not a phone: it moves the user agent, the touch flags and the
 * device pixel ratio, and it changes nothing at all about the GPU underneath.
 *
 * @param {{width?:number,height?:number,hash?:string,cpu?:boolean,timeout?:number,
 *          url?:string,device?:object,autoBegin?:boolean}} opts
 * @param {(ctx:{page:any,url:string,errs:string[],gl:object}) => Promise<void>} body
 */
export async function run(opts, body) {
  const {
    width = 1600, height = 900, hash = 'manual',
    cpu = process.argv.includes('--cpu'),
    timeout = 180_000,
    url: externalUrl = process.env.JUNGLE_URL || null,
    device = null,
    autoBegin = true,
  } = opts || {};

  const bad = check();
  if (bad.length) {
    console.error('✗ parse errors — not launching a browser:\n' + bad.join('\n'));
    process.exitCode = 1;
    return { errs: bad, gl: null };
  }

  let srv = null;
  let url = externalUrl;
  if (!url) {
    srv = serve();
    await new Promise(r => srv.listen(0, r));
    url = `http://localhost:${srv.address().port}/#${hash}`;
  }

  const unpin = pinChildren();
  const browser = await chromium.launch({
    headless: true,
    args: cpu ? CPU_ARGS : GPU_ARGS,
  });

  const errs = [];
  let code = 0, gl = null;
  try {
    const page = await browser.newPage({
      viewport: { width, height }, deviceScaleFactor: 1, ...(device || {}),
    });
    page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    page.on('requestfailed', r => errs.push('[netfail] ' + r.url().slice(0, 120)));
    page.on('crash', () => errs.push('[crash] renderer process died'));

    console.log(`→ ${url}  ${width}x${height}  backend=${cpu ? 'swiftshader' : 'gpu'}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    /* A module that throws on load never defines __game, so waiting for it
     * burns the full timeout to report a syntax error the page already knew
     * about. Race the wait against the first page error instead. */
    /* Poll `errs` rather than listening for the next 'pageerror': a module
     * that fails to parse throws during goto(), so by the time a fresh
     * listener is attached the only event has already been and gone. */
    /* Skippable, because there is now a path on which no game is built until
     * something taps: the mobile gate holds the boot behind a button, so a
     * tool that wants to look at that screen has to be allowed past here
     * without a `__game` that is deliberately not there yet. */
    if (autoBegin) {
      await Promise.race([
        page.waitForFunction(() => !!window.__game, null, { timeout }),
        (async () => {
          for (let i = 0; i < timeout / 250; i++) {
            await new Promise(r => setTimeout(r, 250));
            const fatal = errs.find(e => e.startsWith('[pageerror]') || e.startsWith('[crash]'));
            if (fatal) throw new Error('page threw during boot: ' + fatal.slice(0, 300));
          }
        })(),
      ]);
    }

    gl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g2 = c.getContext('webgl2');
      const dbg = g2.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: dbg ? g2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        vendor: dbg ? g2.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
      };
    });
    const soft = /swiftshader|software|llvmpipe/i.test(gl.renderer);
    console.log(`   adapter: ${gl.renderer}${soft ? '  (SOFTWARE — CPU bound)' : ''}`);

    if (autoBegin) await page.evaluate(() => window.__game.begin());
    await body({ page, url, errs, gl });
  } catch (err) {
    console.error('\n✗ probe failed:', (err && err.message) || err);
    code = 1;
  } finally {
    await browser.close().catch(() => {});
    if (srv) srv.close();
    unpin();
  }

  if (errs.length) {
    console.log('\n─── page errors ───');
    [...new Set(errs)].slice(0, 15).forEach(e => console.log(' ', e));
  }
  process.exitCode = code;
  return { errs: [...new Set(errs)], gl };
}
