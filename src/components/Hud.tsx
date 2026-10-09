"use client";
import { useEffect, useId, useState } from "react";
import { useGameStore } from "@/game/store";
import { fullscreenSupported, isFullscreen, isIOS, isStandalone, toggleFullscreen } from "@/lib/fullscreen";
import Minimap from "./Minimap";
import PauseMenu from "./PauseMenu";

function Heart({ fill }: { fill: 0 | 1 | 2 }) {
  const clip = `heart-clip-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 24 22" className="h-6 w-6 drop-shadow-[0_2px_0_rgba(0,0,0,0.4)] [@media(min-height:520px)]:h-7 [@media(min-height:520px)]:w-7">
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width={fill === 2 ? 24 : fill === 1 ? 12 : 0} height="22" />
        </clipPath>
      </defs>
      <path d="M12 21 L2.5 11.5 C-0.5 8.5 1 2 6.5 2 C9 2 11 3.6 12 5.5 C13 3.6 15 2 17.5 2 C23 2 24.5 8.5 21.5 11.5 Z" fill="#3a1820" stroke="#f3e2b0" strokeOpacity="0.55" strokeWidth="1.4" />
      <path d="M12 21 L2.5 11.5 C-0.5 8.5 1 2 6.5 2 C9 2 11 3.6 12 5.5 C13 3.6 15 2 17.5 2 C23 2 24.5 8.5 21.5 11.5 Z" fill="#ff4d5e" clipPath={`url(#${clip})`} />
      {fill > 0 && <ellipse cx="7" cy="7" rx="2.2" ry="1.4" fill="#ffd0d5" opacity="0.8" clipPath={`url(#${clip})`} />}
    </svg>
  );
}

function Rupee({ className = "h-5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 20" className={className}>
      <path d="M6 0 L12 5 L12 15 L6 20 L0 15 L0 5 Z" fill="#2ee88a" stroke="#0e5c35" strokeWidth="1" />
      <path d="M6 3 L9 6 L9 14 L6 17 Z" fill="#9dffc9" opacity="0.7" />
    </svg>
  );
}

