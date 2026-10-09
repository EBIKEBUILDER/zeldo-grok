import { afterEach, describe, expect, it } from "vitest";
import { boxHitsSolid, contactRange, gateClosed, playerField, stepGame, yawOf } from "@/game/sim";
import { NAV_MAX_REQUESTS_PER_TICK, NAV_TICK_NODES, fieldAt } from "@/game/path";
import { navGrid, navStats } from "@/game/nav";
import { BLOB_GIVEUP, CONTACT_COOLDOWN, SAFE_RADIUS, SCREEN_H, SCREEN_W } from "@/game/constants";
import { GATE_ROW, GATE_X, MAPS, OVER_DOOR, PORTALS, SPAWN, Tile, isSolidTile, tileAt } from "@/game/world";
import type { Enemy, GameState } from "@/game/types";
import { fresh, idle, run } from "./helpers";

const blobs = (s: GameState) => s.enemies.filter((e) => e.kind === "blob");
function only(s: GameState, keep: Enemy[]) {
  for (const e of blobs(s)) if (!keep.includes(e)) (e.alive = false), (e.respawnT = 1e9);
}
function place(e: Enemy, x: number, y: number) {
  e.x = e.homeX = x; e.y = e.homeY = y; e.vx = e.vy = 0;
}
function chase(e: Enemy) {
  e.state = "chase"; e.stuckT = 0; e.sampleT = 0; e.sampleX = e.x; e.sampleY = e.y;
}
const screen = (x: number, y: number) => Math.floor(y / SCREEN_H) * 3 + Math.floor(x / SCREEN_W);
/** an open 7×7 grass patch, away from the sanctuary */
function openSpot(): [number, number] {
  for (let y = 4; y < 20; y++)
    for (let x = 4; x < 44; x++) {
      let ok = Math.hypot(x + 0.5 - SPAWN.x, y + 0.5 - SPAWN.y) > 10;
      for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3 && ok; dx++) if (isSolidTile(tileAt(MAPS.over, x + dx, y + dy), true)) ok = false;
      if (ok) return [x + 0.5, y + 0.5];
    }
  throw new Error("no open spot");
}
function clearPots(s: GameState, x: number, y: number, r: number) {
  for (const b of s.breakables) if (Math.hypot(b.x - x, b.y - y) < r) b.alive = false;
  s.worldVersion++;
}
/** walk the hero onto the vault doorway and through it */
function enterVault(s: GameState) {
  s.player.x = OVER_DOOR.x1 + 0.5; s.player.y = OVER_DOOR.y + 1.6;
  for (let i = 0; i < 90 && s.player.map === "over"; i++) stepGame(s, { ...idle(), up: true });
  expect(s.player.map).toBe("dungeon");
}

afterEach(() => {
  for (const q of PORTALS) q.traversableByAI = false;
});

describe("cross-screen navigation", () => {
  it("a chaser follows the hero across an overworld screen boundary", () => {
    const s = fresh();
    const e = blobs(s).find((b) => b.homeX === 19.5)!; // Cinderstone Crags (screen 1)
    only(s, [e]);
    s.player.invuln = 1e9;
    s.player.x = 21.5; s.player.y = 5.5;
    run(s, {}, 20);
    expect(e.state).toBe("chase");
    expect(screen(e.x, e.y)).toBe(1);
    // west through the hedge gap at x=15 (y 6..9) into Thistlewick Wood (screen 0), at chase pace
    for (let i = 0; i < 60 * 9; i++) {
      const go = i % 5 < 2;
      const inp = idle();
      if (go) {
        if (s.player.y < 7.3) inp.down = true;
        else if (s.player.x > 9.5) inp.left = true;
      }
      stepGame(s, inp);
    }
    expect(screen(s.player.x, s.player.y)).toBe(0);
    expect(screen(e.x, e.y)).toBe(0);
    expect(e.state).toBe("chase");
    expect(Math.hypot(e.x - s.player.x, e.y - s.player.y)).toBeLessThan(contactRange(e) + 0.3);
  });

  it("the overworld is one stitched grid: the flow field is continuous across every screen seam", () => {
    const s = fresh();
    s.player.x = 21.5; s.player.y = 7.5; s.tick += 10;
    const f = playerField(s, "over").field;
    // tiles straight across the x=15/16 and x=31/32 seams and the y=11/12 seam through the gaps
    expect(fieldAt(f, 14, 7)).toBeLessThan(Infinity);
    expect(fieldAt(f, 16, 7)).toBeLessThan(Infinity);
    expect(fieldAt(f, 33, 8)).toBeLessThan(Infinity);
    expect(fieldAt(f, 23, 13)).toBeLessThan(Infinity);
  });
});

