import GameLoader from "@/components/GameLoader";

export default function Home() {
  return (
    <main className="fixed inset-0 h-dvh w-full overflow-hidden">
      <GameLoader />
    </main>
  );
}
