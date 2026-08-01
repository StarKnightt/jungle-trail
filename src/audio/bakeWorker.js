/* The bank bake, off the main thread.
 *
 * The bake was originally paced one job per macrotask on the main thread, on
 * the assumption that the jobs were small enough for that to be invisible.
 * They are not: `node tools/audio.mjs jobs` shows twelve of the sixty over a
 * 60 Hz frame and the two cricket beds at well over a hundred milliseconds
 * each. A job is indivisible, so yielding between jobs cannot help — whatever
 * frame a cricket bed lands in is dropped, and the whole bake lands in the
 * first two seconds after the player clicks to start, which is the worst
 * possible moment to drop a dozen frames.
 *
 * Moving it here costs nothing in structure because the synthesis was already
 * pure: bank.js and everything under it touch no DOM, no Web Audio and no
 * three, which is the same property that lets tools/audio.mjs render the
 * soundscape in Node. Buffers are transferred rather than copied, so the main
 * thread's only remaining work is one createBuffer/copyToChannel per job.
 *
 * The engine keeps the old paced loop as a fallback for environments without
 * module workers, and that fallback is what Node's smoke test exercises.
 */
import { bankJobs } from './bank.js';

onmessage = ({ data: { sr, seed } }) => {
  try {
    for (const job of bankJobs(sr, seed)) {
      const { key, buf } = job();
      // Transferred, not structured-cloned: 31 MiB of Float32 copied twice
      // would put a good part of the cost back on the main thread.
      postMessage({ key, buf }, [buf.buffer]);
    }
    postMessage({ done: true });
  } catch (err) {
    postMessage({ error: (err && err.message) || String(err) });
  }
};
