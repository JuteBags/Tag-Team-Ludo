// Daily check-in (#75): the first time the home screen opens on a new day, a card offers the day's gold.
// Days in a row grow the reward along a 7-day track that then repeats; a missed day starts again at day 1.
// Offline: the day is the device's local date. Closing the card is fine, it comes back next time home opens
// that day.
import { sfx } from './sfx';
import { earn } from './skins';
import { award, newAchievements } from './rewards';
import { settings } from './settings';
import { loadCheckIn, recordCheckIn, saveCheckIn, type CheckIn } from './store';

/** Gold for each day of the 7-day track. A week is 380, about one cheap skin. */
export const CHECKIN_GOLD = [20, 30, 40, 50, 60, 80, 100];

/** The local date as YYYY-MM-DD. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whole days from day `a` to day `b` (both YYYY-MM-DD). */
export const daysBetween = (a: string, b: string) => {
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

/** Coins fly from `from` into the gold pill, which counts up to the new total. They live in `screen`, so they go with it. */
function flyCoins(screen: HTMLElement, from: DOMRect, gold: number) {
  const pill = screen.querySelector<HTMLElement>('.gp');
  if (!pill) return;
  const start = settings.gold - gold;
  const show = (n: number) => pill.replaceChildren(Object.assign(document.createElement('i'), { className: 'coin' }), String(n));
  if (calm()) return show(settings.gold);
  // Screen pixels to the (scaled) stage's own pixels.
  const box = screen.getBoundingClientRect();
  const k = screen.offsetWidth / box.width;
  const to = pill.getBoundingClientRect();
  const size = to.height * 0.85 * k;
  const x0 = (from.left + from.width / 2 - box.left) * k, y0 = (from.top + from.height / 2 - box.top) * k;
  const dx = (to.left + to.width * 0.2 - box.left) * k - x0, dy = (to.top + to.height / 2 - box.top) * k - y0;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.className = 'coin flycoin';
    Object.assign(c.style, { width: `${size}px`, height: `${size}px`, left: `${x0 - size / 2}px`, top: `${y0 - size / 2}px` });
    screen.appendChild(c);
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
      if (!screen.isConnected) return;
      show(Math.round(start + (gold * (i + 1)) / n));
      sfx.tick();
      pill.animate([{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 160 });
    };
  }
}

/** A short achievement note over the home screen. */
function toast(screen: HTMLElement, html: string, delay: number, row: number) {
  const t = document.createElement('div');
  t.className = 'achtoast';
  t.style.top = `${120 + row * 50}px`;
  t.innerHTML = html;
  screen.appendChild(t);
  t.animate([{ opacity: 0, transform: 'translate(-50%,10px)' }, { opacity: 1, transform: 'translate(-50%,0)', offset: 0.12 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: 3200, delay, fill: 'both' }).onfinish = () => t.remove();
}

/** Shows today's check-in card over the home `screen` if it hasn't been collected. Resolves when it closes. */
export async function offerCheckIn(screen: HTMLElement): Promise<void> {
  const c = await loadCheckIn();
  // Storage that can't be read isn't a new player: offering day 1 would reset a real streak.
  if (c === 'error') return;
  const d = due(c, dayKey());
  if (!d || !screen.isConnected) return;
  const week = Math.floor((d.streak - 1) / CHECKIN_GOLD.length);
  const track = CHECKIN_GOLD.map((g, i) => {
    const state = i + 1 < d.day ? 'got' : i + 1 === d.day ? 'now' : '';
    return `<span class="cd ${state}"><small>Day ${week * 7 + i + 1}</small><i class="coin"></i><b>${g}</b></span>`;
  }).join('');
  const ov = document.createElement('div');
  ov.className = 'menu-ov checkin-ov';
  ov.innerHTML = `<div class="box"><h2>Daily reward</h2><p class="sub">${d.streak === 1 ? 'Day 1 of 7: more each day in a row' : `${d.streak} days in a row!`}</p>
    <div class="track">${track}</div>
    <button class="b3 green disp" data-act="collect"><i class="coin"></i> COLLECT ${d.gold}</button><button class="later" data-act="later">Later</button></div>`;
  screen.appendChild(ov);
  return new Promise((done) => {
    ov.addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
      if (b?.dataset.act === 'collect') {
        if (b.disabled) return;
        b.disabled = true;
        const from = b.getBoundingClientRect();
        // The day again, in case the card stayed open past midnight. The check-in is stored before the gold
        // is paid: a failed write loses one day's gold rather than paying it twice.
        const today = dayKey();
        const now = due(c, today);
        const next = collect(c, today);
        if (now && (await saveCheckIn(next))) {
          // A long enough run completes the check-in achievements; their gold flies in with the day's.
          const fresh = newAchievements(await recordCheckIn(next.best), null, settings.achieved);
          award(fresh.map((a) => a.id));
          const gold = now.gold + fresh.reduce((a, x) => a + x.gold, 0);
          earn(gold);
          flyCoins(screen, from, gold);
          fresh.forEach((a, i) => toast(screen, `🏆 ${a.name} <em>+${a.gold}</em>`, 900 + i * 400, i));
        }
        ov.remove();
        done();
      } else if (b?.dataset.act === 'later' || e.target === ov) {
        ov.remove();
        done();
      }
    });
  });
}
