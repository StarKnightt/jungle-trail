/* Shared harness plumbing: keep headless test runs from starving the machine,
   and make sure they always let go of it afterwards.

   SwiftShader is a CPU rasteriser and will saturate all twelve threads; the
   user is usually gaming or working on this box while tests run. Importing
   this module pins node and every chrome-headless-shell child to the top four
   cores at low priority, re-applied on a timer because Chromium spawns its
   workers late.

   It also installs the teardown that every script was missing. Each of them
   starts an HTTP server and a browser and closes both on the last line, so any
   throw in between — and a headless run has no shortage of ways to throw —
   skipped the cleanup and left node holding a listening socket, which keeps
   the event loop alive forever. That is the process that has to be killed by
   hand, with a SwiftShader browser still rendering behind it. */
import { exec } from 'node:child_process';
import http from 'node:http';

const ps = c => exec('powershell -NoProfile -Command "' + c + '"', () => {});
const AFFINITY = '0xF00';          // top four logical cores of twelve

// node does the JSON marshalling and, in some harnesses, the stepping
ps(`$p=Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; ` +
   `if($p){ $p.PriorityClass='BelowNormal'; $p.ProcessorAffinity=${AFFINITY} }`);

const tameChildren = () => ps(
  "Get-Process chrome-headless-shell -ErrorAction SilentlyContinue | ForEach-Object " +
  `{ try { $_.PriorityClass = 'Idle'; $_.ProcessorAffinity = ${AFFINITY} } catch {} }`);
setTimeout(tameChildren, 1500).unref();
setInterval(tameChildren, 4000).unref();

/* ---- guaranteed teardown ----------------------------------------------
   Deliberately requires nothing of the scripts themselves: importing this
   module is the whole contract, so a new harness cannot forget to opt in.

   A listening socket is a ref'd handle, which is why a script that throws
   before its close() calls leaves node resident forever rather than exiting
   with the error. Unref'ing every server the harness opens removes that
   whole failure mode: the page load is held open by Playwright's own socket
   while the run is live, and the moment the browser closes there is nothing
   left to keep the process up. */
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(...a){
  const r = listen.apply(this, a);
  // on 'listening', not immediately: a socket that is still binding is the
  // only thing holding the loop up at that point, and unref'ing it there can
  // let node exit before the server is ready
  this.once('listening', () => this.unref());
  return r;
};

const closeables = [];
/** Optionally register a browser or server to be closed however the script
    ends. Register the browser first so Chromium is gone before we stop
    serving it. */
export function guard(...things){
  for(const t of things) if(t) closeables.push(t);
  return things[0];
}

let closing = false;
async function teardown(code, why){
  if(closing) return;
  closing = true;
  if(why) console.error('\n[teardown] ' + why);
  for(const t of closeables){
    try{ await t.close(); }catch(_){}
  }
  // An HTTP server with a keep-alive socket still open will not release the
  // loop just because close() was called, so leaving is not optional.
  process.exit(code);
}
/** Normal end of a script. */
export const finish = (code = 0) => teardown(code);

process.on('SIGINT',  () => teardown(130, 'interrupted'));
process.on('SIGTERM', () => teardown(143, 'terminated'));
process.on('uncaughtException',  e => teardown(1, (e && e.stack) || e));
process.on('unhandledRejection', e => teardown(1, (e && e.stack) || e));
