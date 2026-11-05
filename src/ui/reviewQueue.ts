// The review queue (#96): game reviews run while the app is open, one at a time, in the review worker. A
// finished game with a person in it is queued as soon as it's saved (the newest few only, so a long session
// doesn't leave a battery-eating backlog). The game being looked at goes first, then vs Computer games before
// With friends ones, newest first. Leaving the review screen doesn't stop it.
// It pauses during any game (the game's own review runs then, liveReview.ts, #176) and while the app is
// hidden: it runs while the app is open, never in the background in the OS's sense. A game reviewed while it
// was played comes with what's done (its verdicts and luck chunks), and the full pool finishes the rest.
// Once the queue is empty the worker is ended, so no idle worker holds memory.
import type { GameRecord } from '../engine';
import { REVIEW_VERSION, type Reviewer } from '../engine/ai/review';
import { stopReviewWorker, workerLuck, workerReviewer } from '../engine/ai/review-worker';
import type { LiveHandOff } from './liveReview';
import { peopleOf, runReview, type ReviewProgress } from './reviewRun';
import { saveSetting, settings } from './settings';
import { keyOf, loadPastGames, loadReview, loadSummaries, loadSummary, type StoredReview } from './store';

/** Reviews run on their own (#97, Settings): off, only a review whose screen was opened runs. */
const auto = () => settings.autoReview !== false;

/** How many of the newest unreviewed games are queued on their own; older ones are reviewed when opened. */
export const AUTO_QUEUE = 3;

/** A record's identity (store.ts): the same game from storage, the result screen or a link. */
export { keyOf };

/** A stored review that needs no more work: this version, finished. */
export const isComplete = (r: StoredReview | undefined) => !!r && r.v === REVIEW_VERSION && !!r.done;

interface Job {
  key: string;
  rec: GameRecord;
  /** Keep the review with the past game (not for a game from a link). */
  keep: boolean;
  pvp: boolean;
  /** When the game was played, for "newest first". */
  at: number;
  /** When it was last opened (0: never), so the game being looked at goes first. */
  opened: number;
  who: number[];
  last?: ReviewProgress;
  finished: boolean;
  /** What the review while the game was played did (#176). */
  live?: LiveHandOff;
}

const jobs = new Map<string, Job>();
const watchers = new Map<string, Set<(p: ReviewProgress) => void>>();
const changes = new Set<() => void>();
let running: { job: Job; stop: () => void } | null = null;
let starting = false;
let game: 'none' | 'light' | 'extreme' = 'none';
let hidden = typeof document !== 'undefined' && document.hidden;
// During a game the queue gives way to the game's own review (liveReview.ts, #176).
const paused = () => hidden || game !== 'none';

/** Tells the screens; one that throws never stops the review (or the others). */
const emit = (job: Job) => {
  const safe = (f: () => void) => {
    try {
      f();
    } catch (e) {
      console.error('review screen update failed', e);
    }
  };
  if (job.last) for (const w of watchers.get(job.key) ?? []) safe(() => w(job.last!));
  for (const c of changes) safe(c);
};

function next(): Job | undefined {
  return [...jobs.values()].filter((j) => !j.finished && (auto() || j.opened > 0)).sort((a, b) => b.opened - a.opened || Number(a.pvp) - Number(b.pvp) || b.at - a.at)[0];
}

/** The reviewer, giving the page a turn between decisions so a game's turn never waits on the review. */
function politeReviewer(): (Reviewer & { parallel: number }) | null {
  const base = workerReviewer();
  if (!base) return null;
  // It forwards every argument the Reviewer type has (#101 adds an optional 4th), and how many decisions the
  // pool of workers takes at once (#151).
  const polite = async (...args: Parameters<Reviewer>) => {
    await new Promise((r) => setTimeout(r, 0));
    return base(...args);
  };
  return Object.assign(polite, { parallel: base.parallel });
}

async function pump() {
  if (running || starting || paused()) return;
  const job = next();
  if (!job) {
    stopReviewWorker();
    return;
  }
  starting = true;
  let stored: StoredReview | undefined;
  try {
    stored = job.keep ? await loadReview(job.rec) : memory.get(job.key);
  } catch {
    stored = undefined;
  }
  // A game reviewed while it was played: its verdicts so far, and its luck chunks for the luck pass (#176).
  const live = job.live;
  if (!stored && live && (live.moves.length || live.skip.length)) stored = { v: REVIEW_VERSION, moves: live.moves, luck: null, skip: live.skip.length ? live.skip : undefined };
  starting = false;
  if (running || paused() || job.finished) return void pump();
  const reviewer = politeReviewer();
  const run = { job, stop: () => {} };
  running = run;
  run.stop = runReview(
    job.rec,
    stored,
    (p) => {
      job.last = p;
      if (!job.keep) memory.set(job.key, { v: REVIEW_VERSION, moves: p.moves, luck: p.luck, chances: p.chances ?? undefined, who: p.who, done: p.finished || undefined });
      if (p.finished) job.finished = true;
      emit(job);
      if (p.finished && running === run) {
        running = null;
        void pump();
      }
    },
    job.keep,
    reviewer,
    job.who,
    (r, stopped, yieldTo) => workerLuck(r, stopped, yieldTo, live?.luckHave ?? []),
  );
  // No worker (or nothing left to do): it reported finished, or it can never run.
  if (!reviewer && running === run) {
    job.finished = true;
    running = null;
  }
}

