// End-to-end check of Ranked against a running server: guest accounts, the queue, the matched room and the
// rating. With two players they're matched at once; with one (`solo`), bots fill the game after a minute.
// Run: npx esbuild scripts/ranked-smoke.ts --bundle --platform=node --format=esm --outfile=.wrangler/ranked.mjs
//      node .wrangler/ranked.mjs [ws://localhost:8787] [ffa|1v1|duo|2v2] [solo]
import { STOP_EVENT, applyEvent, createGame, moveEvent, type GameState } from '../../src/engine';
import { PROTOCOL, type AccountReply, type GameMode, type GameSetup, type QueueServerMsg, type ServerMsg } from '../../src/net/protocol';

const base = process.argv[2] ?? 'ws://localhost:8787';
const mode = (process.argv[3] ?? '1v1') as GameMode;
const solo = process.argv[4] === 'solo';
const http = base.replace(/^ws/, 'http');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !f(); await wait(50)) if (Date.now() - t0 > ms) throw new Error('timed out');
};

async function account(name: string): Promise<AccountReply> {
  const res = await fetch(`${http}/api/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  return (await res.json()) as AccountReply;
}

class Player {
  state: GameState | null = null;
  setup: GameSetup | null = null;
  events: string[] = [];
  you = -1;
  over = false;
  rated: Extract<ServerMsg, { t: 'rated' }> | null = null;
  matched: Extract<QueueServerMsg, { t: 'matched' }> | null = null;
  lastSearch: Extract<QueueServerMsg, { t: 'search' }> | null = null;
  room: WebSocket | null = null;
  constructor(readonly acc: AccountReply) {}

  queue() {
    const ws = new WebSocket(`${base}/mm?mode=${mode}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'queue', protocol: PROTOCOL, account: { id: this.acc.id, secret: this.acc.secret }, name: this.acc.name }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as QueueServerMsg;
      if (m.t === 'search') this.lastSearch = m;
      if (m.t === 'matched') {
        this.matched = m;
        this.join(m.code, m.token);
      }
      if (m.t === 'error') console.log(this.acc.name, 'queue error', m);
    };
  }

  join(code: string, token: string) {
    const ws = new WebSocket(`${base}/ws?code=${code}`);
    this.room = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, token, name: this.acc.name }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMsg;
      if (m.t === 'game') {
        this.you = m.you;
        this.setup = m.setup;
        this.events = [...m.events];
        this.state = createGame(m.setup.seats, m.setup.first, m.setup.singles);
        for (const ev of m.events) if (ev !== STOP_EVENT) this.state = applyEvent(this.state, ev);
        this.act();
      } else if (m.t === 'ev') {
        this.events.push(m.ev);
        if (m.ev !== STOP_EVENT) this.state = applyEvent(this.state!, m.ev);
        this.act();
      } else if (m.t === 'over') this.over = true;
      else if (m.t === 'rated') this.rated = m;
      else if (m.t === 'error') console.log(this.acc.name, 'room error', m.code);
    };
  }

  act() {
    const s = this.state;
    if (!s || s.phase === 'over' || this.over) return;
    if (this.setup!.control[s.players[s.current]!.color] !== this.you) return;
    const seq = this.events.length;
    setTimeout(() => {
      if (this.events.length !== seq) return;
      if (s.phase === 'roll') this.room!.send(JSON.stringify({ t: 'roll', seq }));
      else this.room!.send(JSON.stringify({ t: 'move', seq, ev: moveEvent(s.moves[Math.floor(Math.random() * s.moves.length)]!) }));
    }, 20);
  }
}

const people = solo ? 1 : 2;
const players = await Promise.all(Array.from({ length: people }, (_, i) => account(`Ranker${i + 1}`)).map(async (a) => new Player(await a)));
console.log('accounts:', players.map((p) => `${p.acc.name} ${p.acc.ratings[mode].rating}`).join(', '));
const t0 = Date.now();
players.forEach((p) => p.queue());
await until(() => players.every((p) => p.matched), solo ? 90_000 : 20_000);
console.log(`matched in ${((Date.now() - t0) / 1000).toFixed(1)} s, room ${players[0]!.matched!.code}; last search:`, JSON.stringify(players[0]!.lastSearch));
await until(() => players.every((p) => p.setup), 10_000);
const setup = players[0]!.setup!;
console.log('seats:', setup.seats.map((s) => `${s.color}:${setup.control[s.color]! >= 0 ? setup.people[setup.control[s.color]!] : `bot(${s.level})`}/side${s.owner}`).join(' '));
await until(() => players.every((p) => p.rated), 30 * 60_000);
console.log(`rated after ${Math.round((Date.now() - t0) / 1000)} s:`, players.map((p) => `${p.acc.name} ${p.rated!.before} -> ${p.rated!.after}`).join(', '));
// The account store kept it.
const again = await fetch(`${http}/api/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: players[0]!.acc.id, secret: players[0]!.acc.secret, name: players[0]!.acc.name }) }).then((r) => r.json() as Promise<AccountReply>);
console.log('stored:', JSON.stringify(again.ratings[mode]));
process.exit(0);
