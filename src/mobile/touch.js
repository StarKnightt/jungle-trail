/* Touch controls, and as little of them as will do.
 *
 * This is the one place in the project where UI is allowed on top of the
 * frame, and only because the alternative is arriving somewhere you cannot
 * move: a phone has no keyboard and no pointer lock, so a player who taps
 * through the gate without this is stuck looking at one fixed view of a
 * jungle and concluding it is a screenshot.
 *
 * Two inputs. Drag anywhere to look, which is the whole screen and needs no
 * furniture drawn on it, and one pad held down to walk. There is no second
 * stick: the walker already travels in the direction the camera is pointing,
 * so look plus forward reaches every point in the world, and a strafe axis
 * would be a second visible control bought for nothing. No jump either — it
 * is a nature walk, and the third button is where a HUD starts.
 *
 * Nothing here is imported on a desktop. The module is behind a dynamic
 * import that only a coarse primary pointer takes, so the document a mouse
 * gets is byte for byte the one it got before this file existed.
 */
import { clamp } from '../world/noise.js';

/* Radians per CSS pixel. The mouse path uses 0.0022, which is right for a
 * device that can be picked up and put down again; a thumb has about a
 * screen width of travel in it, and at the mouse rate that is a fifty degree
 * turn per swipe. This is roughly double, which puts a full swipe at about a
 * quarter turn on a phone held in portrait. */
const LOOK = 0.0042;
const PITCH_LIMIT = 1.35;

/**
 * Build the pad, wire the look drag, and return a teardown.
 *
 * @param {{walker: object, canvas: HTMLCanvasElement}} game
 * @returns {() => void}
 */
export function attachTouchControls(game) {
  const walker = game.walker;
  /* The walker's click handler asks for pointer lock. iOS has no Pointer
   * Lock API and Android rejects the request when the gesture was a touch,
   * so on this path it is at best a no-op and at worst an unhandled
   * rejection the capture harness would report as a page error. */
  walker.pointerLock = false;

  const root = document.createElement('div');
  root.className = 'touch';
  root.id = 'touch-controls';

  const pad = document.createElement('button');
  pad.className = 'touch__walk';
  pad.type = 'button';
  pad.setAttribute('aria-label', 'Hold to walk');
  const arrow = document.createElement('span');
  arrow.className = 'touch__arrow';
  arrow.setAttribute('aria-hidden', 'true');
  pad.append(arrow);
  root.append(pad);
  document.body.append(root);

  let walkId = null;
  let lookId = null;
  let lastX = 0;
  let lastY = 0;

  const walkOn = (event) => {
    if (walkId !== null) return;
    walkId = event.pointerId;
    /* Straight into the same key table the keyboard writes. Everything
     * downstream of it — acceleration, the gait clock, footstep audio, the
     * slope cost, collision — is then the walk the desktop build has, rather
     * than a second movement path that would drift away from it. */
    walker.keys.KeyW = true;
    pad.classList.add('is-down');
    /* Capture so that a thumb which slides off the pad while walking keeps
     * walking, which is what a thumb does. Guarded because a synthesised
     * event — the capture harness dispatches some — has no active pointer for
     * the browser to hand over. */
    try { pad.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
    event.preventDefault();
  };

  const walkOff = (event) => {
    if (event && event.pointerId !== walkId) return;
    walkId = null;
    walker.keys.KeyW = false;
    pad.classList.remove('is-down');
  };

  const lookStart = (event) => {
    if (event.pointerType === 'mouse') return;
    if (lookId !== null || root.contains(event.target)) return;
    lookId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
  };

  const lookMove = (event) => {
    if (event.pointerId !== lookId) return;
    walker.yaw -= (event.clientX - lastX) * LOOK;
    walker.pitch = clamp(walker.pitch - (event.clientY - lastY) * LOOK,
      -PITCH_LIMIT, PITCH_LIMIT);
    lastX = event.clientX;
    lastY = event.clientY;
    event.preventDefault();
  };

  const lookEnd = (event) => {
    if (event.pointerId === lookId) lookId = null;
  };

  /* A finger that leaves the glass, a call arriving, or the page going to the
   * background all end a hold without a pointerup. Left unhandled, any of
   * them walks the player into the undergrowth until they touch the pad
   * again. */
  const releaseAll = () => { walkOff(null); lookId = null; };

  pad.addEventListener('pointerdown', walkOn);
  pad.addEventListener('pointerup', walkOff);
  pad.addEventListener('pointercancel', walkOff);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('pointerdown', lookStart);
  addEventListener('pointermove', lookMove, { passive: false });
  addEventListener('pointerup', lookEnd);
  addEventListener('pointercancel', lookEnd);
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', releaseAll);

  return () => {
    releaseAll();
    removeEventListener('pointerdown', lookStart);
    removeEventListener('pointermove', lookMove);
    removeEventListener('pointerup', lookEnd);
    removeEventListener('pointercancel', lookEnd);
    removeEventListener('blur', releaseAll);
    document.removeEventListener('visibilitychange', releaseAll);
    root.remove();
  };
}
