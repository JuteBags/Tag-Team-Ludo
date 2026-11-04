// The review while the game is played (#176): each person's decision is reviewed in the background as soon
// as it's made, and the luck pass a chunk at a time as the game reaches past each chunk, so the review is
// ready (or nearly) on the result screen. Nothing is shown during the game.
// A verdict is the whole review's (decisionSeed: the game's seed and the position, never when it's made), and
// a luck chunk is the whole pass's for it (chunks are independent), so the stored review is the same as the
// after-game one (tests/liveReview.test.ts). At the game's end, handOff() gives what's done to the review
// queue, whose full pool finishes the rest.
// Every result keeps the record it came from; it counts only while the game's record still starts with that
// one. So an undo (the record is cut back), a reply that arrives late, or a game continued after the app was
// closed (update() with the whole record: everything is queued again) need no other bookkeeping.
// The CPU: its own pool of workers (livePoolSize: 1 on a phone, 2 on a computer, none with 2 cores or fewer),
// one call per worker at a time with a turn for the page between calls; nothing new is sent while an
// Extreme bot thinks (thinking(true)) or the app is hidden.
import { move, moveEvent, roll, startOf, type GameRecord, type GameState } from '../engine';
import { LUCK_CHUNK, type MoveReview, type Reviewer } from '../engine/ai/review';
import { isMobile, ReviewPool, type LuckPart } from '../engine/ai/review-worker';
import { peopleOf, reviewDecision } from './reviewRun';

/** Review workers during a game: 1 on a phone (its bot's worker and the UI take two cores), 2 on a computer, none on 2 cores or fewer. */
export function livePoolSize(nav: { hardwareConcurrency?: number; userAgentData?: { mobile?: boolean } } | undefined = typeof navigator !== 'undefined' ? navigator : undefined, coarse?: boolean): number {
  const cores = nav?.hardwareConcurrency ?? 4;
  if (cores <= 2) return 0;
  return isMobile(nav, coarse) ? 1 : Math.min(2, cores - 2);
}

/** What the review needs from its workers (a ReviewPool; tests stand in an engine). */
export interface LiveEngine {
  reviewer: Reviewer;
  /** How many calls at once. */
  parallel: number;
  luckPart(rec: GameRecord, c: number): Promise<LuckPart>;
  stop(): void;
}

/** The pool's side of it: null where workers can't run or the device has no core to spare. */
export function liveEngine(size = livePoolSize()): LiveEngine | null {
  if (size < 1) return null;
  const pool = new ReviewPool(size);
  const reviewer = pool.reviewer();
  if (!reviewer) return null;
  return { reviewer, parallel: size, luckPart: (rec, c) => pool.luckPart(rec, c)!, stop: () => pool.stop() };
}

/** What the game hands the review queue at its end: the verdicts, the decisions with nothing to choose, the luck chunks. */
export interface LiveHandOff {
  moves: MoveReview[];
  skip: number[];
  luckHave: (LuckPart | undefined)[];
}

type Task = { kind: 'move'; at: number } | { kind: 'luck'; c: number };

export class LiveReview {
  private rec: GameRecord | null = null;
  private states: GameState[] = [];
  /** ends[k]: where event k ends in rec.events (a die is one character, a move two); states[k + 1] follows it. */
  private ends: number[] = [];
  private who: number[] = [];
  /** Results, each with the record prefix (events) it depends on. */
  private verdicts = new Map<number, { m: MoveReview | 'skip'; sig: string }>();
  private parts = new Map<number, { part: LuckPart; sig: string }>();
  private queued = new Map<string, Task>();
  private running = new Set<string>();
  private paused = { thinking: false, hidden: false };
  private engine: LiveEngine | null | undefined;
  private ended = false;
  private waiters: (() => void)[] = [];

