/**
 * Pure game simulation. Operates on plain serializable data (GameState) with a fixed timestep.
 * No Babylon, no React, no DOM — so it runs identically in tests, at any frame rate.
 */
import * as C from "./constants";
import { mulberry } from "./rng";
import { FIELD_MIN_TICKS, astar, buildField, canStep, descend, fieldAt, type Blocked, type FlowField } from "./path";
import type { Breakable, Enemy, EventType, GameState, Glob, InputState, Pickup, Player, Puddle } from "./types";
import {
  BREAKABLES,
  BOSS_TRIGGER_Y,
  CHEST,
  DUNGEON_DOOR,
  DUNGEON_ENEMIES,
  DUNGEON_ENTRY,
  GATE_ROW,
  GATE_X,
  MAPS,
  OVER_DOOR,
  OVER_DOOR_EXIT,
  OVER_ENEMIES,
  PEDESTAL,
  SPAWN,
  Tile,
  areaName,
  isSolidTile,
  tileAt,
  type MapId,
} from "./world";

const EVENT_KEEP = 96;

export function createInitialState(seed = 12345): GameState {
  let id = 1;
  const enemies: Enemy[] = [...OVER_ENEMIES, ...DUNGEON_ENEMIES].map((s) => {
    const boss = s.kind === "boss";
    return {
      id: id++,
      kind: s.kind,
      map: s.map,
      x: s.x,
      y: s.y,
      vx: 0,
      vy: 0,
      homeX: s.x,
      homeY: s.y,
      r: boss ? C.BOSS_R : C.BLOB_R,
      hp: boss ? C.BOSS_HP : C.BLOB_HP,
      maxHp: boss ? C.BOSS_HP : C.BLOB_HP,
      alive: true,
      state: "idle",
      stateT: 0.5 + (id % 5) * 0.3,
      wx: 0,
      wy: 0,
      hitFlash: 0,
      stun: 0,
      contactCd: 0,
      respawnT: 0,
      lungeCd: 1.2,
      guardCd: 0,
      spitCd: 2.5,
      farT: 0,
      stunHits: 0,
      stuckT: 0,
      sampleT: 0,
      sampleX: s.x,
      sampleY: s.y,
      aggroCd: 0,
      path: [],
      pathI: 0,
    };
  });
  const breakables: Breakable[] = BREAKABLES.map((b) => ({ id: id++, kind: b.kind, map: b.map, x: b.x, y: b.y, alive: true }));
  const player: Player = {
    map: "over",
    x: SPAWN.x,
    y: SPAWN.y,
    vx: 0,
    vy: 0,
    fx: 0,
    fy: 1,
    hp: C.PLAYER_MAX_HP,
    maxHp: C.PLAYER_MAX_HP,
    rupees: 0,
    invuln: 0,
    knockT: 0,
    swingT: 0,
    swingCd: 0,
    swingId: 0,
    swingAngle: Math.PI / 2,
    hitIds: [],
    hurtCount: 0,
    doorLock: false,
  };
  return {
    phase: "title",
    tick: 0,
    time: 0,
    rng: seed | 0,
    nextId: id,
    eventSeq: 0,
    msgSeq: 0,
    worldVersion: 0,
    explored: [0, 0, 0, 0, 1, 0, 0, 0],
    player,
    enemies,
    pickups: [],
    breakables,
    globs: [],
    puddles: [],
    flags: { hasKey: false, gateOpen: false, bossAwake: false, bossDefeated: false, chestOpened: false },
    message: null,
    area: areaName("over", SPAWN.x, SPAWN.y),
    victoryT: -1,
    transitionCount: 0,
    events: [],
  };
}

// ───────────────────────────── helpers ─────────────────────────────
const rand = (s: GameState) => mulberry(s);

function emit(s: GameState, type: EventType, map: MapId, x: number, y: number, dx?: number, dy?: number) {
  s.events.push({ seq: ++s.eventSeq, type, map, x, y, dx, dy });
  if (s.events.length > EVENT_KEEP) s.events.splice(0, s.events.length - EVENT_KEEP);
}

function say(s: GameState, text: string, t = 2.6) {
  s.message = { id: ++s.msgSeq, text, t };
}

export function gateClosed(s: GameState): boolean {
  // The gate is locked until the key is used, and slams shut while the Warden is fighting.
  return !s.flags.gateOpen || (s.flags.bossAwake && !s.flags.bossDefeated);
}

export function chestVisible(s: GameState): boolean {
  return s.flags.bossDefeated;
}

function solidAt(s: GameState, map: MapId, tx: number, ty: number): boolean {
  return isSolidTile(tileAt(MAPS[map], tx, ty), gateClosed(s));
}

/** Does an axis-aligned box of half-size r centred at (x,y) overlap any solid tile? */
export function boxHitsSolid(s: GameState, map: MapId, x: number, y: number, r: number): boolean {
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r - 1e-6);
  const y0 = Math.floor(y - r), y1 = Math.floor(y + r - 1e-6);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (solidAt(s, map, tx, ty)) return true;
  return false;
}

interface Body {
  map: MapId;
  x: number;
  y: number;
}

