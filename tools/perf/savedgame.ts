// The saved games perf screens continues (#98, #176): a 4-player vs Computer game played from the start with
// the app's own dice and bots (gameScreen.ts: every roll and bot move drawn from the game's seed and the
// position), stopped mid-game with the person (blue) to roll, saved with its record (log) so the game screen
// has one, as a real continued game does: the review while the game is played (#176) then has the person's
// decisions so far to review. Once with Hard bots, once with Extreme ones (the same moves so far: Node has no
// Extreme net here, so the past moves are Hard's either way; it's the turns to come that differ).
//   npx rolldown tools/perf/savedgame.ts --platform node --format esm --file tools/perf/dist/savedgame.mjs
//   node tools/perf/dist/savedgame.mjs > saved-games.json
import { createGame, mixSeed, move, moveEvent, positionKey, roll, rollEvent, seeded, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';

const SEED = 24;
/** About this many events in: the middle of a game, with decisions behind it. */
const EVENTS = 160;

function play(level: 'hard' | 'extreme') {
  const seats: Seat[] = [
    { color: 'blue', owner: 0, bot: false },
    { color: 'green', owner: 1, bot: true, level },
    { color: 'red', owner: 2, bot: true, level },
    { color: 'yellow', owner: 3, bot: true, level },
  ];
  // The person's moves are the Hard bot's here (someone has to choose them).
  const asBots = seats.map((x) => ({ ...x, bot: true, level: 'hard' as const }));
  let s: GameState = createGame(asBots, 'blue');
  let log = '';
  const rng = (what: string) => seeded(mixSeed(SEED, what + positionKey(s)));
  for (let n = 0; s.phase !== 'over'; n++) {
    if (n >= EVENTS && s.phase === 'roll' && s.current === 0 && s.rolls.length === 0) break;
    if (s.phase === 'roll') {
      s = roll(s, rng('dice'));
      log += rollEvent(s.dice!);
    } else {
      const m = chooseBotMove(s, rng('bot'));
      log += moveEvent(m);
      s = move(s, m);
    }
  }
  const state = { ...s, players: s.players.map((p, i) => ({ ...p, bot: seats[i]!.bot, level: seats[i]!.level })) };
  return { v: 1, config: { mode: 'pvc', seats, first: 'blue', names: ['You', 'Bot 1', 'Bot 2', 'Bot 3'] }, state, kills: 0, pairs: 0, faces: [], savedAt: Date.now(), seed: SEED, log };
}

console.log(JSON.stringify({ hard: play('hard'), extreme: play('extreme') }));
