import { describe, expect, it } from "vitest";
import fs from "node:fs";

// Static check of the music sources: every melody line must fill exactly 8 bars (128 sixteenths).
describe("music", () => {
  it("each sequenced melody loops cleanly at 128 steps", () => {
    const src = fs.readFileSync("src/game/music.ts", "utf8");
    const seqs = [...src.matchAll(/seq\(`([^`]+)`\)/g)].map((m) => m[1]);
    expect(seqs.length).toBe(3);
    for (const s of seqs) {
      const total = s.trim().split(/\s+/).reduce((a, t) => a + parseInt(t.split(":")[1]), 0);
      expect(total).toBe(128);
    }
  });
});
