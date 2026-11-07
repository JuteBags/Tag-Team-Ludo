// The online mode picker (#204): which game (the four modes) and, for 1(x2) v 1(x2), where a person's two
// colours sit. Its own piece, so the mode-select design (#210) can replace it without touching the room screens:
// it renders its rows, handles its own taps, and reports the choice.
import { GAME_MODES, MODE_LABEL, MODE_NOTE, type GameMode, type Pairing } from '../net/protocol';
import { sfx } from './sfx';

export interface ModeChoice {
  mode: GameMode;
  pairing: Pairing;
}

const tg = (k: string, items: [string, string][], on: string) => `<div class="tg" data-k="${k}">${items.map(([v, t]) => `<button data-v="${v}"${v === on ? ' class="on"' : ''}>${t}</button>`).join('')}</div>`;
const note = (mode: GameMode) => `${MODE_NOTE[mode]}. Places nobody takes are played by bots`;

/** The picker's rows (a fragment, to sit among the other options), starting at `choice`; `onChange` on every tap. */
export function modePicker(choice: ModeChoice, onChange: (c: ModeChoice) => void): DocumentFragment {
  const c = { ...choice };
  const t = document.createElement('template');
  t.innerHTML = `<div class="row2 q"><span class="lbl">Which game?</span>${tg('mode', GAME_MODES.map((m) => [m, MODE_LABEL[m]]), c.mode).replace('class="tg"', 'class="tg grid2"')}<small class="qh mnote">${note(c.mode)}</small></div>
        <div class="row2 q pairq"${c.mode === 'duo' ? '' : ' hidden'}><span class="lbl">Where are your two colours?</span>${tg('pairing', [['opposite', 'Opposite'], ['adjacent', 'Side by side']], c.pairing)}</div>`;
  const frag = t.content;
  const mnote = frag.querySelector<HTMLElement>('.mnote')!;
  const pairq = frag.querySelector<HTMLElement>('.pairq')!;
  frag.querySelectorAll<HTMLElement>('.tg').forEach((g) =>
    g.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button');
      if (!b) return;
      sfx.tick();
      g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (g.dataset.k === 'mode') {
        c.mode = b.dataset.v as GameMode;
        mnote.textContent = note(c.mode);
        pairq.hidden = c.mode !== 'duo';
      } else c.pairing = b.dataset.v as Pairing;
      onChange({ ...c });
    }),
  );
  return frag;
}
