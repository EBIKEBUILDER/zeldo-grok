import { describe, expect, it } from "vitest";
import { createInitialState, gateClosed, startGame, stepGame } from "@/game/sim";
import type { GameState, InputState } from "@/game/types";
import { CHEST, DUNGEON_ENTRY, GATE_ROW, MAPS, OVER_DOOR, PEDESTAL, SPAWN, Tile, isSolidTile, tileAt } from "@/game/world";
import { BLOB_AGGRO, PLAYER_R, SAFE_RADIUS, SPAWN_CLEARANCE } from "@/game/constants";

const idle = (): InputState => ({ up: false, down: false, left: false, right: false, attack: false });
function run(s: GameState, input: Partial<InputState>, ticks: number) {
  for (let i = 0; i < ticks; i++) stepGame(s, { ...idle(), ...input });
}
function fresh() {
  const s = createInitialState(42);
  startGame(s);
  return s;
}
function toDungeon(s: GameState) {
  s.player.x = OVER_DOOR.x1 + 0.0;
  s.player.y = OVER_DOOR.y + 1.4;
  run(s, { up: true }, 40);
  expect(s.player.map).toBe("dungeon");
}

describe("movement", () => {
  it("D (right) increases x; S (down) increases y; facing follows", () => {
    const s = fresh();
    const x0 = s.player.x;
    run(s, { right: true }, 30);
    expect(s.player.x).toBeGreaterThan(x0 + 1);
    expect(s.player.fx).toBe(1);
    expect(s.player.fy).toBe(0);
  });
  it("accelerates smoothly and has friction", () => {
    const s = fresh();
    run(s, { right: true }, 1);
    const v1 = s.player.vx;
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeLessThan(1);
    run(s, { right: true }, 30);
    run(s, {}, 3);
    expect(s.player.vx).toBeGreaterThan(0); // still sliding, not snapped to 0
    run(s, {}, 30);
    expect(s.player.vx).toBe(0);
  });
  it("8-way facing on diagonals", () => {
    const s = fresh();
    run(s, { up: true, right: true }, 5);
    expect(s.player.fx).toBeCloseTo(Math.SQRT1_2);
    expect(s.player.fy).toBeCloseTo(-Math.SQRT1_2);
  });
  it("never walks into solid tiles and slides along walls", () => {
    const s = fresh();
    // walk west along the road then hold up-left into the hedge for a long time
    run(s, { left: true, up: true }, 600);
    const m = MAPS.over;
    const r = PLAYER_R - 0.01;
    for (const [ox, oy] of [[-r, -r], [r, -r], [-r, r], [r, r]])
      expect(isSolidTile(tileAt(m, Math.floor(s.player.x + ox), Math.floor(s.player.y + oy)), true)).toBe(false);
  });
});

describe("fairness", () => {
  it("every enemy starts (and respawns) well clear of spawn — outside aggro range plus a margin", () => {
    const s = fresh();
    for (const e of s.enemies.filter((e) => e.map === "over")) {
      expect(Math.hypot(e.homeX - SPAWN.x, e.homeY - SPAWN.y)).toBeGreaterThanOrEqual(SPAWN_CLEARANCE);
      expect(SPAWN_CLEARANCE).toBeGreaterThan(BLOB_AGGRO + SAFE_RADIUS + 2);
    }
  });

  it("a just-spawned player who idles a few steps outside the bubble isn't swarmed in the first 10 s", () => {
    const s = fresh();
    s.player.x = SPAWN.x + SAFE_RADIUS + 1;
    run(s, {}, 60 * 10);
    expect(s.player.hp).toBe(s.player.maxHp);
  });

  it("player standing at spawn is never attacked", () => {
    const s = fresh();
    run(s, {}, 60 * 120);
    expect(s.player.hp).toBe(s.player.maxHp);
    for (const e of s.enemies.filter((e) => e.map === "over"))
      expect(Math.hypot(e.x - SPAWN.x, e.y - SPAWN.y)).toBeGreaterThan(SAFE_RADIUS);
  });
});

