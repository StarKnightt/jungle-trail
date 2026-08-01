/* The live ambience engine: the only file in src/audio that touches the
 * Web Audio API — and, deliberately, the only one that touches nothing else.
 * All synthesis lives in the pure layer files; this file's whole job is to
 * put those buffers on loops and sources, and to move gains and positions
 * the same way mix.js does offline.
 *
 * It does not import three. The camera's matrixWorld elements are read
 * directly (column-major: position in 12..14, basis vectors in the first
 * three columns), and trail queries go through duck-typed targets. That
 * keeps the engine loadable in plain Node, where tools/audio.mjs smoke-tests
 * it against a mock audio graph — the closest thing to an integration test
 * this system can have without launching a browser.
 *
 * Wired in main.js: constructed in Game._initScene(), update(dt) last in
 * Game.step() so the listener reads a current camera matrix, setPaused() and
 * dispose() from their namesakes. Everything else — the unlock gesture, the
 * footstep and landing hooks, the bake — this file arranges for itself.
 */
import { makeRng, makeGesture, clamp } from './dsp.js';
import { bankJobs, stepKey, landKey, DEFAULT_SEED } from './bank.js';
import { STEP_VARIANTS, LAND_VARIANTS } from './steps.js';
import {
  levelGain, FALLS_BASE, FALLS_LIP, brookOffset, brookGain, insectTrailGain,
  airCutoff,
} from './score.js';
/* The locomotion dimensions the footstep and landing gains scale against.
 * player/gait.js is dependency-free precisely so this file can read them
 * without dragging three into the Node smoke test; the alternative — the
 * literals these used to be — is how a footstep layer ends up tuned for a
 * gait the game no longer has. */
import { JOG_SPEED, JUMP_SPEED } from '../player/gait.js';
import { cicadaSwell, cricketGate, makeInsectEvents, CICADA_LOOPS, CRICKET_LOOPS } from './insects.js';
import { makeBirdScheduler } from './birds.js';
import { fallsBalance } from './water.js';
import { gustEnvelope, washGain, rustleGain, RUSTLE_LAG } from './wind.js';

/* Control-rate constants. Gains and positions move at 20 Hz with
 * setTargetAtTime smoothing the last mile; per-frame updates buy nothing
 * audible and triple the AudioParam traffic. */
const CTL_DT = 1 / 20;
const SMOOTH = 0.12;
/* How far ahead events are committed to the audio clock. Long enough that a
 * control tick landing late never drops a call, short enough that pausing
 * doesn't leave seconds of already-scheduled birds to play over the pause. */
const HORIZON = 1.5;
const MAX_VOICES = 16;

