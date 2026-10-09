/** Small deterministic PRNG (mulberry32). State is a plain number so it can live in the store. */
export function mulberry(state: { rng: number }): number {
  let a = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  let t = Math.imul(a ^ (a >>> 15), a | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Stateless helper for build-time / view-time decoration. */
export function makeRng(seed: number): () => number {
  const s = { rng: seed | 0 };
  return () => mulberry(s);
}

/** Hash two ints to a 0..1 float (stable per tile). */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