/** Axis-separated move against tiles — gives natural wall-sliding. Returns which axes were blocked. */
export function moveBody(s: GameState, b: Body, dx: number, dy: number, r: number): { bx: boolean; by: boolean } {
  let bx = false, by = false;
  if (dx !== 0) {
    const nx = b.x + dx;
    if (!boxHitsSolid(s, b.map, nx, b.y, r)) b.x = nx;
    else {
      bx = true;
      const snapped = dx > 0 ? Math.floor(nx + r) - r - 1e-4 : Math.floor(nx - r) + 1 + r + 1e-4;
      if ((dx > 0 ? snapped >= b.x : snapped <= b.x) && !boxHitsSolid(s, b.map, snapped, b.y, r)) b.x = snapped;
    }
  }
  if (dy !== 0) {
    const ny = b.y + dy;
    if (!boxHitsSolid(s, b.map, b.x, ny, r)) b.y = ny;
    else {
      by = true;
      const snapped = dy > 0 ? Math.floor(ny + r) - r - 1e-4 : Math.floor(ny - r) + 1 + r + 1e-4;
      if ((dy > 0 ? snapped >= b.y : snapped <= b.y) && !boxHitsSolid(s, b.map, b.x, snapped, r)) b.y = snapped;
    }
  }
  return { bx, by };
}

interface Circle {
  x: number;
  y: number;
  r: number;
}
/** Static round obstacles: pots, the key pedestal, the chest (once it exists). */
function staticCircles(s: GameState, map: MapId): Circle[] {
  const out: Circle[] = [];
  for (const b of s.breakables) if (b.alive && b.kind === "pot" && b.map === map) out.push({ x: b.x, y: b.y, r: 0.32 });
  if (map === "dungeon") {
    out.push({ x: PEDESTAL.x, y: PEDESTAL.y, r: 0.42 });
    if (chestVisible(s)) out.push({ x: CHEST.x, y: CHEST.y, r: 0.55 });
  }
  return out;
}

function pushOutOfCircles(s: GameState, b: Body, r: number, circles: Circle[]) {
  for (const c of circles) {
    const dx = b.x - c.x, dy = b.y - c.y;
    const d = Math.hypot(dx, dy);
    const min = r + c.r;
    if (d < min) {
      const nx = d > 1e-5 ? dx / d : 0, ny = d > 1e-5 ? dy / d : 1;
      moveBody(s, b, nx * (min - d), ny * (min - d), r);
    }
  }
}

function len(x: number, y: number) {
  return Math.hypot(x, y);
}

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function inSanctuary(map: MapId, x: number, y: number, pad = 0) {
  return map === "over" && Math.hypot(x - SPAWN.x, y - SPAWN.y) < C.SAFE_RADIUS + pad;
}

// ───────────────────────────── drops ─────────────────────────────
function spawnPickup(s: GameState, kind: Pickup["kind"], map: MapId, x: number, y: number, value = 1) {
  const a = rand(s) * Math.PI * 2;
  const sp = 1 + rand(s) * 1.5;
  s.pickups.push({
    id: s.nextId++,
    kind,
    map,
    x,
    y,
    z: 0.2,
    vx: Math.cos(a) * sp,
    vy: Math.sin(a) * sp,
    vz: 4.5,
    life: C.PICKUP_LIFE,
    value,
  });
}

function rollDrop(s: GameState, map: MapId, x: number, y: number, rupeeChance: number, heartChance: number) {
  const r = rand(s);
  const hurt = s.player.hp < s.player.maxHp;
  if (r < heartChance && hurt) spawnPickup(s, "heart", map, x, y);
  else if (r < heartChance + rupeeChance) spawnPickup(s, "rupee", map, x, y, rand(s) < 0.15 ? 5 : 1);
}

// ───────────────────────────── player ─────────────────────────────
function hurtPlayer(s: GameState, amount: number, fromX: number, fromY: number) {
  const p = s.player;
  if (p.invuln > 0 || s.phase !== "playing" || s.victoryT >= 0) return;
  p.hp = Math.max(0, p.hp - amount);
  p.invuln = C.INVULN_TIME;
  p.knockT = 0.2;
  let dx = p.x - fromX, dy = p.y - fromY;
  const d = len(dx, dy) || 1;
  dx /= d;
  dy /= d;
  p.vx = dx * 9;
  p.vy = dy * 9;
  p.swingT = 0;
  p.hurtCount++;
  emit(s, "hurt", p.map, p.x, p.y, dx, dy);
  if (p.hp <= 0) {
    s.phase = "gameover";
    emit(s, "gameover", p.map, p.x, p.y);
  }
}

function changeMap(s: GameState, map: MapId, x: number, y: number, fx: number, fy: number) {
  const p = s.player;
  p.map = map;
  p.x = x;
  p.y = y;
  p.vx = p.vy = 0;
  p.fx = fx;
  p.fy = fy;
  p.swingT = 0;
  p.doorLock = true;
  s.pickups = s.pickups.filter((k) => k.map === map);
  s.transitionCount++;
  emit(s, "door", map, x, y);
}

