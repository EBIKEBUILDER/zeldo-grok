import { BOSS_LUNGE_DIST, BOSS_LUNGE_DMG, BOSS_WINDUP } from "@/game/constants";
import { describe, expect, it } from "vitest";
import { boxHitsSolid, globHits, playerField, stepGame } from "@/game/sim";
import { fieldAt } from "@/game/path";
import { BLOB_R, GLOB_FUSE, GLOB_SPLASH_R, PLAYER_R, SAFE_RADIUS } from "@/game/constants";
import { MAPS, SPAWN, Tile, isSolidTile, tileAt, GATE_ROW } from "@/game/world";
import type { Enemy, GameState } from "@/game/types";
import { boss, bossFight, fresh, idle, run, toDungeon } from "./helpers";

const overBlob = (s: GameState) => s.enemies.find((e) => e.kind === "blob" && e.map === "over")!;
function isolate(s: GameState, keep: Enemy) {
  for (const e of s.enemies) if (e !== keep && e.kind === "blob") (e.alive = false), (e.respawnT = 1e9);
}
function place(e: Enemy, x: number, y: number) {
  e.x = x; e.y = y; e.vx = e.vy = 0; e.homeX = x; e.homeY = y;
}
const free = (x: number, y: number) => !isSolidTile(tileAt(MAPS.over, x, y), true);