  /** Resolves once nothing is queued or running (tests; also true when paused with nothing in flight). */
  idle(): Promise<void> {
    if (!this.running.size && (!this.queued.size || this.ended || this.paused.thinking || this.paused.hidden || this.engine === null)) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  /** `engine` makes the workers when first needed (null: no live review on this device). */
  constructor(private readonly makeEngine: () => LiveEngine | null = () => liveEngine()) {}

  /**
   * The game's record now (after each event, or once with the whole record when a saved game is continued).
   * A record that no longer starts with the last one was cut back by an undo: what came after goes.
   */
  update(rec: GameRecord) {
    if (this.ended) return;
    const old = this.rec?.events ?? '';
    const sameGame = !!this.rec && this.rec.seed === rec.seed && this.rec.first === rec.first && JSON.stringify(this.rec.seats) === JSON.stringify(rec.seats);
    if (!sameGame) {
      this.who = peopleOf(rec);
      this.states = [startOf(rec)];
      this.ends = [];
    } else {
      // Back to the last event both records share, then forward along the new one.
      let lcp = 0;
      while (lcp < old.length && lcp < rec.events.length && old[lcp] === rec.events[lcp]) lcp++;
      let k = this.ends.length;
      while (k > 0 && this.ends[k - 1]! > lcp) k--;
      this.states.length = k + 1;
      this.ends.length = k;
    }
    this.rec = rec;
    this.extend();
    this.dropStale();
    this.findWork();
    this.pump();
  }

  /** An Extreme bot is thinking: nothing new goes to the workers until it's done. */
  thinking(on: boolean) {
    this.paused.thinking = on;
    if (!on) this.pump();
  }

  /** The app is hidden (or shown again). */
  hidden(on: boolean) {
    this.paused.hidden = on;
    if (!on) this.pump();
  }

  /** The game is over (or left): what's done, for the review queue; the workers end. */
  handOff(rec: GameRecord): LiveHandOff {
    this.update(rec);
    this.ended = true;
    this.stop();
    const moves: MoveReview[] = [];
    const skip: number[] = [];
    for (const [at, v] of this.verdicts) if (v.m === 'skip') skip.push(at);
    else moves.push(v.m);
    const luckHave: (LuckPart | undefined)[] = [];
    for (const [c, p] of this.parts) luckHave[c] = p.part;
    return { moves: moves.sort((a, b) => a.at - b.at), skip: skip.sort((a, b) => a - b), luckHave };
  }

  /** Ends the workers (the game screen goes away). */
  stop() {
    this.ended = true;
    this.queued.clear();
    this.engine?.stop();
    this.engine = undefined;
  }

  // ---------- inside ----------

  /** The states past the last one known, from the record's events (as record.ts replay does). */
  private extend() {
    const e = this.rec!.events;
    let i = this.ends.at(-1) ?? 0;
    let s = this.states.at(-1)!;
    while (i < e.length && s.phase !== 'over' && e[i] !== 'x') {
      if (s.phase === 'roll') {
        const face = Number(e[i]);
        if (!(face >= 1 && face <= 6)) break;
        s = roll(s, () => 0, face);
        i++;
      } else {
        const m = s.moves.find((x) => moveEvent(x) === e.slice(i, i + 2));
        if (!m) break;
        s = move(s, m);
        i += 2;
      }
      this.ends.push(i);
      this.states.push(s);
    }
  }

  /** The record's events before event k: what a result about states 0..k depends on. */
  private sigTo(k: number): string {
    return this.rec!.events.slice(0, k === 0 ? 0 : this.ends[k - 1]);
  }

  private valid(sig: string): boolean {
    return !!this.rec && this.rec.events.startsWith(sig);
  }

  private dropStale() {
    for (const [at, v] of this.verdicts) if (!this.valid(v.sig)) this.verdicts.delete(at);
    for (const [c, p] of this.parts) if (!this.valid(p.sig)) this.parts.delete(c);
    for (const [key, t] of this.queued) if (t.kind === 'move' ? t.at + 1 >= this.states.length : (t.c + 1) * LUCK_CHUNK >= this.states.length) this.queued.delete(key);
  }

  /** Every person's decision made so far (the move is in the record), and every luck chunk the game has passed. */
  private findWork() {
    const n = this.states.length;
    for (let at = 0; at + 1 < n; at++) {
      const s = this.states[at]!;
      if (s.phase !== 'move' || s.moves.length < 2 || !this.who.includes(s.players[s.current]!.owner)) continue;
      if (this.verdicts.has(at) || this.running.has(`m${at}`)) continue;
      this.queued.set(`m${at}`, { kind: 'move', at });
    }
    for (let c = 0; (c + 1) * LUCK_CHUNK < n; c++) if (!this.parts.has(c) && !this.running.has(`l${c}`)) this.queued.set(`l${c}`, { kind: 'luck', c });
  }

  private pump() {
    this.pumpTasks();
    if (!this.running.size) this.waiters.splice(0).forEach((w) => w());
  }

  private pumpTasks() {
    if (this.ended || this.paused.thinking || this.paused.hidden) return;
    if (this.engine === undefined) this.engine = this.makeEngine();
    const engine = this.engine;
    if (!engine) return;
    while (this.running.size < engine.parallel && this.queued.size) {
      // Decisions first, oldest first: a verdict waits less than the luck, which is wanted last anyway.
      const [key, task] = [...this.queued].sort(([, a], [, b]) => (a.kind === b.kind ? (a.kind === 'move' ? a.at - (b as { at: number }).at : a.c - (b as { c: number }).c) : a.kind === 'move' ? -1 : 1))[0]!;
      this.queued.delete(key);
      this.running.add(key);
      void this.run(engine, task).finally(() => {
        this.running.delete(key);
        // A turn for the page between calls.
        setTimeout(() => this.pump(), 0);
      });
    }
  }

  private async run(engine: LiveEngine, task: Task) {
    const rec = this.rec!;
    try {
      if (task.kind === 'move') {
        const sig = this.sigTo(task.at + 1);
        const m = await reviewDecision(rec, this.states.slice(0, task.at + 2), task.at, this.who, engine.reviewer);
        if (m !== undefined && !this.ended && this.valid(sig)) this.verdicts.set(task.at, { m, sig });
      } else {
        const sig = this.sigTo((task.c + 1) * LUCK_CHUNK);
        const part = await engine.luckPart({ ...rec, events: sig }, task.c);
        if (!this.ended && this.valid(sig)) this.parts.set(task.c, { part, sig });
      }
    } catch {
      // A worker failed or was stopped: the review queue does it after the game.
    }
  }
}
