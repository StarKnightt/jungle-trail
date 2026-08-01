/* Ad-hoc inspector.
 *
 *   node tools/diag.mjs [--w 640] [--h 360] "<expression evaluated in the page>"
 *
 * Exists so that "why is this black" is answered by asking the running scene
 * instead of by reading the code again and guessing. Keep it: the alternative
 * is a rebuild-and-screenshot cycle for every question.
 *
 * The default frame is deliberately small — most questions are about values,
 * not pixels, and a quarter-size canvas boots faster. The size is a flag
 * because timing questions are the exception: at 640x360 a fragment-bound
 * cost is measured over an eighth of the pixels it will really cover, which
 * flatters an expensive shader into looking free.
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : +args[i + 1]; };
const textFlag = (k, d = '') => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const expr = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))).join(' ')
  || 'Object.keys(window.__game)';

await run({
  width: flag('w', 640),
  height: flag('h', 360),
  hash: 'manual&tier=high',
  url: textFlag('url') || null,
}, async ({ page }) => {
  const out = await page.evaluate((src) => {
    const g = window.__game;
    g.warp(1.0);
    g.renderOnce();
    try {
      // eslint-disable-next-line no-new-func
      const v = new Function('g', 'THREE', `return (${src});`)(g, window.THREE);
      return JSON.stringify(v, (k, val) => (typeof val === 'number' ? +val.toFixed(4) : val), 2);
    } catch (e) { return 'ERROR: ' + (e.stack || e.message); }
  }, expr);
  console.log(out);
});

finish(process.exitCode || 0);
