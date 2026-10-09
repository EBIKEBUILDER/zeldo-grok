import { create } from "zustand";
import { DT } from "./constants";
import { createInitialState, startGame, stepGame } from "./sim";
import type { GameState, InputState } from "./types";

/**
 * The single source of truth. `game` is plain serializable data (JSON-safe);
 * the sim mutates it in place each fixed tick and we bump `frame` so subscribers re-run selectors.
 */
export interface GameStore {
  game: GameState;
  frame: number;
  muted: boolean;
  start: () => void;
  retry: () => void;
  step: (input: InputState, ticks?: number) => void;
  toggleMute: () => void;
}

export const useGameStore = create<GameStore>((set, get) => ({
  game: createInitialState(),
  frame: 0,
  muted: false,
  start: () => {
    const g = get().game;
    if (g.phase === "title") {
      startGame(g);
      set({ game: g, frame: get().frame + 1 });
    }
  },
  retry: () => {
    const g = createInitialState((Date.now() & 0xffff) + 1);
    g.msgSeq = get().game.msgSeq; // keep message ids unique across retries
    startGame(g);
    set({ game: g, frame: get().frame + 1 });
  },
  step: (input, ticks = 1) => {
    const g = get().game;
    for (let i = 0; i < ticks; i++) {
      stepGame(g, input, DT);
      input.attack = false;
    }
    set({ frame: get().frame + 1 });
  },
  toggleMute: () => set({ muted: !get().muted }),
}));