/** Reviews of games from links live only in memory. */
const memory = new Map<string, StoredReview>();

function pause() {
  // The pool of workers goes too (#151): during an Extreme game or with the app hidden, no review worker runs
  // (or holds memory). A decision in flight is redone on resume, from its own seed: the same verdict.
  stopReviewWorker();
  if (!running) return;
  running.stop();
  running = null;
}

function update() {
  if (paused()) pause();
  else void pump();
}

/** Puts a game in the queue (if it isn't there or done) without moving anything ahead of it. */
export function enqueue(rec: GameRecord, opts: { keep?: boolean; pvp?: boolean; at?: number; live?: LiveHandOff } = {}) {
  // Off (#97): nothing is queued on its own; the review starts when its screen is opened.
  if (!auto()) return;
  const key = keyOf(rec);
  if (!jobs.has(key)) jobs.set(key, { key, rec, keep: opts.keep ?? true, pvp: !!opts.pvp, at: opts.at ?? Date.now(), opened: 0, who: peopleOf(rec), finished: false, live: opts.live });
  trim();
  void pump();
}

/** Only the newest AUTO_QUEUE unfinished games wait on their own; opened ones and the one running stay. */
function trim() {
  const waiting = [...jobs.values()].filter((j) => !j.finished && !j.opened && running?.job !== j).sort((a, b) => b.at - a.at);
  for (const j of waiting.slice(AUTO_QUEUE)) jobs.delete(j.key);
}

/**
 * Follows a game's review: `onUpdate` gets its progress now (if any) and as it goes. `open` moves it to the
 * front of the queue (the review screen is showing it); `who` adds owners to review (a bot's side, on demand).
 * Returns the unsubscribe; the review itself carries on.
 */
export function follow(rec: GameRecord, onUpdate: (p: ReviewProgress) => void, opts: { keep?: boolean; open?: boolean; who?: number[]; pvp?: boolean; at?: number } = {}): () => void {
  const key = keyOf(rec);
  let job = jobs.get(key);
  if (!job && opts.open) {
    job = { key, rec, keep: opts.keep ?? true, pvp: !!opts.pvp, at: opts.at ?? Date.now(), opened: 0, who: peopleOf(rec), finished: false };
    jobs.set(key, job);
  }
  const set = watchers.get(key) ?? new Set();
  set.add(onUpdate);
  watchers.set(key, set);
  if (job) {
    const more = (opts.who ?? []).filter((o) => !job!.who.includes(o));
    if (more.length) {
      job.who = [...job.who, ...more];
      job.finished = false;
      if (running?.job === job) pause();
    }
    if (opts.open) {
      job.opened = Date.now();
      // The game being looked at goes first: whatever else is running gives way.
      if (running && running.job !== job) pause();
    }
    if (job.last) onUpdate(job.last);
    update();
  }
  return () => {
    set.delete(onUpdate);
  };
}

/** The latest progress of a game's review, if it's been queued this session. */
export const progressOf = (rec: GameRecord) => jobs.get(keyOf(rec))?.last;

/** Whether a game is waiting or being reviewed. */
export const isQueued = (rec: GameRecord) => {
  const j = jobs.get(keyOf(rec));
  return !!j && !j.finished;
};

/** Calls `cb` whenever any review moves on (for the status on the result card and in Past games). */
export function onReviewChange(cb: () => void): () => void {
  changes.add(cb);
  return () => changes.delete(cb);
}

/** What's being played: no game, a game whose bots barely use the CPU, or an Extreme game (the queue pauses). */
export function setGame(kind: 'none' | 'light' | 'extreme') {
  game = kind;
  update();
}

let booted = false;
/** At start: queue the newest unreviewed past games, and pause while the app is hidden. */
export async function bootReviews() {
  if (booted) return;
  booted = true;
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    update();
  });
  await queuePast();
}

/** Queues the newest unreviewed past games (none while reviews don't run on their own). */
async function queuePast() {
  if (!auto()) return;
  const past = (await loadPastGames().catch(() => [])).filter((g) => g.rec.seats.some((s) => !s.bot));
  // Finished or not, from the reviews' summaries (one small read, #98). A game without a current summary is
  // read in full once, which writes its summary for the next start.
  const index = await loadSummaries().catch(() => ({}));
  const todo = [];
  for (const g of past) {
    if (todo.length >= AUTO_QUEUE) break;
    const s = await loadSummary(g.rec, index);
    const complete = s ? s.done : isComplete(await loadReview(g.rec).catch(() => undefined));
    if (!complete) todo.push(g);
  }
  todo.forEach((g) => enqueue(g.rec, { pvp: g.mode === 'pvp', at: g.at }));
}

/**
 * The Settings switch (#97): on, past games are queued again; off, every job nobody opened goes, and the one
 * running stops unless its screen was opened. A game being played is reviewed live only when on (gameScreen).
 */
export async function setAutoReview(on: boolean) {
  saveSetting('autoReview', on);
  if (on) {
    await queuePast();
    void pump();
    return;
  }
  if (running && !running.job.opened) pause();
  for (const [k, j] of jobs) if (!j.opened && !j.finished) jobs.delete(k);
  void pump();
}

/** For tests: forget every job. */
export function resetQueue() {
  pause();
  jobs.clear();
  watchers.clear();
  memory.clear();
  game = 'none';
  hidden = false;
}
