// The binary net (src/engine/ai/netbin.ts, #98): extreme-net.bin is extreme-net.json's weights rounded to
// Float32, exactly, so the app evaluates as the rounded net does. (That rounding changed no game, no review
// label and no Extreme choice on CI: .github/workflows/net-f32.yml.) If the JSON changes (a new training
// run), regenerate the .bin:
//   UPDATE_NET_BIN=1 npx vitest run tests/netBin.test.ts
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync, writeFileSync } from 'node:fs';
import { createGame, move, roll, seeded, SEATS, type GameState } from '../src/engine';
import { Net, type NetJSON } from '../src/engine/ai/net';
import { decodeNet, encodeNet, roundNet } from '../src/engine/ai/netbin';
import { ownerValues } from '../src/engine/ai/search';

const binUrl = new URL('../src/engine/ai/extreme-net.bin', import.meta.url);
const json = JSON.parse(readFileSync(new URL('../src/engine/ai/extreme-net.json', import.meta.url), 'utf8')) as NetJSON;
// @ts-expect-error: process is Node's.
if (process.env.UPDATE_NET_BIN) writeFileSync(binUrl, encodeNet(json));
const bin = new Uint8Array(readFileSync(binUrl));

describe('extreme-net.bin', () => {
  it('is extreme-net.json encoded, byte for byte (regenerate with UPDATE_NET_BIN=1)', () => {
    expect(bin).toEqual(encodeNet(json));
  });

  it('holds every weight of the JSON rounded to Float32, exactly (Object.is, so even -0 and the last bit match)', () => {
    const d = decodeNet(bin);
    const r = roundNet(json);
    const layers = [...r.trunk, r.pool, r.out];
    const got = [...d.trunk, d.pool, d.out];
    expect(got.length).toBe(layers.length);
    expect([...d.inputs]).toEqual(json.inputs);
    let n = 0;
    layers.forEach((l, k) => {
      const g = got[k]!;
      expect([g.out, g.inn]).toEqual([l.b.length, l.W[0]!.length]);
      l.W.flat().forEach((w, i) => {
        if (!Object.is(g.W[i], w)) expect.fail(`layer ${k} W[${i}]: ${g.W[i]} != ${w}`);
        n++;
      });
      l.b.forEach((b, i) => {
        if (!Object.is(g.b[i], b)) expect.fail(`layer ${k} b[${i}]: ${g.b[i]} != ${b}`);
        n++;
      });
    });
    expect(n).toBeGreaterThan(50_000);
  });

  it('evaluates exactly as the rounded JSON net, and within 1e-6 of the Float64 one, position after position', () => {
    const a = new Net(roundNet(json));
    const b = new Net(decodeNet(bin));
    const f64 = new Net(json);
    let checked = 0;
    for (const players of [2, 4] as const) {
      const rng = seeded(players);
      let s: GameState = createGame(SEATS[players].map((color, owner) => ({ color, owner, bot: true, level: 'hard' })));
      for (let i = 0; i < 3000 && s.phase !== 'over'; i++) {
        if (s.phase === 'roll') {
          const va = ownerValues(a, s, players);
          const vb = ownerValues(b, s, players);
          const v64 = ownerValues(f64, s, players);
          for (let k = 0; k < players; k++) {
            if (!Object.is(va[k], vb[k])) expect.fail(`position ${i}: ${va[k]} != ${vb[k]}`);
            expect(Math.abs(vb[k]! - v64[k]!)).toBeLessThan(1e-6);
          }
          checked++;
          s = roll(s, rng);
        } else s = move(s, s.moves[Math.floor(rng() * s.moves.length)]!);
      }
    }
    expect(checked).toBeGreaterThan(200);
    // About 2 s alone, but past vitest's 5 s default while the whole suite runs in parallel.
  }, 30_000);
});
