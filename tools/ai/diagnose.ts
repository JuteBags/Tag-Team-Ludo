// Why does A lose to B? A in one house, B in the others (4p by default), every seed played from each
// house with the same dice, like the arena, and per house: captures made and suffered (by where the victim
// was), turns with every token in base, dice lost, how often each move kind was played, and the race
// standing at a quarter, half and three quarters of the game. Prints DIAG {a: {...}, b: {...}} with per-game
// means for A's houses and B's houses, plus A's win rate by its standing at half time.
//   node diagnose.mjs --a blend:net.json:rules.json:0.6:1 --b net:hard2-tuned.json:1 --from 0 --to 500 --dice fair
import { createGame, move, ownerRanking, roll, seeded, type GameState, type Move } from '../../src/engine';
import { diceRngFor, flags, MODES, peopleIn, policy, rollFace, type DiceMode } from './common';

const a = flags(process.argv.slice(2));
const A = policy(a.a!);
const B = policy(a.b!);
const mode = a.mode ?? '4p';
const diceMode = (a.dice ?? 'fair') as DiceMode;
const people = peopleIn(mode);

type Tally = Record<string, number>;
const side = { a: {} as Tally, b: {} as Tally };
const add = (t: Tally, k: string, v = 1) => (t[k] = (t[k] ?? 0) + v);
const progress = (s: GameState, owner: number) =>
  s.players.filter((p) => p.owner === owner).reduce((n, p) => n + p.tokens.reduce((m, x) => m + (x + 1), 0), 0);
let games = 0;
let aWins = 0;
const byHalf: Record<string, [number, number]> = {}; // A's standing (1 = ahead) at half time -> [games, wins]

for (let seed = Number(a.from ?? 0); seed < Number(a.to ?? 200); seed++) {
  for (let seat = 0; seat < people; seat++) {
    const rng = seeded(seed * 7919 + 13);
    const dice = diceRngFor(seed * 7919 + 13);
    const m = MODES[mode]!;
    let s = createGame(m.seats(), undefined, m.singles);
    s = { ...s, current: (seed % 4) % s.players.length };
    const t = Array.from({ length: people }, () => ({} as Tally));
    const standings: number[][] = [];
    for (let steps = 0; s.phase !== 'over' && steps < 50000; steps++) {
      const owner = s.players[s.current]!.owner;
      if (s.phase === 'roll') {
        if (s.rolls.length === 0) {
          add(t[owner]!, 'turns');
          if (s.players.filter((p) => p.owner === owner).every((p) => p.tokens.every((x) => x === -1))) add(t[owner]!, 'turnsAllInBase');
          standings.push(Array.from({ length: people }, (_, o) => progress(s, o)));
        }
        s = roll(s, dice, rollFace(s, dice, diceMode));
        if (s.event?.type === 'no-move') add(t[owner]!, 'diceNoMove');
        continue;
      }
      const mv: Move = (owner === seat ? A : B)(s, rng);
      add(t[owner]!, `move:${mv.kind}`);
      for (const c of mv.captures) {
        const victim = s.players.find((p) => p.color === c.color)!;
        const at = victim.tokens[c.token]!;
        add(t[owner]!, 'kills');
        add(t[victim.owner]!, 'deaths');
        add(t[victim.owner]!, at < 13 ? 'deathsEarly' : at < 39 ? 'deathsMid' : 'deathsLate');
        add(t[victim.owner]!, 'pipsLostToDeaths', at + 1);
      }
      s = move(s, mv);
      if (s.event?.type === 'moved') add(t[owner]!, 'diceLost', s.event.lost.length);
    }
    const rank = ownerRanking(s);
    games++;
    if (rank[0] === seat) aWins++;
    // Standing at a quarter, half, three quarters of the game: A's rank by race progress (1 = ahead).
    for (const [name, f] of [['q1', 0.25], ['half', 0.5], ['q3', 0.75]] as const) {
      const row = standings[Math.floor(standings.length * f)]!;
      const place = 1 + row.filter((x, o) => o !== seat && x > row[seat]!).length;
      add(side.a, `rank_${name}`, place);
      if (name === 'half') {
        const k = String(place);
        byHalf[k] = byHalf[k] ?? [0, 0];
        byHalf[k]![0]++;
        if (rank[0] === seat) byHalf[k]![1]++;
      }
    }
    for (let o = 0; o < people; o++) {
      const into = o === seat ? side.a : side.b;
      for (const [k, v] of Object.entries(t[o]!)) add(into, k, v);
      add(into, 'houses');
      add(into, 'wins', rank[0] === o ? 1 : 0);
    }
  }
}
// Per house per game for both sides (B has people-1 houses per game).
const mean = (t: Tally) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'houses').map(([k, v]) => [k, +(v / t.houses!).toFixed(3)]));
console.log(`DIAG ${JSON.stringify({ a: a.a, b: a.b, mode, games, aWin: aWins / games, A: mean(side.a), B: mean(side.b),
  aWinByHalfRank: Object.fromEntries(Object.entries(byHalf).map(([k, [g, w]]) => [k, { games: g, win: +(w / g).toFixed(3) }])) })}`);
