"use client";
import { useEffect, useId, useState } from "react";
import { useGameStore } from "@/game/store";

function Heart({ fill }: { fill: 0 | 1 | 2 }) {
  const clip = `heart-clip-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 24 22" className="h-7 w-7 drop-shadow-[0_2px_0_rgba(0,0,0,0.35)]">
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width={fill === 2 ? 24 : fill === 1 ? 12 : 0} height="22" />
        </clipPath>
      </defs>
      <path d="M12 21 L2.5 11.5 C-0.5 8.5 1 2 6.5 2 C9 2 11 3.6 12 5.5 C13 3.6 15 2 17.5 2 C23 2 24.5 8.5 21.5 11.5 Z" fill="#3a1820" stroke="#1b1424" strokeWidth="1.5" />
      <path
        d="M12 21 L2.5 11.5 C-0.5 8.5 1 2 6.5 2 C9 2 11 3.6 12 5.5 C13 3.6 15 2 17.5 2 C23 2 24.5 8.5 21.5 11.5 Z"
        fill="#ff4d5e"
        clipPath={`url(#${clip})`}
      />
      {fill > 0 && <ellipse cx="7" cy="7" rx="2.2" ry="1.4" fill="#ffd0d5" opacity="0.8" clipPath={`url(#${clip})`} />}
    </svg>
  );
}

function Rupee() {
  return (
    <svg viewBox="0 0 12 20" className="h-6 w-4">
      <path d="M6 0 L12 5 L12 15 L6 20 L0 15 L0 5 Z" fill="#2ee88a" stroke="#0e5c35" strokeWidth="1" />
      <path d="M6 3 L9 6 L9 14 L6 17 Z" fill="#9dffc9" opacity="0.7" />
    </svg>
  );
}

const fmtTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