describe("pathfinding", () => {
  it("routes around a hedge wall instead of getting stuck on it", () => {
    const s = fresh();
    // find a spot on the hedge row y=12 (between screens): enemy above, player below, hedge between
    const e = overBlob(s);
    isolate(s, e);
    s.player.invuln = 1e9;
    // hedge tile with open ground on both sides, a real detour, and far enough from spawn
    let ex = -1;
    for (let x = 2; x < 46 && ex < 0; x++) {
      if (tileAt(MAPS.over, x, 12) !== Tile.HEDGE || !free(x, 11) || !free(x, 13)) continue;
      if (Math.hypot(x + 0.5 - SPAWN.x, 13.5 - SPAWN.y) < 9) continue;
      s.player.x = x + 0.5; s.player.y = 13.5; s.tick += 10;
      const fd = fieldAt(playerField(s, "over").field, x, 11);
      if (fd > 4 && fd < 14) ex = x;
    }
    expect(ex).toBeGreaterThan(0);
    place(e, ex + 0.5, 11.5);
    s.player.x = ex + 0.5; s.player.y = 13.5;
    let reached = false;
    for (let i = 0; i < 60 * 15; i++) {
      s.player.x = ex + 0.5; s.player.y = 13.5; s.player.vx = s.player.vy = 0;
      stepGame(s, idle());
      if (Math.hypot(e.x - s.player.x, e.y - s.player.y) < PLAYER_R + BLOB_R + 0.2) { reached = true; break; }
    }
    expect(reached).toBe(true);
    expect(boxHitsSolid(s, "over", e.x, e.y, e.r * 0.85)).toBe(false);
  });

  it("stays aggressive when the player briefly breaks line of sight within the area", () => {
    const s = fresh();
    const e = overBlob(s);
    isolate(s, e);
    s.player.invuln = 1e9;
    s.player.x = e.x + 2.5; s.player.y = e.y;
    run(s, {}, 20);
    expect(e.state).toBe("chase");
    // hop behind cover 6 tiles away for 2 seconds (beyond the 5.5 aggro radius, well within 10 de-aggro)
    const hx = e.homeX, hy = e.homeY;
    let spot: [number, number] | null = null;
    for (let r = 6; r < 8 && !spot; r += 0.5)
      for (let a = 0; a < Math.PI * 2 && !spot; a += 0.3) {
        const x = hx + Math.cos(a) * r, y = hy + Math.sin(a) * r;
        if (!boxHitsSolid(s, "over", x, y, PLAYER_R) && Math.hypot(x - SPAWN.x, y - SPAWN.y) > SAFE_RADIUS + 2) spot = [x, y];
      }
    expect(spot).not.toBeNull();
    for (let i = 0; i < 120; i++) {
      s.player.x = spot![0]; s.player.y = spot![1]; s.player.vx = s.player.vy = 0;
      stepGame(s, idle());
      expect(e.state).toBe("chase");
    }
  });

  it("gives up after ~5.5s when the player is unreachable, then walks home and idles", () => {
    const s = fresh();
    toDungeon(s);
    const e = s.enemies.find((e) => e.kind === "blob" && e.map === "dungeon")!;
    for (const o of s.enemies) if (o !== e && o.kind === "blob") (o.alive = false), (o.respawnT = 1e9);
    place(e, 8.5, 12.5);
    e.homeX = 2.5; e.homeY = 12.8;
    s.player.invuln = 1e9;
    // player stands just behind the locked gate, in the boss hall (not deep enough to wake him)
    s.player.x = 8.0; s.player.y = GATE_ROW - 0.6;
    run(s, {}, 10);
    expect(e.state).toBe("chase");
    let gaveUpAt = -1;
    for (let i = 0; i < 60 * 9; i++) {
      s.player.x = 8.0; s.player.y = GATE_ROW - 0.6; s.player.vx = s.player.vy = 0;
      stepGame(s, idle());
      if ((e.state as string) === "return") { gaveUpAt = i / 60; break; }
    }
    expect(gaveUpAt).toBeGreaterThan(4.5);
    expect(gaveUpAt).toBeLessThan(7.5);
    for (let i = 0; i < 60 * 8 && (e.state as string) === "return"; i++) {
      s.player.x = 8.0; s.player.y = GATE_ROW - 0.6;
      stepGame(s, idle());
    }
    expect(Math.hypot(e.x - e.homeX, e.y - e.homeY)).toBeLessThan(0.8);
    expect(["idle", "wander"]).toContain(e.state);
  });

  it("chasers never enter the spawn sanctuary, and a player at spawn is never touched", () => {
    const s = fresh();
    s.player.invuln = 0;
    // lure every overworld blob toward spawn, then stand still at spawn for a minute
    for (const e of s.enemies.filter((e) => e.map === "over")) {
      s.player.x = e.x + 2; s.player.y = e.y;
      run(s, {}, 3);
    }
    s.player.x = SPAWN.x; s.player.y = SPAWN.y; s.player.hp = s.player.maxHp; s.player.invuln = 0;
    for (let i = 0; i < 60 * 60; i++) {
      s.player.x = SPAWN.x; s.player.y = SPAWN.y;
      stepGame(s, idle());
      for (const e of s.enemies) if (e.alive && e.map === "over") expect(Math.hypot(e.x - SPAWN.x, e.y - SPAWN.y)).toBeGreaterThan(SAFE_RADIUS);
    }
    expect(s.player.hp).toBe(s.player.maxHp);
  });

  it("the Warden walks around a pillar instead of grinding into it", () => {
    const s = bossFight();
    const b = boss(s);
    s.player.invuln = 1e9;
    b.lungeCd = 99; b.spitCd = 99; b.state = "chase";
    // pillar at tile (3,8): boss directly north of it, player directly south (straight line blocked)
    b.x = 3.5; b.y = 6.4; s.player.x = 3.5; s.player.y = 9.8;
    let reached = false;
    for (let i = 0; i < 60 * 6; i++) {
      s.player.x = 3.5; s.player.y = 9.8; s.player.vx = s.player.vy = 0;
      b.lungeCd = 99; b.spitCd = 99;
      stepGame(s, idle());
      if (Math.hypot(b.x - s.player.x, b.y - s.player.y) < b.r + PLAYER_R + 0.3) { reached = true; break; }
    }
    expect(reached, `boss at ${b.x.toFixed(2)},${b.y.toFixed(2)} state ${b.state}; player ${s.player.x.toFixed(2)},${s.player.y.toFixed(2)}`).toBe(true);
  });
});

