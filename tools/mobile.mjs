/* Verify the phone path, and verify that the desktop one did not move.
 *
 *   node tools/mobile.mjs [--w 393] [--h 852] [--dpr 3]
 *
 * Two runs. The first is a desktop viewport with a mouse, and its only job is
 * to prove a negative: `document.body.innerHTML` byte for byte what it was, no
 * request for anything under src/mobile except the detector. The second is a
 * phone — user agent, touch flags and a device pixel ratio of 3 — and it walks
 * the whole arrival: the gate stands in front of an unbuilt scene, the button
 * builds it, the touch controls appear, and a real touch drag turns the head
 * while a real touch hold moves the feet.
 *
 * What this cannot tell you is whether a phone can actually draw the frame.
 * The GPU underneath is still the desktop's, and emulation moves flags rather
 * than silicon. Every timing this prints is a 4060's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : +args[i + 1]; };

const W = flag('w', 393), H = flag('h', 852), DPR = flag('dpr', 3);
const outDir = path.join(ROOT, 'shots', 'mobile');
fs.mkdirSync(outDir, { recursive: true });

const IPHONE = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  deviceScaleFactor: DPR,
  isMobile: true,
  hasTouch: true,
};

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const ok = (pass, label) => console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}`);
let failures = 0;
const expect = (pass, label) => { if (!pass) failures++; ok(pass, label); };

/* Touch through the DevTools protocol rather than through synthesised
 * PointerEvents. The controls read `pointerType`, pointer ids and capture, and
 * a hand-built event agrees with all of that by construction — which makes it
 * a test of the test. These are dispatched where a browser dispatches them and
 * arrive as the pointer events the browser derives from them. */
async function touchSeq(cdp, points) {
  for (const [type, touches] of points) {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: touches.map(([x, y], i) => ({ x, y, id: i + 1 })),
    });
  }
}

console.log('\n─── desktop, mouse ───');
let desktopHtml = '';
await run({ width: 1600, height: 900, hash: '' }, async ({ page, errs }) => {
  /* Reloaded so the request log covers the boot. The harness navigates before
   * handing the page over, so a listener attached here would otherwise see
   * every module request except the ones this is about. */
  const requested = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/src/mobile/')) requested.push(u.slice(u.indexOf('/src/')));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);

  desktopHtml = await page.evaluate(() => document.body.innerHTML);
  fs.writeFileSync(path.join(outDir, 'dom-desktop.txt'), desktopHtml);
  console.log(`  body.innerHTML  ${desktopHtml.length} bytes  sha256:${sha(desktopHtml)}`);
  console.log(`  ${JSON.stringify(desktopHtml)}`);

  expect(!/gate|touch/.test(desktopHtml), 'no gate or touch controls in the desktop document');
  expect(requested.length === 1 && requested[0].endsWith('detect.js'),
    `only the detector is fetched on desktop (${requested.join(', ') || 'nothing'})`);
  expect(await page.evaluate(() => window.__game.walker.pointerLock === true),
    'pointer lock still armed on desktop');
  expect(errs.length === 0, `no page errors (${errs.length})`);
});

