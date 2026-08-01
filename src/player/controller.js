/* First-person walker.
 *
 * The camera is the whole interface, so it gets more attention than the input.
 * Three things separate a camera that feels like a person from one that feels
 * like a flying tripod:
 *
 *  - Weight. Acceleration and damping on the velocity, not direct assignment,
 *    so starting and stopping take a moment.
 *  - Gait. The head rises and falls twice per stride and rolls once, because
 *    it is on top of a spine that is being alternately supported by two legs.
 *  - Being held. Even standing still, a real camera drifts. The handheld noise
 *    never stops, and it is the single cheapest thing that stops footage
 *    looking computer-generated.
 *
 * Ground contact is still sampled directly from the procedural heightfield,
 * but jumping gets one vertical ballistic degree of freedom. Keeping horizontal
 * collision and vertical contact separate prevents a landing on a root from
 * tunnelling the eye into the terrain.
 */
import * as THREE from 'three';
import { clamp, lerp, smoothstep, Noise2D } from '../world/noise.js';
import {
  WALK_SPEED,
  JOG_SPEED,
  WALK_STEP_LENGTH,
  JUMP_SPEED,
  gaitBlend,
  stepLengthAt,
  gaitCycleRate,
} from './gait.js';

const EYE = 1.66;
const GROUND_ACCEL = 6.2;
const GROUND_BRAKE = 7.5;
const AIR_STEER = 1.15;
const AIR_DRAG = 0.18;
const STRAFE_SCALE = 0.80;
const BACKWARD_SCALE = 0.70;
const PLAYER_RADIUS = 0.32;
const PLAYER_HEADROOM = 0.14;
/* A bank above about thirty-nine degrees is not a walking surface in wet
 * litter. Rejecting it here is deliberately stricter than the old forty-four
 * degree limit: the latter let the eye glide up faces that the planted-foot
 * solve could not plausibly reach. */