function updatePlayer(s: GameState, input: InputState, dt: number) {
  const p = s.player;
  p.invuln = Math.max(0, p.invuln - dt);
  p.swingCd = Math.max(0, p.swingCd - dt);
  if (p.swingT > 0) p.swingT = Math.max(0, p.swingT - dt);

  let ix = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let iy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  let il = len(ix, iy);
  let throttle = 1;
  if (il > 0) {
    ix /= il;
    iy /= il;
  } else if (input.mx !== undefined && input.my !== undefined) {
    // analog stick: direction is free, speed scales with deflection past a dead zone
    const m = Math.min(1, len(input.mx, input.my));
    if (m > 0.18) {
      ix = input.mx / len(input.mx, input.my);
      iy = input.my / len(input.mx, input.my);
      il = 1;
      throttle = Math.min(1, (m - 0.18) / 0.62 + 0.25);
    }
  }

  if (p.knockT > 0) {
    p.knockT -= dt;
    const f = Math.exp(-10 * dt);
    p.vx *= f;
    p.vy *= f;
  } else {
    const swinging = p.swingT > 0;
    const max = C.PLAYER_MAX_SPEED * (swinging ? 0.45 : 1) * throttle;
    const tx = ix * max, ty = iy * max;
    let dvx = tx - p.vx, dvy = ty - p.vy;
    const dl = len(dvx, dvy);
    const maxStep = (il > 0 ? C.PLAYER_ACCEL : C.PLAYER_DECEL) * dt;
    if (dl > maxStep) {
      dvx = (dvx / dl) * maxStep;
      dvy = (dvy / dl) * maxStep;
    }
    p.vx += dvx;
    p.vy += dvy;
    if (il > 0 && !swinging) {
      // facing is always one of 8 directions
      const a = Math.round(Math.atan2(iy, ix) / (Math.PI / 4)) * (Math.PI / 4);
      p.fx = Math.abs(Math.cos(a)) < 1e-9 ? 0 : Math.cos(a);
      p.fy = Math.abs(Math.sin(a)) < 1e-9 ? 0 : Math.sin(a);
    }
  }

  // attack
  if (input.attack && p.swingCd <= 0 && p.knockT <= 0) {
    p.swingT = C.SWING_TIME;
    p.swingCd = C.SWING_COOLDOWN;
    p.swingId++;
    p.swingAngle = Math.atan2(p.fy, p.fx);
    p.hitIds = [];
    emit(s, "swing", p.map, p.x, p.y, p.fx, p.fy);
  }

  moveBody(s, p, p.vx * dt, p.vy * dt, C.PLAYER_R);
  pushOutOfCircles(s, p, C.PLAYER_R, staticCircles(s, p.map));

  if (p.swingT > 0) swordHits(s);

  // doors
  const tx = Math.floor(p.x), ty = Math.floor(p.y);
  const onDoor = tileAt(MAPS[p.map], tx, ty) === Tile.DOOR;
  if (!onDoor) p.doorLock = false;
  else if (!p.doorLock) {
    if (p.map === "over" && ty === OVER_DOOR.y) changeMap(s, "dungeon", DUNGEON_ENTRY.x, DUNGEON_ENTRY.y, 0, -1);
    else if (p.map === "dungeon" && ty === DUNGEON_DOOR.y) changeMap(s, "over", OVER_DOOR_EXIT.x, OVER_DOOR_EXIT.y, 0, 1);
  }

  if (p.map === "dungeon") dungeonTriggers(s);
}

function swordHits(s: GameState) {
  const p = s.player;
  const a = p.swingAngle;
  // the blade sweeps; the hit zone is a generous cone in front of the hero
  for (const e of s.enemies) {
    if (!e.alive || e.map !== p.map || p.hitIds.includes(e.id)) continue;
    if (e.kind === "boss" && !s.flags.bossAwake) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = len(dx, dy);
    if (d - e.r > C.SWING_REACH) continue;
    if (d > e.r + 0.15 && angleDiff(Math.atan2(dy, dx), a) > C.SWING_HALF_ARC) continue;
    p.hitIds.push(e.id);
    hitEnemy(s, e, Math.cos(a), Math.sin(a));
  }
  for (const b of s.breakables) {
    if (!b.alive || b.map !== p.map || p.hitIds.includes(b.id)) continue;
    const dx = b.x - p.x, dy = b.y - p.y;
    const d = len(dx, dy);
    if (d > C.SWING_REACH + 0.2) continue;
    if (d > 0.4 && angleDiff(Math.atan2(dy, dx), a) > C.SWING_HALF_ARC) continue;
    p.hitIds.push(b.id);
    b.alive = false;
    s.worldVersion++;
    if (b.kind === "tuft") {
      emit(s, "tuft", b.map, b.x, b.y);
      rollDrop(s, b.map, b.x, b.y, 0.22, 0.12);
    } else {
      emit(s, "pot", b.map, b.x, b.y);
      rollDrop(s, b.map, b.x, b.y, 0.55, 0.3);
    }
  }
}

function hitEnemy(s: GameState, e: Enemy, dx: number, dy: number) {
  if (e.kind === "boss") return hitBoss(s, e, dx, dy);
  e.hp -= 1;
  e.hitFlash = 0.14;
  e.stun = 0.32;
  const kb = 10;
  e.vx = dx * kb;
  e.vy = dy * kb;
  emit(s, "hit", e.map, e.x, e.y, dx, dy);
  if (e.hp <= 0) killEnemy(s, e);
}

/** True when the boss's armor is up: sword hits clank off harmlessly. */
export function bossArmored(e: Enemy): boolean {
  return e.state === "windup" || e.state === "lunge" || e.state === "spitWindup" || (e.state !== "stunned" && e.guardCd > 0);
}

/**
 * Gloomgulp's damage rules:
 *  - stunned (after a lunge): full damage, no knockback — the reward window.
 *  - windup / lunge / spit tell / guarded: CLANK — no damage, no knockback, nothing interrupts him.
 *  - otherwise (chasing): one glancing hit lands, then he guards and counter-lunges at point blank.
 */
