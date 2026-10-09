# Zeldo — The Hollow Sunstone

A tiny, complete, low-poly overhead 3D Zelda-like that runs in the browser. Takes about 5–10 minutes to finish.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm test         # sim/quest unit tests (vitest)

# headless console audit against the dev server (needs `npx playwright install chromium` once)
npm run dev &    # in another terminal: http://localhost:3000
URL=http://localhost:3000/ npm run check:browser
```
The browser check plays through title → hits taken while messages show → vault → key/gate/boss messages → victory → retry → game over → retry. It fails on any console error or warning, including React dev-only key warnings.

**Controls:** WASD / Arrow keys to move · Space or Click to swing · M to mute · Enter or Click to start/retry

## The quest
You start in **Hearthollow**, a safe village with a cottage and a well. Enemies can't enter the area around spawn and won't chase you there. Head north through **Cinderstone Crags** to the arched doorway of the **Mossgrave Vault**. Grab the key from the pedestal in the Antechamber and unlock the gate. The gate slams shut behind you, and you fight **Gloomgulp, the Vault Warden**, a crowned 8-HP blob that winds up and lunges. Beat it and a chest rises with the Sunstone inside.

Other areas: **Thistlewick Wood** (dense pines), **Mirelight Pond** (plank bridge, stream), **Bramblebell Meadow** (flowers and tall grass), and **Lanternfall Glade** (autumn trees).

## Architecture
- `src/game/sim.ts`: the pure fixed-timestep simulation (60 Hz). All rules live here: movement with acceleration and friction, axis-separated tile collision (wall sliding), sword cone hits, knockback/hitstun/i-frames, blob AI, the boss, pickups, quest triggers. It emits events.
- `src/game/store.ts`: Zustand store holding plain JSON-serializable `GameState`.
- `src/game/world.ts`: tile maps (3×2 screens of 16×12 tiles, plus a 2-room vault), area names, spawn points.
- `src/game/render/`: Babylon.js view layer. It only reads state each frame and positions meshes. Also handles particles, camera, shake, and lighting.
- `src/game/audio.ts`: synthesized Web Audio SFX (no audio files).
- `src/components/`: React canvas host plus the HUD and the title, game-over, and victory screens.

No external assets, no API keys.
