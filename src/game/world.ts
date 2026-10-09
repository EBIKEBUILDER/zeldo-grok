import { OVER_H, OVER_W, SCREEN_H, SCREEN_W } from "./constants";
import { makeRng } from "./rng";

export const Tile = {
  GRASS: 0,
  PATH: 1,
  FLOWERS: 2,
  WATER: 3,
  BRIDGE: 4,
  HEDGE: 5,
  TREE: 6,
  ROCK: 7,
  WALL: 8,
  FLOOR: 9,
  DOOR: 10,
  GATE: 11,
  BLOCK: 12, // solid, drawn by a decoration (e.g. the cottage)
} as const;
export type TileId = (typeof Tile)[keyof typeof Tile];

export type MapId = "over" | "dungeon";

export interface Decor {
  kind: "cottage" | "arch" | "torch" | "pedestal" | "chest" | "gate" | "sign" | "well";
  x: number;
  y: number;
  /** facing for wall-mounted things: direction into the room */
  dir?: number;
}

export interface MapData {
  id: MapId;
  w: number;
  h: number;
  tiles: Uint8Array;
  decor: Decor[];
}

export interface BreakableSpawn {
  kind: "tuft" | "pot";
  map: MapId;
  x: number;
  y: number;
}
export interface EnemySpawn {
  kind: "blob" | "boss";
  map: MapId;
  x: number;
  y: number;
}

const PERMA_SOLID = new Set<number>([Tile.WATER, Tile.HEDGE, Tile.TREE, Tile.ROCK, Tile.WALL, Tile.BLOCK]);
export function isSolidTile(t: number, gateClosed: boolean): boolean {
  if (t === Tile.GATE) return gateClosed;
  return PERMA_SOLID.has(t);
}

export function tileAt(map: MapData, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return map.id === "over" ? Tile.TREE : Tile.WALL;
  return map.tiles[ty * map.w + tx];
}

// ───────────────────────────── Key locations ─────────────────────────────
export const SPAWN = { x: 24, y: 18.6 };
/** Overworld doorway into the vault (2 tiles wide). */
export const OVER_DOOR = { x0: 23, x1: 24, y: 2 };
export const OVER_DOOR_EXIT = { x: 24, y: 4.1 };
export const DUNGEON_W = 16;
export const DUNGEON_H = 23;
export const DUNGEON_DOOR = { x0: 7, x1: 8, y: 22 };
export const DUNGEON_ENTRY = { x: 8, y: 20.4 };
export const GATE_ROW = 11;
export const GATE_X = [7, 8];
export const PEDESTAL = { x: 8, y: 15.6 };
export const CHEST = { x: 8, y: 2.6 };
export const BOSS_HOME = { x: 8, y: 5.6 };
/**
 * Nav portals: links between tiles that are NOT grid neighbours (the vault doorways). The overworld
 * itself is one stitched 48×24 grid, so screens need no portals. Pathfinding treats a portal as an
 * edge of `cost`; enemies only use it when `traversableByAI` (default false for dungeon mouths:
 * chasers give up at the entrance, classic Zelda leash). Chunk ids match `state.explored`
 * (overworld screens 0-5 = sy*3+sx, vault antechamber 6, Warden's hall 7).
 */
export interface Portal {
  id: number;
  fromMap: MapId;
  fromChunk: number;
  fromTile: { x: number; y: number };
  toMap: MapId;
  toChunk: number;
  toTile: { x: number; y: number };
  cost: number;
  traversableByAI: boolean;
}
export const PORTALS: Portal[] = [
  { id: 1, fromMap: "over", fromChunk: 1, fromTile: { x: 23, y: 2 }, toMap: "dungeon", toChunk: 6, toTile: { x: 7, y: 20 }, cost: 2, traversableByAI: false },
  { id: 2, fromMap: "over", fromChunk: 1, fromTile: { x: 24, y: 2 }, toMap: "dungeon", toChunk: 6, toTile: { x: 8, y: 20 }, cost: 2, traversableByAI: false },
  { id: 3, fromMap: "dungeon", fromChunk: 6, fromTile: { x: 7, y: 22 }, toMap: "over", toChunk: 1, toTile: { x: 23, y: 4 }, cost: 2, traversableByAI: false },
  { id: 4, fromMap: "dungeon", fromChunk: 6, fromTile: { x: 8, y: 22 }, toMap: "over", toChunk: 1, toTile: { x: 24, y: 4 }, cost: 2, traversableByAI: false },
];

/** Player crossing north of this line (inside the vault) wakes the boss. */
export const BOSS_TRIGGER_Y = 9.6;

