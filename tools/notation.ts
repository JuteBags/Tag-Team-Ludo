// The game notation read back into a record (#164; the spec is docs/NOTATION.md). For us, not the app (the app
// has no import): turning a pasted game into a replayable record, to debug or study it.
//   npx tsx tools/notation.ts game.ttl.txt      prints the record as JSON, after checking it replays
// parseNotation checks each move's landing square against the replay, so a hand-edited game fails loudly.
import { COLORS, type Color } from '../src/engine/board';
import type { Seat } from '../src/engine/game';
import { moveEvent, NOTATION_NAME, PAWN_LETTERS, replay, rollEvent, squareName, STOP_EVENT, type GameRecord } from '../src/engine/record';
import type { BotLevel, Move } from '../src/engine/types';

const COLOR_OF_NAME = Object.fromEntries(COLORS.map((c) => [NOTATION_NAME[c], c])) as Record<string, Color>;
const LETTER_COLOR: Record<string, Color> = { B: 'blue', G: 'green', R: 'red', Y: 'yellow' };
const PAWN: Record<string, { color: Color; token: number }> = Object.fromEntries(
  COLORS.flatMap((c) => [...PAWN_LETTERS[c]].map((l, token) => [l, { color: c, token }])),
);
const LEVELS: Record<string, BotLevel> = { Easy: 'easy', Normal: 'normal', Hard: 'hard', Extreme: 'extreme' };

export type Parsed = { ok: true; record: GameRecord } | { ok: false; error: string };

const unquote = (v: string) => v.replace(/\\(.)/g, '$1');

