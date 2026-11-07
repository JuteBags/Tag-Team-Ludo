// The app's side of Ranked PvP: the guest account (kept on this device) and the search queue.
//
// The account is made by the server on the first visit (POST /api/account); its id and secret stay in this
// device's storage. Losing them (clearing the app's data, reinstalling) means a new account; Google sign-in
// will later tie an account to a person instead of a device.
import { roomsUrl } from './client';
import { BOT_VERSION } from './localBots';
import { PROTOCOL, type AccountKey, type AccountReply, type GameMode, type QueueClientMsg, type QueueServerMsg } from './protocol';

const KEY = 'ludo-ranked-account';

export function savedKey(): AccountKey | null {
  try {
    const k = JSON.parse(localStorage.getItem(KEY) ?? 'null') as AccountKey | null;
    return k && typeof k.id === 'string' && typeof k.secret === 'string' ? k : null;
  } catch {
    return null;
  }
}

function saveKey(k: AccountKey | null) {
  try {
    if (k) localStorage.setItem(KEY, JSON.stringify({ id: k.id, secret: k.secret }));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: a new guest account next time.
  }
}

/** The server's HTTP address (the room server's WebSocket address, as http). */
const httpBase = () => roomsUrl().replace(/^ws/, 'http');

/** This device's ranked account and its ratings (made on the first call), with `name` as its name. */
export async function loadAccount(name: string): Promise<AccountReply> {
  const post = (key: AccountKey | null) =>
    fetch(`${httpBase()}/api/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(key ?? {}), name }) });
  let res = await post(savedKey());
  // The server doesn't know this key (a different server, or a wiped store): start a new account.
  if (res.status === 404) {
    saveKey(null);
    res = await post(null);
  }
  if (!res.ok) throw new Error(`account: HTTP ${res.status}`);
  const reply = (await res.json()) as AccountReply;
  saveKey(reply);
  return reply;
}

/** A search for a ranked game in one mode: the server's messages until it's matched, cancelled or lost. */
export class QueueLink {
  private ws: WebSocket;
  private listeners = new Set<(m: QueueServerMsg | { t: 'closed' }) => void>();
  private done = false;

  constructor(readonly mode: GameMode, account: AccountKey, name: string) {
    this.ws = new WebSocket(`${roomsUrl()}/mm?mode=${mode}`);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'queue', protocol: PROTOCOL, botVersion: BOT_VERSION, account: { id: account.id, secret: account.secret }, name } satisfies QueueClientMsg));
    this.ws.onmessage = (e) => {
      let m: QueueServerMsg;
      try {
        m = JSON.parse(String(e.data)) as QueueServerMsg;
      } catch {
        return;
      }
      if (m.t === 'matched' || m.t === 'error') this.done = true;
      this.emit(m);
    };
    // Closed without a match: the connection dropped (the search is over; the screen offers to search again).
    this.ws.onclose = () => {
      if (!this.done) this.emit({ t: 'closed' });
      this.done = true;
    };
  }

  on(f: (m: QueueServerMsg | { t: 'closed' }) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(m: QueueServerMsg | { t: 'closed' }) {
    for (const f of [...this.listeners]) f(m);
  }

  /** Stops searching. */
  cancel() {
    this.done = true;
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'leave' } satisfies QueueClientMsg));
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}
