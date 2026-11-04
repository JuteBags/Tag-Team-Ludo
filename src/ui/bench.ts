// A hidden page of speed tests for a real phone: open the web game at /play/#bench. Nothing on it is stored
// and it fetches nothing beyond the app's own engine files. "Copy" gives plain lines with the device, ready to
// paste into chat or an issue.
//   Extreme moves (#62): the same fixed decisions on every device (positions from seeded bot games) through
//     the real rollout worker, at 128 and 256 playouts, in 2- and 4-player games: p50 / p90 / max per move.
//   Game review (#105, #151): two fixed games (review-speed.yml's, so a phone compares with the CI runner)
//     reviewed exactly as the app reviews a game (reviewRun.ts: the biggest decisions first, the luck pass
//     after the first few) on a pool of 1, 2 and 3 workers of the bench's own (review-worker.ts ReviewPool):
//     when the first key verdict and the whole review are in, the luck pass's own time, and each worker's
//     memory, with the pool size the app would use on this device.
// The review queue waits while a test runs, so a past game's review doesn't share the phone's time.
import { SEATS as TABLE, chooseMove, createGame, move, roll, seeded, seededDie, type Color, type GameRecord, type GameState, type Seat } from '../engine';
import type { Label } from '../engine/ai/review';
import { setGame } from './reviewQueue';
import { runReview } from './reviewRun';
import { isMobile, MAX_POOL_DESKTOP, poolSize, ReviewPool } from '../engine/ai/review-worker';

const PER_ARM = 50;
const ARMS: { layout: '2p' | '4p'; nmax: number }[] = [
  { layout: '2p', nmax: 128 },
  { layout: '2p', nmax: 256 },
  { layout: '4p', nmax: 128 },
  { layout: '4p', nmax: 256 },
];

const SEATS: Record<'2p' | '4p', Seat[]> = {
  '2p': [{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 1, bot: true }],
  '4p': (['blue', 'green', 'red', 'yellow'] as Color[]).map((color, owner) => ({ color, owner, bot: true })),
};

/** `count` real decisions (more than one move) from seeded Easy-bot games: the same on every device. */
export function benchDecisions(layout: '2p' | '4p', count: number): GameState[] {
  const out: GameState[] = [];
  for (let seed = 1; out.length < count; seed++) {
    const rng = seeded(seed);
    let s = createGame(SEATS[layout], 'blue');
    // Every 3rd real decision of each game, so positions spread over the opening, middle and end.
    for (let n = 0; s.phase !== 'over' && out.length < count && n < 4000; n++) {
      if (s.phase === 'roll') s = roll(s, () => 0, seededDie(seed, s));
      else {
        if (s.moves.length > 1 && n % 3 === 0) out.push(s);
        s = move(s, chooseMove(s, rng, 'easy'));
      }
    }
  }
  return out;
}

/** p50 / p90 / max (ms) and the share over 1.5 s. (With 50 moves a "p99" would just be the max.) */
export function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.round((s.length - 1) * p)] ?? NaN;
  return { p50: q(0.5), p90: q(0.9), max: s.at(-1) ?? NaN, over: s.filter((x) => x > 1500).length / (s.length || 1) };
}

/**
 * The order the runs go in: for each decision, both playout caps back to back, alternating which goes first,
 * and alternating 2- and 4-player decisions, so a phone heating up (and throttling) as the test goes on
 * weighs on every arm alike.
 */
export function benchOrder(perArm: number): { layout: '2p' | '4p'; nmax: number; i: number }[] {
  const out: { layout: '2p' | '4p'; nmax: number; i: number }[] = [];
  for (let i = 0; i < perArm; i++)
    for (const layout of i % 2 ? (['4p', '2p'] as const) : (['2p', '4p'] as const))
      for (const nmax of (i + (layout === '4p' ? 1 : 0)) % 2 ? [256, 128] : [128, 256]) out.push({ layout, nmax, i });
  return out;
}