function hitBoss(s: GameState, e: Enemy, dx: number, dy: number) {
  if (e.state === "stunned") {
    e.hp -= 1;
    e.hitFlash = 0.14;
    e.stunHits++;
    emit(s, "hit", e.map, e.x, e.y, dx, dy);
    if (e.hp <= 0) return killEnemy(s, e);
    if (e.stunHits >= C.BOSS_STUN_MAX_HITS) {
      // jolted awake — back off!
      e.state = "recover";
      e.stateT = 0.35;
      e.guardCd = 0.6;
      e.lungeCd = C.BOSS_LUNGE_CD;
    }
    return;
  }
  if (bossArmored(e)) {
    emit(s, "clank", e.map, e.x - dx * e.r * 0.8, e.y - dy * e.r * 0.8, dx, dy);
    return;
  }
  e.hp -= 1;
  e.hitFlash = 0.14;
  emit(s, "hit", e.map, e.x, e.y, dx, dy);
  if (e.hp <= 0) return killEnemy(s, e);
  e.guardCd = C.BOSS_GUARD;
  e.state = "windup";
  e.stateT = C.BOSS_COUNTER_WINDUP;
  const px = s.player.x - e.x, py = s.player.y - e.y;
  const pl = len(px, py) || 1;
  e.wx = px / pl;
  e.wy = py / pl;
  emit(s, "bossCharge", e.map, e.x, e.y, e.wx, e.wy);
}

function killEnemy(s: GameState, e: Enemy) {
  e.alive = false;
  e.vx = e.vy = 0;
  if (e.kind === "boss") {
    s.flags.bossDefeated = true;
    s.globs = [];
    s.puddles = [];
    emit(s, "bossDie", e.map, e.x, e.y);
    emit(s, "chestAppear", e.map, CHEST.x, CHEST.y);
    spawnPickup(s, "heart", e.map, e.x, e.y);
    spawnPickup(s, "heart", e.map, e.x, e.y);
    for (let i = 0; i < 4; i++) spawnPickup(s, "rupee", e.map, e.x, e.y, 5);
    say(s, "The Warden dissolves… a chest rises from the stone!", 3.2);
  } else {
    e.respawnT = C.BLOB_RESPAWN;
    emit(s, "enemyDie", e.map, e.x, e.y);
    spawnPickup(s, "rupee", e.map, e.x, e.y, rand(s) < 0.2 ? 5 : 1);
  }
}

function dungeonTriggers(s: GameState) {
  const p = s.player;
  const f = s.flags;
  if (!f.hasKey && len(p.x - PEDESTAL.x, p.y - PEDESTAL.y) < 0.95) {
    f.hasKey = true;
    emit(s, "key", "dungeon", PEDESTAL.x, PEDESTAL.y);
    say(s, "You got the Mossgrave Key! The gate to the north awaits.");
  }
  if (!f.gateOpen) {
    const gx = (GATE_X[0] + GATE_X[1] + 1) / 2;
    const gy = GATE_ROW + 1;
    if (Math.abs(p.x - gx) < 1.3 && p.y - gy < 0.6 && p.y > gy - 0.2) {
      if (f.hasKey) {
        f.gateOpen = true;
        emit(s, "gate", "dungeon", gx, GATE_ROW + 0.5);
        say(s, "The key turns. The gate grinds open…");
      } else if (!s.message || s.message.t <= 0) {
        say(s, "The gate is locked tight. There must be a key somewhere…", 2);
      }
    }
  }
  if (f.gateOpen && !f.bossAwake && !f.bossDefeated && p.y < BOSS_TRIGGER_Y) {
    f.bossAwake = true;
    emit(s, "gateSlam", "dungeon", 8, GATE_ROW + 0.5);
    emit(s, "bossRoar", "dungeon", 8, 5);
    say(s, "Gloomgulp, Warden of the Vault, awakens!", 2.4);
  }
  if (f.bossDefeated && !f.chestOpened && len(p.x - CHEST.x, p.y - CHEST.y) < 1.05) {
    f.chestOpened = true;
    s.victoryT = 2.2;
    emit(s, "chest", "dungeon", CHEST.x, CHEST.y);
    say(s, "You found the Hollow Sunstone!", 3);
  }
}


// ───────────────────────────── navigation ─────────────────────────────
/** Pots block the flow field (they're solid); everything else comes from the tile map. */
function navBlocked(s: GameState, map: MapId): Blocked {
  const pots = new Set<number>();
  const w = MAPS[map].w;
  for (const b of s.breakables) if (b.alive && b.kind === "pot" && b.map === map) pots.add(Math.floor(b.y) * w + Math.floor(b.x));
  return (tx, ty) => solidAt(s, map, tx, ty) || pots.has(ty * w + tx);
}

interface FieldCache {
  key: string;
  tick: number;
  field: FlowField;
  blocked: Blocked;
}
const fieldCache = new WeakMap<GameState, Partial<Record<MapId, FieldCache>>>();

/** Shared flow field toward the player for `map`; rebuilt on player tile/world change, rate-capped. */
export function playerField(s: GameState, map: MapId): FieldCache {
  let c = fieldCache.get(s);
  if (!c) fieldCache.set(s, (c = {}));
  const p = s.player;
  const ptx = Math.floor(p.x), pty = Math.floor(p.y);
  const key = `${p.map === map ? `${ptx},${pty}` : "none"}|${gateClosed(s) ? 1 : 0}|${s.worldVersion}`;
  const cur = c[map];
  if (cur && (cur.key === key || s.tick - cur.tick < FIELD_MIN_TICKS)) return cur;
  const m = MAPS[map];
  const blocked = navBlocked(s, map);
  const field = p.map === map ? buildField(m.w, m.h, blocked, ptx, pty) : buildField(m.w, m.h, blocked, -1, -1);
  return (c[map] = { key, tick: s.tick, field, blocked });
}