export class Ambience {
  /**
   * @param {object} o
   * @param {THREE.Camera} o.camera    read-only; only matrixWorld is used
   * @param {Trail} o.trail            for the brook's position query
   * @param {Terrain} o.terrain        for footstep wetness (evalWet)
   * @param {Walker} o.walker          for trailT and the onStep hook
   * @param {Function} [o.contextFactory]  test seam: () => AudioContext-like
   * @param {Document|null} [o.doc]        test seam: null skips DOM listeners
   */
  constructor({ camera, trail, terrain, walker, seed = DEFAULT_SEED, contextFactory, doc }) {
    this.camera = camera;
    this.trail = trail;
    this.terrain = terrain;
    this.walker = walker;
    this.seed = seed;
    this._makeCtx = contextFactory
      || (() => new (globalThis.AudioContext || globalThis.webkitAudioContext)());

    this.ready = false;
    this._unlocking = false;
    this._disposed = false;
    this.fallsBase = { ...FALLS_BASE };
    this.fallsLip = { ...FALLS_LIP };
    this._time = 0;          // ambience clock: seconds since unlock
    this._ctl = 0;
    this._rng = makeRng(seed ^ 0xa0d10);
    this._gesture = makeGesture(seed + 777);
    this._voices = 0;
    this._foot = 0;
    this._boutPos = new Map();
    this._layerTrim = {};    // runtime dB trims, for tuning via __ambience
    this.bakeMs = 0;
    this.deviceMs = 0;
    this.bytes = 0;
    this.bakedOffThread = false;

    /* Chain rather than overwrite: the character-body system may also want
     * footfalls, and whichever of us wires up second must not silence the
     * other. Restored on dispose for the same reason — a game that rebuilds
     * its audio would otherwise stack a callback per Ambience it ever made. */
    const prevStep = walker.onStep;
    const prevLand = walker.onLand;
    walker.onStep = (pos, speed) => {
      if (prevStep) prevStep(pos, speed);
      this._onFootstep(pos, speed);
    };
    walker.onLand = (pos, impact, speed) => {
      if (prevLand) prevLand(pos, impact, speed);
      this._onLanding(pos, impact);
    };
    this._detachWalker = () => {
      walker.onStep = prevStep;
      walker.onLand = prevLand;
    };

    /* Browsers refuse to start audio without a user gesture. Pointer lock
     * is the game's gesture, so the pointerlockchange that starts the walk
     * also starts the sound; the pointerdown fallback covers the harness
     * and any future menu that clicks without locking. */
    const d = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null);
    if (d) {
      /* The rejection has to be swallowed here, not left to float. unlock()
       * is async and nobody awaits it from an event listener, so a machine
       * with no audio output device would otherwise turn a silent game into
       * an unhandled promise rejection — which the capture harness reports
       * as a page error and which reads as a rendering fault. */
      const tryUnlock = () => {
        this.unlock().catch((err) => {
          console.warn('[ambience] audio unavailable:', (err && err.message) || err);
        });
      };
      d.addEventListener('pointerlockchange', tryUnlock);
      d.addEventListener('pointerdown', tryUnlock, { once: true });
      this._detachDoc = () => d.removeEventListener('pointerlockchange', tryUnlock);
    }