describe("portals", () => {
  function doorChaser() {
    const s = fresh();
    const e = blobs(s)[0];
    only(s, [e]);
    place(e, 24.5, 6.5);
    s.player.invuln = 1e9;
    s.player.x = 24.5; s.player.y = 4.5;
    chase(e);
    return { s, e };
  }

  it("traversableByAI=false: the chaser stops at the vault mouth (no jitter), then gives up and goes home", () => {
    const { s, e } = doorChaser();
    enterVault(s);
    const trail: [number, number][] = [];
    let gaveUpAt = -1;
    for (let i = 0; i < 60 * 14; i++) {
      stepGame(s, idle());
      trail.push([e.x, e.y]);
      if (gaveUpAt < 0 && e.state === "return") gaveUpAt = i;
    }
    expect(e.map).toBe("over");
    expect(gaveUpAt).toBeGreaterThan(0);
    expect(gaveUpAt / 60).toBeLessThan(BLOB_GIVEUP + 4);
    // it got right up to the entrance before giving up...
    const [ax, ay] = trail[gaveUpAt - 1];
    expect(Math.hypot(ax - (OVER_DOOR.x1 + 0.5), ay - (OVER_DOOR.y + 0.5))).toBeLessThan(2.2);
    // ...and stood still there (no vibrating against the door frame) for the last 2 s
    let path = 0;
    for (let i = gaveUpAt - 120; i < gaveUpAt - 1; i++) path += Math.hypot(trail[i + 1][0] - trail[i][0], trail[i + 1][1] - trail[i][1]);
    expect(path).toBeLessThan(0.25);
    // and made it home afterwards
    const homeBest = Math.min(...trail.slice(gaveUpAt).map(([x, y]) => Math.hypot(x - e.homeX, y - e.homeY)));
    expect(homeBest).toBeLessThan(0.5);
  });

  it("traversableByAI=true (test-only): the chaser follows through the portal, then walks home through it", () => {
    for (const q of PORTALS) q.traversableByAI = true;
    const { s, e } = doorChaser();
    enterVault(s);
    run(s, { up: true }, 25); // a couple of tiles into the antechamber
    let reached = false;
    for (let i = 0; i < 60 * 8 && !reached; i++) {
      stepGame(s, idle());
      reached = e.map === "dungeon" && Math.hypot(e.x - s.player.x, e.y - s.player.y) < contactRange(e) + 0.3;
    }
    expect(e.map).toBe("dungeon");
    expect(reached).toBe(true);
    // send it home: it must find the door back to the overworld
    e.stuckT = 99;
    for (let i = 0; i < 60 * 15 && !(e.map === "over" && e.state !== "return"); i++) stepGame(s, idle());
    expect(e.map).toBe("over");
    expect(Math.hypot(e.x - e.homeX, e.y - e.homeY)).toBeLessThan(1);
  });
});

describe("no-path fallback", () => {
  it("walks to the closest reachable tile, holds still (no oscillation), then gives up", () => {
    const s = fresh();
    const [px, py] = openSpot();
    clearPots(s, px, py, 6);
    const e = blobs(s)[0];
    only(s, [e]);
    s.player.invuln = 1e9;
    s.player.x = px; s.player.y = py;
    // wall the hero in with a ring of pots: no route to them at all
    let id = 9000;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) s.breakables.push({ id: id++, kind: "pot", map: "over", x: px + dx, y: py + dy, alive: true });
    s.worldVersion++;
    place(e, px + 4, py + 0.2);
    chase(e);
    const trail: [number, number][] = [];
    let gaveUpAt = -1;
    for (let i = 0; i < 60 * 10 && gaveUpAt < 0; i++) {
      s.player.x = px; s.player.y = py; s.player.vx = s.player.vy = 0;
      stepGame(s, idle());
      trail.push([e.x, e.y]);
      if (e.state === "return") gaveUpAt = i;
    }
    expect(gaveUpAt).toBeGreaterThan(0);
    // it came up to the ring...
    const [ax, ay] = trail[gaveUpAt - 1];
    expect(Math.hypot(ax - px, ay - py)).toBeLessThan(2.4);
    // ...and then stood still: over the last 3 s before giving up it barely moved and never reversed
    let path = 0, flips = 0, lastSign = 0;
    for (let i = gaveUpAt - 180; i < gaveUpAt - 1; i++) {
      const dx = trail[i + 1][0] - trail[i][0];
      path += Math.hypot(dx, trail[i + 1][1] - trail[i][1]);
      const sg = Math.abs(dx) > 1e-4 ? Math.sign(dx) : 0;
      if (sg && lastSign && sg !== lastSign) flips++;
      if (sg) lastSign = sg;
    }
    expect(path).toBeLessThan(0.3);
    expect(flips).toBeLessThan(3);
  });
});