describe("combat", () => {
  it("sword hit knocks back, flashes, kills, drops a rupee and respawns ~20s later", () => {
    const s = fresh();
    const e = s.enemies.find((e) => e.kind === "blob" && e.map === "over")!;
    s.player.x = e.x - 1.0;
    s.player.y = e.y;
    s.player.fx = 1;
    s.player.fy = 0;
    e.vx = e.vy = 0;
    stepGame(s, { ...idle(), attack: true });
    expect(e.hp).toBe(e.maxHp - 1);
    expect(e.hitFlash).toBeGreaterThan(0);
    expect(e.vx).toBeGreaterThan(0);
    run(s, {}, 30);
    s.player.x = e.x - 1.0;
    s.player.y = e.y;
    s.player.fx = 1;
    s.player.fy = 0;
    stepGame(s, { ...idle(), attack: true });
    expect(e.alive).toBe(false);
    expect(s.pickups.some((p) => p.kind === "rupee")).toBe(true);
    s.player.x = SPAWN.x;
    s.player.y = SPAWN.y;
    run(s, {}, 60 * 19);
    expect(e.alive).toBe(false);
    run(s, {}, 60 * 2);
    expect(e.alive).toBe(true);
  });
  it("sword misses enemies behind the hero", () => {
    const s = fresh();
    const e = s.enemies.find((e) => e.kind === "blob" && e.map === "over")!;
    s.player.x = e.x - 1.0;
    s.player.y = e.y;
    s.player.fx = -1;
    s.player.fy = 0;
    stepGame(s, { ...idle(), attack: true });
    expect(e.hp).toBe(e.maxHp);
  });
  it("contact damage, knockback, i-frames; bodies never overlap", () => {
    const s = fresh();
    const e = s.enemies.find((e) => e.kind === "blob" && e.map === "over")!;
    s.player.x = e.x - 1.6;
    s.player.y = e.y;
    let minD = Infinity;
    for (let i = 0; i < 240; i++) {
      stepGame(s, { ...idle(), right: true });
      if (e.alive) minD = Math.min(minD, Math.hypot(e.x - s.player.x, e.y - s.player.y));
    }
    expect(s.player.hp).toBeLessThan(s.player.maxHp);
    expect(s.player.hurtCount).toBeGreaterThan(0);
    expect(minD).toBeGreaterThan(PLAYER_R + e.r - 0.08);
  });
  it("game over when hearts run out", () => {
    const s = fresh();
    s.player.hp = 1;
    const e = s.enemies.find((e) => e.kind === "blob" && e.map === "over")!;
    s.player.x = e.x - 0.75;
    s.player.y = e.y;
    run(s, { right: true }, 60);
    expect(s.phase).toBe("gameover");
  });
});

