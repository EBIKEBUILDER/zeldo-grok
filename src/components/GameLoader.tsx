"use client";
import dynamic from "next/dynamic";

const Game = dynamic(() => import("./Game"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-amber-100/70">Loading…</div>
  ),
});

export default function GameLoader() {
  return <Game />;
}
