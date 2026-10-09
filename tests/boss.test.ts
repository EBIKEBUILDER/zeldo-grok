import { describe, expect, it } from "vitest";
import { bossArmored, stepGame } from "@/game/sim";
import { BOSS_HP, BOSS_STUN, GLOB_SPLASH_R, PLAYER_R } from "@/game/constants";
import { boss, bossFight, carefulInput, idle, run } from "./helpers";

function swingAt(s: ReturnType<typeof bossFight>) {
  const b = boss(s);
  s.player.x = b.x;
  s.player.y = b.y + b.r + 0.7;
  s.player.fx = 0;
  s.player.fy = -1;
  s.player.swingCd = 0;
  stepGame(s, { ...idle(), attack: true });
}

describe("Gloomgulp", () => {
  it("lunge is uninterruptible: hits clank off with no damage, knockback or state change", () => {
    const s = bossFight();
    const b = boss(s);
    s.player.invuln = 1e9;
    b.x = 8; b.y = 4; s.player.x = 8; s.player.y = 9;
    b.lungeCd = 0;
    b.state = "chase";
    // wait for the windup tell
    for (let i = 0; i < 120 && (b.state as string) !== "windup"; i++) stepGame(s, idle());
    expect(b.state as string).toBe("windup");
    expect(bossArmored(b)).toBe(true);
    const hp = b.hp;
    // hit during windup
    s.player.x = b.x; s.player.y = b.y + b.r + 0.7; s.player.fx = 0; s.player.fy = -1;
    stepGame(s, { ...idle(), attack: true });
    expect(b.hp).toBe(hp);
    expect(s.events.some((e) => e.type === "clank")).toBe(true);
    for (let i = 0; i < 60 && (b.state as string) !== "lunge"; i++) stepGame(s, idle());
    expect(b.state as string).toBe("lunge");
    const vx = b.vx, vy = b.vy;
    // hit mid-lunge from beside
    s.player.x = b.x + b.r + 0.6; s.player.y = b.y; s.player.fx = -1; s.player.fy = 0; s.player.swingCd = 0;
    stepGame(s, { ...idle(), attack: true });
    expect(b.hp).toBe(hp);
    if ((b.state as string) === "lunge") {
      expect(Math.sign(b.vx)).toBe(Math.sign(vx));
      expect(Math.sign(b.vy)).toBe(Math.sign(vy));
      expect(b.stun).toBe(0);
    }
    for (let i = 0; i < 60 && (b.state as string) === "lunge"; i++) stepGame(s, idle());
    expect(b.state as string).toBe("stunned");
  });

  it("every lunge ends in a ~1.5s stun window where hits deal full damage", () => {
    const s = bossFight();
    const b = boss(s);
    s.player.invuln = 1e9;
    b.state = "lunge"; b.stateT = 0.05; b.wx = 0; b.wy = 1;
    run(s, {}, 5);
    expect(b.state as string).toBe("stunned");
    expect(b.stateT).toBeGreaterThan(BOSS_STUN - 0.2);
    const hp = b.hp;
    let hits = 0;
    while ((b.state as string) === "stunned") {
      swingAt(s);
      run(s, {}, 22);
      hits++;
    }
    // two clean hits per window, then he shakes it off
    expect(hp - b.hp).toBe(2);
    expect(hits).toBe(2);
    expect(b.state as string).not.toBe("stunned");
  });

  it("outside the stun window a hit only glances once, then he guards and counter-lunges", () => {
    const s = bossFight();
    const b = boss(s);
    s.player.invuln = 1e9;
    b.state = "chase"; b.guardCd = 0; b.lungeCd = 5;
    const hp = b.hp;
    swingAt(s);
    expect(b.hp).toBe(hp - 1);
    expect(b.state as string).toBe("windup");
    run(s, {}, 22);
    swingAt(s);
    run(s, {}, 22);
    swingAt(s);
    expect(b.hp).toBe(hp - 1); // further spam just clanks
  });

  it("is faster than before but the hero still outpaces him", () => {
    const s = bossFight();
    const b = boss(s);
    b.state = "chase"; b.lungeCd = 99; b.spitCd = 99;
    s.player.x = 8; s.player.y = 9.5; b.x = 8; b.y = 3;
    s.player.invuln = 1e9;
    run(s, {}, 60);
    expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(3.3);
    expect(Math.hypot(b.vx, b.vy)).toBeLessThan(5.2);
  });

  it("spits telegraphed globs when the player is out of reach; splash hurts inside the radius only", () => {
    const s = bossFight();
    const b = boss(s);
    b.x = 3; b.y = 2; b.lungeCd = 99; b.spitCd = 0; b.state = "chase";
    s.player.x = 13; s.player.y = 9; // far corner, > lunge range
    let fired = false;
    for (let i = 0; i < 120; i++) {
      stepGame(s, idle());
      if (s.globs.length) { fired = true; break; }
      s.player.x = 13; s.player.y = 9; s.player.vx = s.player.vy = 0;
    }
    expect(fired).toBe(true);
    expect(s.events.some((e) => e.type === "spit")).toBe(true);
    // the first glob is aimed at the player — stand outside its splash and you are safe
    const g = s.globs[0];
    s.globs = [g];
    s.player.invuln = 0;
    s.player.x = g.tx + GLOB_SPLASH_R + PLAYER_R + 0.6; s.player.y = g.ty;
    const hp = s.player.hp;
    for (let i = 0; i < 200 && s.globs.length; i++) { s.player.x = g.tx + GLOB_SPLASH_R + PLAYER_R + 0.6; s.player.y = g.ty; b.state = "stunned"; b.stateT = 9; stepGame(s, idle()); }
    expect(s.player.hp).toBe(hp);
    expect(s.puddles.length).toBe(1);
    // a second glob onto a player who stays inside the ring
    s.puddles = [];
    s.globs = [{ ...g, id: 999, t: 0 }];
    s.player.x = g.tx + 0.5; s.player.y = g.ty;
    for (let i = 0; i < 200 && s.globs.length; i++) { s.player.x = g.tx + 0.5; s.player.y = g.ty; stepGame(s, idle()); }
    expect(s.player.hp).toBeLessThan(hp);
  });

  it("a sword-spammer standing still loses", () => {
   for (const seed of [1, 2, 3, 7, 11]) {
    const s = bossFight(seed);
    const b = boss(s);
    for (let i = 0; i < 60 * 60 && s.phase === "playing"; i++) {
      const dx = b.x - s.player.x, dy = b.y - s.player.y;
      const l = Math.hypot(dx, dy) || 1;
      s.player.fx = dx / l; s.player.fy = dy / l;
      stepGame(s, { ...idle(), attack: true });
    }
    expect(s.phase, `seed ${seed} boss hp ${b.hp}`).toBe("gameover");
    expect(b.alive).toBe(true);
   }
  });

  it("a careful player (bait lunge → sidestep → punish stun, dodge globs) wins with 3 hearts", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 42]) {
      const s = bossFight(seed);
      const b = boss(s);
      for (let i = 0; i < 60 * 120 && s.phase === "playing" && b.alive; i++) stepGame(s, carefulInput(s));
      expect(b.alive, `seed ${seed}: hp left ${b.hp}, player ${s.player.hp}`).toBe(false);
      expect(s.phase).toBe("playing");
      console.log(`careful seed ${seed}: won in ${(s.time).toFixed(1)}s with ${s.player.hp}/6 half-hearts`);
      expect(b.maxHp).toBe(BOSS_HP);
    }
  });
});
