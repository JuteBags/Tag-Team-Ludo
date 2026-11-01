import type { GameState, Rng } from './types';

/** Seeded generator for tests and replays. */
export function seeded(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Production generator backed by the platform CSPRNG. */
export const cryptoRng: Rng = () => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! / 4294967296;
};

/** A 32-bit seed from a game's seed and a text key (FNV-1a), for dice that depend on the position. */
export function mixSeed(seed: number, key: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The engine state that decides the dice: where every token is, whose roll it is, and the tray. */
export const positionKey = (s: GameState) => JSON.stringify([s.players.map((p) => p.tokens), s.current, s.phase, s.rolls, s.sixes, s.turnCount, s.ranking]);
