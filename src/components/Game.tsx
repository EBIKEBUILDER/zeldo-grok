"use client";
import { useEffect, useRef } from "react";
import { Sfx } from "@/game/audio";
import { DT } from "@/game/constants";
import { GameView } from "@/game/render/view";
import { useGameStore } from "@/game/store";
import type { InputState } from "@/game/types";
import Hud from "./Hud";

const KEYMAP: Record<string, keyof Omit<InputState, "attack">> = {
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
  const sfxRef = useRef<Sfx | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const view = new GameView(canvas);
    const sfx = (sfxRef.current = new Sfx());
    sfx.setMuted(useGameStore.getState().muted);
    const input: InputState = { up: false, down: false, left: false, right: false, attack: false };
    // Keys tapped between two sim ticks still count for one tick (no lost quick taps on slow frames).
    const tapped = { up: false, down: false, left: false, right: false };

    const startOrRetry = () => {
      sfx.unlock();
      const { game, start, retry } = useGameStore.getState();
      if (game.phase === "title") start();
      else if (game.phase === "gameover" || game.phase === "victory") retry();
    };

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
        if (!e.repeat && useGameStore.getState().game.phase === "playing") input.attack = true;
      }
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        if (!e.repeat) startOrRetry();
      }
      if (e.code === "KeyM" && !e.repeat) {
        useGameStore.getState().toggleMute();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = KEYMAP[e.code];
      if (dir) input[dir] = false;
    };
    const onBlur = () => {
      input.up = input.down = input.left = input.right = false;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      sfx.unlock();
      if (useGameStore.getState().game.phase === "playing") input.attack = true;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    canvas.addEventListener("pointerdown", onPointerDown);
    const unsubMute = useGameStore.subscribe((s, prev) => {
      if (s.muted !== prev.muted) sfx.setMuted(s.muted);
    });
    (window as unknown as { __startOrRetry: () => void }).__startOrRetry = startOrRetry;

    // Fixed-timestep simulation, variable-rate rendering.
    let acc = 0;
    view.engine.runRenderLoop(() => {
      const frameDt = Math.min(0.25, view.engine.getDeltaTime() / 1000);
      acc += frameDt;
      const ticks = Math.floor(acc / DT);
      acc -= ticks * DT;
      const store = useGameStore.getState();
      if (ticks > 0 && store.game.phase === "playing") {
        const frameInput: InputState = {
          up: input.up || tapped.up,
          down: input.down || tapped.down,
          left: input.left || tapped.left,
          right: input.right || tapped.right,
          attack: input.attack,
        };
        store.step(frameInput, Math.min(ticks, 15));
        input.attack = false;
        tapped.up = tapped.down = tapped.left = tapped.right = false;
      } else if (store.game.phase !== "playing") input.attack = false;
      const game = useGameStore.getState().game;
      for (const ev of view.newEvents(game)) {
        sfx.play(ev.type);
        view.handleEvent(ev);
      }
      view.sync(game, frameDt);
      view.render();
    });

    const onResize = () => view.engine.resize();
    window.addEventListener("resize", onResize);

    // handy for debugging / automated checks
    (window as unknown as { __zeldo: unknown }).__zeldo = { store: useGameStore, view };

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      unsubMute();
      view.dispose();
    };
  }, []);

  const onOverlayClick = () => {
    (window as unknown as { __startOrRetry?: () => void }).__startOrRetry?.();
  };

  return (
    <div className="relative h-full w-full select-none">
      <canvas ref={canvasRef} className="block h-full w-full outline-none" style={{ touchAction: "none" }} />
      <Hud onStart={onOverlayClick} />
    </div>
  );
}
