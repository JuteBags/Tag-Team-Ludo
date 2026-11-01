// Daily check-in (#75): the first time the home screen opens on a new day, a card offers the day's gold.
// Days in a row grow the reward along a 7-day track that then repeats; a missed day starts again at day 1.
// Offline: the day is the device's local date. Closing the card is fine, it comes back next time home opens
// that day.
import { sfx } from './sfx';
import { earn } from './skins';
import { settings } from './settings';
import { loadCheckIn, saveCheckIn, type CheckIn } from './store';

/** Gold for each day of the 7-day track. A week is 380, about one cheap skin. */
export const CHECKIN_GOLD = [20, 30, 40, 50, 60, 80, 100];

/** The local date as YYYY-MM-DD. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whole days from day `a` to day `b` (both YYYY-MM-DD). */
const daysBetween = (a: string, b: string) => {
  const t = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((t(b) - t(a)) / 86400000);
};

/**
 * Today's reward, or null when today is already collected (or the clock was moved back before the last
 * check-in). `streak` counts days in a row, today included.
 */
export function due(c: CheckIn | null, today: string): { streak: number; day: number; gold: number } | null {
  const gap = c ? daysBetween(c.last, today) : 0;
  if (c && gap <= 0) return null;
  const streak = c && gap === 1 ? c.streak + 1 : 1;
  const day = ((streak - 1) % CHECKIN_GOLD.length) + 1;
  return { streak, day, gold: CHECKIN_GOLD[day - 1]! };
}

/** The check-in after collecting today's reward. */
export function collect(c: CheckIn | null, today: string): CheckIn {
  const d = due(c, today);
  if (!d) return c!;
  return { last: today, streak: d.streak, best: Math.max(c?.best ?? 0, d.streak) };
}

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Coins fly from `from` into the gold pill, which counts up to the new total. */
function flyCoins(screen: HTMLElement, from: DOMRect, gold: number) {
  const pill = screen.querySelector<HTMLElement>('.gp');
  if (!pill) return;
  const start = settings.gold - gold;
  const show = (n: number) => pill.replaceChildren(Object.assign(document.createElement('i'), { className: 'coin' }), String(n));
  if (calm()) return show(settings.gold);
  const to = pill.getBoundingClientRect();
  const size = to.height * 0.85;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.className = 'coin flycoin';
    Object.assign(c.style, { width: `${size}px`, height: `${size}px`, left: `${from.left + from.width / 2 - size / 2}px`, top: `${from.top + from.height / 2 - size / 2}px` });
    document.body.appendChild(c);
    const dx = to.left + to.width * 0.2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const spread = (i - (n - 1) / 2) * size * 0.9;
    const a = c.animate(
      [
        { transform: 'translate(0,0) scale(.6)', opacity: 0 },
        { transform: `translate(${spread}px,${-size * 2}px) scale(1.1)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${dx}px,${dy}px) scale(.8)`, opacity: 1 },
      ],
      { duration: 700, delay: i * 60, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'both' },
    );
    a.onfinish = () => {
      c.remove();
      show(Math.round(start + (gold * (i + 1)) / n));
      sfx.tick();
      pill.animate([{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 160 });
    };
  }
}

/** Shows today's check-in card over the home `screen` if it hasn't been collected. Resolves when it closes. */
export async function offerCheckIn(screen: HTMLElement): Promise<void> {
  const c = await loadCheckIn();
  const today = dayKey();
  const d = due(c, today);
  if (!d || !screen.isConnected) return;
  const week = Math.floor((d.streak - 1) / CHECKIN_GOLD.length);
  const track = CHECKIN_GOLD.map((g, i) => {
    const state = i + 1 < d.day ? 'got' : i + 1 === d.day ? 'now' : '';
    return `<span class="cd ${state}"><small>Day ${week * 7 + i + 1}</small><i class="coin"></i><b>${g}</b></span>`;
  }).join('');
  const ov = document.createElement('div');
  ov.className = 'menu-ov checkin-ov';
  ov.innerHTML = `<div class="box"><h2>Daily reward</h2><p class="sub">${d.streak === 1 ? 'Come back tomorrow for more' : `${d.streak} days in a row!`}</p>
    <div class="track">${track}</div>
    <button class="b3 green disp" data-act="collect"><i class="coin"></i> COLLECT ${d.gold}</button><button class="later" data-act="later">Later</button></div>`;
  screen.appendChild(ov);
  return new Promise((done) => {
    ov.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (b?.dataset.act === 'collect') {
        const from = b.getBoundingClientRect();
        void saveCheckIn(collect(c, today));
        earn(d.gold);
        ov.remove();
        flyCoins(screen, from, d.gold);
        done();
      } else if (b?.dataset.act === 'later' || e.target === ov) {
        ov.remove();
        done();
      }
    });
  });
}
