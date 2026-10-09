# Zeldo — The Hollow Sunstone

A tiny, complete, low-poly overhead 3D Zelda-like that runs in the browser. Takes about 5–10 minutes to finish. Plays on desktop and on phones in landscape.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm test         # sim/quest/pathfinding unit tests (vitest)

# headless audit against the dev server (needs `npx playwright install chromium` once)
npm run dev &    # in another terminal: http://localhost:3000
URL=http://localhost:3000/ npm run check:browser
```
The browser check fails on any console error or warning, including React dev-only warnings. It also fails on any of its functional checks.

**Desktop pass:**
- D moves the hero right.
- Minimap and fullscreen button are present.
- F3/` toggles the perf overlay.
- The Esc pause menu freezes the sim, and its controls help, perf, mute and fullscreen buttons work, as does resume.
- Full playthrough: title → hits taken while messages show → vault → key/gate/boss → victory → retry → game over → retry.

**Mobile pass** (844×390 landscape, touch emulation):
- Tap to start.
- The joystick moves the hero right and the sword button swings.
- Pause menu, perf toggle and mute work, and the fullscreen button is present.
- No page scroll, and portrait shows the rotate hint.

## Controls
| | Desktop | Touch |
|---|---|---|
| Move | WASD / arrow keys | drag anywhere on the left half (floating analog stick) |
| Sword | Space / click | ⚔ button (bottom right) |
| Pause | Esc / P / ❚❚ | ❚❚ |
| Mute | M / 🔊 | 🔊 |
| Fullscreen | ⤢ button | ⤢ button. On iPhone it explains Add to Home Screen, which launches fullscreen via the web-app manifest. |
| Perf overlay | F3 / ` / pause menu | pause menu |

## The quest
You start in **Hearthollow**, a safe village with a cottage and a well. Enemies can't enter the area around spawn and won't chase you there. Head north through **Cinderstone Crags** to the arched doorway of the **Mossgrave Vault**. Grab the key from the pedestal in the Antechamber and unlock the gate. The gate slams shut behind you, and you fight **Gloomgulp, the Vault Warden**. Beat it and a chest rises with the Sunstone inside.

## Enemy AI (`src/game/path.ts`, `sim.ts`)
- **Navigation:** a shared Dijkstra flow field toward the player, one per map.
  - 8-directional, with no corner cutting. Pots count as walls.
  - Rebuilt only when the player changes tile, the gate moves or a pot breaks, and at most every 4 ticks.
  - Budget: cost ≤ 36 tiles and ≤ 1400 nodes.
- **Steering:** blobs walk straight at you when the corridor is clear. Otherwise they follow the field downhill and aim at the furthest tile they can walk to in a straight line (path smoothing). Body separation keeps them from stacking.
- **Chase rules:**
  - Aggro at 5.5 tiles, needing line of sight unless within 2.5.
  - Keeps chasing until you're 10 tiles away. Brief loss of line of sight does nothing.
  - Leash: 18 tiles from home.
  - Gives up after 5.5 s with no path or no progress, then walks home along an A* path (≤ 900 nodes) and won't re-aggro for 3 s.
  - The spawn sanctuary (radius 6.5) is never entered.
- **The Warden** (1.6 tiles wide) pushes field waypoints away from walls so it uses 2-tile corridors instead of grinding into pillars.

## Boss telegraphs
- **Lunge:**
  - 0.8 s windup (0.65 s when enraged). He crouches, his glow ramps up and pulses faster, and a rising charge growl plays.
  - A ground lane runs from him to his true reach: 11 t/s × 0.5 s = 5.5 tiles plus his body. It fills during the windup and turns red when the aim locks 0.3 s before release.
  - Tested: sidestepping 0.25 s or 0.3 s after the cue avoids all damage. Standing still costs a full heart.
- **Globs:**
  - On landing, a 0.8 s fuse starts. The glob swells, pulses faster and shifts green → white-hot, with an accelerating tick sound.
  - A ring marks the exact hit radius: 1.15 + hero radius/2 = 1.31 tiles. A disc fills out to the ring as the timer runs.
  - From a standstill at the center, getting clear takes ~0.32 s. With a 0.3 s reaction you're out at ~0.62 s, about 0.18 s before the burst.
  - Tested: a 0.3 s reaction escapes, and standing still gets hit.

## Rendering & performance
- **Static batching:** static scenery is baked into one mesh per screen (or vault room) per material group: ground, walls, scenery, flora. Frustum culling then drops whole screens, and the shadow map only draws chunks within ~9 tiles of the camera.
- **Breakables:** pots and tufts are per-chunk dynamic thin instances.
- **Glow layer:** only draws emissive things (flames, runes, globs, telegraphs, pickups, enemies).
- **Frozen state:** static materials and world matrices are frozen.
- **Allocations:** per-frame allocations were removed (no `new Vector3`/`Set`/arrays in the frame loop).
- **Adaptive hardware scaling:** render scale drops to as low as ½ resolution when fps stays under 45 and recovers above 57. It is disabled under automation so screenshots stay sharp.
- **Look:**
  - ACES tone mapping, color curves and vignette, applied in the material shaders with no extra pass.
  - Exp² fog per area.
  - Baked AO: tiles darken next to walls and trees, and props darken toward their base.
  - Scrolling water shimmer.
  - Foliage sway in a vertex-shader material plugin.

## Architecture
- `src/game/sim.ts`: the pure fixed-timestep simulation (60 Hz).
  - All rules live here: movement, collision, combat, AI, the boss, pickups and quest triggers.
  - It emits events and tracks explored screens for the minimap.
- `src/game/path.ts`: flow field + A* (pure, unit-tested).
- `src/game/store.ts`: Zustand store holding plain JSON-serializable `GameState`, plus UI flags (`paused`, `perf`, `muted`) that never enter the sim.
- `src/game/world.ts`: tile maps (3×2 screens of 16×12 tiles, plus a 2-room vault), area names, spawn points.
- `src/game/render/`: the Babylon.js view layer. It only reads state each frame.
- `src/game/audio.ts`, `music.ts`: synthesized Web Audio SFX and music (no audio files).
- `src/components/`: React canvas host plus the RPG HUD (hearts panel, rupee/key counters, area plate, minimap, boss bar), the pause menu, touch controls, the perf overlay, and the title, game-over and victory screens.

No external assets, no API keys.