const MAX_SLOPE = 0.78;    // cosine of the steepest ground that can be climbed
const TAKEOFF_TIME = 0.18;
const LAND_TIME = 0.24;
const GRAVITY = 9.81;
const TAU = Math.PI * 2;
const fract = v => v - Math.floor(v);
const response = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Walker {
  constructor(camera, terrain, trail, collision = null) {
    this.camera = camera;
    this.terrain = terrain;
    this.trail = trail;
    this.collision = collision;
    this.radius = PLAYER_RADIUS;
    this.height = EYE + PLAYER_HEADROOM;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.bobPhase = 0;
    this.dist = 0;
    this.speed = 0;
    this.stepLength = WALK_STEP_LENGTH;
    this._paceBlend = 0;
    this.runBlend = 0;
    this.slopeGrade = 0;
    this.slopeFactor = 1;
    this.gaitBounce = 0;

    this.grounded = true;
    this.verticalVelocity = 0;
    this.jumpState = 'grounded';
    this.jumpTime = 0;
    this.jumpCrouch = 0;
    this.jumpTakeoff = 0;
    this.jumpAir = 0;
    this.jumpLand = 0;
    this.jumpHeight = 0;
    this._jumpHeld = false;
    this._jumpQueued = false;
    this._baseFov = camera.fov;

    this.keys = Object.create(null);
    this.enabled = false;
    this.auto = null;          // { t } — scripted walk, used by the capture harness
    this.noise = new Noise2D(4242);
    this._time = 0;
    this._tmp = new THREE.Vector3();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._q = {};

    /** Fired on each footfall so the audio system can place a step. */
    this.onStep = null;
    /* Fired once when a descent contacts the ground, with the speed it
     * arrived at. A landing is not a loud footstep and must not be inferred
     * from one: the gait clock is frozen in mid-air, so the footfall boundary
     * that would otherwise stand in for the impact does not occur until the
     * walk resumes, several frames after the feet are down. */
    this.onLand = null;
    this.placeAt(0.02);
  }

  /** Drop the walker onto the trail at normalised arc length `t`, facing along it. */
  placeAt(t) {
    const p = this.trail.pointAt(t, new THREE.Vector3());
    const tan = this.trail.tangentAt(t, new THREE.Vector3());
    this.pos.set(p.x, this.terrain.height(p.x, p.z) + EYE, p.z);
    this.yaw = Math.atan2(-tan.x, -tan.z);
    this.pitch = -0.05;
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this._paceBlend = 0;
    this.runBlend = 0;
    this.slopeGrade = 0;
    this.slopeFactor = 1;
    this.stepLength = WALK_STEP_LENGTH;
    this.verticalVelocity = 0;
    this.grounded = true;
    this.jumpState = 'grounded';
    this.jumpTime = 0;
    this.jumpCrouch = 0;
    this.jumpTakeoff = 0;
    this.jumpAir = 0;
    this.jumpLand = 0;
    this.jumpHeight = 0;
    this.camera.position.copy(this.pos);
    return this;
  }

  attach(dom) {
    this.dom = dom;
    const down = (e) => { this.keys[e.code] = true; if (e.code === 'Space') e.preventDefault(); };
    const up = (e) => { this.keys[e.code] = false; };
    /* Browsers do not promise a keyup when focus or pointer lock is lost. A
     * missed release used to leave the walker moving until that key happened
     * to be pressed again, which made returning from Escape feel like broken
     * pointer-lock re-entry rather than a keyboard edge case. */
    const clear = () => {
      for (const code of Object.keys(this.keys)) this.keys[code] = false;
      this._jumpHeld = false;
      this._jumpQueued = false;
    };
    const click = () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock();
    };
    const lock = () => {
      this.enabled = document.pointerLockElement === dom;
      if (!this.enabled) clear();
    };
    const move = (e) => {
      if (!this.enabled) return;
      /* Raw relative motion is intentional here. Smoothing mouse deltas adds
       * latency to the one control that represents the player's own head, and
       * operating-system pointer settings already provide any acceleration a
       * player has asked for. */
      const s = 0.0022;
      this.yaw -= e.movementX * s;
      this.pitch = clamp(this.pitch - e.movementY * s, -1.35, 1.35);
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    window.addEventListener('mousemove', move);
    dom.addEventListener('click', click);
    document.addEventListener('pointerlockchange', lock);
    this._detach = () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      window.removeEventListener('mousemove', move);
      dom.removeEventListener('click', click);
      document.removeEventListener('pointerlockchange', lock);
    };
    return this;
  }

  /** Scripted trail travel. `jog` exists for motion capture; the intro stays a walk. */
  setAuto(t, pace = 'walk') {
    this.auto = (t === null || t === undefined) ? null : { t, pace };
    return this;
  }

  /** Queue one grounded jump; holding Space cannot repeatedly bunny-hop. */
  jump() { this._jumpQueued = true; return this; }

  update(dt) {
    this._time += dt;
    this._consumeJumpInput();

    if (this.auto) {
      this._updateAuto(dt);
    } else {
      this._updateInput(dt);
    }

    this._updateVertical(dt);
    this._advanceGait(dt);
    this._settleCamera(dt);
  }

  _updateAuto(dt) {
    const a = this.auto;
    const jog = a.pace === 'jog';
    this._paceBlend += ((jog ? 1 : 0) - this._paceBlend) * response(3.8, dt);
    const pace = lerp(WALK_SPEED, JOG_SPEED, this._paceBlend);
    a.t = Math.min(1, a.t + (pace * dt) / this.trail.length);
    const p = this.trail.pointAt(a.t, this._tmp);
    // Aim a few metres ahead so the heading leads the position through bends,
    // the way a person looks into a corner before walking around it.
    const ahead = this.trail.pointAt(Math.min(1, a.t + 0.012), new THREE.Vector3());
    /* Capture walks stay on the authored centreline and deliberately bypass
     * lateral collision. A newly scattered verge tree should not strand every
     * downstream critic frame, and manual travel still uses the same terrain,
     * camera and gait path below. */
    this.pos.x = p.x; this.pos.z = p.z;
    const wantYaw = Math.atan2(p.x - ahead.x, p.z - ahead.z);
    let d = wantYaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 2.2);
    this.speed = pace;
    this.runBlend = gaitBlend(this.speed);
    this.slopeGrade += (0 - this.slopeGrade) * response(5, dt);
    this.slopeFactor = 1;
    this.dist += pace * dt;
  }

  _updateInput(dt) {
    const k = this.keys;
    let fx = 0, fz = 0;
    if (k.KeyW || k.ArrowUp) fz -= 1;
    if (k.KeyS || k.ArrowDown) fz += 1;
    if (k.KeyA || k.ArrowLeft) fx -= 1;
    if (k.KeyD || k.ArrowRight) fx += 1;
    const mag = Math.hypot(fx, fz);
    if (mag > 0) { fx /= mag; fz /= mag; }

    /* Shift selects a pace, while runBlend below describes the pace the body
     * has actually reached. Keeping those separate prevents an idle Shift key,
     * a steep blocked bank, or a slow backward jog from widening the lens and
     * posing the body as if it were already travelling at full speed. */
    const wantsJog = mag > 0 && !!(k.ShiftLeft || k.ShiftRight);
    this._paceBlend += ((wantsJog ? 1 : 0) - this._paceBlend) * response(3.8, dt);
    const pace = lerp(WALK_SPEED, JOG_SPEED, this._paceBlend);
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    const wx = fx * cos - fz * sin;
    const wz = fx * sin + fz * cos;

    /* A sidestep and a blind backward step are deliberately shorter than a
     * forward stride. The input was normalised first, so adding a second key
     * can never produce the classic square-root-of-two speed increase; this
     * scalar only changes the humanly available pace for that direction. */
    const directionScale = fz < 0
      ? 1
      : fz > 0
        ? BACKWARD_SCALE
        : mag > 0 ? STRAFE_SCALE : 0;

    let grade = 0;
    let slopeFactor = 1;
    if (this.grounded && mag > 0) {
      const n = this.terrain.normal(this.pos.x, this.pos.z, this._normal);
      grade = -(n.x * wx + n.z * wz) / Math.max(0.1, n.y);
      /* Tiny grade changes are terrain texture, not exertion. Above that dead
       * band, climbing costs appreciably more than descending: downhill still
       * slows a little because wet roots demand shorter, cautious steps. */
      const uphill = Math.min(0.28, Math.max(0, grade - 0.04) * 0.72);
      const downhill = Math.min(0.10, Math.max(0, -grade - 0.08) * 0.26);
      slopeFactor = 1 - uphill - downhill;
    }
    this.slopeGrade += (grade - this.slopeGrade) * response(5, dt);
    this.slopeFactor = slopeFactor;

    const target = pace * directionScale * slopeFactor;
    if (this.grounded) {
      const kResponse = response(mag > 0 ? GROUND_ACCEL : GROUND_BRAKE, dt);
      const tx = mag > 0 ? wx * target : 0;
      const tz = mag > 0 ? wz * target : 0;
      this.vel.x += (tx - this.vel.x) * kResponse;
      this.vel.z += (tz - this.vel.z) * kResponse;
    } else if (mag > 0) {
      /* Steering can correct a poor takeoff, but the low response rate makes
       * changing direction in one short hop impossible. */
      const kResponse = response(AIR_STEER, dt);
      this.vel.x += (wx * target - this.vel.x) * kResponse;
      this.vel.z += (wz * target - this.vel.z) * kResponse;
    } else {
      /* Releasing a key in flight is not an air brake. Only a small drag term
       * remains, so a jump carries the horizontal momentum it left with. */
      const drag = Math.exp(-AIR_DRAG * dt);
      this.vel.x *= drag;
      this.vel.z *= drag;
    }

    const travelled = this._move(this.vel.x * dt, this.vel.z * dt);
    this.speed = dt > 0 ? travelled / dt : Math.hypot(this.vel.x, this.vel.z);
    this.runBlend = gaitBlend(this.speed);
    this.dist += travelled;
  }

  _consumeJumpInput() {
    const down = !!this.keys.Space;
    const pressed = (down && !this._jumpHeld) || this._jumpQueued;
    this._jumpHeld = down;
    this._jumpQueued = false;
    if (pressed && this.jumpState === 'grounded') {
      this.jumpState = 'takeoff';
      this.jumpTime = 0;
    }
  }

  _advanceGait(dt) {
    this.stepLength = stepLengthAt(this.speed);
    const moving = smoothstep(0.05, 0.9, this.speed);
    if (!this.grounded || this.jumpState === 'takeoff' || moving < 0.01) return;

    const previousStep = Math.floor(this.bobPhase * 2);
    this.bobPhase += gaitCycleRate(this.speed) * dt;
    const nextStep = Math.floor(this.bobPhase * 2);
    if (this.onStep && nextStep !== previousStep) {
      /* Half a gait phase is one opposite-foot contact. Emitting on that
       * boundary keeps sound, planted-foot IK and the camera's downward settle
       * on the same frame instead of using a visually convenient later zero. */
      this.onStep(this.pos, this.speed);
    }
  }

  _updateVertical(dt) {
    const groundY = this.terrain.height(this.pos.x, this.pos.z) + EYE;
    this.jumpTakeoff = 0;
    this.jumpLand = 0;

    if (this.jumpState === 'takeoff') {
      this.grounded = true;
      this.jumpAir = lerp(this.jumpAir, 0, Math.min(1, dt * 12));
      this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 12);
      this.jumpTime += dt;
      const u = clamp(this.jumpTime / TAKEOFF_TIME, 0, 1);
      /* Compression happens early and the extension is faster. A symmetric
       * crouch reads as kneeling in place rather than loading the legs. */
      this.jumpCrouch = u < 0.58
        ? smoothstep(0, 0.58, u)
        : 1 - smoothstep(0.58, 1, u);
      this.jumpTakeoff = smoothstep(0.46, 1, u);
      if (u >= 1) {
        this.jumpState = 'airborne';
        this.jumpTime = 0;
        this.grounded = false;
        this.verticalVelocity = JUMP_SPEED;
        this.jumpCrouch = 0;
      }
    } else if (this.jumpState === 'airborne') {
      this.grounded = false;
      this.jumpAir = lerp(this.jumpAir, 1, Math.min(1, dt * 9));
      this.verticalVelocity -= GRAVITY * dt;
      this.pos.y += this.verticalVelocity * dt;
      if (this.verticalVelocity < 0 && this.pos.y <= groundY) {
        // Read before the zeroing below: how hard the contact was is the one
        // thing about a landing that the resulting state no longer records.
        const impact = -this.verticalVelocity;
        this.pos.y = groundY;
        this.verticalVelocity = 0;
        this.grounded = true;
        this.jumpState = 'land';
        this.jumpTime = 0;
        if (this.onLand) this.onLand(this.pos, impact, this.speed);
      }
    } else if (this.jumpState === 'land') {
      this.grounded = true;
      this.jumpAir = lerp(this.jumpAir, 0, Math.min(1, dt * 12));
      this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 14);
      this.jumpTime += dt;
      const u = clamp(this.jumpTime / LAND_TIME, 0, 1);
      this.jumpLand = u < 0.28
        ? smoothstep(0, 0.28, u)
        : 1 - smoothstep(0.28, 1, u);
      this.jumpCrouch = this.jumpLand * 0.82;
      if (u >= 1) {
        this.jumpState = 'grounded';
        this.jumpTime = 0;
        this.jumpCrouch = 0;
        this.jumpLand = 0;
      }
    } else {
      this.grounded = true;
      this.jumpAir = lerp(this.jumpAir, 0, Math.min(1, dt * 12));
      this.jumpCrouch = 0;
      this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 12);
    }

    this.jumpHeight = Math.max(0, this.pos.y - groundY);
  }

  /* Slide along whatever is too steep to climb rather than stopping dead.
   * Tested per axis: hitting a bank at an angle should redirect you along it,
   * which a single combined test cannot express. */
  _move(dx, dz) {
    const x0 = this.pos.x, z0 = this.pos.z;
    const climbable = (x, z) => {
      const t = this.terrain;
      const e = 0.45;
      const hL = t.height(x - e, z), hR = t.height(x + e, z);
      const hD = t.height(x, z - e), hU = t.height(x, z + e);
      const nx = hL - hR, ny = 2 * e, nz = hD - hU;
      const inv = 1 / Math.hypot(nx, ny, nz);
      return ny * inv > MAX_SLOPE;
    };
    let mx = 0, mz = 0;
    if (!this.grounded) {
      /* Slope is a ground-contact constraint. Applying it in the air made a
       * jump toward a bank lose an axis of motion despite clearing the soil. */
      mx = dx;
      mz = dz;
    } else {
      if (climbable(this.pos.x + dx, this.pos.z)) mx = dx;
      else if (Math.abs(dx) > 1e-8) this.vel.x = 0;
      if (climbable(this.pos.x + mx, this.pos.z + dz)) mz = dz;
      else if (Math.abs(dz) > 1e-8) this.vel.z = 0;
    }

    if (this.collision) {
      /* The heightfield remains the source of vertical contact. The registry
       * answers only whether the standing capsule can occupy the requested
       * plan position, which keeps steps and jumps from acquiring a second,
       * subtly different notion of ground. Passing velocity lets the resolver
       * remove only the component pressing into a contact, so input along a
       * trunk or wall remains a slide rather than accumulating into a stick. */
      const feetY = this.pos.y - EYE;
      const hit = this.collision.move(
        this.pos.x, this.pos.z, mx, mz,
        feetY, feetY + this.height, this.radius, this.vel,
      );
      this.pos.x = hit.x;
      this.pos.z = hit.z;
    } else {
      this.pos.x += mx;
      this.pos.z += mz;
    }

    // Hard bound: the terrain runs out eventually and there is nothing to see
    // past the ridge lines.
    this.terrain.sampleField(this.pos.x, this.pos.z, this._q);
    if (this._q.dist > 46) {
      const p = this.trail.pointAt(this._q.t, this._tmp);
      const k = 46 / this._q.dist;
      this.pos.x = p.x + (this.pos.x - p.x) * k;
      this.pos.z = p.z + (this.pos.z - p.z) * k;
      /* Remove only the velocity pressing out of the corridor. Leaving it in
       * place makes turning back feel sticky because the next input first has
       * to cancel a full-speed velocity that never produced any movement;
       * preserving the tangent still lets the player slide along the ridge. */
      const nx = (this.pos.x - p.x) / 46;
      const nz = (this.pos.z - p.z) / 46;
      const outward = this.vel.x * nx + this.vel.z * nz;
      if (outward > 0) {
        this.vel.x -= nx * outward;
        this.vel.z -= nz * outward;
      }
    }
    /* Gait, body animation and footstep audio all use speed. Returning actual
     * displacement rather than desired velocity keeps all three still when a
     * steep bank blocks the walker instead of walking in place against it. */
    return Math.hypot(this.pos.x - x0, this.pos.z - z0);
  }

  _settleCamera(dt) {
    const moving = smoothstep(0.05, 0.9, this.speed);
    const groundMotion = this.grounded ? 1 - this.jumpCrouch * 0.75 : 0;
    const amp = lerp(0.024, 0.044, this.runBlend) * moving * groundMotion;

    /* Each step rises through support and drops into the next contact. The
     * rise deliberately occupies more of the step than the drop; a sine gives
     * both halves equal weight and is the familiar mechanical head-bob tell. */
    const stepPhase = fract(this.bobPhase * 2);
    const warped = stepPhase < 0.58
      ? (stepPhase / 0.58) * 0.5
      : 0.5 + ((stepPhase - 0.58) / 0.42) * 0.5;
    const support = (1 - Math.cos(warped * TAU)) * 0.5;
    const bobY = (support * 2 - 1) * amp;
    const b = this.bobPhase * TAU;
    const bobX = Math.cos(b) * amp * lerp(0.72, 0.88, this.runBlend);
    const roll = Math.sin(b) * lerp(0.012, 0.019, this.runBlend) * moving;
    this.gaitBounce = bobY;

    // Handheld drift. Two incommensurate noise rates so it never finds a
    // period the eye can lock onto.
    const nt = this._time;
    const driftY = this.noise.n(nt * 0.31, 11.2) * 0.0075 + this.noise.n(nt * 0.93, 4.7) * 0.0028;
    const driftP = this.noise.n(nt * 0.27, 61.5) * 0.0060 + this.noise.n(nt * 0.81, 27.3) * 0.0022;
    const breathe = Math.sin(nt * 1.35) * 0.0035 * (1 - moving * 0.6);

    const cam = this.camera;
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    cam.position.set(
      this.pos.x + bobX * cos,
      this.pos.y + bobY + breathe - this.jumpCrouch * 0.105,
      this.pos.z + bobX * sin,
    );
    cam.rotation.set(0, 0, 0);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + driftY;
    cam.rotation.x = this.pitch + driftP - bobY * 0.28;
    cam.rotation.z = roll + driftY * 0.5;

    /* A restrained jog widens the lens by only a few degrees. It adds speed
     * without turning an observational walk into an action-camera sprint. */
    const wantFov = this._baseFov + this.runBlend * 2.4;
    const nextFov = lerp(cam.fov, wantFov, Math.min(1, dt * 4.2));
    if (Math.abs(nextFov - cam.fov) > 1e-4) {
      cam.fov = nextFov;
      cam.updateProjectionMatrix();
    }
  }

  /** Normalised progress along the trail, for systems that fade by location. */
  get trailT() {
    this.terrain.sampleField(this.pos.x, this.pos.z, this._q);
    return this._q.t;
  }

  dispose() { if (this._detach) this._detach(); }
}