    // Same convention as window.__game: the capture harness and anyone
    // tuning levels from the console get a handle without a code change.
    globalThis.__ambience = this;
  }

  /** Idempotent. Creates the context, bakes the bank, builds the graph. */
  async unlock() {
    if (this.ready || this._unlocking || this._disposed) return;
    this._unlocking = true;
    try {
      /* Constructing the context opens the output device, and that is a
       * synchronous ~30 ms on the main thread in Chromium — one dropped frame,
       * and the only one the unlock costs now that the bake is off-thread. It
       * cannot be moved: the context has to exist, and it has to be created
       * inside the gesture handler or the browser will not let it start.
       * Measured rather than assumed, because it is otherwise indistinguishable
       * from a bake that is stalling the loop. */
      const tDev = (globalThis.performance || Date).now();
      const ctx = this._makeCtx();
      this.ctx = ctx;
      this.deviceMs = (globalThis.performance || Date).now() - tDev;
      if (ctx.state === 'suspended' && ctx.resume) await ctx.resume();

      /* The bake is ~1 s of CPU, and nothing plays until every buffer exists:
       * starting layers piecemeal sounded like a mixing desk being switched
       * on channel by channel. */
      const t0 = (globalThis.performance || Date).now();
      const sr = ctx.sampleRate;
      await this._bake(ctx, sr);
      if (this._disposed) return;
      this.bakeMs = (globalThis.performance || Date).now() - t0;

      this._buildGraph();
      this._birdSched = makeBirdScheduler(this.seed + 1000);
      this._insectSched = makeInsectEvents(this.seed + 2000);
      this._nextBird = this._birdSched.next(this.walker.trailT);
      this._nextInsect = this._insectSched.next();
      this._t0 = this.ctx.currentTime;
      this.ready = true;
    } catch (err) {
      // Leave nothing half-built: a later gesture gets a clean attempt
      // rather than inheriting a context that failed to produce a graph.
      if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch (_) { /* already dead */ } }
      this.ctx = null;
      this.bank = null;
      throw err;
    } finally {
      this._unlocking = false;
    }
  }

  /**
   * Fill `this.bank` with AudioBuffers, off the main thread where possible.
   *
   * The jobs are wildly uneven — the cricket beds are over a hundred
   * milliseconds each and a dozen jobs exceed a 60 Hz frame (see
   * `node tools/audio.mjs jobs`) — so pacing them across macrotasks on the
   * main thread cannot make them invisible: a job runs to completion inside
   * whatever frame it starts in. A worker removes the question entirely, and
   * the paced loop stays as the fallback for anywhere without module workers,
   * which is also the path Node's smoke test takes.
   */
  async _bake(ctx, sr) {
    this.bank = {};
    this.bytes = 0;
    const store = (key, buf) => {
      const ab = ctx.createBuffer(1, buf.length, sr);
      ab.copyToChannel(buf, 0);
      this.bank[key] = ab;
      this.bytes += buf.byteLength;
    };

    const worker = this._makeBakeWorker();
    if (worker) {
      try {
        await this._bakeInWorker(worker, sr, store);
        this.bakedOffThread = true;
        return;
      } catch (err) {
        // Falling back rather than failing: a worker that cannot load is a
        // reason for a stuttery unlock, not for a silent game.
        console.warn('[ambience] bake worker unavailable, baking inline:',
          (err && err.message) || err);
        this.bank = {};
        this.bytes = 0;
      } finally {
        worker.terminate();
      }
    }

    this.bakedOffThread = false;
    for (const job of bankJobs(sr, this.seed)) {
      const { key, buf } = job();
      store(key, buf);
      await new Promise((r) => setTimeout(r, 0));
      /* The bake spans a second of wall-clock across dozens of macrotasks,
       * which is long enough for the page to navigate away underneath it.
       * Building a graph on a closed context throws, so the check belongs
       * inside the loop rather than only before it. */
      if (this._disposed) return;
    }
  }

  _makeBakeWorker() {
    if (typeof Worker === 'undefined') return null;
    try {
      return new Worker(new URL('./bakeWorker.js', import.meta.url), { type: 'module' });
    } catch (_) {
      return null;
    }
  }

  _bakeInWorker(worker, sr, store) {
    return new Promise((resolve, reject) => {
      /* A worker that never answers would leave the game permanently silent
       * with no indication why, since unlock() is fire-and-forget. The
       * timeout converts that into the inline bake. */
      const timer = setTimeout(() => reject(new Error('bake worker timed out')), 30_000);
      const done = (fn, arg) => { clearTimeout(timer); fn(arg); };
      worker.onerror = (e) => done(reject, new Error(e.message || 'bake worker failed to load'));
      worker.onmessageerror = () => done(reject, new Error('bake worker sent an uncloneable message'));
      worker.onmessage = ({ data }) => {
        if (data.error) return done(reject, new Error(data.error));
        if (data.done || this._disposed) return done(resolve);
        store(data.key, data.buf);
      };
      worker.postMessage({ sr, seed: this.seed });
    });
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = levelGain('master');
    /* The compressor is a safety net, not a mix tool: with the score's
     * levels it should never engage except when a close bird call lands on
     * the falls at full crescendo, and then it is the difference between
     * "loud moment" and digital clipping. */
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 4;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    /* Non-positional beds: gain → stereo pan → master. Each loop starts at
     * a random offset so no two sessions begin at the same phase alignment
     * of the beds — the alignment, not the content, is what would make two
     * playthroughs sound like the same recording. */
    this._beds = {};
    const bed = (key, pan) => {
      const src = ctx.createBufferSource();
      src.buffer = this.bank[key];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(g); g.connect(p); p.connect(this.master);
      src.start(0, this._rng() * this.bank[key].duration);
      this._beds[key] = g;
    };
    [-0.5, 0.12, 0.55].forEach((pan, k) => bed(`cicada${k}`, pan));
    [-0.3, 0.35].forEach((pan, k) => bed(`cricket${k}`, pan));
    bed('wash', 0);
    bed('rustle0', -0.6);
    bed('rustle1', 0.6);

    /* Positional sources: gain → air-absorption lowpass → panner → master.
     * Equal-power panning, not HRTF: a dozen concurrent HRTF convolutions
     * is real audio-thread CPU on a machine already rendering 7M triangles,
     * and for sources that are mostly broadband texture the localisation
     * gain from HRTF is small. */
    this._pos = {};
    const positional = (key, ref) => {
      const src = ctx.createBufferSource();
      src.buffer = this.bank[key];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 18000;
      const pan = ctx.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = ref;
      pan.rolloffFactor = 1;
      src.connect(g); g.connect(lp); lp.connect(pan); pan.connect(this.master);
      src.start(0, this._rng() * this.bank[key].duration);
      this._pos[key] = { gain: g, lp, pan };
    };
    positional('rumble', 18);
    positional('cascade', 18);
    positional('spray', 18);
    positional('babble', 6);
    this._placePanner(this._pos.rumble.pan, this.fallsBase);
    this._placePanner(this._pos.cascade.pan, this.fallsBase);
    this._placePanner(this._pos.spray.pan, this.fallsLip);

    // Reused duck-typed target for trail.pointAt/tangentAt, which normally
    // allocate a THREE.Vector3 when no target is given.
    this._v = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; } };
    this._q = {};
  }

  /* Source positions snap rather than smooth. A new event panner is born at
   * the origin — inside the listener's head — and smoothing it out to the
   * bird would audibly fly the call through the ear. The sources that do
   * move (the brook) move centimetres per control tick, which needs no
   * smoothing; only the listener itself is smoothed, because the listener
   * genuinely moves fast. */
  _placePanner(pan, p) {
    if (pan.positionX) {
      pan.positionX.setValueAtTime(p.x, this.ctx.currentTime);
      pan.positionY.setValueAtTime(p.y, this.ctx.currentTime);
      pan.positionZ.setValueAtTime(p.z, this.ctx.currentTime);
    } else if (pan.setPosition) {
      pan.setPosition(p.x, p.y, p.z);
    }
  }

  /** System 5 calls this once the real falls mesh exists. */
  setWaterfallPosition(base, lip = null) {
    this.fallsBase = { x: base.x, y: base.y, z: base.z };
    if (lip) this.fallsLip = { x: lip.x, y: lip.y, z: lip.z };
    if (this.ready) {
      this._placePanner(this._pos.rumble.pan, this.fallsBase);
      this._placePanner(this._pos.cascade.pan, this.fallsBase);
      this._placePanner(this._pos.spray.pan, this.fallsLip);
    }
  }

  /** Runtime per-layer trim in dB, for tuning from the console/harness. */
  setLayerTrim(name, db) { this._layerTrim[name] = db; }
  _lv(name) {
    const trim = this._layerTrim[name] || 0;
    return levelGain(name) * Math.pow(10, trim / 20);
  }

  update(dt) {
    if (!this.ready) return;
    this._time += dt;
    this._ctl += dt;
    if (this._ctl < CTL_DT) return;
    this._ctl = 0;
    this._controlTick();
  }

  _controlTick() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const time = this._time;
    const t = this.walker.trailT;
    const g = this._gesture;

    // Listener from the camera's world matrix. Column-major: position at
    // 12..14, forward is -Z (third column negated), up is the second column.
    const e = this.camera.matrixWorld.elements;
    const lis = ctx.listener;
    if (lis.positionX) {
      lis.positionX.setTargetAtTime(e[12], now, 0.05);
      lis.positionY.setTargetAtTime(e[13], now, 0.05);
      lis.positionZ.setTargetAtTime(e[14], now, 0.05);
      lis.forwardX.setTargetAtTime(-e[8], now, 0.05);
      lis.forwardY.setTargetAtTime(-e[9], now, 0.05);
      lis.forwardZ.setTargetAtTime(-e[10], now, 0.05);
      lis.upX.setTargetAtTime(e[4], now, 0.05);
      lis.upY.setTargetAtTime(e[5], now, 0.05);
      lis.upZ.setTargetAtTime(e[6], now, 0.05);
    } else if (lis.setPosition) {
      lis.setPosition(e[12], e[13], e[14]);
      lis.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }

    const set = (param, v) => param.setTargetAtTime(v, now, SMOOTH);

    // Beds: the same gesture functions the offline renderer evaluates.
    const insG = insectTrailGain(t);
    CICADA_LOOPS.forEach((_, k) =>
      set(this._beds[`cicada${k}`].gain, this._lv('cicada') * cicadaSwell(g, time, k) * insG));
    CRICKET_LOOPS.forEach((_, k) =>
      set(this._beds[`cricket${k}`].gain, this._lv('crickets') * cricketGate(g, time, k) * insG));
    const gust = gustEnvelope(g, time);
    set(this._beds.wash.gain, this._lv('wash') * washGain(gust));
    set(this._beds.rustle0.gain, this._lv('rustle') * rustleGain(gust));
    set(this._beds.rustle1.gain, this._lv('rustle') * rustleGain(gustEnvelope(g, time - RUSTLE_LAG)));

    /* Falls: the panner handles inverse-distance level; character (the
     * rumble→cascade→spray unmasking) and air absorption are ours. Distance
     * is measured to the real source position, so once System 5 relocates
     * the falls everything follows automatically. */
    const dx = this.fallsBase.x - e[12], dy = this.fallsBase.y - e[13], dz = this.fallsBase.z - e[14];
    const dFalls = Math.hypot(dx, dy, dz);
    const bal = fallsBalance(dFalls);
    const cut = airCutoff(dFalls);
    for (const part of ['rumble', 'cascade', 'spray']) {
      set(this._pos[part].gain.gain, this._lv('falls') * bal[part]);
      this._pos[part].lp.frequency.setTargetAtTime(cut, now, SMOOTH);
    }

    /* The brook is a line source faked as a point that slides along the
     * channel to stay abreast of the walker — the nearest water is always
     * the loudest, and a fixed point would pass behind you and fade out
     * even while you walk beside the stream. */
    const bg = brookGain(t);
    set(this._pos.babble.gain.gain, this._lv('brook') * bg);
    if (bg > 0.001) {
      const p = this.trail.pointAt(t, this._v);
      const px = p.x, pz = p.z;
      const tan = this.trail.tangentAt(t, this._v);
      const off = brookOffset(t);
      /* Offset along (tz, -tx), which is the direction whose signed-side
       * value in Trail.nearest equals `off` — matching the terrain's own
       * convention is what puts the babble on the side the ground is
       * actually carved and darkened. */
      const bx = px + tan.z * off, bz = pz - tan.x * off;
      const by = this.terrain.height(bx, bz);
      this._placePanner(this._pos.babble.pan, { x: bx, y: by, z: bz });
      this._pos.babble.lp.frequency.setTargetAtTime(airCutoff(Math.abs(off)), now, SMOOTH);
    }

    // Events, committed up to the horizon.
    const ambNow = now - this._t0;
    while (this._nextBird.time < ambNow + HORIZON) {
      this._spawnBird(this._nextBird, e);
      this._nextBird = this._birdSched.next(t);
    }
    while (this._nextInsect.time < ambNow + HORIZON) {
      this._spawnPositionalOneShot(
        this.bank[`${this._nextInsect.kind}:${this._nextInsect.variant}`],
        this._nextInsect, e, this._lv('insectEvent'), 6);
      this._nextInsect = this._insectSched.next();
    }
  }

  /* Bird bouts keep one world anchor for all their calls: the anchor is
   * resolved from the listener position at the first call and cached by
   * bout id, so a bird you walked past keeps calling from behind you. */
  _spawnBird(ev, e) {
    let p = this._boutPos.get(ev.bout);
    if (!p) {
      p = {
        x: e[12] + Math.sin(ev.az) * ev.dist,
        y: e[13] + ev.elev,
        z: e[14] + Math.cos(ev.az) * ev.dist,
      };
      this._boutPos.set(ev.bout, p);
      // Several species can hold live bouts at once, so prune by age
      // rather than clearing — a cleared anchor would make a bird jump to
      // wherever the listener has walked to mid-bout.
      if (this._boutPos.size > 12) {
        this._boutPos.delete(this._boutPos.keys().next().value);
      }
    }
    this._spawnOneShotAt(this.bank[`bird:${ev.species}:${ev.variant}`], ev, p,
      this._lv('birds'), 8);
  }

  _spawnPositionalOneShot(buf, ev, e, level, ref) {
    this._spawnOneShotAt(buf, ev, {
      x: e[12] + Math.sin(ev.az) * ev.dist,
      y: e[13] + ev.elev,
      z: e[14] + Math.cos(ev.az) * ev.dist,
    }, level, ref);
  }

  _spawnOneShotAt(buf, ev, p, level, ref) {
    if (this._voices >= MAX_VOICES || !buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = ev.rate;
    const g = ctx.createGain();
    g.gain.value = level * ev.gain;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = airCutoff(ev.dist);
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = ref;
    pan.rolloffFactor = 1;
    this._placePanner(pan, p);
    src.connect(g); g.connect(lp); lp.connect(pan); pan.connect(this.master);
    this._voices++;
    src.onended = () => { this._voices--; pan.disconnect(); };
    src.start(this._t0 + ev.time);
  }

  /* Wetness from the same field that darkens the ground texture, so the
   * squelch arrives exactly where the trail looks soaked. */
  _wetnessAt(pos) {
    const q = this.trail.nearest(pos.x, pos.z, this._q);
    return clamp(
      this.terrain.evalWet(pos.x, pos.z, this.terrain.height(pos.x, pos.z), q), 0, 1);
  }

  _onFootstep(pos, speed) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.bank[stepKey(this._wetnessAt(pos), (this._rng() * STEP_VARIANTS) | 0)];
    src.playbackRate.value = 0.94 + this._rng() * 0.12;
    const g = ctx.createGain();
    /* Heavier at speed: kinetic energy, not just cadence, is what a jog adds.
     * The cadence itself is entirely the walker's — this fires from onStep,
     * which the gait clock in player/gait.js drives — so a jog is already
     * 3.04 steps/s here without this layer knowing anything about timing. */
    g.gain.value = this._lv('steps')
      * (0.7 + 0.3 * clamp(speed / JOG_SPEED, 0, 1))
      * (0.85 + this._rng() * 0.15);
    const p = ctx.createStereoPanner();
    p.pan.value = this._foot++ % 2 ? 0.22 : -0.22;
    src.connect(g); g.connect(p); p.connect(this.master);
    src.start();
  }

  /**
   * A jump's descent contacting the ground. `impact` is the downward speed at
   * contact, which is JUMP_SPEED for a jump on the flat and more when the
   * landing is below where it started.
   */
  _onLanding(pos, impact) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const hard = clamp(impact / JUMP_SPEED, 0, 1.6);
    const src = ctx.createBufferSource();
    src.buffer = this.bank[landKey(this._wetnessAt(pos), (this._rng() * LAND_VARIANTS) | 0)];
    /* Pitched down with the force of the arrival rather than jittered around
     * 1 like a footstep. The variants already carry the randomness; here the
     * rate is carrying information, and a heavy landing that came out higher
     * than a light one would actively mislead. */
    src.playbackRate.value = (1.03 - 0.10 * clamp(hard, 0, 1)) * (0.98 + this._rng() * 0.04);
    const g = ctx.createGain();
    g.gain.value = this._lv('land') * clamp(0.55 + 0.45 * hard, 0, 1.2);
    /* Dead centre, unlike a footstep. Both feet arrive together, and the
     * ±0.22 alternation that gives a walk its left/right anatomy would put a
     * two-footed impact off to one side for no reason. */
    const p = ctx.createStereoPanner();
    p.pan.value = 0;
    src.connect(g); g.connect(p); p.connect(this.master);
    src.start();
    // Resume the walk on the other foot: pushing off and landing square means
    // the next footfall is not a continuation of the pre-jump alternation.
    this._foot = 0;
  }

  setPaused(paused) {
    if (!this.ready) return;
    if (paused && this.ctx.state === 'running' && this.ctx.suspend) this.ctx.suspend();
    else if (!paused && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
  }

  stats() {
    return {
      ready: this.ready,
      state: this.ctx ? this.ctx.state : 'no-context',
      bakeMs: Math.round(this.bakeMs),
      deviceMs: Math.round(this.deviceMs),
      bakedOffThread: this.bakedOffThread,
      bankBytes: this.bytes,
      buffers: this.bank ? Object.keys(this.bank).length : 0,
      voices: this._voices,
    };
  }

  dispose() {
    this._disposed = true;
    if (this._detachDoc) this._detachDoc();
    if (this._detachWalker) this._detachWalker();
    if (this.ctx && this.ctx.close) this.ctx.close();
    this.ready = false;
    // Only if it is still us: a replacement Ambience constructed before this
    // one was disposed owns the handle, and clearing it would strand it.
    if (globalThis.__ambience === this) globalThis.__ambience = null;
  }
}
