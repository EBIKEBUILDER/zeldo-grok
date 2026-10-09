import type { MapId } from "./world";

export type Phase = "title" | "playing" | "gameover" | "victory";

export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** edge-triggered: set true on key/click press, consumed by the sim */
  attack: boolean;
}

export interface Player {
  map: MapId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** unit facing vector (8-way) */
  fx: number;
  fy: number;
  hp: number;
  maxHp: number;
  rupees: number;
  invuln: number;
  knockT: number;
  swingT: number;
  swingCd: number;
  swingId: number;
  /** angle (radians, map space) locked at the start of the current swing */
  swingAngle: number;
  hitIds: number[];
  hurtCount: number;
  doorLock: boolean;
}

export type EnemyState = "idle" | "wander" | "chase" | "windup" | "lunge" | "recover";

export interface Enemy {
  id: number;
  kind: "blob" | "boss";
  map: MapId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
  r: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  state: EnemyState;
  stateT: number;
  wx: number;
  wy: number;
  hitFlash: number;
  stun: number;
  contactCd: number;
  respawnT: number;
  lungeCd: number;
}

export interface Pickup {
  id: number;
  kind: "rupee" | "heart";
  map: MapId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  value: number;
}

export interface Breakable {
  id: number;
  kind: "tuft" | "pot";
  map: MapId;
  x: number;
  y: number;
  alive: boolean;
}

export type EventType =
  | "swing"
  | "hit"
  | "enemyDie"
  | "bossDie"
  | "rupee"
  | "heart"
  | "hurt"
  | "key"
  | "gate"
  | "gateSlam"
  | "chestAppear"
  | "chest"
  | "tuft"
  | "pot"
  | "spawn"
  | "bossRoar"
  | "lunge"
  | "door"
  | "gameover"
  | "victory";

export interface GameEvent {
  seq: number;
  type: EventType;
  map: MapId;
  x: number;
  y: number;
  dx?: number;
  dy?: number;
}

export interface Flags {
  hasKey: boolean;
  gateOpen: boolean;
  bossAwake: boolean;
  bossDefeated: boolean;
  chestOpened: boolean;
}

export interface Message {
  id: number;
  text: string;
  t: number;
}

export interface GameState {
  phase: Phase;
  tick: number;
  time: number;
  rng: number;
  nextId: number;
  eventSeq: number;
  player: Player;
  enemies: Enemy[];
  pickups: Pickup[];
  breakables: Breakable[];
  flags: Flags;
  message: Message | null;
  area: string;
  /** seconds until the victory screen after opening the chest; <0 when inactive */
  victoryT: number;
  /** increments on every map transition (HUD uses it for a fade) */
  transitionCount: number;
  events: GameEvent[];
}