export const AREA_NAMES = [
  ["Thistlewick Wood", "Cinderstone Crags", "Mirelight Pond"],
  ["Bramblebell Meadow", "Hearthollow", "Lanternfall Glade"],
];

export function areaName(map: MapId, x: number, y: number): string {
  if (map === "dungeon") return y < GATE_ROW + 0.5 ? "Mossgrave Vault · Warden's Hall" : "Mossgrave Vault · Antechamber";
  const sx = Math.min(2, Math.max(0, Math.floor(x / SCREEN_W)));
  const sy = Math.min(1, Math.max(0, Math.floor(y / SCREEN_H)));
  return AREA_NAMES[sy][sx];
}

// ───────────────────────────── Overworld builder ─────────────────────────────
function buildOverworld() {
  const w = OVER_W;
  const h = OVER_H;
  const tiles = new Uint8Array(w * h).fill(Tile.GRASS);
  const rnd = makeRng(20261008);
  const set = (x: number, y: number, t: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) tiles[y * w + x] = t;
  };
  const get = (x: number, y: number) => tiles[y * w + x];
  const rect = (x0: number, y0: number, x1: number, y1: number, t: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, t);
  };
  const protectedTiles = new Set<number>();
  const protect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) protectedTiles.add(y * w + x);
  };

  // Outer forest wall
  for (let x = 0; x < w; x++) {
    set(x, 0, Tile.TREE);
    set(x, h - 1, Tile.TREE);
  }
  for (let y = 0; y < h; y++) {
    set(0, y, Tile.TREE);
    set(w - 1, y, Tile.TREE);
  }

  // Screen dividers: hedgerows with gaps, so each screen feels like a "room".
  for (let y = 1; y < h - 1; y++) {
    if (!(y >= 17 && y <= 20) && !(y >= 6 && y <= 9)) set(15, y, Tile.HEDGE);
    if (!(y >= 17 && y <= 20) && !(y >= 7 && y <= 10)) set(32, y, Tile.HEDGE);
  }
  for (let x = 1; x < w - 1; x++) {
    if (!(x >= 22 && x <= 25) && !(x >= 4 && x <= 8) && !(x >= 43 && x <= 45)) set(x, 12, Tile.HEDGE);
  }

  // ── Hearthollow (home): sandy plaza and roads out in every direction
  rect(20, 16, 28, 20, Tile.PATH);
  rect(2, 18, 20, 19, Tile.PATH); // west road
  rect(28, 18, 45, 19, Tile.PATH); // east road
  rect(23, 3, 24, 16, Tile.PATH); // north road to the crags
  protect(19, 15, 29, 21);
  // cottage (3x2 footprint) with flower beds
  rect(17, 14, 19, 15, Tile.BLOCK);
  rect(17, 16, 19, 16, Tile.FLOWERS);
  rect(29, 14, 30, 15, Tile.FLOWERS);
  set(27, 14, Tile.BLOCK); // well

  // ── Thistlewick Wood: a winding trail through dense pines
  rect(5, 12, 6, 17, Tile.PATH);
  rect(5, 8, 6, 12, Tile.PATH);
  rect(6, 7, 11, 8, Tile.PATH);
  rect(10, 3, 11, 7, Tile.PATH);
  rect(11, 7, 15, 8, Tile.PATH); // east to the crags gap
  rect(16, 7, 22, 8, Tile.PATH);
  // clearing
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 7; x++) if ((x - 4.5) ** 2 / 6 + (y - 4) ** 2 / 3 <= 1) set(x, y, Tile.FLOWERS);
  protect(2, 2, 7, 6);

  // ── Mirelight Pond: an oval pond with a plank bridge, feeding a stream south
  for (let y = 1; y <= 10; y++)
    for (let x = 33; x <= 46; x++) {
      const d = (x + 0.5 - 40.5) ** 2 / 30 + (y + 0.5 - 5.5) ** 2 / 13;
      if (d <= 1) set(x, y, Tile.WATER);
    }
  rect(25, 8, 33, 9, Tile.PATH); // path from the north road to the pond
  rect(33, 5, 34, 9, Tile.PATH);
  for (let x = 35; x <= 46; x++) for (let y = 5; y <= 6; y++) if (get(x, y) === Tile.WATER) set(x, y, Tile.BRIDGE);
  rect(44, 3, 46, 8, Tile.PATH); // little landing on the far shore
  for (let y = 5; y <= 6; y++) for (let x = 35; x <= 46; x++) if (get(x, y) === Tile.GRASS) set(x, y, Tile.PATH);
  protect(33, 1, 46, 10);
  // stream
  for (let y = 9; y <= 22; y++) {
    const off = y > 15 ? 1 : 0;
    set(39 + off, y, Tile.WATER);
    set(40 + off, y, Tile.WATER);
  }
  for (let x = 38; x <= 42; x++) for (let y = 18; y <= 19; y++) if (get(x, y) === Tile.WATER) set(x, y, Tile.BRIDGE);
  set(43, 12, Tile.GRASS);
  set(44, 12, Tile.GRASS);
  set(45, 12, Tile.GRASS);

  // ── Cinderstone Crags: a rocky bowl with the vault doorway carved into the north cliff
  rect(17, 1, 30, 1, Tile.ROCK);
  rect(18, 2, 22, 3, Tile.ROCK);
  rect(25, 2, 29, 3, Tile.ROCK);
  set(23, 1, Tile.ROCK);
  set(24, 1, Tile.ROCK);
  set(OVER_DOOR.x0, OVER_DOOR.y, Tile.DOOR);
  set(OVER_DOOR.x1, OVER_DOOR.y, Tile.DOOR);
  set(23, 3, Tile.PATH);
  set(24, 3, Tile.PATH);
  protect(21, 2, 26, 9);

  // Scatter per area
  const scatter = (x0: number, y0: number, x1: number, y1: number, t: number, p: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (tiles[i] !== Tile.GRASS || protectedTiles.has(i)) continue;
        // keep a breathing gap next to paths
        let nearPath = false;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = tiles[ny * w + nx];
            if (n === Tile.PATH || n === Tile.BRIDGE || n === Tile.DOOR) nearPath = true;
          }
        if (nearPath && t !== Tile.FLOWERS) continue;
        if (rnd() < p) tiles[i] = t;
      }
  };
  scatter(1, 1, 14, 11, Tile.TREE, 0.55); // wood
  scatter(1, 1, 14, 11, Tile.FLOWERS, 0.05);
  scatter(16, 1, 31, 11, Tile.ROCK, 0.2); // crags
  scatter(33, 1, 46, 11, Tile.TREE, 0.12); // pond shore
  scatter(33, 1, 46, 11, Tile.FLOWERS, 0.12);
  scatter(1, 13, 14, 22, Tile.FLOWERS, 0.26); // meadow
  scatter(1, 13, 14, 22, Tile.ROCK, 0.03);
  scatter(16, 13, 31, 22, Tile.FLOWERS, 0.08); // home
  scatter(16, 13, 31, 22, Tile.TREE, 0.06);
  scatter(33, 13, 46, 22, Tile.TREE, 0.3); // glade
  scatter(33, 13, 46, 22, Tile.FLOWERS, 0.1);

  // Clear enemy homes so nobody spawns inside a tree
  for (const e of OVER_ENEMIES)
    for (let y = Math.floor(e.y) - 1; y <= Math.floor(e.y) + 1; y++)
      for (let x = Math.floor(e.x) - 1; x <= Math.floor(e.x) + 1; x++) {
        const t = get(x, y);
        if (t === Tile.TREE || t === Tile.ROCK) set(x, y, Tile.GRASS);
      }

  const decor: Decor[] = [
    { kind: "cottage", x: 18.5, y: 15 },
    { kind: "well", x: 27.5, y: 14.5 },
    { kind: "arch", x: 24, y: 2.5 },
    { kind: "sign", x: 21.4, y: 4.3 },
  ];
  return { tiles, decor };
}