describe("pathfinding budget", () => {
  it("twelve monsters repathing on the same tick are time-sliced within the per-tick cap", () => {
    const s = fresh();
    const base = blobs(s);
    // top up to 12 chasers
    let id = 500;
    while (blobs(s).length < 12) {
      const src = base[blobs(s).length % base.length];
      s.enemies.push({ ...src, id: id++, path: [], x: src.x + 0.3, y: src.y + 0.3 });
    }
    const all = blobs(s);
    for (const e of all) chase(e);
    stepGame(s, idle());
    // everyone gives up at once → 12 walk-home requests on one tick
    for (const e of all) if (e.state === "chase") e.stuckT = 99;
    stepGame(s, idle());
    const pending = () => all.filter((e) => e.alive && e.navReq !== 0).length;
    const start = pending();
    expect(start).toBeGreaterThan(NAV_MAX_REQUESTS_PER_TICK);
    let ticks = 0;
    while (pending() > 0 && ticks < 20) {
      stepGame(s, idle());
      ticks++;
      const st = navStats(s);
      expect(st.requests).toBeLessThanOrEqual(NAV_MAX_REQUESTS_PER_TICK);
      expect(st.nodes).toBeLessThanOrEqual(NAV_TICK_NODES);
    }
    expect(pending()).toBe(0);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(start / NAV_MAX_REQUESTS_PER_TICK) + 2);
    expect(navStats(s).peakNodes).toBeLessThanOrEqual(NAV_TICK_NODES);
    expect(navStats(s).peakRequests).toBeLessThanOrEqual(NAV_MAX_REQUESTS_PER_TICK);
  });
});

describe("nav grid rebuilds", () => {
  it("a broken pot frees its cell incrementally and the field routes through it", () => {
    const s = fresh();
    const pot = s.breakables.find((b) => b.kind === "pot" && b.map === "over")!;
    const g0 = navGrid(s, "over", gateClosed(s));
    const cell = Math.floor(pot.y) * g0.w + Math.floor(pot.x);
    expect(g0.cells[cell]).toBe(1);
    const v0 = g0.version;
    s.player.x = pot.x + 1.5; s.player.y = pot.y; s.tick += 10;
    expect(fieldAt(playerField(s, "over").field, Math.floor(pot.x), Math.floor(pot.y))).toBe(Infinity);
    pot.alive = false;
    s.worldVersion++;
    const g1 = navGrid(s, "over", gateClosed(s));
    expect(g1).toBe(g0); // patched in place, not rebuilt
    expect(g1.cells[cell]).toBe(0);
    expect(g1.version).toBe(v0 + 1);
    expect(g1.fullBuilds).toBe(1);
    s.tick += 10;
    expect(fieldAt(playerField(s, "over").field, Math.floor(pot.x), Math.floor(pot.y))).toBeLessThan(Infinity);
  });

  it("the vault gate opening/closing flips its cells and the field follows", () => {
    const s = fresh();
    s.player.map = "dungeon"; s.player.x = 8; s.player.y = GATE_ROW - 2.5; s.tick += 10;
    const below = () => fieldAt(playerField(s, "dungeon").field, GATE_X[0], GATE_ROW + 2);
    const g = navGrid(s, "dungeon", true);
    expect(g.cells[GATE_ROW * g.w + GATE_X[0]]).toBe(1);
    expect(below()).toBe(Infinity);
    s.flags.gateOpen = true;
    s.tick += 10;
    expect(below()).toBeLessThan(Infinity);
    expect(navGrid(s, "dungeon", false).cells[GATE_ROW * g.w + GATE_X[0]]).toBe(0);
    expect(navGrid(s, "dungeon", false).fullBuilds).toBe(1);
  });
});

