"use client";
import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useGameStore } from "@/game/store";
import { touchInput } from "@/game/touch";

const RADIUS = 56; // px of thumb travel for full deflection

/**
 * Mobile controls: a floating analog stick that appears wherever the left thumb lands, and a big
 * sword button on the right. Writes into `touchInput`; the game loop folds it into the sim input.
 */
export default function TouchControls() {
  const phase = useGameStore((s) => s.game.phase);
  const paused = useGameStore((s) => s.paused);
  const stickId = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const [stick, setStick] = useState<{ ox: number; oy: number; kx: number; ky: number } | null>(null);
  const [pressed, setPressed] = useState(false);

  if (phase !== "playing" || paused) return null;

  const move = (e: RPointerEvent, ox: number, oy: number) => {
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const l = Math.hypot(dx, dy);
    if (l > RADIUS) {
      dx = (dx / l) * RADIUS;
      dy = (dy / l) * RADIUS;
    }
    touchInput.mx = dx / RADIUS;
    touchInput.my = dy / RADIUS;
    touchInput.stick = true;
    setStick({ ox, oy, kx: dx, ky: dy });
  };
  const end = (e: RPointerEvent) => {
    if (e.pointerId !== stickId.current) return;
    stickId.current = null;
    touchInput.mx = touchInput.my = 0;
    touchInput.stick = false;
    setStick(null);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-10" data-testid="touch-controls">
      <div
        className="pointer-events-auto absolute bottom-0 left-0 top-[18%] w-1/2"
        style={{ touchAction: "none" }}
        data-testid="joystick-zone"
        onPointerDown={(e) => {
          if (stickId.current !== null) return;
          stickId.current = e.pointerId;
          e.currentTarget.setPointerCapture(e.pointerId);
          origin.current = { x: e.clientX, y: e.clientY };
          move(e, e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.pointerId === stickId.current) move(e, origin.current.x, origin.current.y);
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {!stick && (
          <div className="safe-bl absolute flex h-28 w-28 items-center justify-center rounded-full border-2 border-dashed border-amber-100/25 text-[10px] font-bold uppercase tracking-widest text-amber-100/40">
            move
          </div>
        )}
      </div>
      {stick && (
        <>
          <div
            className="pointer-events-none fixed rounded-full border-2 border-amber-100/40 bg-black/25"
            style={{ width: RADIUS * 2 + 28, height: RADIUS * 2 + 28, left: stick.ox - RADIUS - 14, top: stick.oy - RADIUS - 14 }}
            data-testid="joystick-base"
          />
          <div
            className="pointer-events-none fixed h-14 w-14 rounded-full border-2 border-amber-50/80 bg-amber-100/40 shadow-lg"
            style={{ left: stick.ox + stick.kx - 28, top: stick.oy + stick.ky - 28 }}
            data-testid="joystick-knob"
          />
        </>
      )}
      <button
        type="button"
        aria-label="Swing sword"
        data-testid="attack-btn"
        className={`safe-br pointer-events-auto absolute flex h-24 w-24 items-center justify-center rounded-full border-4 border-amber-200/80 bg-gradient-to-b from-amber-500/70 to-rose-700/70 text-amber-50 shadow-[0_6px_0_rgba(0,0,0,0.35)] transition-transform ${pressed ? "translate-y-1 scale-95" : ""}`}
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          touchInput.attack = true;
          setPressed(true);
        }}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
      >
        <svg viewBox="0 0 24 24" className="h-11 w-11 drop-shadow" aria-hidden>
          <path d="M19 3 L21 3 L21 5 L10 16 L8 14 Z" fill="#f4f1e6" stroke="#2a1d33" strokeWidth="1.2" />
          <path d="M6.5 12.5 L11.5 17.5 L10 19 L5 14 Z" fill="#f2c14b" stroke="#2a1d33" strokeWidth="1.2" />
          <path d="M7.5 16.5 L4 20" stroke="#8a5a2b" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