/** Is a straight walk from a→b clear for a body of half-size r (samples every ¼ tile)? */
function clearWalk(s: GameState, map: MapId, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const d = len(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(d / 0.25));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (boxHitsSolid(s, map, ax + (bx - ax) * t, ay + (by - ay) * t, r)) return false;
  }
  return true;
}

const steerOut = { x: 0, y: 0 };
/**
 * Steering toward the player: go straight if the corridor is clear, otherwise follow the flow field
 * downhill and aim for the furthest tile on that chain we can walk to in a straight line (path
 * smoothing). Returns null when there is no path.
 */
export function steerToPlayer(s: GameState, e: Enemy): { x: number; y: number } | null {
  const p = s.player;
  const r = e.r * 0.85;
  if (len(p.x - e.x, p.y - e.y) < 7 && clearWalk(s, e.map, e.x, e.y, p.x, p.y, r * 0.9)) {
    steerOut.x = p.x;
    steerOut.y = p.y;
    return steerOut;
  }
  const fc = playerField(s, e.map);
  let tx = Math.floor(e.x), ty = Math.floor(e.y);
  if (fieldAt(fc.field, tx, ty) === Infinity) {
    // standing on a tile edge / inside a blocked cell: try neighbours
    let found = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (fieldAt(fc.field, tx + dx, ty + dy) < Infinity) {
        tx += dx;
        ty += dy;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  let bx = tx + 0.5, by = ty + 0.5;
  let first = true;
  for (let k = 0; k < 8; k++) {
    const nxt = descend(fc.field, fc.blocked, tx, ty);
    if (!nxt) break;
    [tx, ty] = nxt;
    if (first || clearWalk(s, e.map, e.x, e.y, tx + 0.5, ty + 0.5, r * 0.9)) {
      bx = tx + 0.5;
      by = ty + 0.5;
    } else break;
    first = false;
  }
  if (e.r > 0.6) {
    // big bodies (the Warden) don't fit a tile: nudge the waypoint away from walls beside it so a
    // 2-tile corridor is usable (the body hugs the far side instead of grinding on the near edge)
    const cx = Math.floor(bx), cy = Math.floor(by);
    const blk = (x: number, y: number) => fc.blocked(x, y);
    const off = e.r - 0.5 + 0.05;
    if (blk(cx + 1, cy) && !blk(cx - 1, cy)) bx -= off;
    else if (blk(cx - 1, cy) && !blk(cx + 1, cy)) bx += off;
    if (blk(cx, cy + 1) && !blk(cx, cy - 1)) by -= off;
    else if (blk(cx, cy - 1) && !blk(cx, cy + 1)) by += off;
  }
  steerOut.x = bx;
  steerOut.y = by;
  return steerOut;
}

function startReturn(s: GameState, e: Enemy) {
  e.state = "return";
  e.aggroCd = C.BLOB_REAGGRO_CD;
  e.stuckT = 0;
  const m = MAPS[e.map];
  const path = astar(m.w, m.h, navBlocked(s, e.map), Math.floor(e.x), Math.floor(e.y), Math.floor(e.homeX), Math.floor(e.homeY));
  e.path = path ?? [];
  e.pathI = 0;
}

function blobBrain(s: GameState, e: Enemy, dt: number, d: number, samePlace: boolean) {
  const p = s.player;
  e.aggroCd = Math.max(0, e.aggroCd - dt);
  const playerSafe = inSanctuary(p.map, p.x, p.y);
  let tx = 0, ty = 0;
  const homeD = len(e.x - e.homeX, e.y - e.homeY);

  if (e.state === "chase") {
    if (!samePlace || s.phase !== "playing" || d > C.BLOB_DEAGGRO || homeD > C.BLOB_LEASH) startReturn(s, e);
    else {
      // progress check once a second: moved meaningfully, or already brawling
      e.sampleT += dt;
      if (e.sampleT >= 1) {
        const moved = len(e.x - e.sampleX, e.y - e.sampleY);
        const brawling = d < e.r + C.PLAYER_R + 0.6;
        if (moved > 0.5 || brawling) e.stuckT = 0;
        else e.stuckT += e.sampleT;
        e.sampleT = 0;
        e.sampleX = e.x;
        e.sampleY = e.y;
      }
      const goal = steerToPlayer(s, e);
      if (e.stuckT >= C.BLOB_GIVEUP) startReturn(s, e);
      else if (goal) {
        const gx = goal.x - e.x, gy = goal.y - e.y;
        const gl = len(gx, gy) || 1;
        tx = (gx / gl) * C.BLOB_SPEED;
        ty = (gy / gl) * C.BLOB_SPEED;
      }
    }
  }
  if (e.state === "return") {
    if (e.pathI < e.path.length) {
      const w = MAPS[e.map].w;
      // smoothing: skip ahead to the furthest waypoint we can walk to directly
      let target = e.pathI;
      for (let k = e.pathI + 1; k < Math.min(e.path.length, e.pathI + 5); k++) {
        const c = e.path[k];
        if (clearWalk(s, e.map, e.x, e.y, (c % w) + 0.5, Math.floor(c / w) + 0.5, e.r * 0.8)) target = k;
      }
      e.pathI = target;
      const c = e.path[e.pathI];
      const wx = (c % w) + 0.5 - e.x, wy = Math.floor(c / w) + 0.5 - e.y;
      const wl = len(wx, wy);
      if (wl < 0.35) e.pathI++;
      else {
        tx = (wx / wl) * 1.6;
        ty = (wy / wl) * 1.6;
      }
    } else {
      const hx = e.homeX - e.x, hy = e.homeY - e.y;
      const hl = len(hx, hy);
      if (hl < 0.4) {
        e.state = "idle";
        e.stateT = 1;
      } else {
        tx = (hx / hl) * 1.6;
        ty = (hy / hl) * 1.6;
      }
    }
  }
  if (e.state !== "chase" && e.state !== "return") {
    const sees = samePlace && d < C.BLOB_AGGRO && (d < 2.5 || clearWalk(s, e.map, e.x, e.y, p.x, p.y, 0.05));
    if (s.phase === "playing" && !playerSafe && e.aggroCd <= 0 && sees) {
      e.state = "chase";
      e.stuckT = 0;
      e.sampleT = 0;
      e.sampleX = e.x;
      e.sampleY = e.y;
    } else {
      e.stateT -= dt;
      if (e.stateT <= 0) {
        if (homeD > 3.5) {
          e.state = "wander";
          e.wx = (e.homeX - e.x) / homeD;
          e.wy = (e.homeY - e.y) / homeD;
        } else if (rand(s) < 0.4) {
          e.state = "idle";
        } else {
          e.state = "wander";
          const a = rand(s) * Math.PI * 2;
          e.wx = Math.cos(a);
          e.wy = Math.sin(a);
        }
        e.stateT = 0.9 + rand(s) * 1.6;
      }
      if (e.state === "wander") {
        tx = e.wx * 1.0;
        ty = e.wy * 1.0;
      }
    }
  }
  const k = Math.min(1, 8 * dt);
  e.vx += (tx - e.vx) * k;
  e.vy += (ty - e.vy) * k;
}

// ───────────────────────────── enemies ─────────────────────────────
function updateEnemies(s: GameState, dt: number) {
  const p = s.player;
  for (const e of s.enemies) {
    if (!e.alive) {
      if (e.kind === "blob") {
        e.respawnT -= dt;
        const far = p.map !== e.map || len(p.x - e.homeX, p.y - e.homeY) > 6;
        if (e.respawnT <= 0 && far) {
          e.alive = true;
          e.hp = e.maxHp;
          e.x = e.homeX;
          e.y = e.homeY;
          e.vx = e.vy = 0;
          e.state = "idle";
          e.stateT = 1;
          emit(s, "spawn", e.map, e.x, e.y);
        }
      }
      continue;
    }
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    e.contactCd = Math.max(0, e.contactCd - dt);
    const samePlace = e.map === p.map;
    const dx = p.x - e.x, dy = p.y - e.y;
    const d = len(dx, dy);

    if (e.stun > 0) {
      e.stun -= dt;
      const f = Math.exp(-9 * dt);
      e.vx *= f;
      e.vy *= f;
    } else if (e.kind === "boss") {
      updateBoss(s, e, dt, dx, dy, d);
      if (e.state === "lunge") {
        const before = { x: e.x, y: e.y };
        const b = moveBody(s, e, e.vx * dt, e.vy * dt, e.r * 0.85);
        const moved = len(e.x - before.x, e.y - before.y);
        if ((b.bx || b.by) && moved < C.BOSS_LUNGE_SPEED * dt * 0.5) {
          // slammed into a wall/pillar: dazed for longer
          e.state = "stunned";
          e.stateT = C.BOSS_BONK_STUN;
          e.stunHits = 0;
          e.vx = e.vy = 0;
          emit(s, "bossStun", e.map, e.x, e.y, e.wx, e.wy);
        }
        pushOutOfCircles(s, e, e.r * 0.85, staticCircles(s, e.map));
        continue;
      }
    } else {
      blobBrain(s, e, dt, d, samePlace);
    }
    const blocked = moveBody(s, e, e.vx * dt, e.vy * dt, e.r * 0.85);
    if (blocked.bx || blocked.by) {
      if (e.state === "wander") e.stateT = 0;
    }
    pushOutOfCircles(s, e, e.r * 0.85, staticCircles(s, e.map));
    // Sanctuary: enemies can never enter the spawn circle.
    if (e.map === "over") {
      const sx = e.x - SPAWN.x, sy = e.y - SPAWN.y;
      const sd = len(sx, sy);
      const min = C.SAFE_RADIUS + e.r;
      if (sd < min) moveBody(s, e, (sx / (sd || 1)) * (min - sd), (sy / (sd || 1)) * (min - sd), e.r * 0.85);
    }
  }
}

function hasLineOfSight(s: GameState, map: MapId, x0: number, y0: number, x1: number, y1: number): boolean {
  const d = len(x1 - x0, y1 - y0);
  const n = Math.ceil(d / 0.25);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (solidAt(s, map, Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t))) return false;
  }
  return true;
}

