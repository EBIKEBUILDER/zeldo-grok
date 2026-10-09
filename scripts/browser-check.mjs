// Dev-server audit: every console error/warning (React key warnings are dev-only) plus functional
// checks — desktop (D moves right, pause menu, perf overlay, fullscreen button, full quest) and a
// mobile-landscape pass with touch emulation (joystick, attack button, pause, fullscreen, perf).
import { chromium } from "playwright";
const URL = process.env.URL || "http://localhost:3100/";
const OUT = process.env.OUT || ".";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
const failures = [];
const audit = (pg, tag) => {
  pg.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning" || t === "warn") problems.push(`[${tag} ${t}] ${m.text().slice(0, 300)}`);
  });
  pg.on("pageerror", (e) => problems.push(`[${tag} pageerror] ` + e.message));
};
audit(page, "desktop");
function expect(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
}
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

// ── D moves the hero right, on screen and in the world
{
  await G(() => { for (const e of window.__zeldo.store.getState().game.enemies) e.state = "idle"; });
  const a = await G(() => ({ x: window.__zeldo.store.getState().game.player.x, s: window.__zeldo.view.heroScreen().x }));
  await page.keyboard.down("KeyD"); await page.waitForTimeout(900); await page.keyboard.up("KeyD"); await page.waitForTimeout(400);
  const b = await G(() => ({ x: window.__zeldo.store.getState().game.player.x, s: window.__zeldo.view.heroScreen().x }));
  expect("D moves the hero right", b.x > a.x + 0.5 && b.s > a.s, `world x ${a.x.toFixed(2)}→${b.x.toFixed(2)}, screen x ${a.s.toFixed(3)}→${b.s.toFixed(3)}`);
}
// ── HUD bits
expect("minimap present", await page.locator("[data-testid=minimap]").isVisible());
expect("fullscreen button present (desktop)", await page.locator("[data-testid=fullscreen-btn]").isVisible());
// ── perf overlay: F3 and backquote toggle, off by default
{
  const off0 = await page.locator("[data-testid=perf]").count();
  await page.keyboard.press("F3");
  let txt = "";
  for (let i = 0; i < 30 && !/draws\s+\d+/.test(txt); i++) { await page.waitForTimeout(150); txt = (await page.locator("[data-testid=perf]").textContent()) || ""; }
  await page.keyboard.press("Backquote"); await page.waitForTimeout(300);
  const off1 = await page.locator("[data-testid=perf]").count();
  expect("perf overlay toggles (F3 / `)", off0 === 0 && /FPS/.test(txt) && /draws\s+\d+/.test(txt) && off1 === 0, txt.replace(/\n/g, " | "));
}
// ── pause menu: Esc pauses the sim, buttons work, resume
{
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  const menu = await page.locator("[data-testid=pause-menu]").isVisible();
  const t0 = await G(() => window.__zeldo.store.getState().game.time);
  await page.waitForTimeout(800);
  const t1 = await G(() => window.__zeldo.store.getState().game.time);
  await page.click("[data-testid=pause-controls]");
  const help = await page.locator("[data-testid=controls-help]").isVisible();
  await page.click("[data-testid=pause-perf]"); await page.waitForTimeout(400);
  const perfOn = await page.locator("[data-testid=perf]").isVisible();
  await page.click("[data-testid=pause-perf]");
  await page.click("[data-testid=pause-mute]");
  const muted = await G(() => window.__zeldo.store.getState().muted);
  await page.click("[data-testid=pause-mute]");
  const fsBtn = await page.locator("[data-testid=pause-fullscreen]").isVisible();
  await page.click("[data-testid=pause-resume]");
  let t2 = t1;
  for (let i = 0; i < 25 && t2 <= t1; i++) { await page.waitForTimeout(100); t2 = await G(() => window.__zeldo.store.getState().game.time); }
  const gone = (await page.locator("[data-testid=pause-menu]").count()) === 0;
  expect("pause menu (Esc): freezes sim, controls/perf/mute/fullscreen, resume", menu && t1 === t0 && help && perfOn && muted && fsBtn && gone && t2 > t1, `menu=${menu} frozen=${t1 === t0} help=${help} perf=${perfOn} mute=${muted} fs=${fsBtn} resumed=${gone && t2 > t1}`);
}
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
let questWon = false;
await step("chest + victory", async () => { await G(() => { const p = window.__zeldo.store.getState().game.player; p.x = 8; p.y = 4.2; }); await holdUntil("KeyW", () => window.__zeldo.store.getState().game.flags.chestOpened); for (let i = 0; i < 60 && (await st()).phase !== "victory"; i++) await page.waitForTimeout(200); questWon = (await st()).phase === "victory"; });
await step("retry (Enter)", async () => { await page.keyboard.press("Enter"); await page.waitForTimeout(700); });
await step("hurt after retry", async () => { await getHurtNearBlob(); await page.waitForTimeout(400); });
await step("game over", async () => { await G(() => { window.__zeldo.store.getState().game.player.hp = 1; }); await page.waitForTimeout(1300); await getHurtNearBlob(); for (let i = 0; i < 40 && (await st()).phase !== "gameover"; i++) await page.waitForTimeout(100); });
await step("retry from game over", async () => { await page.keyboard.press("Enter"); await page.waitForTimeout(700); });
{
  const s = await st();
  expect("full quest completes (victory reached, retry works)", s.phase === "playing" && questWon, `victory=${questWon}`);
}
await page.screenshot({ path: `${OUT}/40-devcheck-final.png` });

