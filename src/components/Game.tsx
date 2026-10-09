"use client";
import { useEffect, useRef, useState } from "react";
import { Sfx } from "@/game/audio";
import { DT } from "@/game/constants";
import { GameView } from "@/game/render/view";
import { useGameStore } from "@/game/store";
import { touchInput } from "@/game/touch";
import type { InputState } from "@/game/types";
import Hud from "./Hud";
import PerfOverlay from "./PerfOverlay";
import TouchControls from "./TouchControls";

const KEYMAP: Record<string, "up" | "down" | "left" | "right"> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<GameView | null>(null);
  const startRef = useRef<() => void>(() => {});
  const [touchUI, setTouchUI] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const view = (viewRef.current = new GameView(canvas));
    const sfx = new Sfx();
    sfx.setMuted(useGameStore.getState().muted);
    const input: InputState = { up: false, down: false, left: false, right: false, attack: false };
    // Keys tapped between two sim ticks still count for one tick (no lost quick taps on slow frames).
    const tapped = { up: false, down: false, left: false, right: false };
    const frameInput: InputState = { up: false, down: false, left: false, right: false, attack: false };

    const startOrRetry = () => {
      sfx.unlock();
      const { game, start, retry } = useGameStore.getState();
      if (game.phase === "title") start();
      else if (game.phase === "gameover" || game.phase === "victory") retry();
    };
    startRef.current = startOrRetry;

    if (matchMedia("(pointer: coarse)").matches) setTouchUI(true);

    const onKeyDown = (e: KeyboardEvent) => {
      const dir = KEYMAP[e.code];
      if (dir) {
        input[dir] = true;
        tapped[dir] = true;
        e.preventDefault();
      }
      if (e.code === "Space") {
        e.preventDefault();
        sfx.unlock();
        const st = useGameStore.getState();
        if (!e.repeat && st.game.phase === "playing" && !st.paused) input.attack = true;
      }
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        if (!e.repeat) startOrRetry();
      }
      if (e.repeat) return;
      if (e.code === "KeyM") useGameStore.getState().toggleMute();
      if (e.code === "Escape" || e.code === "KeyP") useGameStore.getState().togglePause();
      if (e.code === "F3" || e.code === "Backquote") {
        e.preventDefault();
        useGameStore.getState().togglePerf();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = KEYMAP[e.code];
      if (dir) input[dir] = false;
    };
    const releaseAll = () => {
      input.up = input.down = input.left = input.right = false;
      touchInput.mx = touchInput.my = 0;
      touchInput.stick = false;
    };
    const onBlur = () => releaseAll();
    const onVisibility = () => {
      if (document.hidden) {
        releaseAll();
        useGameStore.getState().setPaused(true);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        setTouchUI(true);
        return; // touch attacks come from the on-screen button
      }
      if (e.button !== 0) return;
      sfx.unlock();
      const st = useGameStore.getState();
      if (st.game.phase === "playing" && !st.paused) input.attack = true;
    };
    const onAnyTouch = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        setTouchUI(true);
        sfx.unlock();
      }
    };
    // no long-press menus, pinch-zoom or double-tap zoom while playing
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", onAnyTouch, { capture: true });
    window.addEventListener("contextmenu", prevent);
    document.addEventListener("gesturestart", prevent);
    document.addEventListener("dblclick", prevent);
    canvas.addEventListener("pointerdown", onPointerDown);
    const unsub = useGameStore.subscribe((s, prev) => {
      if (s.muted !== prev.muted) sfx.setMuted(s.muted);
      if (s.perf !== prev.perf) view.setInstrumentation(s.perf);
      if (s.paused !== prev.paused) {
        sfx.setPaused(s.paused);
        if (s.paused) releaseAll();
      }
    });
    (window as unknown as { __startOrRetry: () => void }).__startOrRetry = startOrRetry;

    // Fixed-timestep simulation, variable-rate rendering.
    let acc = 0;
    view.engine.runRenderLoop(() => {
      const frameDt = Math.min(0.25, view.engine.getDeltaTime() / 1000);
      const store = useGameStore.getState();
      const paused = store.paused;
      if (!paused) acc += frameDt;
      const ticks = Math.floor(acc / DT);
      acc -= ticks * DT;
      if (ticks > 0 && store.game.phase === "playing" && !paused) {
        frameInput.up = input.up || tapped.up;
        frameInput.down = input.down || tapped.down;
        frameInput.left = input.left || tapped.left;
        frameInput.right = input.right || tapped.right;
        frameInput.attack = input.attack || touchInput.attack;
        if (touchInput.stick) {
          frameInput.mx = touchInput.mx;
          frameInput.my = touchInput.my;
        } else frameInput.mx = frameInput.my = undefined;
        store.step(frameInput, Math.min(ticks, 15));
        input.attack = false;
        touchInput.attack = false;
        tapped.up = tapped.down = tapped.left = tapped.right = false;
      } else if (store.game.phase !== "playing" || paused) {
        input.attack = false;
        touchInput.attack = false;
      }
      const game = useGameStore.getState().game;
      for (const ev of view.newEvents(game)) {
        sfx.play(ev.type);
        if (ev.type === "bossDie") sfx.stingVictory();
        view.handleEvent(ev);
      }
      // background music follows the situation; Sfx crossfades only when the track changes
      const f = game.flags;
      let track: "over" | "dungeon" | "boss" | null = null;
      if (game.phase === "playing" && game.victoryT < 0) {
        if (game.player.map === "over") track = "over";
        else track = f.bossAwake && !f.bossDefeated ? "boss" : "dungeon";
      }
      sfx.setTrack(track, game.phase === "gameover" ? 0.8 : f.bossAwake && !f.bossDefeated ? 0.6 : 1.6);
      view.sync(game, paused ? 0 : frameDt);
      view.render();
    });

    const onResize = () => view.resize();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    view.resize();

    // handy for debugging / automated checks
    (window as unknown as { __zeldo: unknown }).__zeldo = { store: useGameStore, view, sfx, touch: touchInput };

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", onAnyTouch, { capture: true });
      window.removeEventListener("contextmenu", prevent);
      document.removeEventListener("gesturestart", prevent);
      document.removeEventListener("dblclick", prevent);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      unsub();
      sfx.dispose();
      view.dispose();
      viewRef.current = null;
    };
  }, []);

  return (
    <div className="game-root relative h-full w-full select-none">
      <canvas ref={canvasRef} className="block h-full w-full outline-none" style={{ touchAction: "none" }} data-testid="canvas" />
      <Hud onStart={() => startRef.current()} touch={touchUI} />
      {touchUI && <TouchControls />}
      <PerfOverlay viewRef={viewRef} />
    </div>
  );
}
