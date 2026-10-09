/**
 * Grid pathfinding for enemies (pure, deterministic, allocation-light).
 *
 *  - Flow field: Dijkstra from the player's tile outward (8-dir, no corner cutting, small
 *    penalty for hugging walls). One field per map is shared by every enemy on it and is only
 *    rebuilt when the player changes tile / the world changes, at most every FIELD_MIN_TICKS.
 *    Expansion is capped by cost (FIELD_MAX_COST) and node count (FIELD_MAX_NODES).
 *  - A*: used once when an enemy gives up and walks home (capped at ASTAR_MAX_NODES).
 */
export const FIELD_MAX_COST = 36;
export const FIELD_MAX_NODES = 1400;
export const FIELD_MIN_TICKS = 4;
export const ASTAR_MAX_NODES = 900;
const WALL_PENALTY = 0.5;
const D1 = 1;
const D2 = Math.SQRT2;
const DIRS: [number, number, number][] = [
  [1, 0, D1], [-1, 0, D1], [0, 1, D1], [0, -1, D1],
  [1, 1, D2], [1, -1, D2], [-1, 1, D2], [-1, -1, D2],
];

export type Blocked = (tx: number, ty: number) => boolean;

/** Min-heap keyed by float priority (parallel arrays, no per-push allocation). */
class Heap {
  private ids: number[] = [];
  private pri: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, p: number) {
    const ids = this.ids, pri = this.pri;
    let i = ids.length;
    ids.push(id);
    pri.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      ids[i] = ids[parent];
      pri[i] = pri[parent];
      i = parent;
    }
    ids[i] = id;
    pri[i] = p;
  }
  pop(): number {
    const ids = this.ids, pri = this.pri;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastP = pri.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        let mp = lastP;
        if (l < n && pri[l] < mp) (m = l), (mp = pri[l]);
        if (r < n && pri[r] < mp) m = r;
        if (m === i) break;
        ids[i] = ids[m];
        pri[i] = pri[m];
        i = m;
      }
      ids[i] = lastId;
      pri[i] = lastP;
    }
    return top;
  }
}

function nearWall(blocked: Blocked, x: number, y: number) {
  return blocked(x + 1, y) || blocked(x - 1, y) || blocked(x, y + 1) || blocked(x, y - 1);
}

/** Can we step from (x,y) by (dx,dy)? Diagonals need both orthogonal neighbours open. */
export function canStep(blocked: Blocked, x: number, y: number, dx: number, dy: number) {
  if (blocked(x + dx, y + dy)) return false;
  if (dx !== 0 && dy !== 0 && (blocked(x + dx, y) || blocked(x, y + dy))) return false;
  return true;
}

export interface FlowField {
  w: number;
  h: number;
  ox: number;
  oy: number;
  dist: Float32Array;
  nodes: number;
}

export function buildField(w: number, h: number, blocked: Blocked, ox: number, oy: number): FlowField {
  const dist = new Float32Array(w * h).fill(Infinity);
  const field: FlowField = { w, h, ox, oy, dist, nodes: 0 };
  if (ox < 0 || oy < 0 || ox >= w || oy >= h) return field;
  const heap = new Heap();
  const start = oy * w + ox;
  dist[start] = 0;
  heap.push(start, 0);
  const done = new Uint8Array(w * h);
  while (heap.size && field.nodes < FIELD_MAX_NODES) {
    const id = heap.pop();
    if (done[id]) continue;
    done[id] = 1;
    field.nodes++;
    const d = dist[id];
    if (d > FIELD_MAX_COST) break;
    const x = id % w, y = (id / w) | 0;
    for (const [dx, dy, c] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      // the origin tile may itself be "blocked" (e.g. player brushing a pot) — still expand from it
      if (!canStep(blocked, x, y, dx, dy)) continue;
      const nid = ny * w + nx;
      const nd = d + c + (nearWall(blocked, nx, ny) ? WALL_PENALTY : 0);
      if (nd < dist[nid]) {
        dist[nid] = nd;
        heap.push(nid, nd);
      }
    }
  }
  return field;
}

export function fieldAt(f: FlowField, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= f.w || ty >= f.h) return Infinity;
  return f.dist[ty * f.w + tx];
}

/** Next tile downhill from (tx,ty), or null at a local minimum / unreachable. */
export function descend(f: FlowField, blocked: Blocked, tx: number, ty: number): [number, number] | null {
  let best = fieldAt(f, tx, ty);
  let bx = -1, by = -1;
  for (const [dx, dy] of DIRS) {
    const nx = tx + dx, ny = ty + dy;
    const v = fieldAt(f, nx, ny);
    if (v < best && canStep(blocked, tx, ty, dx, dy)) {
      best = v;
      bx = nx;
      by = ny;
    }
  }
  return bx < 0 ? null : [bx, by];
}

/** A* from (sx,sy) to (gx,gy). Returns tile indices (excluding start), or null if none within budget. */
export function astar(w: number, h: number, blocked: Blocked, sx: number, sy: number, gx: number, gy: number): number[] | null {
  if (sx === gx && sy === gy) return [];
  const g = new Float32Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const heap = new Heap();
  const hfn = (x: number, y: number) => {
    const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
    return D1 * (dx + dy) + (D2 - 2 * D1) * Math.min(dx, dy);
  };
  const start = sy * w + sx, goal = gy * w + gx;
  g[start] = 0;
  heap.push(start, hfn(sx, sy));
  let n = 0;
  while (heap.size && n < ASTAR_MAX_NODES) {
    const id = heap.pop();
    if (closed[id]) continue;
    closed[id] = 1;
    n++;
    if (id === goal) {
      const out: number[] = [];
      for (let c = goal; c !== start; c = came[c]) out.push(c);
      return out.reverse();
    }
    const x = id % w, y = (id / w) | 0;
    for (const [dx, dy, c] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!canStep(blocked, x, y, dx, dy)) continue;
      const nid = ny * w + nx;
      const ng = g[id] + c;
      if (ng < g[nid]) {
        g[nid] = ng;
        came[nid] = id;
        heap.push(nid, ng + hfn(nx, ny));
      }
    }
  }
  return null;
}
