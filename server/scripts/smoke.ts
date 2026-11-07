// End-to-end check of a running room server (default: `npm run dev` on this computer). Two players create and
// join a room over real WebSockets; the host starts it; each keeps the game with the engine (as the app does)
// and plays a random legal move on its turn, until the game is over. Bots take ~1 s per step on the server.
// Run: npm run smoke -- [ws://localhost:8787] [ffa|1v1|duo|2v2] [easy|normal|hard]
import { STOP_EVENT, applyEvent, createGame, moveEvent, type GameState } from '../../src/engine';
import { PROTOCOL, modeSlots, type GameMode, type GameSetup, type ServerMsg } from '../../src/net/protocol';

const base = process.argv[2] ?? 'ws://localhost:8787';
const mode = (process.argv[3] ?? '1v1') as GameMode;
const botLevel = process.argv[4] ?? 'normal';
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Player {
  ws: WebSocket;
  token = hex();
  state: GameState | null = null;
  setup: GameSetup | null = null;
  events: string[] = [];
  you = -1;
  code = '';
  members = 0;
  over: Extract<ServerMsg, { t: 'over' }> | null = null;
  errors: string[] = [];
  constructor(readonly name: string, url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => this.send({ t: 'hello', protocol: PROTOCOL, token: this.token, name }));
    this.ws.addEventListener('message', (e) => this.on(JSON.parse(String(e.data)) as ServerMsg));
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  on(m: ServerMsg) {
    if (m.t === 'lobby') ((this.code = m.code), (this.you = m.you), (this.members = m.members.length));
    else if (m.t === 'game') {
      this.you = m.you;
      this.setup = m.setup;
      this.events = [...m.events];
      this.state = createGame(m.setup.seats, m.setup.first, m.setup.singles);
      for (const ev of m.events) if (ev !== STOP_EVENT) this.state = applyEvent(this.state, ev);
    } else if (m.t === 'ev') {
      if (m.seq !== this.events.length) throw new Error(`${this.name}: gap at ${m.seq}`);
      this.events.push(m.ev);
      if (m.ev !== STOP_EVENT) this.state = applyEvent(this.state!, m.ev);
      this.act();
    } else if (m.t === 'over') this.over = m;
    else if (m.t === 'error') this.errors.push(m.code);
  }
  /** On our turn: roll, or a random legal move, after a short "thinking" pause. */
  act() {
    const s = this.state;
    if (!s || s.phase === 'over' || this.over) return;
    const p = s.players[s.current]!;
    if (this.setup?.control[p.color] !== this.you) return;
    const seq = this.events.length;
    setTimeout(() => {
      if (this.events.length !== seq) return;
      if (s.phase === 'roll') this.send({ t: 'roll', seq });
      else this.send({ t: 'move', seq, ev: moveEvent(s.moves[Math.floor(Math.random() * s.moves.length)]!) });
    }, 30);
  }
}

const until = async (f: () => boolean, ms = 15_000) => {
  for (const t0 = Date.now(); !f(); await wait(20)) if (Date.now() - t0 > ms) throw new Error('timed out');
};

const a = new Player('Asha', `${base}/ws?create=${encodeURIComponent(JSON.stringify({ mode, pairing: 'opposite', singles: false, botLevel }))}`);
await until(() => !!a.code);
const b = new Player('Bilal', `${base}/ws?code=${a.code.toLowerCase()}`);
await until(() => a.members === 2);
console.log(`room ${a.code}: ${mode}, 2 people, ${modeSlots(mode).length - 2} bot slots`);
const t0 = Date.now();
a.send({ t: 'start' });
await until(() => !!a.state && !!b.state);
a.act();
b.act();
const s = a.state!;
console.log('started; first:', s.players[s.current]!.color);
await until(() => !!a.over && !!b.over, 30 * 60_000);
const same = a.events.join() === b.events.join();
console.log(`over in ${Math.round((Date.now() - t0) / 1000)} s: ${a.events.length} events, same on both: ${same}, stopped: ${a.over!.stopped}, seed revealed: ${a.over!.seed}, errors: ${JSON.stringify([...a.errors, ...b.errors])}`);
a.ws.close();
b.ws.close();
process.exit(same && !a.errors.length && !b.errors.length ? 0 : 1);