/**
 * The review test's games (#105): review-speed.yml's games (tools/ai/review_speed.ts, mover Hard, every other
 * seat Hard, the app's dice) of the same seeds, so a phone's time compares with the CI runner's for the very
 * same review. Seat 0 is reviewed; both games have a key verdict (inaccuracy or worse). The moves are written
 * out because playing the games with the Hard bots would hold up a phone for seconds before the test;
 * tests/bench.test.ts plays them again and checks they're the same.
 */
export const REVIEW_GAMES: { layout: '2p' | '4p'; seed: number; events: string }[] = [
  {
    layout: '2p',
    seed: 101,
    events:
      '43215342242465d6d511d122d232d214d445d562d6d24d43d32d25d561d1c64d45d52d21d15d52d23d35d54d43d363d3c65c' +
      '52c23c31c13c32d22c23d31c14c462c2d61c11c14c462c2b6664c4b6a663c3a61c12c265c5c63a362a2c65a51a15a54a461c' +
      '1c62a22b2664a4a6a62b21a11b11b13b34b44c43b35b52d23c31d14a4661d61a1a1a666662c2c63a33a32d265b5a63d32a21' +
      'a11a12b24a42b24a41c161c1c65c55b55c54b42a22c232c261b6b11c12b25a55b561d1d65b54d43b32d24b43d33b35b53b36' +
      '2a2a64b42b21b161b1b64b44b42b21b12b21b164b4b61b15b51b1365a5b645d535b553c354c442b23a345a554d41b1663a3a' +
      '64d4d6631c15665d6d6663521c12d2331b1',
  },
  {
    layout: '4p',
    seed: 102,
    events:
      '61d6d15354d41432d24325d5664d6d4c6432d264d4b6223d35d5313d363b3a6151d12b2155d562b2b61461c6c13a3113c364' +
      'a4a6335c52c24462c63c2c35a5111c12a2152c21a163d6d361d6d12c23b34b432d23c34b413d362d2b62b26661d161b1a65a' +
      '515d55b54a461d6d15d51b11d164a4c632d23b35a522d24j43d352d21d15a54d4664d6d4c62d261a1b65d54d463c6c35a51c' +
      '13c35c52a25c51c1664b6d6665d5a6d62c2d464j4j65b565c6c52c25a51b13c31c11a15b554a42a23d32j24j43b32a23a31b' +
      '162j2b65b561a1d61b15b51a162a2c62e21b12a22h23a364d6d44j44a461a1h6664d4c6b61b15b52a23d34d42j21a11a11d1' +
      '561b1e62e22d25d533c32d24b412c2661c6c1b64b464j4b63a32c25b52j23a32c23d33b361a1h65d54d42c22j22b264b4b64' +
      'd464c4a63b365c5b62c24b42b22b26663b33b32b264c4d65c52b22b24b44c42j25d52d24d42b21b15c53d33c32d24b42c22a' +
      '24d444j4662b2c6a664h4h62a24j41d15d53d363a3d62j262c2c62a24d4562a2a64h465d5c62j265a5c62a265d5b63c31c11' +
      'a164d4d63d362c263d33a3a6a63a33a3362b2a665a51a1a61d14d455a51d13d315a51d13d34j461a1b64d4663b3b6b62j266' +
      '65b54b45b52j22b24b44b43b362j2b6264b4b661b1b664b4a62661b1b6b63b365b5b6363b35c5c665a5a64a42b2531a165b5' +
      'b61b1451a12b261b6b1461a1b65b55b54664a662d2a4g6a62b242d251a15c5445a564b4b6343a33b3455d53b3131d15d5166' +
      '4c6c64c4c44b41c14d45d5515c52b22c2244c43c33c3565c6c51c14c455c52a21c161d6a13a344c425c532c215a524c445a5' +
      '34c464d6d4664a4a6a633c31d11d14a4241d12c25a5314d44d45465d5c63d3525d53d3364c6c44d41d11a1564c4c64c41d11' +
      '12c21c1442c22c261d6d123c35c51d1361c1c62c25d565b6b54c45d5665c5c6b64d411c161c1c64c45c5313c35b5533c31b1' +
      '61d6d1342b25d561b6b11c12b25d563b3a624c45c54d43a3364c4d665a6a51a16564c4b61d15a5645b52d22a233c3662d61d' +
      '1d2d65d546661d13a3424d45d5244d465d53a3a661b6b144b465a5a61b135b52a23b324b465a5a63b334b43a364a6b43b31c' +
      '162d6d23a33b3665d5c6b65d54b44d45a55a53d3651b163d3d61d12b21d1563b3b62d23a35a52d2653a364b4d661d15b55d5' +
      '23b32b222b22b245b52b235b53b344a465b5b632b23a33b353a34b425a54b4635a55b51a11d165a5a65b54a43b32a21b165a' +
      '54b452b245d51a1',
  },
];