console.log(`\n─── phone, ${W}x${H} @ dpr ${DPR} ───`);
await run({
  width: W, height: H, hash: '', device: IPHONE, autoBegin: false,
}, async ({ page, errs }) => {
  const cdp = await page.context().newCDPSession(page);

  await page.waitForSelector('#gate .gate__enter', { timeout: 30_000 });
  expect(await page.evaluate(() => window.__game === undefined),
    'the gate stands in front of an unbuilt scene');
  expect(await page.evaluate(() => !!document.querySelector('.gate__still')?.src
    .startsWith('data:image/jpeg')),
  'the still is a data URI, not a fetch');
  expect(await page.evaluate(() => !document.getElementById('boot')),
    'the boot line is gone');
  await page.screenshot({ path: path.join(outDir, 'gate.png') });

  /* Watched rather than polled. The building state and the world build are
   * separated by two animation frames, so a check that goes back over the
   * protocol to look for it is racing a synchronous block that removes it. */
  await page.evaluate(() => {
    window.__sawBuilding = false;
    new MutationObserver(() => {
      if (document.querySelector('.gate__building')) window.__sawBuilding = true;
    }).observe(document.body, { childList: true, subtree: true });
  });

  const t0 = Date.now();
  await page.click('.gate__enter');
  await page.waitForFunction(() => !!window.__game, null, { timeout: 120_000 });
  expect(await page.evaluate(() => window.__sawBuilding === true),
    'the button paints a building state before the world blocks the thread');
  console.log(`  world built in ${((Date.now() - t0) / 1000).toFixed(1)} s (on a 4060)`);
  await page.waitForTimeout(2500);

  const st = await page.evaluate(() => {
    const g = window.__game;
    return {
      devicePixelRatio,
      rendererPixelRatio: g.renderer.getPixelRatio(),
      drawingBuffer: [g.renderer.domElement.width, g.renderer.domElement.height],
      cssViewport: [innerWidth, innerHeight],
      tier: g.tier,
      fps: +g.fps.toFixed(1),
      frameMs: +g.frameMs.toFixed(2),
      calls: g.info().calls,
      gateGone: !document.getElementById('gate'),
      touchControls: !!document.getElementById('touch-controls'),
      pointerLock: g.walker.pointerLock,
    };
  });
  console.log('  ' + JSON.stringify(st));

  expect(st.rendererPixelRatio === 1 && st.drawingBuffer[0] === st.cssViewport[0],
    `device pixel ratio ${st.devicePixelRatio} clamped to ${st.rendererPixelRatio} `
    + `(${st.drawingBuffer.join('x')} drawing buffer, not ${st.cssViewport[0] * DPR}x`
    + `${st.cssViewport[1] * DPR})`);
  expect(st.tier === 'high', `no reduced tier on the phone path (tier=${st.tier})`);
  expect(st.gateGone, 'the gate removed itself');
  expect(st.touchControls, 'the touch controls are in the document');
  expect(st.pointerLock === false, 'pointer lock disarmed on touch');

  // Look: a drag across the middle of the screen, away from the pad.
  const yaw0 = await page.evaluate(() => window.__game.walker.yaw);
  const mid = H * 0.4;
  await touchSeq(cdp, [
    ['touchStart', [[W * 0.75, mid]]],
    ['touchMove', [[W * 0.55, mid]]],
    ['touchMove', [[W * 0.35, mid]]],
    ['touchMove', [[W * 0.2, mid]]],
    ['touchEnd', []],
  ]);
  const yaw1 = await page.evaluate(() => window.__game.walker.yaw);
  expect(Math.abs(yaw1 - yaw0) > 0.3,
    `drag turned the head ${(((yaw1 - yaw0) * 180) / Math.PI).toFixed(1)} degrees`);

  /* Back onto the trail before the walk test. The drag above turned the head
   * most of a right angle off the path, and a walk from there is a walk into
   * a bank the slope limit will refuse — which would be the controls working
   * and the assertion failing. */
  await page.evaluate(() => window.__game.goTo(0.10));
  await page.waitForTimeout(400);

  // Walk: hold the pad and let the loop run.
  const pad = await page.locator('.touch__walk').boundingBox();
  const px = pad.x + pad.width / 2, py = pad.y + pad.height / 2;
  const from = await page.evaluate(() => [...window.__game.walker.pos.toArray()]);
  await touchSeq(cdp, [['touchStart', [[px, py]]]]);
  await page.waitForTimeout(1400);
  const held = await page.evaluate(() => ({
    key: window.__game.walker.keys.KeyW === true,
    lit: document.querySelector('.touch__walk').classList.contains('is-down'),
    speed: +window.__game.walker.speed.toFixed(2),
  }));
  await touchSeq(cdp, [['touchEnd', []]]);
  await page.waitForTimeout(600);
  const to = await page.evaluate(() => [...window.__game.walker.pos.toArray()]);
  const moved = Math.hypot(to[0] - from[0], to[2] - from[2]);
  const after = await page.evaluate(() => window.__game.walker.keys.KeyW === true);

  expect(held.key && held.lit, 'holding the pad presses forward and lights it');
  expect(moved > 1.0, `the walk covered ${moved.toFixed(2)} m at ${held.speed} m/s`);
  expect(!after, 'lifting the thumb stops the walk');

  await page.screenshot({ path: path.join(outDir, 'in-scene.png') });

  const audio = await page.evaluate(() => globalThis.__ambience?.stats());
  console.log('  audio: ' + JSON.stringify(audio));
  expect(!!audio?.ready, 'the ambience unlocked on the first touch');
  expect(audio?.bakedOffThread === true, 'the bank baked in a worker, off the main thread');

  expect(errs.length === 0, `no page errors (${errs.length})`);
});

console.log(`\n  desktop body sha256:${sha(desktopHtml)}`);
console.log(`  → ${path.relative(ROOT, outDir)}`);
console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all checks passed\n');
if (failures) process.exitCode = 1;

finish(process.exitCode || 0);