// Enemy homes in the overworld — every one sits well outside the spawn sanctuary.
export const OVER_ENEMIES: EnemySpawn[] = [
  { kind: "blob", map: "over", x: 4.5, y: 15.5 },
  { kind: "blob", map: "over", x: 10.5, y: 21 },
  { kind: "blob", map: "over", x: 3.5, y: 9.5 },
  { kind: "blob", map: "over", x: 12.5, y: 4.5 },
  { kind: "blob", map: "over", x: 19.5, y: 5.5 },
  { kind: "blob", map: "over", x: 28.5, y: 5.5 },
  { kind: "blob", map: "over", x: 44.5, y: 10.5 },
  { kind: "blob", map: "over", x: 36.5, y: 15.5 },
  { kind: "blob", map: "over", x: 44.5, y: 21 },
];

const over = buildOverworld();
export const OVERWORLD: MapData = { id: "over", w: OVER_W, h: OVER_H, tiles: over.tiles, decor: over.decor };

// ───────────────────────────── Dungeon builder ─────────────────────────────
function buildDungeon(): MapData {
  const w = DUNGEON_W;
  const h = DUNGEON_H;
  const tiles = new Uint8Array(w * h).fill(Tile.WALL);
  const rect = (x0: number, y0: number, x1: number, y1: number, t: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles[y * w + x] = t;
  };
  rect(1, 1, 14, 10, Tile.FLOOR); // Warden's Hall (boss)
  rect(1, 12, 14, 21, Tile.FLOOR); // Antechamber
  for (const x of GATE_X) tiles[GATE_ROW * w + x] = Tile.GATE;
  rect(DUNGEON_DOOR.x0, DUNGEON_DOOR.y, DUNGEON_DOOR.x1, DUNGEON_DOOR.y, Tile.DOOR);
  // pillars
  for (const [x, y] of [
    [3, 3], [12, 3], [3, 8], [12, 8],
    [3, 14], [12, 14], [3, 18], [12, 18],
  ])
    tiles[y * w + x] = Tile.WALL;

  const decor: Decor[] = [
    { kind: "pedestal", x: PEDESTAL.x, y: PEDESTAL.y },
    { kind: "chest", x: CHEST.x, y: CHEST.y },
    { kind: "gate", x: 8, y: GATE_ROW + 0.5 },
  ];
  // torches on the east/west walls of both rooms, plus flanking the gate
  for (const y of [2.5, 6, 9.5, 13.5, 17, 20.5]) {
    decor.push({ kind: "torch", x: 1.05, y, dir: 0 });
    decor.push({ kind: "torch", x: 14.95, y, dir: Math.PI });
  }
  decor.push({ kind: "torch", x: 5.5, y: GATE_ROW + 1.05, dir: -Math.PI / 2 });
  decor.push({ kind: "torch", x: 10.5, y: GATE_ROW + 1.05, dir: -Math.PI / 2 });
  return { id: "dungeon", w, h, tiles, decor };
}
export const DUNGEON = buildDungeon();