/** review_speed.ts's seats: SEATS[n] in order, seat i owned by i, all bots at Hard. */
export const reviewSeats = (layout: '2p' | '4p'): Seat[] => TABLE[layout === '2p' ? 2 : 4].map((color, owner) => ({ color, owner, bot: true, level: 'hard' }));

/** A review game's record, as review_speed.ts writes it: doubles on, the first player by the seed. */
export function reviewRecord(g: { layout: '2p' | '4p'; seed: number; events: string }): GameRecord {
  const seats = reviewSeats(g.layout);
  return { v: 1, seats, first: seats[g.seed % seats.length]!.color, seed: g.seed, events: g.events };
}

const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);

export interface ReviewTiming {
  /** Since the review started (ms): the first key verdict in, and all done. */
  firstKeyMs: number | null;
  totalMs: number;
  /** The luck pass's own call (ms): one worker call that holds up the verdicts behind it (#93, #125). */
  luckMs: number | null;
  decisions: number;
  reviewed: number;
}

/**
 * Reviews seat 0's decisions in `rec` through runReview, as the app does, on `pool`, with nothing stored, and
 * times what a person waits for. `onStop` is handed a function that stops it (the result is then null).
 */
function timeReview(rec: GameRecord, pool: ReviewPool, onStop: (stop: () => void) => void): Promise<ReviewTiming | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let luckMs: number | null = null;
    let firstKeyMs: number | null = null;
    const luck = (r: GameRecord, stopped?: () => boolean) => {
      const t = performance.now();
      return pool.luck(r, stopped)!.then((v) => ((luckMs = performance.now() - t), v));
    };
    const stop = runReview(
      rec,
      undefined,
      (p) => {
        const now = performance.now() - t0;
        if (firstKeyMs === null && p.moves.some((m) => KEY.has(m.label))) firstKeyMs = now;
        if (p.finished) resolve({ luckMs, firstKeyMs, totalMs: now, decisions: p.total, reviewed: p.done });
      },
      false,
      pool.reviewer(),
      [0],
      luck,
    );
    onStop(() => {
      stop();
      pool.stop();
      resolve(null);
    });
  });
}

const sec = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);

/** A test on a worker: the Extreme moves test or the review test (`onStop` is handed a function that stops it). */
type BenchTest = (worker: Worker, say: (l: string) => void, hidden: () => boolean, onStop: (stop: () => void) => void) => Promise<void>;

export interface BenchDeps {
  /** A fresh rollout worker for this run. */
  worker: () => Worker;
  /** Pauses (true) or unpauses (false) the review queue (reviewQueue.ts setGame 'extreme' / 'none'). */
  pause: (on: boolean) => void;
  say: (line: string) => void;
  /** The test itself (tests stand one in); by default the Extreme moves test or the review test. */
  test?: BenchTest;
}

/**
 * One run of a test. The review queue waits while it runs, so a past game's review doesn't share the time,
 * and a run during which the page was hidden is thrown away (it was throttled). `stop` (leaving the bench)
 * ends it at once: the worker is terminated and the queue unpaused then, never again later. Everything is
 * ended exactly once, whichever comes first.
 */
