/**
 * Navigation grid per map, maintained INCREMENTALLY from game state (derived data — never stored in
 * the serializable state, so a restored/cloned state just rebuilds it on first use).
 *
 * The overworld's six screens are one stitched 48×24 grid: edge tiles of one screen are ordinary
 * neighbours of the next, so A* / flow fields never know chunks exist. Static solids are baked once;
 * only the dynamic cells are patched afterwards: a pot breaking clears its cell, the vault gate
 * opening/closing flips its two cells. Each patch bumps `version`, which keys the flow-field cache.
 */
import { MAPS, Tile, isSolidTile, type MapId } from "./world";
import type { GameState } from "./types";
import type { Blocked } from "./path";

export interface NavGrid {
  map: MapId;
  w: number;
  h: number;
  /** 1 = blocked for walkers */
  cells: Uint8Array;
  /** static solids (gate excluded) */
  base: Uint8Array;
  gateCells: number[];
  potCount: Uint8Array;
  potAlive: Map<number, boolean>;
  potCell: Map<number, number>;
  gateClosed: boolean;
  /** state.worldVersion seen at the last sync (cheap "anything changed?" test) */
  seenWorld: number;
  version: number;
  fullBuilds: number;
  patches: number;
  blocked: Blocked;
}

const cache = new WeakMap<GameState, Partial<Record<MapId, NavGrid>>>();

function cellOf(g: NavGrid, i: number) {
  g.cells[i] = g.base[i] || g.potCount[i] > 0 || (g.gateClosed && g.gateCells.includes(i)) ? 1 : 0;
}

function build(s: GameState, map: MapId, gateClosed: boolean): NavGrid {
  const m = MAPS[map];
  const n = m.w * m.h;
  const base = new Uint8Array(n);
  const gateCells: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = m.tiles[i];
    if (t === Tile.GATE) gateCells.push(i);
    else if (isSolidTile(t, false)) base[i] = 1;
  }
  const cells = new Uint8Array(n);
  const g: NavGrid = {
    map, w: m.w, h: m.h, cells, base, gateCells, potCount: new Uint8Array(n), potAlive: new Map(), potCell: new Map(),
    gateClosed, seenWorld: s.worldVersion, version: 1, fullBuilds: 1, patches: 0,
    blocked: (tx, ty) => tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || cells[ty * m.w + tx] === 1,
  };
  for (const b of s.breakables) {
    if (b.kind !== "pot" || b.map !== map) continue;
    const i = Math.floor(b.y) * m.w + Math.floor(b.x);
    g.potCell.set(b.id, i);
    g.potAlive.set(b.id, b.alive);
    if (b.alive) g.potCount[i]++;
  }
  for (let i = 0; i < n; i++) cellOf(g, i);
  return g;
}

/** Current nav grid for `map`, patched for any pot/gate change since the last call. */
export function navGrid(s: GameState, map: MapId, gateClosed: boolean): NavGrid {
  let c = cache.get(s);
  if (!c) cache.set(s, (c = {}));
  let g = c[map];
  if (!g) return (c[map] = build(s, map, gateClosed));
  if (g.gateClosed !== gateClosed) {
    g.gateClosed = gateClosed;
    if (g.gateCells.length) {
      for (const i of g.gateCells) cellOf(g, i);
      g.version++;
      g.patches++;
    }
  }
  if (g.seenWorld !== s.worldVersion) {
    g.seenWorld = s.worldVersion;
    for (const b of s.breakables) {
      if (b.kind !== "pot" || b.map !== map) continue;
      const was = g.potAlive.get(b.id);
      if (was === b.alive) continue;
      let i = g.potCell.get(b.id);
      if (i === undefined) g.potCell.set(b.id, (i = Math.floor(b.y) * g.w + Math.floor(b.x)));
      g.potAlive.set(b.id, b.alive);
      g.potCount[i] = Math.max(0, g.potCount[i] + (b.alive ? 1 : -1));
      cellOf(g, i);
      g.version++;
      g.patches++;
    }
  }
  return g;
}

/** Per-tick pathfinding accounting (derived; for the budget and for tests/the perf overlay). */
export interface NavStats {
  tick: number;
  nodes: number;
  requests: number;
  fieldBuilds: number;
  /** most nodes / requests seen in any single tick so far */
  peakNodes: number;
  peakRequests: number;
}
const stats = new WeakMap<GameState, NavStats>();
export function navStats(s: GameState): NavStats {
  let st = stats.get(s);
  if (!st) stats.set(s, (st = { tick: s.tick, nodes: 0, requests: 0, fieldBuilds: 0, peakNodes: 0, peakRequests: 0 }));
  if (st.tick !== s.tick) {
    st.tick = s.tick;
    st.nodes = 0;
    st.requests = 0;
    st.fieldBuilds = 0;
  }
  return st;
}
export function chargeNav(s: GameState, nodes: number, request: boolean) {
  const st = navStats(s);
  st.nodes += nodes;
  if (request) st.requests++;
  st.peakNodes = Math.max(st.peakNodes, st.nodes);
  st.peakRequests = Math.max(st.peakRequests, st.requests);
}
