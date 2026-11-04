// Pop-up sheets on the home screen: Settings and Stats. Back (or the close button) dismisses them.
import { COLORS, type GameRecord } from '../engine';
import { PALETTE, miniBoard, symbolPath } from './art';
import { saveSetting, settings } from './settings';
import { sfx } from './sfx';
import { emptyStats, loadCheckIn, loadPastGames, loadReview, loadStats, loadSummaries, loadSummary, resetStats, type PastGame, type ReviewSummary, type Stats, type StoredReview } from './store';
import { daysBetween, dayKey } from './checkin';
import { ACHIEVEMENTS, takeNew, type AchievementGroup } from './rewards';
import { summary } from '../engine/ai/review';
import { isComplete, isQueued, onReviewChange, progressOf } from './reviewQueue';
import { peopleOf } from './reviewRun';
import { accuracyText, trendOf } from './reviewWords';
import { THEMES, setSymbols, setTheme, usableThemes } from './themes';

const GROUPS: AchievementGroup[] = ['Ladder', 'Extreme', 'Milestones', 'Everyday'];

function sheet(host: HTMLElement, title: string, body: string): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'menu-ov sheet';
  ov.innerHTML = `<div class="box"><button class="x" data-act="close" aria-label="Close">×</button><h2>${title}</h2>${body}<button class="b3 green disp" data-act="close">DONE</button></div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov || (e.target as Element).closest('[data-act=close]')) ov.remove();
  });
  host.appendChild(ov);
  return ov;
}

/** The four colour-blind symbols, in their colours, for labels. */
export const symbolRow = () =>
  `<svg class="syms" viewBox="0 0 64 16" aria-hidden="true">${COLORS.map((c, i) => `<path d="${symbolPath(c, 5.5)}" transform="translate(${8 + i * 16} 8)" fill="${PALETTE[c].m}" stroke="#fff" stroke-width="1"/>`).join('')}</svg>`;

/** An on/off switch row, the same switch as on the home screen. */
const sw = (key: string, label: string, on: boolean) =>
  `<button class="swrow" data-k="${key}" role="switch" aria-checked="${on}"><span>${label}</span><em class="swl">${on ? 'On' : 'Off'}</em><i class="sw"></i></button>`;

/** Wires a switch row to a setter; the row flips and reports its new state. */
function switchRow(ov: HTMLElement, key: string, set: (on: boolean) => void) {
  const b = ov.querySelector<HTMLElement>(`.swrow[data-k=${key}]`)!;
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(on));
    b.querySelector('.swl')!.textContent = on ? 'On' : 'Off';
    set(on);
  });
}

/** A tiny die with the counted face lit, for the dice-face choice. */
const faceIcon = (top: boolean) =>
  `<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 3 L25 8.5 L14 14 L3 8.5Z" fill="${top ? '#ffd65a' : 'rgba(255,255,255,.35)'}"/><path d="M3 8.5 L14 14 L14 25 L3 19.5Z" fill="${top ? 'rgba(255,255,255,.35)' : '#ffd65a'}"/><path d="M25 8.5 L14 14 L14 25 L25 19.5Z" fill="rgba(255,255,255,.2)"/></svg>`;

/** Wires a two-way toggle group (`.tg[data-k]`) to a setter. */
function toggle(ov: HTMLElement, key: string, set: (v: string) => void) {
  const tg = ov.querySelector<HTMLElement>(`.tg[data-k=${key}]`)!;
  tg.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    tg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    set(b.dataset.v!);
  });
}

const tg = (key: string, options: [string, string, boolean][]) =>
  `<div class="tg" data-k="${key}">${options.map(([v, label, on]) => `<button class="${on ? 'on' : ''}" data-v="${v}">${label}</button>`).join('')}</div>`;

/** What the Doubles setting means, under its switch. It applies to new games. */
const DOUBLES_HINT = {
  true: 'Two of your tokens on one square are a double: they move together and block. New games.',
  false: 'Classic Ludo: every token moves alone and nothing blocks. New games.',
};

