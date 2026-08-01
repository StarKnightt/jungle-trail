/* Parse every source file before spending three minutes on a browser.
 *
 * Almost all of this project's JavaScript is GLSL held in template literals,
 * and the failure mode that costs the most time is a stray backtick inside a
 * shader comment: it closes the literal early, the file becomes a syntax
 * error, and the symptom is a headless run that waits out its full timeout for
 * a global that was never going to be defined. `node --check` finds it in
 * milliseconds, so the capture tools run this first.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

/** @returns {string[]} human-readable failures, empty when everything parses. */
export function check() {
  const bad = [];
  for (const f of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tools'))]) {
    try {
      // --input-type=module so a bare `import` at top level is not a syntax
      // error just because the extension is .js.
      execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      const msg = (e.stderr || '').toString().split('\n').filter(Boolean).slice(0, 4).join('\n    ');
      bad.push(`${path.relative(ROOT, f)}\n    ${msg}`);
    }
  }
  return bad;
}

/* Compared through pathToFileURL rather than by pasting a prefix on the path.
 * A Windows absolute path becomes file:///c:/... with three slashes, so the
 * hand-built two-slash version never matched and running this file directly
 * printed nothing and exited zero — a checker that always passes is worse than
 * no checker, and it stayed unnoticed because the harness calls check()
 * itself. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bad = check();
  if (bad.length) { console.error('✗ parse errors:\n' + bad.join('\n')); process.exit(1); }
  console.log('✓ all sources parse');
}