describe("contact damage", () => {
  it("a chasing blob that reaches an idle hero deals damage within its cooldown", () => {
    const s = fresh();
    const [px, py] = openSpot();
    clearPots(s, px, py, 5);
    const e = blobs(s)[0];
    only(s, [e]);
    s.player.x = px; s.player.y = py; s.player.invuln = 0;
    place(e, px + 3, py);
    chase(e);
    const reachT = (3 - contactRange(e)) / 2.1;
    let firstHit = -1;
    let hits = 0, lastHp = s.player.hp;
    for (let i = 0; i < 60 * 6; i++) {
      stepGame(s, idle());
      if (s.player.hp < lastHp) {
        hits++;
        if (firstHit < 0) firstHit = i / 60;
      }
      lastHp = s.player.hp;
    }
    expect(firstHit).toBeGreaterThan(0);
    expect(firstHit).toBeLessThan(reachT + CONTACT_COOLDOWN);
    expect(hits).toBeGreaterThanOrEqual(2); // and keeps hitting once its cooldown/i-frames are up
  });

  it("several blobs around the hero each land hits (no starvation in a crowd)", () => {
    const s = fresh();
    const [px, py] = openSpot();
    clearPots(s, px, py, 5);
    const crowd = blobs(s).slice(0, 4);
    only(s, crowd);
    s.player.maxHp = s.player.hp = 1000;
    crowd.forEach((b, i) => {
      const a = (i / crowd.length) * Math.PI * 2 + 0.4;
      place(b, px + Math.cos(a) * 2, py + Math.sin(a) * 2);
      chase(b);
    });
    const hits = crowd.map(() => 0);
    const prev = crowd.map(() => 0);
    for (let i = 0; i < 60 * 10; i++) {
      stepGame(s, idle());
      s.player.x = px; s.player.y = py; s.player.vx = s.player.vy = 0; // the hero stands their ground
      crowd.forEach((b, k) => {
        if (b.contactCd > prev[k] + 0.5) hits[k]++;
        prev[k] = b.contactCd;
      });
    }
    for (const h of hits) expect(h).toBeGreaterThanOrEqual(1);
    for (const b of crowd) expect(Math.hypot(b.x - px, b.y - py)).toBeLessThan(contactRange(b));
  });

  it("a chaser hot on the hero's heels turns back cleanly at the spawn bubble (no edge loitering/jitter)", () => {
    const s = fresh();
    const e = blobs(s)[0];
    only(s, [e]);
    // hero walks west along the east road into the bubble with a blob right behind them
    place(e, SPAWN.x + 7.2, SPAWN.y);
    s.player.x = SPAWN.x + 6; s.player.y = SPAWN.y; s.player.invuln = 1e9;
    chase(e);
    run(s, {}, 5);
    s.player.invuln = 0;
    let brokeOff = -1, settled = -1, minSpawnD = Infinity, closest = Infinity, rechased = false;
    const dist: number[] = [];
    for (let i = 0; i < 60 * 6; i++) {
      const inside = Math.hypot(s.player.x - SPAWN.x, s.player.y - SPAWN.y) < SAFE_RADIUS - 0.5;
      stepGame(s, { ...idle(), left: !inside && i % 5 < 2 }); // chase pace, so the blob stays close
      const d = Math.hypot(e.x - SPAWN.x, e.y - SPAWN.y);
      minSpawnD = Math.min(minSpawnD, d);
      dist.push(d);
      if (brokeOff < 0 && e.state === "return") brokeOff = i;
      if (brokeOff < 0) closest = Math.min(closest, Math.hypot(e.x - s.player.x, e.y - s.player.y));
      if (brokeOff >= 0 && settled < 0 && e.state !== "return") settled = i;
      if (brokeOff >= 0 && e.state === "chase") rechased = true;
    }
    expect(brokeOff).toBeGreaterThanOrEqual(0);
    // never inside the bubble, and once it broke off it walked away: no edge-hugging back-and-forth
    expect(minSpawnD).toBeGreaterThan(SAFE_RADIUS + e.r - 0.01);
    expect(closest).toBeLessThan(1.5); // it really was on the hero's heels
    expect(rechased).toBe(false);
    // from the break-off until it is home it only walks away — no edge-hugging back-and-forth
    expect(settled).toBeGreaterThan(brokeOff);
    let approaches = 0;
    for (let i = brokeOff + 20; i < settled - 1; i++) if (dist[i + 1] < dist[i] - 1e-3) approaches++;
    expect(approaches).toBeLessThan(5);
    // the hero idling inside the bubble takes no damage after stepping in
    const hp = s.player.hp;
    run(s, {}, 60 * 10);
    expect(s.player.hp).toBe(hp);
  });
});