export function benchRun(review: boolean, deps: BenchDeps): { done: Promise<void>; stop: () => void } {
  const worker = deps.worker();
  let hidden = false;
  let left = false;
  let over = false;
  let stopReview = () => {};
  let lock: { release(): Promise<void> } | null = null;
  const onHide = () => {
    if (hidden || document.visibilityState !== 'hidden') return;
    hidden = true;
    stopReview();
  };
  const end = () => {
    if (over) return;
    over = true;
    document.removeEventListener('visibilitychange', onHide);
    void lock?.release().catch(() => {});
    worker.terminate();
    deps.pause(false);
  };
  document.addEventListener('visibilitychange', onHide);
  deps.pause(true);
  const test: BenchTest = deps.test ?? (review ? reviewBench : (w, say, h) => movesBench(w, say, h));
  const done = (async () => {
    try {
      lock = (await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
    } catch {
      // No wake lock here: the screen may dim, which ends the run.
    }
    if (over) {
      void lock?.release().catch(() => {});
      return;
    }
    const t0 = Date.now();
    try {
      await test(worker, deps.say, () => hidden || left, (f) => (stopReview = f));
      if (left) return;
      if (hidden) deps.say('interrupted: the page was hidden during the run, so the numbers are left out. Run again.');
      else {
        deps.say(`took ${Math.round((Date.now() - t0) / 1000)} s, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
        deps.say('done');
      }
    } catch (err) {
      if (!left) deps.say(`failed: ${String(err)}`);
    } finally {
      end();
    }
  })();
  return {
    done,
    stop: () => {
      left = true;
      stopReview();
      end();
    },
  };
}

export function benchScreen(onClose: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen bench';
  el.innerHTML = `<div class="benchbox"><h2 class="disp">Speed tests</h2>
    <p class="sub">Times this device. Extreme moves: ${PER_ARM} moves each at 128 and 256 playouts, in 2- and 4-player games, a minute or two. Game review: a 2- and a 4-player game, a few minutes. Stay on this page until it's done.</p>
    <button class="b3 green disp" data-act="run">EXTREME MOVES</button>
    <button class="b3 green disp" data-act="review">GAME REVIEW</button>
    <pre class="benchout" aria-live="polite"></pre>
    <button class="b3 blue disp" data-act="copy" hidden>COPY RESULTS</button>
    <button class="later" data-act="back">Back to the game</button></div>`;
  const out = el.querySelector<HTMLElement>('.benchout')!;
  const starts = [...el.querySelectorAll<HTMLButtonElement>('[data-act=run], [data-act=review]')];
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    out.textContent = lines.join('\n');
  };
  let running = false;
  let current: { stop(): void } | null = null;
  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'back') {
      // Leaving mid-run stops the run now (#126 review): a run left going would unpause the review queue
      // whenever it ended, maybe in the middle of an Extreme game started meanwhile.
      current?.stop();
      onClose();
    } else if (b.dataset.act === 'copy') {
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        b.textContent = 'COPIED';
      } catch {
        b.textContent = 'SELECT THE TEXT TO COPY';
      }
    } else if ((b.dataset.act === 'run' || b.dataset.act === 'review') && !running) {
      running = true;
      starts.forEach((s) => (s.disabled = true));
      lines.length = 0;
      const review = b.dataset.act === 'review';
      say(`Tag Team Ludo ${review ? 'review' : 'Extreme'} bench, v${__APP_VERSION__}`);
      say(`device: ${navigator.userAgent}`);
      say(`cores: ${navigator.hardwareConcurrency ?? '?'}`);
      const run = benchRun(review, {
        worker: () => new Worker(new URL('../engine/ai/rollout-worker.ts', import.meta.url), { type: 'module' }),
        pause: (on) => setGame(on ? 'extreme' : 'none'),
        say,
      });
      current = run;
      await run.done;
      current = null;
      running = false;
      starts.forEach((s) => (s.disabled = false));
      el.querySelector<HTMLElement>('[data-act=copy]')!.hidden = false;
    }
  });
  return el;
}

/** The Extreme moves test (#62): each arm's p50 / p90 / max per move. */
async function movesBench(worker: Worker, say: (l: string) => void, hidden: () => boolean) {
  const ask = (state: GameState, nmax: number, seed: number) =>
    new Promise<number>((done, fail) => {
      worker.onmessage = (m: MessageEvent<{ index?: number; error?: string }>) => (m.data.error ? fail(new Error(m.data.error)) : done(m.data.index ?? -1));
      worker.onerror = () => fail(new Error('the worker failed to load'));
      worker.postMessage({ id: 0, state, nmax, seed });
    });
  // One untimed move first: loading the engine and the net isn't a move's cost.
  await ask(benchDecisions('2p', 1)[0]!, 16, 1);
  const decisions = { '2p': benchDecisions('2p', PER_ARM), '4p': benchDecisions('4p', PER_ARM) };
  const times = new Map(ARMS.map((a) => [`${a.layout}:${a.nmax}`, [] as number[]]));
  for (const run of benchOrder(PER_ARM)) {
    if (hidden()) return;
    const t = performance.now();
    await ask(decisions[run.layout][run.i]!, run.nmax, run.i + 1);
    times.get(`${run.layout}:${run.nmax}`)!.push(performance.now() - t);
  }
  for (const arm of ARMS) {
    const ms = times.get(`${arm.layout}:${arm.nmax}`)!;
    const r = stats(ms);
    say(`${arm.layout} race:${arm.nmax}: p50 ${Math.round(r.p50)} ms, p90 ${Math.round(r.p90)} ms, max ${Math.round(r.max)} ms, over 1.5 s ${Math.round(100 * r.over)}% (${ms.length} moves)`);
  }
}

/**
 * The game review test (#105, #151): per game, the first key verdict, the whole review and the luck pass, on
 * a pool of 1, 2 and 3 workers (and 4 and 6 on a computer: MAX_POOL_DESKTOP), and each worker's wasm memory.
 * The app uses poolSize().
 */
async function reviewBench(_worker: Worker, say: (l: string) => void, hidden: () => boolean, onStop: (stop: () => void) => void) {
  const nav = navigator as Navigator & { deviceMemory?: number };
  say(`pool: the app uses ${poolSize()} review worker${poolSize() > 1 ? 's' : ''} here (cores ${nav.hardwareConcurrency ?? '?'}, memory ${nav.deviceMemory ?? '?'} GB)`);
  const games = REVIEW_GAMES.map((g) => ({ ...g, rec: reviewRecord(g) }));
  const sizes = isMobile(nav) ? [1, 2, 3] : [1, 2, 3, 4, MAX_POOL_DESKTOP];
  for (const size of sizes) {
    if (hidden()) return;
    const pool = new ReviewPool(size);
    try {
      // Untimed first: every worker loads its engine, the net and the luck net (as after a first review).
      const warm = games[0]!.rec;
      await pool.luck({ ...warm, events: '' });
      const rv = pool.reviewer()!;
      await Promise.all(Array.from({ length: size }, (_, k) => rv(benchDecisions('2p', 1)[0]!, 16, k + 1)));
      for (const g of games) {
        if (hidden()) return;
        say(`reviewing the ${g.layout} game on ${size} worker${size > 1 ? 's' : ''}…`);
        const r = await timeReview(g.rec, pool, onStop);
        if (!r) return;
        const missing = r.reviewed < r.decisions ? `; only ${r.reviewed} of ${r.decisions} reviewed: a worker failed` : '';
        say(`review ${g.layout} game ${g.seed}, ${size} worker${size > 1 ? 's' : ''}: first key verdict ${sec(r.firstKeyMs)}, all ${sec(r.totalMs)} (of which the luck pass ${sec(r.luckMs)}; ${r.decisions} decisions${missing})`);
      }
      const mem = await pool.memory();
      say(`memory, ${size} worker${size > 1 ? 's' : ''}: wasm ${mem.map((b) => `${(b / 1048576).toFixed(1)} MB`).join(' + ')}`);
    } finally {
      pool.stop();
    }
  }
}
