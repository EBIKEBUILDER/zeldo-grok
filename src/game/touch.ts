/**
 * Virtual (touch) controls write here; the game loop merges it with the keyboard each frame.
 * Kept outside React state on purpose: it changes on every pointermove.
 */
export const touchInput = {
  /** analog stick, -1..1, y positive = south (screen down) */
  mx: 0,
  my: 0,
  stick: false,
  /** latched until the next sim tick consumes it */
  attack: false,
};