export function settingsSheet(host: HTMLElement, changed: () => void) {
  const ov = sheet(
    host,
    'Settings',
    `<div class="set"><span>Board</span><div class="themes">${usableThemes().map((t) => `<button class="th${t.id === settings.theme ? ' on' : ''}" data-t="${t.id}">${miniBoard(t.id)}${t.name}</button>`).join('')}</div></div>
    <div class="set">${sw('doubles', 'Doubles', settings.doubles)}<small class="qh">${DOUBLES_HINT[String(settings.doubles) as 'true' | 'false']}</small></div>
    <div class="set">${sw('sym', `Colour-blind symbols ${symbolRow()}`, settings.symbols)}</div>
    <div class="set"><span>Which face of the die counts?</span>${tg('face', [['top', `${faceIcon(true)}The top`, settings.diceFace === 'top'], ['front', `${faceIcon(false)}The front`, settings.diceFace === 'front']])}</div>
    <div class="set">${sw('sound', 'Sound', !sfx.muted)}</div>
    <div class="set"><span>Kill animations</span>${tg('killfx', [['full', 'Full', settings.killFx === 'full'], ['short', 'Short', settings.killFx === 'short'], ['off', 'Off', settings.killFx === 'off']])}</div>
    <div class="set">${sw('fast', 'Fast bots', settings.fastBots)}<small class="qh">Bots roll and move twice as fast</small></div>
    <div class="set"><span>Undos per game</span>${tg('undos', [['0', 'Off', settings.undos === 0], ['1', '1', settings.undos === 1], ['2', '2', (settings.undos ?? 2) === 2]])}</div>
    <div class="set">${sw('undowait', 'Wait for Undo when my turn ends', settings.undoWait !== false)}<small class="qh">A moment to take back a mis-touch before the next player rolls</small></div>`,
  );
  ov.querySelector('.themes')!.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.th');
    if (!b) return;
    ov.querySelectorAll('.th').forEach((x) => x.classList.toggle('on', x === b));
    setTheme(b.dataset.t as (typeof THEMES)[number]['id']);
  });
  switchRow(ov, 'sym', (on) => {
    setSymbols(on);
    changed();
  });
  switchRow(ov, 'doubles', (on) => {
    saveSetting('doubles', on);
    ov.querySelector('.set .qh')!.textContent = DOUBLES_HINT[String(on) as 'true' | 'false'];
  });
  toggle(ov, 'face', (v) => saveSetting('diceFace', v as 'top' | 'front'));
  switchRow(ov, 'sound', (on) => sfx.setMuted(!on));
  switchRow(ov, 'fast', (on) => saveSetting('fastBots', on));
  toggle(ov, 'killfx', (v) => saveSetting('killFx', v as 'full' | 'short' | 'off'));
  toggle(ov, 'undos', (v) => saveSetting('undos', Number(v) as 0 | 1 | 2));
  switchRow(ov, 'undowait', (on) => saveSetting('undoWait', on));
}

/**
 * The accuracy and luck trends (#134): your last reviewed games, oldest on the left; accuracy solid sky blue, luck
 * dashed orange (safe for colour-blindness, and solid vs dashed besides), a legend row naming both, the averages.
 */
function trendCard(box: HTMLElement, t: ReturnType<typeof trendOf>) {
  box.hidden = false;
  if (!t) {
    box.innerHTML = '<p class="tnote">Review 2 games to see your accuracy and luck trend.</p>';
    return;
  }
  const W = 300, H = 90, L = 22;
  const n = t.games.length;
  const x = (k: number) => L + (n > 1 ? k / (n - 1) : 0.5) * (W - L);
  const y = (v: number) => H * (1 - v / 100);
  const line = (vals: number[], cls: string) => {
    const pts = vals.flatMap((v, k) => (Number.isFinite(v) ? [`${x(k).toFixed(1)},${y(v).toFixed(1)}`] : []));
    return pts.length ? `<polyline class="${cls}" points="${pts.join(' ')}"/>${vals.map((v, k) => (Number.isFinite(v) ? `<circle class="${cls}" cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6"/>` : '')).join('')}` : '';
  };
  const grid = [0, 50, 100].map((v) => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`).join('');
  const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v)}%` : '–');
  box.innerHTML = `<h4>Accuracy and luck, your last ${n} games</h4>
    <p class="tlegend"><span class="acc"><i></i>Accuracy</span><span class="luck"><i></i>Luck-O-Meter</span></p>
    <svg viewBox="-4 -6 ${W + 8} ${H + 12}" aria-hidden="true">${grid}${line(t.games.map((g) => 100 * g.accuracy), 'acc')}${line(t.games.map((g) => g.luckPct), 'luck')}</svg>
    <p class="tavg">Average: <b class="acc">accuracy ${pct(100 * t.accuracy)}</b> · <b class="luck">luck ${pct(t.luck)}</b>. Oldest on the left.</p>`;
}

