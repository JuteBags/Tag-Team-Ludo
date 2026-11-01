// A hidden page for timing Extreme on a real phone (#62): open the web game at /play/#bench. It plays the
// same fixed decisions on every device (positions from seeded bot games) through the real rollout worker,
// at 128 and 256 playouts, in 2- and 4-player games, and shows each arm's p50 / p99 / max time per move.
// "Copy" gives plain lines with the device, ready to paste into chat or an issue.
import { chooseMove, createGame, move, roll, seeded, seededDie, type Color, type GameState, type Seat } from '../engine';

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

export function benchScreen(onClose: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen bench';
  el.innerHTML = `<div class="benchbox"><h2 class="disp">Extreme speed test</h2>
    <p class="sub">Times the Extreme bot on this device: ${PER_ARM} moves each at 128 and 256 playouts, in 2- and 4-player games. Takes a minute or two: stay on this page until it's done.</p>
    <button class="b3 green disp" data-act="run">START</button>
    <pre class="benchout" aria-live="polite"></pre>
    <button class="b3 blue disp" data-act="copy" hidden>COPY RESULTS</button>
    <button class="later" data-act="back">Back to the game</button></div>`;
  const out = el.querySelector<HTMLElement>('.benchout')!;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    out.textContent = lines.join('\n');
  };
  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'back') onClose();
    else if (b.dataset.act === 'copy') {
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        b.textContent = 'COPIED';
      } catch {
        b.textContent = 'SELECT THE TEXT TO COPY';
      }
    } else if (b.dataset.act === 'run' && !b.disabled) {
      b.disabled = true;
      lines.length = 0;
      say(`Tag Team Ludo Extreme bench, v${__APP_VERSION__}`);
      say(`device: ${navigator.userAgent}`);
      say(`cores: ${navigator.hardwareConcurrency ?? '?'}`);
      const worker = new Worker(new URL('../engine/ai/rollout-worker.ts', import.meta.url), { type: 'module' });
      const ask = (state: GameState, nmax: number, seed: number) =>
        new Promise<number>((done, fail) => {
          worker.onmessage = (m: MessageEvent<{ index?: number; error?: string }>) => (m.data.error ? fail(new Error(m.data.error)) : done(m.data.index ?? -1));
          worker.onerror = () => fail(new Error('the worker failed to load'));
          worker.postMessage({ id: 0, state, nmax, seed });
        });
      // A run with the page hidden is throttled, so its numbers would mislead: it's thrown away.
      let hidden = false;
      const onHide = () => (hidden ||= document.visibilityState === 'hidden');
      document.addEventListener('visibilitychange', onHide);
      let lock: { release(): Promise<void> } | null = null;
      try {
        lock = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
      } catch {
        // No wake lock here: the screen may dim, which ends the run.
      }
      const t0 = Date.now();
      try {
        // One untimed move first: loading the engine and the net isn't a move's cost.
        await ask(benchDecisions('2p', 1)[0]!, 16, 1);
        const decisions = { '2p': benchDecisions('2p', PER_ARM), '4p': benchDecisions('4p', PER_ARM) };
        const times = new Map(ARMS.map((a) => [`${a.layout}:${a.nmax}`, [] as number[]]));
        for (const run of benchOrder(PER_ARM)) {
          if (hidden) break;
          const t = performance.now();
          await ask(decisions[run.layout][run.i]!, run.nmax, run.i + 1);
          times.get(`${run.layout}:${run.nmax}`)!.push(performance.now() - t);
        }
        if (hidden) say('interrupted: the page was hidden during the run, so the numbers are left out. Run again.');
        else {
          for (const arm of ARMS) {
            const ms = times.get(`${arm.layout}:${arm.nmax}`)!;
            const r = stats(ms);
            say(`${arm.layout} race:${arm.nmax}: p50 ${Math.round(r.p50)} ms, p90 ${Math.round(r.p90)} ms, max ${Math.round(r.max)} ms, over 1.5 s ${Math.round(100 * r.over)}% (${ms.length} moves)`);
          }
          say(`took ${Math.round((Date.now() - t0) / 1000)} s, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
          say('done');
        }
      } catch (err) {
        say(`failed: ${String(err)}`);
      } finally {
        document.removeEventListener('visibilitychange', onHide);
        void lock?.release().catch(() => {});
        worker.terminate();
        b.disabled = false;
        el.querySelector<HTMLElement>('[data-act=copy]')!.hidden = false;
      }
    }
  });
  return el;
}