function updateBoss(s: GameState, e: Enemy, dt: number, dx: number, dy: number, d: number) {
  const f = s.flags;
  const p = s.player;
  if (!f.bossAwake) {
    e.vx = e.vy = 0;
    return;
  }
  e.stateT -= dt;
  e.lungeCd -= dt;
  e.spitCd -= dt;
  e.guardCd = Math.max(0, e.guardCd - dt);
  const enraged = e.hp <= e.maxHp / 2;
  const nx = dx / (d || 1), ny = dy / (d || 1);
  const canLunge = d < C.BOSS_LUNGE_RANGE && hasLineOfSight(s, e.map, e.x, e.y, p.x, p.y);
  e.farT = canLunge ? 0 : e.farT + dt;
  let tx = 0, ty = 0;
  let accel = 6;
  switch (e.state) {
    case "windup":
      // planted and shuddering; tracks the player until the aim locks just before release
      if (e.stateT > C.BOSS_AIM_LOCK) {
        e.wx = nx;
        e.wy = ny;
      }
      if (e.stateT <= 0) {
        e.state = "lunge";
        e.stateT = C.BOSS_LUNGE_TIME;
        emit(s, "lunge", e.map, e.x, e.y, nx, ny);
        e.vx = e.wx * C.BOSS_LUNGE_SPEED;
        e.vy = e.wy * C.BOSS_LUNGE_SPEED;
      }
      break;
    case "lunge":
      // freight train: fixed heading, full speed, nothing interrupts it
      e.vx = e.wx * C.BOSS_LUNGE_SPEED;
      e.vy = e.wy * C.BOSS_LUNGE_SPEED;
      if (e.stateT <= 0) {
        e.state = "stunned";
        e.stateT = C.BOSS_STUN;
        e.stunHits = 0;
        e.vx = e.vy = 0;
        emit(s, "bossStun", e.map, e.x, e.y);
      }
      return;
    case "stunned":
      accel = 10;
      if (e.stateT <= 0) {
        e.state = "recover";
        e.stateT = 0.3;
        e.guardCd = 0;
        e.lungeCd = C.BOSS_LUNGE_CD;
      }
      break;
    case "spitWindup":
      if (e.stateT <= 0) {
        fireGlobs(s, e, enraged ? 5 : 3);
        e.state = "recover";
        e.stateT = 0.5;
        e.spitCd = C.BOSS_SPIT_CD;
      }
      break;
    case "recover":
      if (e.stateT <= 0) e.state = "chase";
      break;
    default: {
      e.state = "chase";
      const sp = C.BOSS_SPEED * (enraged ? 1.15 : 1);
      const goal = steerToPlayer(s, e);
      if (goal) {
        const gx = goal.x - e.x, gy = goal.y - e.y;
        const gl = len(gx, gy) || 1;
        tx = (gx / gl) * sp;
        ty = (gy / gl) * sp;
      }
      if (e.lungeCd <= 0 && canLunge && d > 1.6) {
        e.state = "windup";
        e.stateT = enraged ? 0.65 : C.BOSS_WINDUP;
        e.wx = nx;
        e.wy = ny;
        emit(s, "bossCharge", e.map, e.x, e.y, nx, ny);
      } else if (e.spitCd <= 0 && (d >= C.BOSS_LUNGE_RANGE || e.farT > 1.2)) {
        // the player is kiting or hiding behind a pillar: flush them out
        e.state = "spitWindup";
        e.stateT = C.BOSS_SPIT_WINDUP;
        emit(s, "spit", e.map, e.x, e.y);
      }
    }
  }
  const k = Math.min(1, accel * dt);
  e.vx += (tx - e.vx) * k;
  e.vy += (ty - e.vy) * k;
}