export async function statsSheet(host: HTMLElement, onReplay?: (rec: GameRecord) => void, onReview?: (rec: GameRecord) => void) {
  const s: Stats = await loadStats().catch(() => emptyStats());
  const past = await loadPastGames().catch(() => [] as PastGame[]);
  // The check-in achievements show the current run (still alive if the last check-in was today or yesterday);
  // whether they're done comes from the achievements already earned.
  const c = await loadCheckIn();
  const run = c && c !== 'error' && daysBetween(c.last, dayKey()) <= 1 ? c.streak : 0;
  const view: Stats = { ...s, checkinBest: run };
  const rate = s.played ? `${Math.round((100 * s.wins) / s.played)}%` : '–';
  const best = s.best ? ['', '1st', '2nd', '3rd', '4th'][s.best]! : '–';
  const cell = (v: string | number, label: string) => `<div class="st"><b class="disp">${v}</b><small>${label}</small></div>`;
  const empty = !s.played && !s.friends;
  // Achievements earned since the sheet last showed them: it opens on them, highlighted.
  const fresh = takeNew().filter((id) => settings.achieved.includes(id));
  const doneCount = ACHIEVEMENTS.filter((a) => settings.achieved.includes(a.id)).length;
  const achTab = fresh.length > 0;
  const statsPane = empty
    ? `<div class="empty"><b class="disp">No games yet</b><p class="sub">Play a game vs Computer and your wins, kills and best place show up here.</p></div>`
    : `<p class="sub">vs Computer, on this device</p>
    <div class="trend" hidden></div>
    <div class="stats">${cell(s.played, 'Games')}${cell(s.wins, 'Wins')}${cell(rate, 'Win rate')}${cell(best, 'Best place')}${cell(s.streak, 'Win streak')}${cell(s.bestStreak, 'Best streak')}${cell(s.kills, 'Kills')}${cell(s.sixes, 'Sixes')}${cell(s.xStreak, s.xBestStreak ? `Extreme (best ${s.xBestStreak})` : 'Extreme streak')}</div>
    <p class="sub">With friends: ${s.friends} game${s.friends === 1 ? '' : 's'}${s.undos ? ` · Undos used: ${s.undos}` : ''}</p>
    ${onReplay ? `<button class="pastrow" data-act="past"><span><b>Games &amp; reviews</b><small>${past.length ? `Your last ${past.length}: replays and reviews` : 'Finished games show up here'}</small></span><em>›</em></button>` : ''}
    <button class="reset" data-act="reset">Reset stats</button>`;
  const achPane = `<div class="achscroll">${GROUPS.map((g) => `<h4 class="achg">${g}</h4><div class="achlist">${ACHIEVEMENTS.filter((a) => a.group === g).map((a) => {
      const done = settings.achieved.includes(a.id);
      const [have, need] = a.progress?.(view) ?? [done ? 1 : 0, 1];
      // A streak nobody has started shows no "0/3".
      const bar = !done && need > 1 && !(a.quiet && have === 0);
      return `<div class="ar${done ? ' done' : ''}${fresh.includes(a.id) ? ' new' : ''}"><span class="ai">${done ? '🏆' : '🔒'}</span><span class="at"><b>${a.name}</b><small>${a.blurb}</small>${bar ? `<i class="bar"><i style="width:${(100 * have) / need}%"></i></i>` : ''}</span><em>${done ? 'Done' : bar ? `${have}/${need}` : ''}<i class="coin"></i>${a.gold}</em></div>`;
    }).join('')}</div>`).join('')}</div>`;
  const ov = sheet(
    host,
    'Your stats',
    `<div class="tg tabs" role="tablist"><button role="tab" data-tab="stats"${achTab ? '' : ' class="on" aria-selected="true"'}>Stats</button><button role="tab" data-tab="ach"${achTab ? ' class="on" aria-selected="true"' : ''}>Achievements ${doneCount}/${ACHIEVEMENTS.length}${fresh.length ? ` <i class="newdot">${fresh.length} new</i>` : ''}</button></div>
    <div class="pane" data-pane="stats"${achTab ? ' hidden' : ''}>${statsPane}</div><div class="pane" data-pane="ach"${achTab ? '' : ' hidden'}>${achPane}</div>`,
  );
  ov.querySelector('[data-act=past]')?.addEventListener('click', () => {
    ov.remove();
    pastGamesSheet(host, past, onReplay!, onReview);
  });
  // The accuracy and luck trends (#134): from the reviews' summaries (one small read), filled in when ready.
  void loadSummaries()
    .catch(() => ({}))
    .then(async (index) => {
      const games: { accuracy: number; luckPct: number }[] = [];
      for (const g of [...past].reverse()) {
        const me = g.mode === 'pvc' ? peopleOf(g.rec)[0] : undefined;
        if (me === undefined) continue;
        // Finished reviews only (#151): a review still under way is only its resume point, never a result.
        const s = await loadSummary(g.rec, index);
        const o = s?.done ? s.owners[me] : undefined;
        if (o && o.moves) games.push({ accuracy: o.accuracy ?? NaN, luckPct: o.luckPct ?? NaN });
      }
      const box = ov.querySelector<HTMLElement>('.trend');
      if (box && ov.isConnected) trendCard(box, trendOf(games));
    });
  ov.querySelector('.tabs')!.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-tab]');
    if (!b) return;
    ov.querySelectorAll<HTMLElement>('[data-tab]').forEach((t) => {
      t.classList.toggle('on', t === b);
      t.setAttribute('aria-selected', String(t === b));
    });
    ov.querySelectorAll<HTMLElement>('.pane').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  });
  const reset = ov.querySelector<HTMLButtonElement>('[data-act=reset]');
  reset?.addEventListener('click', async () => {
    // Two taps, so stats aren't wiped by accident.
    if (!reset.classList.contains('sure')) {
      reset.classList.add('sure');
      reset.textContent = 'Tap again to reset';
      return;
    }
    await resetStats();
    ov.remove();
    void statsSheet(host);
  });
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} day${h < 36 ? '' : 's'} ago`;
}

/**
 * The last finished games, newest first, with their reviews (#96): accuracy, luck % and the mistakes once
 * reviewed, a progress ring while the review runs. Tapping a game opens its review (or its replay, for a
 * game with no person in it); ▶ opens the replay.
 */
export function pastGamesSheet(host: HTMLElement, past: PastGame[], onReplay: (rec: GameRecord) => void, onReview?: (rec: GameRecord) => void) {
  const place = (p: number) => ['', '1st', '2nd', '3rd', '4th'][p] ?? '';
  // Each game's stored review lives under its own key: loaded once, then the rows are drawn again.
  const reviews = new Map<PastGame, StoredReview | undefined>();
  // A finished review's numbers come from its summary (#98); only the others are read in full.
  const sums = new Map<PastGame, ReviewSummary>();
  const status = (g: PastGame) => {
    const live = progressOf(g.rec);
    // Your side's progress: a bot's side being reviewed on demand doesn't hold the result back.
    if (live && !live.mine.finished) {
      const pct = live.mine.total ? Math.floor((100 * live.mine.done) / live.mine.total) : 0;
      return `<span class="pgr"><i class="ring" style="--p:${pct}"></i>Reviewing ${pct}%</span>`;
    }
    const stored = reviews.get(g);
    const me = peopleOf(g.rec)[0];
    const kept = !live?.mine.finished && me !== undefined ? sums.get(g)?.owners[me] : undefined;
    const r = live?.mine.finished ? { moves: live.moves, luck: live.luck } : isComplete(stored) ? stored! : stored?.old;
    if ((!r && !kept) || me === undefined) return `<span class="pgr off">${isQueued(g.rec) ? 'Review queued' : me === undefined ? '' : 'Not reviewed yet'}</span>`;
    const sum = kept
      ? { moves: kept.moves, accuracy: kept.accuracy ?? NaN, luckPct: kept.luckPct ?? NaN, labels: { mistake: kept.mistake, blunder: kept.blunder } }
      : summary(r!.moves, r!.luck ?? [], new Set(g.rec.seats.map((x) => x.owner)).size)[me]!;
    if (!sum.moves) return '<span class="pgr off">Not reviewed yet</span>';
    const luck = Number.isFinite(sum.luckPct) ? ` · Luck ${Math.round(sum.luckPct)}%` : '';
    // Two lines: accuracy and luck, then the mistakes and blunders as small chips (so nothing wraps at 360dp).
    // None of either shows no chips, rather than a sentence saying so.
    const chip = (sym: string, n: number, cls: string) => (n ? `<i class="pk ${cls}">${sym} ${n}</i>` : '');
    const keys = chip('?', sum.labels.mistake, 'mistake') + chip('??', sum.labels.blunder, 'blunder');
    return `<span class="pgr">${accuracyText(sum.accuracy)} accuracy${luck}</span><span class="pgks">${keys}</span>`;
  };
  const rows = () =>
    past
      .map((g, i) => {
        const people = new Set(g.rec.seats.map((s) => s.owner)).size;
        const colours = [...new Set(g.rec.seats.map((s) => s.color))].map((c) => `<i style="background:${PALETTE[c].m}"></i>`).join('');
        const what = g.mode === 'pvp' ? 'With friends' : 'vs Computer';
        return `<div class="pg${g.mode === 'pvc' && g.place === 1 ? ' won' : ''}"><button class="pgmain" data-i="${i}"><span class="pgc">${colours}</span><span class="pgt"><b>${what} · ${people} players</b><small>${ago(g.at)}${g.mode === 'pvc' ? ` · <em>${g.place === 1 ? '🏆 Won' : place(g.place)}</em>` : ''}</small>${status(g)}</span></button><button class="pgplay" data-replay="${i}" aria-label="Watch the replay">▶</button></div>`;
      })
      .join('');
  const ov = sheet(host, 'Games & reviews', past.length ? `<p class="sub">Tap a game for its review, ▶ for the replay</p><div class="pglist">${rows()}</div>` : `<div class="empty"><b class="disp">No games yet</b><p class="sub">Finish a game and its replay and review show up here.</p></div>`);
  // The statuses follow the reviews while the sheet is open.
  const list = ov.querySelector<HTMLElement>('.pglist');
  void loadSummaries()
    .catch(() => ({}))
    .then((index) =>
      Promise.all(
        past.map(async (g) => {
          const s = await loadSummary(g.rec, index);
          if (s?.done) sums.set(g, s);
          else reviews.set(g, await loadReview(g.rec).catch(() => undefined));
        }),
      ),
    )
    .then(() => {
      if (list && ov.isConnected) list.innerHTML = rows();
    });
  const off = onReviewChange(() => {
    if (!ov.isConnected) return off();
    if (list) list.innerHTML = rows();
  });
  list?.addEventListener('click', (e) => {
    const t = e.target as Element;
    const r = t.closest<HTMLElement>('[data-replay]')?.dataset.replay;
    const i = t.closest<HTMLElement>('[data-i]')?.dataset.i;
    if (r === undefined && i === undefined) return;
    off();
    ov.remove();
    const g = past[Number(r ?? i)]!;
    if (r === undefined && onReview && g.rec.seats.some((s) => !s.bot)) onReview(g.rec);
    else onReplay(g.rec);
  });
}
