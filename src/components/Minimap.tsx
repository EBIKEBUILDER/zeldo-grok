"use client";
import { useGameStore } from "@/game/store";
import { chestVisible } from "@/game/sim";
import { GATE_ROW, OVER_DOOR } from "@/game/world";

const AREA_FILL = [
  ["#3f7a3a", "#9a8a5a", "#3a8aa0"],
  ["#8cc05a", "#79b25e", "#b8a64e"],
];
const CW = 30, CH = 22; // one overworld screen (16×12 tiles) on the map

/** 3×2 overworld map with fog of war, or the vault's two rooms while inside. */
export default function Minimap() {
  const map = useGameStore((s) => s.game.player.map);
  const px = useGameStore((s) => Math.round(s.game.player.x * 2) / 2);
  const py = useGameStore((s) => Math.round(s.game.player.y * 2) / 2);
  const explored = useGameStore((s) => s.game.explored.join(""));
  const bossDown = useGameStore((s) => s.game.flags.bossDefeated);
  const gateOpen = useGameStore((s) => s.game.flags.gateOpen);
  const chest = useGameStore((s) => chestVisible(s.game) && !s.game.flags.chestOpened);
  const ex = (i: number) => explored[i] === "1";

  if (map === "dungeon") {
    // hall rows 0..10, antechamber 12..22 (16 wide) → 64×48 box
    const sx = 64 / 16, sy = 48 / 23;
    return (
      <svg viewBox="-3 -3 70 54" className="h-[54px] w-[70px] [@media(min-height:520px)]:h-[72px] [@media(min-height:520px)]:w-[94px]" data-testid="minimap" data-mode="dungeon">
        <rect x={0} y={0} width={64} height={GATE_ROW * sy} rx={2} fill={ex(7) ? "#5d5470" : "#241d2e"} stroke="#e8d6a0" strokeWidth={1} />
        <rect x={0} y={(GATE_ROW + 1) * sy} width={64} height={(23 - GATE_ROW - 1) * sy} rx={2} fill={ex(6) ? "#4d4560" : "#241d2e"} stroke="#e8d6a0" strokeWidth={1} />
        <rect x={7 * sx} y={GATE_ROW * sy - 0.5} width={2 * sx} height={sy + 1} fill={gateOpen ? "#4d4560" : "#d04050"} />
        <rect x={7 * sx} y={22 * sy} width={2 * sx} height={sy} fill="#e8d6a0" />
        {ex(7) && !bossDown && <text x={32} y={8 * sy} fontSize={9} textAnchor="middle">💀</text>}
        {chest && <text x={8 * sx} y={3.6 * sy} fontSize={8} textAnchor="middle">✦</text>}
        <circle cx={px * sx} cy={py * sy} r={2.6} fill="#fff6c2" stroke="#1b1424" strokeWidth={1} className="pulse-soft" data-testid="minimap-player" />
      </svg>
    );
  }
  const cur = Math.min(1, Math.max(0, Math.floor(py / 12))) * 3 + Math.min(2, Math.max(0, Math.floor(px / 16)));
  return (
    <svg viewBox="-2 -2 94 48" className="h-[48px] w-[94px] [@media(min-height:520px)]:h-[62px] [@media(min-height:520px)]:w-[122px]" data-testid="minimap" data-mode="over">
      {[0, 1].map((r) =>
        [0, 1, 2].map((c) => {
          const i = r * 3 + c;
          return (
            <g key={`cell-${i}`}>
              <rect x={c * CW + 0.5} y={r * CH + 0.5} width={CW - 1} height={CH - 1} rx={2} fill={ex(i) ? AREA_FILL[r][c] : "#241d2e"} opacity={ex(i) ? 0.9 : 1} />
              {!ex(i) && (
                <text x={c * CW + CW / 2} y={r * CH + CH / 2 + 3} fontSize={8} textAnchor="middle" fill="#6d6080">?</text>
              )}
              {i === cur && <rect x={c * CW + 0.5} y={r * CH + 0.5} width={CW - 1} height={CH - 1} rx={2} fill="none" stroke="#fff6c2" strokeWidth={1.2} />}
            </g>
          );
        }),
      )}
      {/* vault entrance */}
      <g transform={`translate(${((OVER_DOOR.x0 + 1) / 16) * CW} ${(OVER_DOOR.y / 12) * CH})`} data-testid="minimap-dungeon">
        <path d="M-4 3 L-4 -1 A4 4 0 0 1 4 -1 L4 3 Z" fill="#1b1424" stroke="#f2c14b" strokeWidth={1} />
      </g>
      <circle cx={(px / 16) * CW} cy={(py / 12) * CH} r={2.4} fill="#fff6c2" stroke="#1b1424" strokeWidth={1} className="pulse-soft" data-testid="minimap-player" />
    </svg>
  );
}