/** Lob a volley: one glob at where the player is heading, the rest bracketing them. */
function fireGlobs(s: GameState, e: Enemy, n: number) {
  const p = s.player;
  const lead = 0.45;
  const ax = p.x + p.vx * lead, ay = p.y + p.vy * lead;
  for (let i = 0; i < n; i++) {
    let tx = ax, ty = ay;
    if (i > 0) {
      const a = ((i - 1) / (n - 1)) * Math.PI * 2 + rand(s) * 0.8;
      const r = 1.7 + rand(s) * 0.6;
      tx += Math.cos(a) * r;
      ty += Math.sin(a) * r;
    }
    // keep landing spots on open floor
    tx = Math.max(1.3, Math.min(14.7, tx));
    ty = Math.max(1.3, Math.min(GATE_ROW - 0.3, ty));
    const g: Glob = { id: s.nextId++, x0: e.x, y0: e.y, tx, ty, t: 0, dur: C.GLOB_FLIGHT + i * 0.12 };
    s.globs.push(g);
  }
  emit(s, "spit", e.map, e.x, e.y, 1, 0);
}

/** Burst hit test: the hero's centre within splash radius + half their body. */
export function globHits(px: number, py: number, gx: number, gy: number): boolean {
  return len(px - gx, py - gy) < C.GLOB_SPLASH_R + C.PLAYER_R * 0.5;
}

function updateHazards(s: GameState, dt: number) {
  const p = s.player;
  const keep: Glob[] = [];
  for (const g of s.globs) {
    const wasFlying = g.t < g.dur;
    g.t += dt;
    if (wasFlying && g.t >= g.dur) emit(s, "globLand", "dungeon", g.tx, g.ty);
    if (g.t < g.dur + C.GLOB_FUSE) {
      keep.push(g);
      continue;
    }
    emit(s, "splash", "dungeon", g.tx, g.ty);
    if (p.map === "dungeon" && globHits(p.x, p.y, g.tx, g.ty)) hurtPlayer(s, C.GLOB_DMG, g.tx, g.ty);
    s.puddles.push({ id: s.nextId++, x: g.tx, y: g.ty, r: C.PUDDLE_R, life: C.PUDDLE_LIFE, max: C.PUDDLE_LIFE });
  }
  s.globs = keep;
  const pk: Puddle[] = [];
  for (const q of s.puddles) {
    q.life -= dt;
    if (q.life <= 0) continue;
    if (p.map === "dungeon" && len(p.x - q.x, p.y - q.y) < q.r + C.PLAYER_R * 0.5) hurtPlayer(s, C.GLOB_DMG, q.x, q.y);
    pk.push(q);
  }
  s.puddles = pk;
}

