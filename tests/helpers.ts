import { createInitialState, startGame, stepGame } from "@/game/sim";
import type { GameState, InputState } from "@/game/types";
import { GATE_ROW, OVER_DOOR } from "@/game/world";
import { BOSS_TRIGGER_Y } from "@/game/world";
import { GLOB_SPLASH_R, SWING_REACH } from "@/game/constants";

export const idle = (): InputState => ({ up: false, down: false, left: false, right: false, attack: false });
export function run(s: GameState, input: Partial<InputState>, ticks: number) {
  for (let i = 0; i < ticks; i++) stepGame(s, { ...idle(), ...input });
}
export function fresh(seed = 42) {
  const s = createInitialState(seed);
  startGame(s);
  return s;
}
export function toDungeon(s: GameState) {
  s.player.x = OVER_DOOR.x1;
  s.player.y = OVER_DOOR.y + 1.4;
  run(s, { up: true }, 40);
}
/** Puts the player in the Warden's Hall with the boss awake. */
export function bossFight(seed = 42) {
  const s = fresh(seed);
  toDungeon(s);
  for (const e of s.enemies) if (e.kind === "blob") (e.alive = false), (e.respawnT = 1e9);
  s.flags.hasKey = true;
  s.flags.gateOpen = true;
  s.player.x = 8;
  s.player.y = BOSS_TRIGGER_Y + 0.6;
  run(s, { up: true }, 20);
  if (!s.flags.bossAwake) throw new Error("boss did not wake");
  void GATE_ROW;
  return s;
}
export const boss = (s: GameState) => s.enemies.find((e) => e.kind === "boss")!;

function dirInput(vx: number, vy: number, attack = false): InputState {
  const t = 0.38;
  const l = Math.hypot(vx, vy) || 1;
  vx /= l;
  vy /= l;
  return { up: vy < -t, down: vy > t, left: vx < -t, right: vx > t, attack };
}

/**
 * A "careful player": keeps its distance, sidesteps the lunge tell, dodges glob markers & puddles,
 * and only commits sword swings while the Warden is stunned.
 */
export function carefulInput(s: GameState): InputState {
  const p = s.player;
  const b = boss(s);
  if (!b.alive) return idle();
  const dx = b.x - p.x, dy = b.y - p.y;
  const d = Math.hypot(dx, dy);
  // 1) hazards first
  for (const g of s.globs) {
    const hd = Math.hypot(p.x - g.tx, p.y - g.ty);
    if (hd < GLOB_SPLASH_R + 0.7) return dirInput(p.x - g.tx || 0.1, p.y - g.ty || 0.1);
  }
  for (const q of s.puddles) {
    const hd = Math.hypot(p.x - q.x, p.y - q.y);
    if (hd < q.r + 0.6) return dirInput(p.x - q.x || 0.1, p.y - q.y || 0.1);
  }
  // 2) punish the stun window
  if (b.state === "stunned" && b.stateT > 0.2) {
    const want = b.r + 0.75;
    if (d > want + 0.3) return dirInput(dx, dy);
    // face the boss, swing
    const inp = dirInput(dx, dy, p.swingCd <= 0 && d - b.r < SWING_REACH);
    if (d < want - 0.2) return { ...inp, up: false, down: false, left: false, right: false, attack: inp.attack };
    return inp;
  }
  // 3) sidestep the lunge: move perpendicular to the boss→player line
  if (b.state === "windup" || b.state === "lunge") {
    // step off the (locked) lunge line, toward whichever side we're already on
    const ax = b.state === "lunge" || b.stateT <= 0.3 ? b.wx : dx / (d || 1);
    const ay = b.state === "lunge" || b.stateT <= 0.3 ? b.wy : dy / (d || 1);
    let px = -ay, py = ax;
    const side = (p.x - b.x) * px + (p.y - b.y) * py;
    let sgn = side >= 0 ? 1 : -1;
    // don't dodge into a wall
    const cx = 8 - p.x, cy = 5.5 - p.y;
    if (Math.abs(side) < 0.3) sgn = px * cx + py * cy >= 0 ? 1 : -1;
    if (b.state === "windup" && b.stateT > 0.3) return idle(); // wait for the aim to lock
    return dirInput(px * sgn, py * sgn);
  }
  // 4) keep a respectful distance (bait the lunge), drifting toward the open middle
  if (d < 3.5) {
    const cx = 8 - p.x, cy = 5.5 - p.y;
    return dirInput(-dx + cx * 0.35 + -dy * 0.5, -dy + cy * 0.35 + dx * 0.5);
  }
  if (d > 5.5) return dirInput(dx, dy);
  return idle();
}