function KeyIcon({ dim }: { dim: boolean }) {
  return (
    <svg viewBox="0 0 20 12" className={`h-4 w-6 ${dim ? "opacity-35 grayscale" : ""}`}>
      <circle cx="5" cy="6" r="4" fill="none" stroke="#f2c14b" strokeWidth="2.4" />
      <path d="M9 6 H19 M15 6 V10 M18 6 V9" stroke="#f2c14b" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function IconBtn({ id, label, onClick, children }: { id: string; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={id}
      onClick={onClick}
      className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-lg border-2 border-amber-200/50 bg-[#1b1424]/75 text-lg leading-none text-amber-50 shadow-[0_3px_0_rgba(0,0,0,0.35)] transition hover:brightness-125 active:translate-y-0.5"
    >
      {children}
    </button>
  );
}

const fmtTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

type FsMode = "on" | "off" | "ios" | "none";

export default function Hud({ onStart, touch }: { onStart: () => void; touch: boolean }) {
  const phase = useGameStore((s) => s.game.phase);
  const hp = useGameStore((s) => s.game.player.hp);
  const maxHp = useGameStore((s) => s.game.player.maxHp);
  const rupees = useGameStore((s) => s.game.player.rupees);
  const area = useGameStore((s) => s.game.area);
  const hurtCount = useGameStore((s) => s.game.player.hurtCount);
  const msgId = useGameStore((s) => s.game.message?.id ?? 0);
  const msgText = useGameStore((s) => s.game.message?.text ?? null);
  const keys = useGameStore((s) => (s.game.flags.hasKey && !s.game.flags.gateOpen ? 1 : 0));
  const bossAwake = useGameStore((s) => s.game.flags.bossAwake && !s.game.flags.bossDefeated);
  const boss = useGameStore((s) => {
    const b = s.game.enemies.find((e) => e.kind === "boss");
    return b ? Math.max(0, b.hp) / b.maxHp : 0;
  });
  const time = useGameStore((s) => Math.floor(s.game.time));
  const muted = useGameStore((s) => s.muted);
  const paused = useGameStore((s) => s.paused);
  const transition = useGameStore((s) => s.game.transitionCount);
  const [fade, setFade] = useState(false);
  const [fs, setFs] = useState<FsMode>("none");
  const [iosHint, setIosHint] = useState(false);
  const [portrait, setPortrait] = useState(false);

  useEffect(() => {
    if (transition === 0) return;
    setFade(true);
    const id = setTimeout(() => setFade(false), 60);
    return () => clearTimeout(id);
  }, [transition]);

  useEffect(() => {
    const update = () => {
      if (isStandalone()) setFs("none");
      else if (fullscreenSupported()) setFs(isFullscreen() ? "on" : "off");
      else setFs(isIOS() ? "ios" : "none");
      setPortrait(window.innerHeight > window.innerWidth * 1.05);
    };
    update();
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const onFullscreen = () => {
    if (fs === "ios") setIosHint(true);
    else void toggleFullscreen();
  };

  const hearts: (0 | 1 | 2)[] = [];
  for (let i = 0; i < maxHp / 2; i++) hearts.push(Math.max(0, Math.min(2, hp - i * 2)) as 0 | 1 | 2);
  const playing = phase === "playing";
  const verb = touch ? "Tap" : "Press Enter or click";

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
          {/* hearts + counters */}
          <div className="safe-tl frame-sm absolute z-20 flex flex-col gap-1 px-2.5 py-2" data-testid="status">
            <div className="flex gap-0.5" data-testid="hearts">
              {hearts.map((f, i) => (
                <Heart key={`heart-${i}`} fill={f} />
              ))}
            </div>
            <div className="flex items-center gap-3 text-base font-black [@media(min-height:520px)]:text-lg">
              <span className="flex items-center gap-1.5" data-testid="rupees">
                <Rupee />
                <span className="tabular-nums">{rupees.toString().padStart(3, "0")}</span>
              </span>
              <span className="flex items-center gap-1" data-testid="keys" title="Mossgrave Key">
                <KeyIcon dim={keys === 0} />
                <span className={`tabular-nums ${keys ? "text-amber-300" : "text-amber-50/40"}`}>×{keys}</span>
              </span>
            </div>
          </div>

          {/* area plate */}
          {!bossAwake && (
            <div className="safe-tc absolute z-10 hidden -translate-x-1/2 sm:block" data-testid="area">
              <div className="plate px-5 py-1 text-sm font-bold tracking-wide text-amber-100">{area}</div>
            </div>
          )}
          <div key={`area-${area}`} className="area-banner absolute left-1/2 top-[22%] -translate-x-1/2 text-center">
            <div className="text-[10px] font-bold uppercase tracking-[0.5em] text-amber-200/80">— entering —</div>
            <div className="whitespace-nowrap text-2xl font-black tracking-widest text-amber-50 drop-shadow-[0_3px_0_rgba(0,0,0,0.6)] [@media(min-height:520px)]:text-3xl">{area}</div>
          </div>

          {/* minimap + buttons */}
          <div className="safe-tr absolute z-20 flex flex-col items-end gap-1.5">
            <div className="frame-sm p-1.5">
              <Minimap />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-xs font-bold tabular-nums text-amber-50/75 drop-shadow" data-testid="timer">{fmtTime(time)}</span>
              {fs !== "none" && (
                <IconBtn id="fullscreen-btn" label={fs === "on" ? "Exit fullscreen" : "Fullscreen"} onClick={onFullscreen}>
                  {fs === "on" ? "⤡" : "⤢"}
                </IconBtn>
              )}
              <IconBtn id="mute-btn" label={muted ? "Unmute (M)" : "Mute (M)"} onClick={() => useGameStore.getState().toggleMute()}>
                {muted ? "🔇" : "🔊"}
              </IconBtn>
              {playing && (
                <IconBtn id="pause-btn" label="Pause (Esc)" onClick={() => useGameStore.getState().togglePause()}>
                  ❚❚
                </IconBtn>
              )}
            </div>
          </div>
        </>
      )}

      {bossAwake && playing && (
        <div className="safe-tc absolute z-10 w-[min(440px,46vw)] -translate-x-1/2" data-testid="bossbar">
          <div className="frame-sm px-3 pb-2 pt-1">
            <div className="mb-1 flex items-center justify-center gap-2 text-[11px] font-black uppercase tracking-[0.3em] text-rose-200">
              <span>☠</span> Gloomgulp, Vault Warden <span>☠</span>
            </div>
            <div className="h-3.5 overflow-hidden rounded-sm border-2 border-black/80 bg-[#2a0a12] shadow-[inset_0_2px_0_rgba(0,0,0,0.5)]">
              <div className="h-full bg-gradient-to-b from-rose-400 via-rose-600 to-rose-800 transition-[width] duration-200" style={{ width: `${boss * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {msgText && playing && (
        // on phones messages sit up top so they never cover the thumbs; keyboard hints become touch hints
        <div
          key={`msg-${msgId}`}
          className={`${touch ? "top-[22%]" : "safe-msg"} frame pop-in absolute left-1/2 z-10 max-w-[min(640px,70vw)] -translate-x-1/2 px-5 py-2.5 text-center text-base font-semibold [@media(min-height:520px)]:text-lg`}
          data-testid="message"
        >
          {touch ? msgText.replace(/\(WASD to move · Space to swing\)/, "(left thumb to move · ⚔ to swing)") : msgText}
        </div>
      )}

      {touch && portrait && phase !== "title" && (
        <div className="safe-msg absolute left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-4 py-1.5 text-sm font-bold" data-testid="rotate-hint" style={{ bottom: "auto", top: "45%" }}>
          ⟳ Rotate to landscape for the best view
        </div>
      )}

      {paused && playing && <PauseMenu fs={fs} onFullscreen={onFullscreen} touch={touch} />}

      {iosHint && (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-black/70" data-testid="ios-hint" onClick={() => setIosHint(false)}>
          <div className="frame pop-in max-w-[min(360px,88vw)] p-5 text-center">
            <div className="text-lg font-black">Play fullscreen on iPhone</div>
            <p className="mt-2 text-sm text-amber-50/85">
              Safari can&apos;t go fullscreen from a page. Tap <b>Share</b> <span aria-hidden>⎋</span> then <b>Add to Home Screen</b>, and launch Zeldo from your home screen — it opens fullscreen, in landscape.
            </p>
            <div className="mt-4 text-xs text-amber-200/70">tap to close</div>
          </div>
        </div>
      )}

      {phase === "title" && (
        <div className="screen pointer-events-auto absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-gradient-to-b from-[#1b1424]/75 via-[#1b1424]/30 to-[#1b1424]/85" onClick={onStart} data-testid="title">
          <div className="pop-in px-4 text-center">
            <div className="text-[11px] font-bold uppercase tracking-[0.5em] text-amber-200/80">a tiny low-poly adventure</div>
            <h1 className="title-glow mt-1 text-6xl font-black tracking-tight text-amber-50 [@media(min-height:520px)]:text-8xl">ZELDO</h1>
            <div className="mt-1 text-xl font-bold text-teal-200 drop-shadow-[0_3px_0_rgba(0,0,0,0.5)] [@media(min-height:520px)]:text-2xl">— The Hollow Sunstone —</div>
            <p className="mx-auto mt-4 hidden max-w-md text-amber-50/85 [@media(min-height:520px)]:block">
              Something stirs beneath Cinderstone Crags. Find the vault, claim its key, best the Warden, and bring the Sunstone home to Hearthollow.
            </p>
            <div className="pulse-soft mt-6 text-xl font-bold text-amber-100" data-testid="start-prompt">{touch ? "Tap to begin" : "Press Enter or click to begin"}</div>
            <div className="frame-sm mx-auto mt-5 grid w-fit grid-cols-2 gap-x-5 gap-y-0.5 px-4 py-2 text-sm text-amber-50/80">
              {touch ? (
                <>
                  <span className="text-right font-semibold">Left thumb</span>
                  <span className="text-left">move</span>
                  <span className="text-right font-semibold">⚔ button</span>
                  <span className="text-left">swing sword</span>
                </>
              ) : (
                <>
                  <span className="text-right font-semibold">WASD / Arrows</span>
                  <span className="text-left">move</span>
                  <span className="text-right font-semibold">Space / Click</span>
                  <span className="text-left">swing sword</span>
                  <span className="text-right font-semibold">Esc · M · F3</span>
                  <span className="text-left">pause · mute · perf</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === "gameover" && (
        <div className="screen pointer-events-auto absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-gradient-to-b from-[#2a0a12]/85 via-[#2a0a12]/60 to-black/85" onClick={onStart} data-testid="gameover">
          <div className="pop-in text-center">
            <div className="text-[11px] font-bold uppercase tracking-[0.5em] text-rose-300/80">game over</div>
            <h2 className="mt-1 text-6xl font-black text-rose-200 drop-shadow-[0_5px_0_rgba(0,0,0,0.5)]">You Fell…</h2>
            <p className="mt-3 text-amber-50/80">The gloomlings snicker. Hearthollow still needs you.</p>
            <div className="frame-sm mx-auto mt-5 flex w-fit gap-6 px-5 py-2 text-lg font-bold">
              <span className="tabular-nums">⏱ {fmtTime(time)}</span>
              <span className="flex items-center gap-1.5 tabular-nums"><Rupee /> {rupees}</span>
            </div>
            <div className="pulse-soft mt-7 text-xl font-bold">{verb} to try again</div>
          </div>
        </div>
      )}

      {phase === "victory" && (
        <div className="screen pointer-events-auto absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-gradient-to-b from-amber-200/35 via-[#1b1424]/60 to-[#1b1424]/90" onClick={onStart} data-testid="victory">
          <div className="pop-in text-center">
            <div className="text-[11px] font-bold uppercase tracking-[0.5em] text-amber-200">quest complete</div>
            <h2 className="title-glow mt-1 text-5xl font-black text-amber-50 [@media(min-height:520px)]:text-6xl">The Sunstone is Yours!</h2>
            <div className="frame mx-auto mt-6 flex w-fit justify-center gap-10 px-8 py-3 text-2xl font-bold">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-amber-200/80">Time</div>
                <div className="tabular-nums" data-testid="victory-time">{fmtTime(time)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-amber-200/80">Rupees</div>
                <div className="flex items-center justify-center gap-2 tabular-nums" data-testid="victory-rupees">
                  <Rupee className="h-6 w-4" /> {rupees}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-amber-200/80">Hearts</div>
                <div className="tabular-nums">{(hp / 2).toFixed(1)}</div>
              </div>
            </div>
            <div className="pulse-soft mt-8 text-xl font-bold">{verb} to play again</div>
          </div>
        </div>
      )}
    </div>
  );
}