describe("glob fuse", () => {
  function landedGlobAtPlayer() {
    const s = bossFight();
    const b = boss(s);
    b.x = 2; b.y = 2; b.state = "stunned"; b.stateT = 1e9;
    s.player.x = 10; s.player.y = 6; s.player.vx = s.player.vy = 0; s.player.invuln = 0;
    s.globs = [{ id: 999, x0: b.x, y0: b.y, tx: 10, ty: 6, t: 1.0, dur: 1.0 }]; // just landed
    return s;
  }
  it("a player at the centre who reacts in 0.3s escapes the burst", () => {
    const s = landedGlobAtPlayer();
    const hp = s.player.hp;
    run(s, {}, 18); // 0.3s reaction
    for (let i = 0; i < 60 && s.globs.length; i++) stepGame(s, { ...idle(), right: true });
    expect(s.globs.length).toBe(0);
    expect(s.player.hp).toBe(hp);
    expect(globHits(s.player.x, s.player.y, 10, 6)).toBe(false);
  });
  it("one who stands still is hit", () => {
    const s = landedGlobAtPlayer();
    const hp = s.player.hp;
    run(s, {}, Math.ceil(GLOB_FUSE * 60) + 2);
    expect(s.player.hp).toBeLessThan(hp);
  });
  it("radius numbers: escape distance and timing are as documented", () => {
    expect(GLOB_SPLASH_R).toBeCloseTo(1.15);
    expect(GLOB_FUSE).toBeCloseTo(0.8);
  });
});

describe("lunge telegraph", () => {
  /** Boss at (5,5.5) facing a player 4 tiles east; returns state at the moment the windup starts. */
  function chargeStart() {
    const s = bossFight();
    const b = boss(s);
    b.x = 5; b.y = 5.5; b.vx = b.vy = 0; b.state = "chase"; b.lungeCd = 0; b.spitCd = 99; b.guardCd = 0;
    s.player.x = 9; s.player.y = 5.5; s.player.vx = s.player.vy = 0; s.player.invuln = 0;
    for (let i = 0; i < 60 && (b.state as string) !== "windup"; i++) {
      s.player.x = 9; s.player.y = 5.5;
      stepGame(s, idle());
    }
    expect(b.state).toBe("windup");
    expect(s.events.some((e) => e.type === "bossCharge")).toBe(true);
    expect(b.stateDur).toBeCloseTo(BOSS_WINDUP);
    return { s, b };
  }
  function lungeDamage(s: ReturnType<typeof bossFight>, react: number, dir: Partial<ReturnType<typeof idle>>) {
    const b = boss(s);
    let dmg = 0;
    for (let i = 0; i < 120; i++) {
      const hp = s.player.hp;
      stepGame(s, i / 60 >= react ? { ...idle(), ...dir } : idle());
      if (b.state === "lunge" || b.state === "windup") dmg += hp - s.player.hp;
      if (b.state === "stunned") break;
    }
    return dmg;
  }
  it.each([0.25, 0.3])("a sidestep %ss after the charge cue clears the lane", (react) => {
    const { s } = chargeStart();
    expect(lungeDamage(s, react, { down: true })).toBe(0);
  });
  it("standing still in the lane eats the lunge (a full heart)", () => {
    const { s } = chargeStart();
    expect(lungeDamage(s, 99, {})).toBe(BOSS_LUNGE_DMG);
  });
  it("the lane length is the true lunge reach", () => {
    expect(BOSS_LUNGE_DIST).toBeCloseTo(5.5);
  });
});

describe("analog input & exploration", () => {
  it("an analog stick pushed right moves the hero right at a speed set by deflection", () => {
    const a = fresh(), b = fresh();
    run(a, { mx: 1, my: 0 }, 30);
    run(b, { mx: 0.5, my: 0 }, 30);
    expect(a.player.x).toBeGreaterThan(b.player.x);
    expect(b.player.x).toBeGreaterThan(24.5);
    expect(a.player.fx).toBe(1);
  });
  it("small stick noise inside the dead zone does nothing", () => {
    const s = fresh();
    run(s, { mx: 0.1, my: 0.05 }, 30);
    expect(s.player.x).toBe(24);
  });
  it("tracks explored screens and rooms for the minimap", () => {
    const s = fresh();
    expect(s.explored[4]).toBe(1); // Hearthollow
    expect(s.explored[1]).toBe(0);
    s.player.x = 24; s.player.y = 8;
    run(s, {}, 1);
    expect(s.explored[1]).toBe(1); // Cinderstone Crags
    toDungeon(s);
    expect(s.explored[6]).toBe(1);
  });
});
