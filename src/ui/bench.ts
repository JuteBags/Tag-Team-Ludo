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

/** p50 / p99 / max (ms) and the share over 1.5 s. */
export function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.round((s.length - 1) * p)] ?? NaN;
  return { p50: q(0.5), p99: q(0.99), max: s.at(-1) ?? NaN, over: s.filter((x) => x > 1500).length / (s.length || 1) };
}

export function benchScreen(onClose: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen bench';
  el.innerHTML = `<div class="benchbox"><h2 class="disp">Extreme speed test</h2>
    <p class="sub">Times the Extreme bot on this device: ${PER_ARM} moves each at 128 and 256 playouts, in 2- and 4-player games. Takes a minute or two. Keep the screen on.</p>
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
      try {
        // One untimed move first: loading the engine and the net isn't a move's cost.
        await ask(benchDecisions('2p', 1)[0]!, 16, 1);
        for (const arm of ARMS) {
          const ms: number[] = [];
          for (const [i, s] of benchDecisions(arm.layout, PER_ARM).entries()) {
            const t0 = performance.now();
            await ask(s, arm.nmax, i + 1);
            ms.push(performance.now() - t0);
          }
          const r = stats(ms);
          say(`${arm.layout} race:${arm.nmax}: p50 ${Math.round(r.p50)} ms, p99 ${Math.round(r.p99)} ms, max ${Math.round(r.max)} ms, over 1.5 s ${Math.round(100 * r.over)}% (${ms.length} moves)`);
        }
        say('done');
      } catch (err) {
        say(`failed: ${String(err)}`);
      } finally {
        worker.terminate();
        b.disabled = false;
        el.querySelector<HTMLElement>('[data-act=copy]')!.hidden = false;
      }
    }
  });
  return el;
}