// ───────────── mobile landscape, touch emulation ─────────────
const mctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" });
const m = await mctx.newPage();
audit(m, "mobile");
const cdp = await mctx.newCDPSession(m);
const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
const MG = (fn, a) => m.evaluate(fn, a);
await m.goto(URL, { waitUntil: "networkidle" });
await m.waitForSelector("[data-testid=title]", { timeout: 60000 });
const prompt = (await m.locator("[data-testid=start-prompt]").textContent()) || "";
await m.touchscreen.tap(422, 200);
await m.waitForTimeout(1200);
expect("mobile: tap to start", (await MG(() => window.__zeldo.store.getState().game.phase)) === "playing", `prompt "${prompt}"`);
expect("mobile: touch controls shown", (await m.locator("[data-testid=joystick-zone]").isVisible()) && (await m.locator("[data-testid=attack-btn]").isVisible()));
expect("mobile: no page scroll", await MG(() => document.scrollingElement.scrollHeight <= innerHeight + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1));
{
  await MG(() => { const g = window.__zeldo.store.getState().game; g.player.invuln = 1e9; for (const e of g.enemies) e.state = "idle"; });
  const a = await MG(() => ({ x: window.__zeldo.store.getState().game.player.x, s: window.__zeldo.view.heroScreen().x }));
  await touch("touchStart", 160, 260);
  for (let i = 1; i <= 6; i++) { await touch("touchMove", 160 + i * 12, 260); await m.waitForTimeout(30); }
  await m.waitForTimeout(400);
  const knob = await m.locator("[data-testid=joystick-knob]").isVisible();
  await m.waitForTimeout(600);
  await touch("touchEnd", 0, 0);
  await m.waitForTimeout(400);
  const b = await MG(() => ({ x: window.__zeldo.store.getState().game.player.x, s: window.__zeldo.view.heroScreen().x, stick: window.__zeldo.touch.stick }));
  expect("mobile: joystick drag right moves the hero right", knob && b.x > a.x + 0.5 && b.s > a.s && !b.stick, `world x ${a.x.toFixed(2)}→${b.x.toFixed(2)}, screen ${a.s.toFixed(3)}→${b.s.toFixed(3)}, knob=${knob}`);
}
{
  const seq0 = await MG(() => window.__zeldo.store.getState().game.eventSeq);
  const box = await m.locator("[data-testid=attack-btn]").boundingBox();
  await m.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  let swung = false;
  for (let i = 0; i < 25 && !swung; i++) {
    await m.waitForTimeout(100);
    swung = await MG((seq0) => window.__zeldo.store.getState().game.events.some((e) => e.type === "swing" && e.seq > seq0), seq0);
  }
  expect("mobile: attack button swings", swung);
}
expect("mobile: fullscreen button present", await m.locator("[data-testid=fullscreen-btn]").isVisible());
{
  await m.locator("[data-testid=pause-btn]").tap();
  await m.waitForTimeout(400);
  const menu = await m.locator("[data-testid=pause-menu]").isVisible();
  const ctl = (await m.locator("[data-testid=touch-controls]").count()) === 0;
  await m.locator("[data-testid=pause-perf]").tap();
  await m.waitForTimeout(500);
  const perf = await m.locator("[data-testid=perf]").isVisible();
  await m.locator("[data-testid=pause-perf]").tap();
  await m.waitForTimeout(300);
  const perfOff = (await m.locator("[data-testid=perf]").count()) === 0;
  await m.locator("[data-testid=pause-resume]").tap();
  await m.waitForTimeout(400);
  const back = (await m.locator("[data-testid=pause-menu]").count()) === 0 && (await m.locator("[data-testid=attack-btn]").isVisible());
  expect("mobile: pause menu + perf overlay toggle", menu && ctl && perf && perfOff && back, `menu=${menu} controlsHidden=${ctl} perfOn=${perf} perfOff=${perfOff} resumed=${back}`);
}
{
  await m.locator("[data-testid=mute-btn]").tap();
  await m.waitForTimeout(200);
  expect("mobile: mute button", await MG(() => window.__zeldo.store.getState().muted));
}
{
  await m.setViewportSize({ width: 390, height: 844 });
  await m.waitForTimeout(800);
  expect("mobile: portrait shows rotate hint", await m.locator("[data-testid=rotate-hint]").isVisible());
  await m.setViewportSize({ width: 844, height: 390 });
  await m.waitForTimeout(500);
}
await m.screenshot({ path: `${OUT}/41-devcheck-mobile.png` });
await mctx.close();

console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].join("\n") : "console errors/warnings: none");
console.log(failures.length ? `FAILED CHECKS: ${failures.join("; ")}` : "functional checks: all passed");
await browser.close();
process.exit(problems.length || failures.length ? 1 : 0);