/** Player and enemies are solid to each other; also handles contact damage. */
function resolveBodies(s: GameState) {
  const p = s.player;
  const live = s.enemies.filter((e) => e.alive && e.map === p.map);
  for (let iter = 0; iter < 3; iter++) {
    // enemy ↔ enemy
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = len(dx, dy);
        const min = a.r + b.r;
        if (d < min) {
          const nx = d > 1e-5 ? dx / d : 1, ny = d > 1e-5 ? dy / d : 0;
          const push = (min - d) / 2 + 1e-3;
          moveBody(s, a, -nx * push, -ny * push, a.r * 0.85);
          moveBody(s, b, nx * push, ny * push, b.r * 0.85);
        }
      }
    // player ↔ enemy
    for (const e of live) {
      const dx = p.x - e.x, dy = p.y - e.y;
      const d = len(dx, dy);
      const min = C.PLAYER_R + e.r;
      if (d < min) {
        const nx = d > 1e-5 ? dx / d : 0, ny = d > 1e-5 ? dy / d : 1;
        const overlap = min - d + 1e-3;
        const pShare = e.kind === "boss" ? (e.state === "lunge" || e.state === "windup" ? 1 : 0.8) : 0.5;
        const before = { x: p.x, y: p.y };
        moveBody(s, p, nx * overlap * pShare, ny * overlap * pShare, C.PLAYER_R);
        const moved = len(p.x - before.x, p.y - before.y);
        moveBody(s, e, -nx * (overlap - moved), -ny * (overlap - moved), e.r * 0.85);
      }
    }
  }
  // contact damage
  for (const e of live) {
    if (e.kind === "boss" && !s.flags.bossAwake) continue;
    const d = len(p.x - e.x, p.y - e.y);
    if (e.state === "stunned") continue; // dazed boss is harmless to touch
    if (d < C.PLAYER_R + e.r + 0.08 && e.contactCd <= 0 && e.stun <= 0 && p.invuln <= 0) {
      e.contactCd = C.CONTACT_COOLDOWN;
      const dmg = e.kind !== "boss" ? 1 : e.state === "lunge" ? C.BOSS_LUNGE_DMG : C.BOSS_CONTACT_DMG;
      hurtPlayer(s, dmg, e.x, e.y);
    }
  }
}

// ───────────────────────────── pickups ─────────────────────────────
function updatePickups(s: GameState, dt: number) {
  const p = s.player;
  const keep: Pickup[] = [];
  for (const k of s.pickups) {
    k.life -= dt;
    if (k.life <= 0) continue;
    // little pop arc
    if (k.z > 0 || k.vz > 0) {
      k.vz -= 18 * dt;
      k.z += k.vz * dt;
      if (k.z <= 0) {
        k.z = 0;
        k.vz = Math.abs(k.vz) > 2 ? -k.vz * 0.35 : 0;
      }
    }
    const dx = p.x - k.x, dy = p.y - k.y;
    const d = len(dx, dy);
    if (k.map === p.map && d < C.MAGNET_RADIUS && s.phase === "playing") {
      const pull = 30 * (1 - d / C.MAGNET_RADIUS) + 6;
      k.vx += (dx / (d || 1)) * pull * dt;
      k.vy += (dy / (d || 1)) * pull * dt;
    } else {
      const f = Math.exp(-4 * dt);
      k.vx *= f;
      k.vy *= f;
    }
    moveBody(s, k, k.vx * dt, k.vy * dt, 0.15);
    if (k.map === p.map && d < 0.5 && s.phase === "playing") {
      if (k.kind === "rupee") {
        p.rupees += k.value;
        emit(s, "rupee", k.map, k.x, k.y);
      } else {
        p.hp = Math.min(p.maxHp, p.hp + 2);
        emit(s, "heart", k.map, k.x, k.y);
      }
      continue;
    }
    keep.push(k);
  }
  s.pickups = keep;
}

// ───────────────────────────── main step ─────────────────────────────
export function stepGame(s: GameState, input: InputState, dt = C.DT): GameState {
  if (s.phase !== "playing") return s;
  s.tick++;
  if (!s.flags.chestOpened) s.time += dt;

  if (s.victoryT >= 0) {
    // The hero holds the treasure aloft; the world keeps breathing but the player can't act.
    s.victoryT -= dt;
    updatePickups(s, dt);
    if (s.message) s.message.t -= dt;
    if (s.victoryT <= 0) {
      s.victoryT = 0;
      s.phase = "victory";
      emit(s, "victory", s.player.map, s.player.x, s.player.y);
    }
    return s;
  }

  updatePlayer(s, input, dt);
  updateEnemies(s, dt);
  resolveBodies(s);
  updateHazards(s, dt);
  updatePickups(s, dt);

  if (s.message) {
    s.message.t -= dt;
    if (s.message.t <= 0) s.message = null;
  }
  s.area = areaName(s.player.map, s.player.x, s.player.y);
  markExplored(s);
  return s;
}

export function markExplored(s: GameState) {
  const p = s.player;
  if (p.map === "over") {
    const sx = Math.min(2, Math.max(0, Math.floor(p.x / C.SCREEN_W)));
    const sy = Math.min(1, Math.max(0, Math.floor(p.y / C.SCREEN_H)));
    s.explored[sy * 3 + sx] = 1;
  } else s.explored[p.y < GATE_ROW + 0.5 ? 7 : 6] = 1;
}

export function startGame(s: GameState): GameState {
  s.phase = "playing";
  say(s, "Find the Hollow Sunstone hidden beneath Cinderstone Crags. (WASD to move · Space to swing)", 4.5);
  return s;
}