/** The notation back into a game record, or why it can't be one. */
export function parseNotation(text: string): Parsed {
  const fail = (error: string): Parsed => ({ ok: false, error });
  const tags = new Map<string, string>();
  const colorTags: [Color, string][] = [];
  const body: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const tag = /^\[(\w+) "((?:[^"\\]|\\.)*)"\]$/.exec(line);
    if (tag) {
      const v = unquote(tag[2]!);
      if (COLOR_OF_NAME[tag[1]!]) colorTags.push([COLOR_OF_NAME[tag[1]!]!, v]);
      else tags.set(tag[1]!, v);
    } else body.push(line.replace(/^\d+\.\s*/, ''));
  }
  if (colorTags.length < 2) return fail('needs a tag for each colour in play');

  // Who plays which colour: owners by the [Sides] tag, else one per colour in tag order.
  const names: string[] = [];
  const ownerOf = new Map<Color, number>();
  const sides = tags.get('Sides');
  if (sides) {
    for (const part of sides.split('; ')) {
      const at = part.lastIndexOf(': ');
      if (at < 0) return fail(`a side without colours: ${part}`);
      names.push(part.slice(0, at));
      for (const n of part.slice(at + 2).split(', ')) {
        if (!COLOR_OF_NAME[n]) return fail(`an unknown colour in [Sides]: ${n}`);
        ownerOf.set(COLOR_OF_NAME[n]!, names.length - 1);
      }
    }
  }
  const seats: Seat[] = colorTags.map(([color, v]) => {
    const bot = /^(.*) \(Bot(?: (Easy|Normal|Hard|Extreme))?\)$/.exec(v);
    const name = bot ? bot[1]! : v;
    if (!ownerOf.has(color)) {
      ownerOf.set(color, names.length);
      names.push(name);
    }
    const seat: Seat = { color, owner: ownerOf.get(color)!, bot: !!bot };
    if (bot?.[2]) seat.level = LEVELS[bot[2]]!;
    return seat;
  });
  const first = COLOR_OF_NAME[tags.get('First') ?? ''];
  if (!first) return fail('needs [First]');
  const mode = tags.get('Mode') === 'With friends' ? 'pvp' : tags.get('Mode') === 'vs Computer' ? 'pvc' : undefined;
  const meta: Record<string, unknown> = { ...(mode ? { mode } : {}), names };
  const undos = tags.get('Undos');
  if (undos) {
    const used: Record<number, number> = {};
    for (const part of undos.split(', ')) {
      const m = /^(.*) (\d+)$/.exec(part);
      const o = m ? names.indexOf(m[1]!) : -1;
      if (o < 0) return fail(`an unknown person in [Undos]: ${part}`);
      used[o] = Number(m![2]);
    }
    meta.undos = used;
  }
  const seed = tags.has('Seed') ? Number(tags.get('Seed')) : undefined;

  // The moves: a colour letter starts a turn, `|` a bonus roll; dice until `:`, then the moves (pawn(s),
  // `+die` or nothing for out of base, the landing square, an optional `x...`). Brackets after moves are dice
  // nothing could use (no events); brackets in a turn's dice are its rolls. `6✕` or `666X`: a run of three 6s.
  let events = '';
  const lands: { color: Color; square: string }[] = [];
  let inMoves = false;
  let afterMoves = false;
  const toks = body.join(' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (LETTER_COLOR[t]) {
      inMoves = afterMoves = false;
      continue;
    }
    if (t === '|') {
      inMoves = afterMoves = false;
      continue;
    }
    if (!inMoves) {
      if (afterMoves) return fail(`a die after the moves, not in brackets: ${t}`);
      const d = t.replace(/[[\]:]/g, '');
      if (/^666[X✕]$/.test(d)) events += '666';
      else if (/^[1-6][X✕]?$/.test(d)) events += rollEvent(Number(d[0]));
      else if (d) return fail(`not a die: ${t}`);
      if (t.endsWith(':')) inMoves = true;
      continue;
    }
    if (t.startsWith('[')) {
      // Dice nothing could use: skip to the closing bracket.
      while (!toks[i]!.endsWith(']')) i++;
      afterMoves = true;
      continue;
    }
    const m = /^([a-dg-jm-ps-v]{1,2})(?:\+([1-6]))?$/.exec(t);
    if (!m) return fail(`not a move: ${t}`);
    const pawns = [...m[1]!].map((l) => PAWN[l]!);
    if (pawns.some((p) => p.color !== pawns[0]!.color)) return fail(`a pair of two colours: ${t}`);
    const square = toks[++i];
    if (!square || !/^(#|[BGRY]H[1-5]|[BGRY](1[0-3]|[1-9]))$/.test(square)) return fail(`no landing square after ${t}`);
    lands.push({ color: pawns[0]!.color, square });
    if (toks[i + 1]?.startsWith('x')) i++;
    events += moveEvent({ tokens: pawns.map((p) => p.token), roll: m[2] ? Number(m[2]) : 6 } as Move);
  }
  if ((tags.get('Result') ?? '').endsWith('(stopped)')) events += STOP_EVENT;

  const record: GameRecord = { v: 1, seats, first, ...(tags.get('Doubles') === 'Off' ? { singles: true } : {}), ...(seed !== undefined ? { seed } : {}), meta, events };
  const rep = replay(record);
  if (!rep.ok) return fail(rep.error);
  // Every move lands where the notation says (states[i + 1] follows the event at `at`: a die is one character, a move two).
  let k = 0;
  let at = 0;
  for (let i = 0; i + 1 < rep.states.length; i++) {
    const s = rep.states[i]!;
    if (s.phase !== 'move') {
      at++;
      continue;
    }
    const code = events.slice(at, at + 2);
    at += 2;
    const m = s.moves.find((x) => moveEvent(x) === code)!;
    const want = lands[k++]!;
    const got = squareName(m.color, m.to);
    if (got !== want.square) return fail(`move ${k} lands on ${got}, not ${want.square}`);
  }
  return { ok: true, record };
}

// The command line: read a file, print the record. (The project has no @types/node: Node is reached loosely.)
const proc = (globalThis as { process?: { argv: string[]; exitCode?: number } }).process;
const script = proc?.argv[1]?.replace(/\\/g, '/');
if (proc?.argv[2] && script && /\/tools\/notation\.ts$/.test(script)) {
  // @ts-expect-error: no @types/node in the project; tsx runs this on Node.
  const { readFileSync } = (await import('node:fs')) as { readFileSync: (f: string, enc: string) => string };
  const r = parseNotation(readFileSync(proc.argv[2], 'utf8'));
  if (r.ok) console.log(JSON.stringify(r.record));
  else {
    console.error(`not a game: ${r.error}`);
    proc.exitCode = 1;
  }
}
