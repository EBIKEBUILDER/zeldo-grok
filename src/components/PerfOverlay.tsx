"use client";
import { useEffect, useRef, type RefObject } from "react";
import type { GameView } from "@/game/render/view";
import { useGameStore } from "@/game/store";

/** F3 / ` / pause menu. Reads Babylon instrumentation at 4 Hz straight into the DOM (no re-renders). */
export default function PerfOverlay({ viewRef }: { viewRef: RefObject<GameView | null> }) {
  const on = useGameStore((s) => s.perf);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!on) return;
    const tick = () => {
      const v = viewRef.current;
      if (!v || !pre.current) return;
      const p = v.perfStats();
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
      pre.current.textContent =
        `FPS     ${p.fps.toFixed(0)}\n` +
        `frame   ${p.frameMs < 0 ? "…" : `${p.frameMs.toFixed(1)} ms`}\n` +
        `GPU     ${p.gpuMs === null ? "n/a" : `${p.gpuMs.toFixed(2)} ms`}\n` +
        `draws   ${p.drawCalls < 0 ? "…" : p.drawCalls}\n` +
        `meshes  ${p.activeMeshes}/${p.totalMeshes}\n` +
        `tris    ${k(p.tris)}\n` +
        `verts   ${k(p.verts)}\n` +
        `scale   ${p.hwScale.toFixed(2)}`;
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [on, viewRef]);
  if (!on) return null;
  return (
    <pre
      ref={pre}
      data-testid="perf"
      className="safe-bl-perf pointer-events-none absolute z-30 m-0 rounded-md border border-lime-300/30 bg-black/70 px-2.5 py-1.5 font-mono text-[11px] leading-tight text-lime-200"
    />
  );
}