describe("returning home", () => {
  const angDiff = (a: number, b: number) => {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };
  /** a hedge tile on the y=12 divider with open ground on both sides and a real detour */
  function hedgeSpot(s: GameState): number {
    for (let x = 2; x < 46; x++) {
      if (tileAt(MAPS.over, x, 12) === Tile.HEDGE && !isSolidTile(tileAt(MAPS.over, x, 11), true) && !isSolidTile(tileAt(MAPS.over, x, 13), true) && Math.hypot(x + 0.5 - SPAWN.x, 13.5 - SPAWN.y) > 9) {
        s.player.x = x + 0.5; s.player.y = 13.5; s.tick += 10;
        const fd = fieldAt(playerField(s, "over").field, x, 11);
        if (fd > 4 && fd < 14) return x;
      }
    }
    throw new Error("no hedge spot");
  }

  it("walks home on a pathfound route around a hedge (never into it), facing where it walks", () => {
    const s = fresh();
    const e = blobs(s)[0];
    only(s, [e]);
    const x = hedgeSpot(s);
    // home is just across the hedge; the hero is far away so it won't re-aggro
    e.homeX = x + 0.5; e.homeY = 13.5;
    e.x = x + 0.5; e.y = 11.5; e.vx = e.vy = 0;
    s.player.x = SPAWN.x; s.player.y = SPAWN.y;
    chase(e);
    e.stuckT = 99; // give up now
    let home = false, checked = 0, aligned = 0, pathLen = 0, sawPath = false;
    let px = e.x, py = e.y;
    for (let i = 0; i < 60 * 15 && !home; i++) {
      stepGame(s, idle());
      if (e.path.length > 0) sawPath = true;
      pathLen += Math.hypot(e.x - px, e.y - py);
      px = e.x; py = e.y;
      expect(boxHitsSolid(s, "over", e.x, e.y, e.r * 0.85)).toBe(false);
      const sp = Math.hypot(e.vx, e.vy);
      if (e.state === "return" && sp > 0.8) {
        checked++;
        if (angDiff(e.face, yawOf(e.vx, e.vy)) < 0.35) aligned++;
      }
      home = e.state !== "return" && Math.hypot(e.x - e.homeX, e.y - e.homeY) < 0.5;
    }
    expect(home).toBe(true);
    expect(sawPath).toBe(true);
    expect(pathLen).toBeGreaterThan(4); // went around, not through (straight line is 2 tiles)
    // facing tracks the actual walking direction (allowing for the turn at corners)
    expect(checked).toBeGreaterThan(60);
    expect(aligned / checked).toBeGreaterThan(0.85);
  });

  it("never moonwalks: walking away from the hero it faces away from them", () => {
    const s = fresh();
    const e = blobs(s)[0];
    only(s, [e]);
    const [x, y] = openSpot();
    clearPots(s, x, y, 5);
    place(e, x, y);
    e.x = x + 2.5; // 2.5 tiles from home
    s.player.x = x + 4.5; s.player.y = y; s.player.invuln = 1e9;
    e.face = yawOf(1, 0); // was staring at the hero
    chase(e);
    e.stuckT = 99;
    let late = 0, backwards = 0;
    for (let i = 0; i < 60 * 2; i++) {
      stepGame(s, idle());
      if (e.state !== "return" || Math.hypot(e.vx, e.vy) < 0.8) continue;
      if (i > 20) {
        late++;
        if (angDiff(e.face, yawOf(s.player.x - e.x, s.player.y - e.y)) < Math.PI / 2) backwards++;
      }
    }
    expect(late).toBeGreaterThan(10);
    expect(backwards).toBe(0);
  });

  it("knockback keeps facing the attacker; idle keeps its facing", () => {
    const s = fresh();
    const e = blobs(s)[0];
    only(s, [e]);
    e.face = 1.0; e.stun = 0.5; e.vx = -6; e.vy = 0;
    run(s, {}, 10);
    expect(e.face).toBeCloseTo(1.0, 6);
  });
});