describe("quest", () => {
  it("full loop: door → key → gate → boss → chest → victory", async () => {
    const s = fresh();
    toDungeon(s);
    expect(s.player.x).toBeCloseTo(DUNGEON_ENTRY.x, 0);
    // clear the antechamber blobs out of the way for determinism
    for (const e of s.enemies) if (e.kind === "blob") e.alive = false, (e.respawnT = 1e9);

    // gate is locked without the key
    expect(gateClosed(s)).toBe(true);
    s.player.x = 8;
    s.player.y = GATE_ROW + 1.6;
    run(s, { up: true }, 30);
    expect(s.player.y).toBeGreaterThan(GATE_ROW + 1);
    expect(s.flags.gateOpen).toBe(false);

    // grab the key
    s.player.x = PEDESTAL.x;
    s.player.y = PEDESTAL.y + 1.2;
    run(s, { up: true }, 30);
    expect(s.flags.hasKey).toBe(true);
    expect(s.events.some((e) => e.type === "key")).toBe(true);

    // open the gate
    s.player.x = 8;
    s.player.y = GATE_ROW + 1.6;
    run(s, { up: true }, 20);
    expect(s.flags.gateOpen).toBe(true);
    expect(tileAt(MAPS.dungeon, 8, GATE_ROW)).toBe(Tile.GATE);

    // walk into the hall → boss wakes and the gate seals
    run(s, { up: true }, 60);
    expect(s.flags.bossAwake).toBe(true);
    expect(gateClosed(s)).toBe(true);

    // no chest yet
    const boss = s.enemies.find((e) => e.kind === "boss")!;
    expect(s.flags.bossDefeated).toBe(false);

    // fight it like a careful player would
    const { carefulInput } = await import("./helpers");
    for (let i = 0; i < 60 * 120 && boss.alive && s.phase === "playing"; i++) stepGame(s, carefulInput(s));
    expect(boss.alive).toBe(false);
    expect(s.flags.bossDefeated).toBe(true);
    expect(gateClosed(s)).toBe(false);

    // boss stays dead
    run(s, {}, 60 * 30);
    expect(boss.alive).toBe(false);

    // open the chest
    s.player.x = CHEST.x;
    s.player.y = CHEST.y + 1.5;
    run(s, { up: true }, 30);
    expect(s.flags.chestOpened).toBe(true);
    expect(s.phase).toBe("playing");
    run(s, {}, 60 * 3);
    expect(s.phase).toBe("victory");
    expect(s.time).toBeGreaterThan(0);
  });

  it("state is JSON-serializable", () => {
    const s = fresh();
    run(s, { right: true, attack: true }, 10);
    const copy = JSON.parse(JSON.stringify(s));
    expect(copy.player.x).toBeCloseTo(s.player.x);
  });

  it("fixed timestep: same inputs give same result", () => {
    const a = fresh(), b = fresh();
    run(a, { right: true, down: true }, 200);
    run(b, { right: true, down: true }, 200);
    expect(a.player.x).toBe(b.player.x);
  });
});

describe("breakables", () => {
  it("pots are solid until broken, then break with debris event and vanish from collision", () => {
    const s = fresh();
    const pot = s.breakables.find((b) => b.kind === "pot" && b.map === "over")!;
    s.player.x = pot.x - 1.5;
    s.player.y = pot.y;
    run(s, { right: true }, 60);
    expect(s.player.x).toBeLessThan(pot.x - 0.5); // blocked by the pot
    s.player.fx = 1; s.player.fy = 0;
    stepGame(s, { ...idle(), attack: true });
    expect(pot.alive).toBe(false);
    expect(s.events.some((e) => e.type === "pot")).toBe(true);
    run(s, { right: true }, 60);
    expect(s.player.x).toBeGreaterThan(pot.x); // walks through the shards now
  });
  it("tufts are cut by the sword", () => {
    const s = fresh();
    const t = s.breakables.find((b) => b.kind === "tuft")!;
    s.player.x = t.x - 0.8; s.player.y = t.y; s.player.fx = 1; s.player.fy = 0;
    stepGame(s, { ...idle(), attack: true });
    expect(t.alive).toBe(false);
    expect(s.events.some((e) => e.type === "tuft")).toBe(true);
  });
});

describe("messages", () => {
  it("message ids are strictly increasing, even after a message expires", () => {
    const s = fresh();
    const ids: number[] = [s.message!.id];
    run(s, {}, 60 * 6); // start message expires
    expect(s.message).toBe(null);
    s.player.x = 24; s.player.y = 4.2;
    run(s, { up: true }, 40); // into the vault
    s.player.x = 8; s.player.y = 13.2;
    for (let i = 0; i < 30 && !s.message; i++) stepGame(s, { ...idle(), up: true });
    ids.push(s.message!.id);
    expect(ids[1]).toBeGreaterThan(ids[0]);
  });
});
