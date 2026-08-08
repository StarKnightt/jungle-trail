/* The capability screen.
 *
 * Most of the traffic this project gets arrives on a phone, loads a scene
 * built for a desktop GPU, and leaves thinking the thing is broken. This is
 * the fix, and the shape of it matters: it is a door with a sign on it, not a
 * wall. Newer iPhones and iPads genuinely run this at full quality, there is
 * no reduced-fidelity tier for them to fall back to, and deciding on their
 * behalf from a user-agent string would be both wrong and unpleasant. So the
 * screen says plainly what is about to happen, shows a frame of it, lists the
 * controls, and then gets out of the way when asked.
 *
 * Nothing here is imported unless `gateRequired()` said so, which is why the
 * poster's forty kilobytes and this file's DOM never reach a desktop at all.
 */
import { POSTER } from './poster.js';
import { isTouchPrimary } from './detect.js';

const TOUCH_CONTROLS = [
  ['Drag anywhere', 'Look'],
  ['Hold the pad', 'Walk'],
];

const KEY_CONTROLS = [
  ['Click', 'Lock the pointer'],
  ['Mouse', 'Look'],
  ['W A S D', 'Move'],
  ['Shift / Space', 'Sprint / jump'],
];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/**
 * Show the screen and resolve once the player has asked to go in.
 *
 * Resolves *after* the browser has painted the "building" state, not on the
 * tap itself. The world build is one long synchronous block — a hundred
 * thousand plants and fifteen GPU bakes — so a caller that started it inside
 * the click handler would freeze the page with the button still lit, which on
 * a slow device is indistinguishable from having crashed it.
 *
 * @returns {Promise<() => void>} a dismiss function, to call once the first
 *   frame exists. It fades the screen out rather than cutting, which also
 *   covers the moment between the canvas appearing and it having anything on
 *   it.
 */
export function presentGate() {
  document.getElementById('boot')?.remove();

  const root = el('div', 'gate');
  root.id = 'gate';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'gate-title');

  const card = el('div', 'gate__card');

  const still = document.createElement('img');
  still.className = 'gate__still';
  still.src = POSTER;
  still.alt = 'A frame from the trail: broad understory leaves under a closed '
    + 'canopy, with a shaft of sunlight falling across the path.';
  still.width = 720;
  still.height = 405;
  still.decoding = 'async';

  const body = el('div', 'gate__body');
  const kicker = el('p', 'gate__kicker', 'Real-time render');
  const title = el('h1', 'gate__title', 'Jungle Trail');
  title.id = 'gate-title';

  const lede = el('p', 'gate__lede',
    'Everything here is computed in your browser as the page loads: a valley '
    + '180 by 492 metres, a hundred thousand plants, 536 eroded stone blocks '
    + 'and sixty synthesised sounds. No photographs, no model files, no '
    + 'recordings.');

  const warn = el('p', 'gate__lede',
    'It was built for a desktop GPU and the quality is not turned down to fit '
    + 'a phone. Recent iPhones and iPads do run it. Older phones will get hot '
    + 'and slow, and some will give up.');

  const keys = el('dl', 'gate__keys');
  for (const [input, action] of isTouchPrimary() ? TOUCH_CONTROLS : KEY_CONTROLS) {
    const row = el('div', 'gate__key');
    row.append(el('dt', null, input), el('dd', null, action));
    keys.append(row);
  }

  const enter = el('button', 'gate__enter', 'Enter anyway');
  enter.type = 'button';

  const note = el('p', 'gate__note',
    'Building the world takes a few seconds after you tap.');

  body.append(kicker, title, lede, warn, keys, enter, note);
  card.append(still, body);
  root.append(card);
  document.body.append(root);

  return new Promise((resolve) => {
    const dismiss = () => {
      root.classList.add('is-leaving');
      setTimeout(() => root.remove(), 420);
    };

    enter.addEventListener('click', () => {
      enter.disabled = true;
      /* Everything below the still is replaced rather than hidden, so the
       * screen keeps its size and the frame stays on it. The player is
       * looking at the picture for the next several seconds either way. */
      body.replaceChildren(el('p', 'gate__building', 'Building the world'));
      root.classList.add('is-building');

      /* Two frames, not one. A single rAF fires before the paint it belongs
       * to, so resolving there hands the world build a screen that has been
       * described to the compositor and not yet drawn by it. */
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(dismiss)));
    }, { once: true });
  });
}
