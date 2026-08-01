# Procedural ambient sound (System 6)

Every sample is synthesized in code — no recordings, no sample libraries.
Synthesis is pure (`Float32Array` in/out, no Web Audio, no three, no DOM) and
lives in the layer files; the only file that touches the Web Audio API is
`engine.js`. That split is what lets `tools/audio.mjs` render and measure the
exact soundscape offline in Node.

## Files

| file | role |
|---|---|
| `dsp.js` | filters, noise, seeded RNG/gestures, loop crossfading |
| `insects.js` | cicada/cricket beds, katydid & chirp one-shots, swell/gate gestures |
| `birds.js` | five species voices, the bout-based scheduler |
| `water.js` | falls textures (rumble/cascade/spray), brook bubble model, distance balance |
| `wind.js` | canopy wash + rustle textures, gust envelope |
| `steps.js` | footstep and landing one-shots, parameterised by wetness |
| `score.js` | every mix level and spatial constant, shared by offline and online |
| `bank.js` | the precompute: all buffers as a job list |
| `bakeWorker.js` | runs that job list off the main thread |
| `mix.js` | offline stereo renderer (the engine's testable twin) |
| `engine.js` | the live Web Audio graph — `Ambience`, the only class to wire in |

## Wiring into the game

Wired. `main.js` constructs `Ambience` at the end of `_initScene()`, calls
`update(dt)` at the end of `step()`, `setPaused(p)` in `setPaused()` and
`dispose()` in `dispose()`. The `update()` call is last in `step()` on purpose:
the listener's position and orientation are read out of the camera's world
matrix, so running it earlier would put the ears one frame behind the eyes.

Everything else the engine does for itself:

- **Audio unlock.** The constructor listens for `pointerlockchange`/
  `pointerdown` and creates the `AudioContext` on the first gesture. Until
  then `update()` is a no-op and no audio object exists at all.
- **Footsteps and landings hook themselves up** by chaining `walker.onStep`
  and `walker.onLand` (existing callbacks are preserved if another system set
  them first, and restored on `dispose()`). Cadence is entirely the walker's,
  so it cannot drift from the head-bob.
- **The waterfall does not exist yet (System 5).** The falls sources sit at a
  default derived from the terrain constants (base `(1, 2.5, -388)`, lip
  `(1, 15, -391)`). When the real falls is built, call
  `game.ambience.setWaterfallPosition(base, lip)` once — everything
  (distance gain, rumble→cascade→spray balance, air absorption) follows the
  real position automatically.
- The engine registers itself as `window.__ambience` for the harness.
  `__ambience.stats()` reports state, bake and device-open times, bank size
  and active voices; `__ambience.setLayerTrim('falls', -3)` trims a layer in
  dB live.

### Gait

The controller, the character body and both renderers share `player/gait.js`.
A 0.76 m walking step at 1.45 m/s gives 1.91 steps/s; the restrained 3.1 m/s
jog blends toward 1.02 m steps and 3.04 steps/s. One `bobPhase` unit is a
complete two-step gait cycle; keeping that distinction explicit prevents the
old 3.7-step/s trot from returning when either system is tuned. `JUMP_SPEED`
lives there too, because the landing's weight is scaled against it.

Nothing in this directory owns a locomotion number of its own. The smoke test
asserts the footfall count over a minute of walking plus a minute of jogging
against `stepRate()`, so a duplicated literal reappearing anywhere in the
chain fails in Node rather than being noticed by ear months later.

### Landings

A jump's descent fires `walker.onLand(pos, impact, speed)` once, at contact,
with the downward speed it arrived at. This is a separate event from a
footfall and not an inference from one: the gait clock is frozen in mid-air,
so no footfall boundary occurs at the moment the feet are down.

`renderLanding()` is not a louder footstep. A walking step is one foot rolling
heel-to-toe and carries two litter-crackle clusters ~90 ms apart; a landing is
both feet arriving flat, so it is one cluster with a longer settling tail, two
slightly offset thumps an octave lower, and — when wet — a single splat rather
than the walk's several suction chirps. Playing an amplified step instead reads
as someone stamping mid-stride.

## Verification

```
node tools/audio.mjs all            # every layer + 3 mix points + smoke test
node tools/audio.mjs mix --t 0.7    # full mix anywhere along the trail
node tools/audio.mjs stats <wav>    # band analysis of an existing render
node tools/audio.mjs smoke          # engine.js against a mock audio graph
node tools/audio.mjs jobs           # bake cost, job by job
node tools/audio-live.mjs           # the real graph in the real page
```

WAVs land in `shots/audio/`. The smoke test drives the real `Ambience` class
through two simulated minutes on a mock Web Audio graph and fails on any
non-finite parameter write or on a footfall count that disagrees with
`player/gait.js`.

`audio-live.mjs` is the half a mock cannot do. Every remaining failure mode of
this system is one that does not throw: a context that never unlocks because
no gesture reached it, a bake that quietly drops a dozen frames, a graph that
builds perfectly and outputs silence. So it boots the real page, unlocks with a
genuine trusted click rather than by calling `unlock()`, samples
`requestAnimationFrame` deltas through the bake, and taps an `AnalyserNode` on
the master bus to prove there is signal on it.

## Performance

Measured by `tools/audio-live.mjs` on a 4060, headless Chromium pinned to four
cores at idle priority — so the numbers are pessimistic rather than flattering.

- **Bank**: 60 buffers, **31.3 MiB** of mono Float32 at 48 kHz. Baked once, on
  unlock, in **~1.4 s** — in a module worker, with the buffers transferred
  rather than copied.
- **The bake used to be paced one job per macrotask on the main thread**, on
  the assumption that the jobs were small. `tools/audio.mjs jobs` says twelve
  of the sixty exceed a 60 Hz frame and the cricket beds cost over 130 ms
  each, and a job is indivisible — so pacing could not help and the unlock
  dropped about a dozen frames, worst 233 ms. Off-thread it drops **one**, and
  that one is `new AudioContext()` opening the output device: **~35 ms**,
  synchronous, unavoidable, and necessarily inside the gesture handler.
- **Steady-state cost**: 13 looped `BufferSource`s + up to 16 event voices
  through equal-power panners (HRTF deliberately not used). All per-sample
  work is native; the JS control tick runs at 20 Hz and measures **~70 µs per
  tick** live, which is ~2 µs per frame amortised. (The smoke test's 5 µs is a
  mock-graph figure — it does not pay for real `AudioParam` writes.)
- Offline rendering runs 12–38× realtime single-threaded in Node, including
  the bake.

## Why it doesn't loop audibly

Stationary *texture* is baked into loops with equal-power seam crossfades and
mutually incommensurate lengths (11.13–16.41 s, no common period); every
*gesture* — cicada swells, cricket lulls, wind gusts, the falls' distance
character — is applied at runtime as a pure function of continuous Perlin
time and never repeats. Anything with an identifiable shape (bird calls,
katydid rasps, footsteps) is a one-shot chosen from seeded variants, pitch-
jittered per play, and scheduled with exponential (memoryless) waits — birds
additionally call in bouts from a fixed world position, then fall silent for
exponentially long stretches.
