"use client";
import { useState } from "react";
import { useGameStore } from "@/game/store";

function Btn({ id, children, onClick, primary }: { id: string; children: React.ReactNode; onClick: () => void; primary?: boolean }) {
return (
  <button
    type="button"
    data-testid={id}
    onClick={onClick}
    className={`w-full rounded-lg border-2 px-4 py-2 text-left text-base font-bold transition hover:translate-x-0.5 hover:brightness-110 active:scale-[0.98] ${
      primary ? "border-amber-200 bg-amber-300/90 text-[#2a1d33]" : "border-amber-200/40 bg-[#2a1d33]/80 text-amber-50"
    }`}
  >
    {children}
  </button>
);
}

export default function PauseMenu({ fs, onFullscreen, touch }: { fs: "on" | "off" | "ios" | "none"; onFullscreen: () => void; touch: boolean }) {
  const muted = useGameStore((s) => s.muted);
  const perf = useGameStore((s) => s.perf);
  const [help, setHelp] = useState(false);
  const st = useGameStore.getState;
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#120c18]/70 backdrop-blur-[2px]" data-testid="pause-menu">
      <div className="frame pop-in w-[min(340px,86vw)] max-h-[92dvh] overflow-y-auto p-5">
        <div className="mb-3 text-center text-xs font-bold uppercase tracking-[0.45em] text-amber-200/80">— Paused —</div>
        <div className="flex flex-col gap-2">
          <Btn id="pause-resume" primary onClick={() => st().setPaused(false)}>▶ Resume</Btn>
          <Btn id="pause-controls" onClick={() => setHelp((h) => !h)}>🎮 Controls {help ? "▴" : "▾"}</Btn>
          {help && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-black/30 px-3 py-2 text-sm text-amber-50/85" data-testid="controls-help">
              {touch ? (
                <>
                  <b>Left thumb</b><span>drag anywhere to move</span>
                  <b>⚔ button</b><span>swing sword</span>
                </>
              ) : (
                <>
                  <b>WASD / ←↑→↓</b><span>move</span>
                  <b>Space / click</b><span>swing sword</span>
                </>
              )}
              <b>Esc / P</b><span>pause</span>
              <b>M</b><span>mute</span>
              <b>F3 / `</b><span>perf overlay</span>
            </div>
          )}
          <Btn id="pause-mute" onClick={() => st().toggleMute()}>{muted ? "🔇 Sound: off" : "🔊 Sound: on"}</Btn>
          {fs !== "none" && (
            <Btn id="pause-fullscreen" onClick={onFullscreen}>
              {fs === "on" ? "⤡ Exit fullscreen" : fs === "ios" ? "⤢ Fullscreen (Add to Home Screen)" : "⤢ Fullscreen"}
            </Btn>
          )}
          <Btn id="pause-perf" onClick={() => st().togglePerf()}>📈 Perf overlay: {perf ? "on" : "off"}</Btn>
        </div>
      </div>
    </div>
  );
}