export const DUNGEON_ENEMIES: EnemySpawn[] = [
  { kind: "blob", map: "dungeon", x: 2.5, y: 12.8 },
  { kind: "blob", map: "dungeon", x: 13.5, y: 12.8 },
  { kind: "boss", map: "dungeon", x: BOSS_HOME.x, y: BOSS_HOME.y },
];

export const MAPS: Record<MapId, MapData> = { over: OVERWORLD, dungeon: DUNGEON };

// ───────────────────────────── Breakables ─────────────────────────────
function buildBreakables(): BreakableSpawn[] {
  const out: BreakableSpawn[] = [];
  const rnd = makeRng(777);
  const m = OVERWORLD;
  // grass tufts in clusters around the overworld
  const clusters: [number, number, number][] = [
    [8, 15, 7], [3, 20, 5], [12, 19, 5], [10, 14, 4], // meadow
    [4, 4, 5], [8, 10, 3], // wood
    [20, 10, 4], [29, 9, 3], // crags
    [37, 9, 3], [43, 2, 3], // pond
    [35, 21, 5], [45, 15, 4], [42, 21, 3], // glade
    [17, 21, 3], [30, 21, 3], [18, 18, 2], // home
  ];
  for (const [cx, cy, n] of clusters) {
    for (let i = 0; i < n; i++) {
      const x = cx + (rnd() - 0.5) * 3.2;
      const y = cy + (rnd() - 0.5) * 2.4;
      const t = tileAt(m, Math.floor(x), Math.floor(y));
      if (t !== Tile.GRASS && t !== Tile.FLOWERS) continue;
      if (Math.hypot(x - SPAWN.x, y - SPAWN.y) < 2.5) continue;
      if (out.some((o) => Math.hypot(o.x - x, o.y - y) < 0.7)) continue;
      out.push({ kind: "tuft", map: "over", x, y });
    }
  }
  const pots: [number, number][] = [
    [21.5, 16.6], [26.6, 16.5], [16.6, 19.6], // home porch
    [45.3, 3.6], [45.6, 7.6], // far shore of the pond
    [3.2, 2.8], [6.6, 2.6], // wood clearing
    [34, 14], [46, 13.6], // glade
    [1.8, 13.6], // meadow corner
    [20.2, 4.6], [27.8, 4.6], // vault approach
  ];
  for (const [x, y] of pots) {
    const i = Math.floor(y) * m.w + Math.floor(x);
    if (isSolidTile(m.tiles[i], true)) m.tiles[i] = Tile.GRASS;
    out.push({ kind: "pot", map: "over", x, y });
  }
  for (const [x, y] of [[1.7, 21.2], [14.3, 21.2], [1.7, 12.7], [14.3, 12.7], [1.7, 1.7], [14.3, 1.7]] as [number, number][])
    out.push({ kind: "pot", map: "dungeon", x, y });
  return out;
}
export const BREAKABLES: BreakableSpawn[] = buildBreakables();
