/* Who gets the gate, and who gets the touch controls.
 *
 * This is the only file in src/mobile that a desktop ever downloads, and it is
 * deliberately the smallest one: everything that builds DOM lives behind a
 * dynamic import that a mouse never triggers, so "absent on desktop" is a
 * property of the network log and not only of a branch.
 */

const mq = (query) => typeof matchMedia === 'function' && matchMedia(query).matches;

const hash = () => (typeof location === 'undefined' ? '' : location.hash);

/**
 * A phone or a tablet: the primary pointer is a finger.
 *
 * Deliberately not `navigator.maxTouchPoints > 0`, which is also true of every
 * touchscreen laptop. A Surface being driven from its trackpad reports a
 * *fine* primary pointer and has a keyboard attached, and it should get the
 * desktop page exactly as it is today — pointer lock, W A S D and no UI.
 */
export const isTouchPrimary = () =>
  mq('(pointer: coarse)') && (navigator.maxTouchPoints || 0) > 0;

/**
 * Whether to hold the boot behind the capability screen.
 *
 * One step wider than `isTouchPrimary`, because a viewport this small is not
 * one anyone is going to fly a first-person camera around in, whatever is
 * pointing at it. `#nogate` skips the screen, which is what the capture tools
 * use to reach the scene under phone emulation; `#gate` forces it, so the
 * screen can be looked at on the machine it was written on.
 */
export const gateRequired = () => {
  if (/(^|[#&])nogate(&|$)/.test(hash())) return false;
  if (/(^|[#&])gate(&|$)/.test(hash())) return true;
  return mq('(pointer: coarse)') || innerWidth < 640 || innerHeight < 480;
};
