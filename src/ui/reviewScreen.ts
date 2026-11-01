// The game review screen (#65): for each person, accuracy, the labels of their moves and how lucky their dice
// were; a graph of their winning chances; and the moves as verdicts come in from the worker (reviewRun.ts).
// Tapping a move opens the replay there. Bots aren't reviewed, but their luck shows, so luck reads as
// "your dice vs theirs".
import { replay, type GameRecord, type GameState } from '../engine';
import { summary, type MoveReview } from '../engine/ai/review';
import { avatarSVG, cssVars, icons } from './art';
import { framesOf, namesOf } from './replay';
import { peopleOf, runReview, type ReviewProgress } from './reviewRun';
import { evenChance, graphPoints, LABEL_LOOK, LABELS, luckWords, moveText, SHOW_AFTER } from './reviewText';
import type { StoredReview } from './store';

const GW = 330;
const GH = 96;

/**
 * The review of `rec`. `stored` is a review kept from before; `store` keeps the result with the past game.
 * `onReplayAt(at)` opens the replay at the move made in position `at`.
 */
export function reviewScreen(rec: GameRecord, stored: StoredReview | undefined, onBack: () => void, onReplayAt: (at: number) => void, store = true): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen review';
  const states: GameState[] = replay(rec).states;
  const names = namesOf(rec);
  const owners = [...new Set(rec.seats.map((s) => s.owner))].sort((a, b) => a - b);
  const people = peopleOf(rec);
  const colorOf = (o: number) => rec.seats.find((s) => s.owner === o)!.color;
  // The move number a reviewed decision has in the replay (its step), so the two screens agree.
  const steps = new Map(framesOf(rec).frames.map((f, i) => [f.at, i]));
  const mode = rec.meta?.mode === 'pvp' ? 'WITH FRIENDS' : 'VS COMPUTER';
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>GAME REVIEW · ${mode}</small><b>${owners.length} PLAYERS</b></div><span class="rbtn-space"></span></div>
    <div class="rvbody">
      <div class="rvcards"></div>
      <div class="rvgraph"></div>
      <div class="rvprog"><span></span><i class="bar"><i></i></i></div>
      <div class="rvlist" role="list"></div>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;

  const draw = (p: ReviewProgress) => {
    const sum = summary(p.moves, p.luck ?? [], owners.length);
    // The people's cards; the bots' luck as one line each.
    q('.rvcards').replaceChildren(
      ...people.map((o) => {
        const s = sum[o]!;
        const card = document.createElement('div');
        card.className = 'rvcard';
        card.setAttribute('style', cssVars(colorOf(o)));
        const you = rec.meta?.mode !== 'pvp' || names[o] === 'You';
        const luck = p.luck ? luckWords(s.luck, you) : null;
        card.innerHTML = `<div class="rvwho"><i>${avatarSVG(colorOf(o))}</i><b></b><em>${s.moves ? `${Math.round(100 * s.accuracy)}%` : '–'}<small>accuracy</small></em></div>
          <div class="rvchips">${LABELS.map((l) => `<span style="--c:${LABEL_LOOK[l].color}" title="${LABEL_LOOK[l].name}"><i>${LABEL_LOOK[l].sym}</i>${s.labels[l]}</span>`).join('')}</div>
          ${luck ? `<div class="rvluck ${luck.tone}"><b>${luck.word}</b> <small>${s.luck >= 0 ? '+' : '−'}${Math.round(Math.abs(s.luck))}</small><p>${luck.line}</p></div>` : '<div class="rvluck"><p>Working out the dice luck…</p></div>'}`;
        card.querySelector('.rvwho b')!.textContent = names[o]!;
        return card;
      }),
      ...(p.luck
        ? owners
            .filter((o) => !people.includes(o))
            .map((o) => {
              const row = document.createElement('div');
              row.className = 'rvbotluck';
              const w = luckWords(sum[o]!.luck, false);
              row.innerHTML = `<i style="${cssVars(colorOf(o))}">${avatarSVG(colorOf(o))}</i><span></span><b class="${w.tone}">${w.word} ${sum[o]!.luck >= 0 ? '+' : '−'}${Math.round(Math.abs(sum[o]!.luck))}</b>`;
              row.querySelector('span')!.textContent = `${names[o]}'s dice`;
              return row;
            })
        : []),
    );
    // The graph: the first person's winning chances after each reviewed move, on a 0-100 axis with the even line.
    const mine = p.moves.filter((m) => m.owner === people[0]);
    const pts = graphPoints(
      mine.map((m) => m.playedChance),
      GW,
      GH,
    );
    const even = GH * (1 - evenChance(owners.length) / 100);
    q('.rvgraph').innerHTML = mine.length >= SHOW_AFTER
      ? `<small>${people.length > 1 ? `${names[people[0]!]}'s` : 'Your'} winning chances</small><svg viewBox="-6 -6 ${GW + 12} ${GH + 12}" aria-hidden="true">
          <line x1="0" y1="${even}" x2="${GW}" y2="${even}" class="even"/><text x="${GW}" y="${even - 4}" text-anchor="end">even</text>
          <polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>
          ${pts.map(([x, y], i) => (mine[i]!.label === 'best' || mine[i]!.label === 'good' ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${LABEL_LOOK[mine[i]!.label].color}" data-at="${mine[i]!.at}"/>`)).join('')}</svg>`
      : '';
    // Progress, then the moves (only once a few verdicts are in).
    q('.rvprog span').textContent = p.finished ? `${p.done} moves reviewed` : `Reviewing… ${p.done} of ${p.total}`;
    q<HTMLElement>('.rvprog .bar i').style.width = `${p.total ? (100 * p.done) / p.total : 100}%`;
    q('.rvprog').classList.toggle('done', p.finished);
    const list = q('.rvlist');
    list.replaceChildren();
    if (p.moves.length < SHOW_AFTER && !p.finished) return;
    for (const m of p.moves) list.appendChild(row(m));
  };

  const row = (m: MoveReview) => {
    const s = states[m.at]!;
    const look = LABEL_LOOK[m.label];
    const b = document.createElement('button');
    b.className = `rvrow ${m.label}`;
    b.dataset.at = String(m.at);
    b.setAttribute('role', 'listitem');
    const who = people.length > 1 ? `${names[m.owner]} ` : 'You ';
    const best = m.played === m.best || m.label === 'best' ? '' : ` · Best: ${moveText(s.moves[m.best]!)}`;
    b.innerHTML = `<i style="--c:${look.color}">${look.sym}</i><span><b>${look.name}${m.label !== 'best' && m.gap >= 1 ? ` −${Math.round(m.gap)}` : ''}</b><small></small></span>`;
    b.querySelector('small')!.textContent = `Move ${steps.get(m.at + 1) ?? '?'} · ${who}${moveText(s.moves[m.played]!)}${best}`;
    return b;
  };

  el.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-act=back]')) {
      stop();
      onBack();
      return;
    }
    const at = t.closest<HTMLElement>('[data-at]')?.dataset.at;
    if (at === undefined) return;
    // A dot on the graph scrolls its move into view; a move opens the replay there.
    if (t.closest('.rvgraph')) el.querySelector(`.rvrow[data-at="${at}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else {
      stop();
      onReplayAt(Number(at));
    }
  });
  const stop = runReview(rec, stored, draw, store);
  return el;
}