export default function Hud({ onStart }: { onStart: () => void }) {
  const phase = useGameStore((s) => s.game.phase);
  const hp = useGameStore((s) => s.game.player.hp);
  const maxHp = useGameStore((s) => s.game.player.maxHp);
  const rupees = useGameStore((s) => s.game.player.rupees);
  const area = useGameStore((s) => s.game.area);
  const hurtCount = useGameStore((s) => s.game.player.hurtCount);
  const msgId = useGameStore((s) => s.game.message?.id ?? 0);
  const msgText = useGameStore((s) => s.game.message?.text ?? null);
  const hasKey = useGameStore((s) => s.game.flags.hasKey && !s.game.flags.gateOpen);
  const bossAwake = useGameStore((s) => s.game.flags.bossAwake && !s.game.flags.bossDefeated);
  const boss = useGameStore((s) => {
    const b = s.game.enemies.find((e) => e.kind === "boss");
    return b ? b.hp / b.maxHp : 0;
  });
  const time = useGameStore((s) => Math.floor(s.game.time));
  const muted = useGameStore((s) => s.muted);
  const transition = useGameStore((s) => s.game.transitionCount);
  const [fade, setFade] = useState(false);

  useEffect(() => {
    if (transition === 0) return;
    setFade(true);
    const id = setTimeout(() => setFade(false), 60);
    return () => clearTimeout(id);
  }, [transition]);

  const hearts: (0 | 1 | 2)[] = [];
  for (let i = 0; i < maxHp / 2; i++) hearts.push(Math.max(0, Math.min(2, hp - i * 2)) as 0 | 1 | 2);

  return (
    <div className="pointer-events-none absolute inset-0 text-amber-50">
      {/* damage flash: red vignette */}
      {hurtCount > 0 && (
        <div
          key={`hurt-${hurtCount}`}
          className="hurt-flash absolute inset-0"
          style={{ boxShadow: "inset 0 0 140px 50px rgba(255,30,50,0.75)", background: "radial-gradient(ellipse at center, transparent 55%, rgba(255,20,40,0.35) 100%)" }}
        />
      )}
      {/* room transition fade */}
      <div className={`absolute inset-0 bg-black transition-opacity ${fade ? "opacity-100 duration-0" : "opacity-0 duration-500"}`} />

      {phase !== "title" && (
        <>
          <div className="absolute left-4 top-4 flex flex-col gap-2">
            <div className="flex gap-1" data-testid="hearts">
              {hearts.map((f, i) => (
                <Heart key={`heart-${i}`} fill={f} />
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-full bg-black/35 px-3 py-1 text-lg font-bold" data-testid="rupees">
              <Rupee />
              <span className="tabular-nums">{rupees.toString().padStart(3, "0")}</span>
              {hasKey && <span className="ml-2 text-amber-300" title="Mossgrave Key">🗝</span>}
            </div>
          </div>
          <div className="absolute right-4 top-4 flex flex-col items-end gap-1">
            <div className="rounded-lg bg-black/40 px-3 py-1 text-sm font-semibold tracking-wide text-amber-100" data-testid="area">
              {area}
            </div>
            <div className="text-xs text-amber-50/70">
              {fmtTime(time)} · {muted ? "🔇 muted (M)" : "🔊 M to mute"}
            </div>
          </div>
          <div key={`area-${area}`} className="area-banner absolute left-1/2 top-16 -translate-x-1/2 text-center">
            <div className="text-2xl font-black tracking-widest text-amber-50 drop-shadow-[0_3px_0_rgba(0,0,0,0.5)]">{area}</div>
          </div>
        </>
      )}

      {bossAwake && phase === "playing" && (
        <div className="absolute left-1/2 top-4 w-[min(420px,60vw)] -translate-x-1/2" data-testid="bossbar">
          <div className="mb-1 text-center text-xs font-bold uppercase tracking-[0.3em] text-rose-200 drop-shadow">Gloomgulp, Vault Warden</div>
          <div className="h-4 overflow-hidden rounded-full border-2 border-black/70 bg-black/60">
            <div className="h-full bg-gradient-to-r from-rose-600 to-amber-400 transition-[width] duration-200" style={{ width: `${boss * 100}%` }} />
          </div>
        </div>
      )}

      {msgText && phase === "playing" && (
        <div key={`msg-${msgId}`} className="pop-in absolute bottom-8 left-1/2 max-w-[80vw] -translate-x-1/2 rounded-xl border-2 border-amber-200/60 bg-[#1b1424]/85 px-6 py-3 text-center text-lg font-semibold shadow-xl">
          {msgText}
        </div>
      )}

      {phase === "title" && (
        <div className="pointer-events-auto absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-gradient-to-b from-[#1b1424]/70 via-[#1b1424]/30 to-[#1b1424]/80" onClick={onStart} data-testid="title">
          <div className="pop-in text-center">
            <div className="text-sm font-bold uppercase tracking-[0.5em] text-amber-200/80">a tiny low-poly adventure</div>
            <h1 className="mt-2 text-7xl font-black tracking-tight text-amber-50 drop-shadow-[0_6px_0_rgba(0,0,0,0.45)] sm:text-8xl">ZELDO</h1>
            <div className="mt-1 text-2xl font-bold text-teal-200 drop-shadow-[0_3px_0_rgba(0,0,0,0.5)]">The Hollow Sunstone</div>
            <p className="mx-auto mt-6 max-w-md text-amber-50/85">
              Something stirs beneath Cinderstone Crags. Find the vault, claim its key, best the Warden, and bring the Sunstone home to Hearthollow.
            </p>
            <div className="pulse-soft mt-8 text-xl font-bold text-amber-100">Press Enter or click to begin</div>
            <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-amber-50/70">
              <span className="text-right font-semibold">WASD / Arrows</span>
              <span className="text-left">move</span>
              <span className="text-right font-semibold">Space / Click</span>
              <span className="text-left">swing sword</span>
              <span className="text-right font-semibold">M</span>
              <span className="text-left">mute</span>
            </div>
          </div>
        </div>
      )}

      {phase === "gameover" && (
        <div className="pointer-events-auto absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-[#2a0a12]/75" onClick={onStart} data-testid="gameover">
          <div className="pop-in text-center">
            <h2 className="text-6xl font-black text-rose-200 drop-shadow-[0_5px_0_rgba(0,0,0,0.5)]">You Fell…</h2>
            <p className="mt-3 text-amber-50/80">The gloomlings snicker. Hearthollow still needs you.</p>
            <div className="pulse-soft mt-8 text-xl font-bold">Press Enter or click to try again</div>
          </div>
        </div>
      )}

      {phase === "victory" && (
        <div className="pointer-events-auto absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-gradient-to-b from-amber-200/30 via-[#1b1424]/60 to-[#1b1424]/90" onClick={onStart} data-testid="victory">
          <div className="pop-in text-center">
            <div className="text-sm font-bold uppercase tracking-[0.5em] text-amber-200">Quest complete</div>
            <h2 className="mt-2 text-6xl font-black text-amber-50 drop-shadow-[0_5px_0_rgba(0,0,0,0.45)]">The Sunstone is Yours!</h2>
            <div className="mx-auto mt-8 flex justify-center gap-10 text-2xl font-bold">
              <div>
                <div className="text-xs uppercase tracking-widest text-amber-200/80">Time</div>
                <div className="tabular-nums" data-testid="victory-time">{fmtTime(time)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-widest text-amber-200/80">Rupees</div>
                <div className="flex items-center justify-center gap-2 tabular-nums" data-testid="victory-rupees">
                  <Rupee /> {rupees}
                </div>
              </div>
            </div>
            <div className="pulse-soft mt-10 text-xl font-bold">Press Enter or click to play again</div>
          </div>
        </div>
      )}
    </div>
  );
}
