// Dev-server console audit: every console error/warning (React key warnings are dev-only).
import { chromium } from "playwright";
const URL = process.env.URL || "http://localhost:3100/";
const OUT = process.env.OUT || ".";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning" || t === "warn") problems.push(`[${t}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => problems.push("[pageerror] " + e.message));
const G = (fn, a) => page.evaluate(fn, a);
const st = () => G(() => { const g = window.__zeldo.store.getState().game; return { phase: g.phase, map: g.player.map, hp: g.player.hp, hurt: g.player.hurtCount, msg: g.message && g.message.id, text: g.message && g.message.text, flags: { ...g.flags } }; });
async function step(label, fn) { await fn(); const s = await st(); console.log(label.padEnd(26), `phase=${s.phase} map=${s.map} hp=${s.hp} hurt=${s.hurt} msgId=${s.msg} problems=${problems.length}`); }
async function holdUntil(key, pred, max = 15000) { await page.keyboard.down(key); const t0 = Date.now(); while (Date.now() - t0 < max) { if (await G(pred)) break; await page.waitForTimeout(40); } await page.keyboard.up(key); }
async function getHurtNearBlob(map = "over") {
  await G((map) => { const g = window.__zeldo.store.getState().game; g.player.invuln = 0; const e = g.enemies.find((e) => e.alive && e.kind === "blob" && e.map === map); if (!e) return; g.player.x = e.x - 0.75; g.player.y = e.y; e.contactCd = 0; }, map);
  const h0 = (await st()).hurt;
  for (let i = 0; i < 80 && (await st()).hurt === h0; i++) await page.waitForTimeout(40);
}

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid=title]", { timeout: 60000 });
await step("title", async () => {});
await step("start (msg #1 shown)", async () => { await page.keyboard.press("Enter"); await page.waitForTimeout(600); });
await step("hurt #1 during msg", async () => { await getHurtNearBlob(); await page.waitForTimeout(400); });
await step("hurt #2", async () => { await page.waitForTimeout(1300); await getHurtNearBlob(); await page.waitForTimeout(400); });
await G(() => { const g = window.__zeldo.store.getState().game; g.player.hp = 6; for (const e of g.enemies) if (e.kind === "blob" && e.map === "over") { e.alive = false; e.respawnT = 1e9; } });
await step("enter vault", async () => { await G(() => { const p = window.__zeldo.store.getState().game.player; p.x = 24; p.y = 4.2; }); await holdUntil("KeyW", () => window.__zeldo.store.getState().game.player.map === "dungeon"); await page.waitForTimeout(800); });
await step("locked-gate msg", async () => { await G(() => { const p = window.__zeldo.store.getState().game.player; p.x = 8; p.y = 13.2; }); await holdUntil("KeyW", () => !!window.__zeldo.store.getState().game.message, 3000); await page.waitForTimeout(300); });
await step("hurt in vault during msg", async () => { await getHurtNearBlob("dungeon"); await page.waitForTimeout(400); });
await step("key msg", async () => { await G(() => { const g = window.__zeldo.store.getState().game; for (const e of g.enemies) if (e.kind === "blob") { e.alive = false; e.respawnT = 1e9; } g.player.x = 8; g.player.y = 17; }); await holdUntil("KeyW", () => window.__zeldo.store.getState().game.flags.hasKey); await page.waitForTimeout(500); });
await step("gate msg", async () => { await G(() => { const p = window.__zeldo.store.getState().game.player; p.x = 8; p.y = 13; }); await holdUntil("KeyW", () => window.__zeldo.store.getState().game.flags.gateOpen); await page.waitForTimeout(600); });
await step("boss wakes msg", async () => { await holdUntil("KeyW", () => window.__zeldo.store.getState().game.flags.bossAwake); await page.waitForTimeout(800); });
await step("boss defeated", async () => {
  for (let i = 0; i < 80; i++) {
    const done = await G(() => { const g = window.__zeldo.store.getState().game; g.player.invuln = 1e9; const b = g.enemies.find((e) => e.kind === "boss"); if (!b.alive) return true; if (b.state !== "stunned") { b.state = "stunned"; b.stateT = 1.5; b.stunHits = 0; } g.player.x = b.x; g.player.y = b.y + b.r + 0.7; g.player.fx = 0; g.player.fy = -1; return false; });
    if (done) break;
    await page.keyboard.press("Space"); await page.waitForTimeout(450);
  }
  await page.waitForTimeout(800);
});
await step("chest + victory", async () => { await G(() => { const p = window.__zeldo.store.getState().game.player; p.x = 8; p.y = 4.2; }); await holdUntil("KeyW", () => window.__zeldo.store.getState().game.flags.chestOpened); for (let i = 0; i < 60 && (await st()).phase !== "victory"; i++) await page.waitForTimeout(200); });
await step("retry (Enter)", async () => { await page.keyboard.press("Enter"); await page.waitForTimeout(700); });
await step("hurt after retry", async () => { await getHurtNearBlob(); await page.waitForTimeout(400); });
await step("game over", async () => { await G(() => { window.__zeldo.store.getState().game.player.hp = 1; }); await page.waitForTimeout(1300); await getHurtNearBlob(); for (let i = 0; i < 40 && (await st()).phase !== "gameover"; i++) await page.waitForTimeout(100); });
await step("retry from game over", async () => { await page.keyboard.press("Enter"); await page.waitForTimeout(700); });
await page.screenshot({ path: `${OUT}/40-devcheck-final.png` });
console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].join("\n") : "console errors/warnings: none");
await browser.close();
process.exit(problems.length ? 1 : 0);
