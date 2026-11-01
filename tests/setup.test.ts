import { describe, expect, it } from 'vitest';
import { NAME_MAX, cleanName, defaultName, pickSequence, pickable, previewLayout, quickSeats, rankRolls, turnLayout, type PickRules } from '../src/ui/setup';

const one: PickRules = { houses: 1, pairing: 'opposite' };
const opp: PickRules = { houses: 2, pairing: 'opposite' };
const adj: PickRules = { houses: 2, pairing: 'adjacent' };

describe('rolling for order', () => {
  it('orders people by their roll, highest first', () => {
    expect(rankRolls([[0, 2], [1, 6], [2, 4]])).toEqual([[1], [2], [0]]);
  });
  it('groups ties so they can roll again', () => {
    expect(rankRolls([[0, 4], [1, 6], [2, 4]])).toEqual([[1], [0, 2]]);
  });
});

describe('picking houses', () => {
  it('takes turns in roll order, twice round with two houses each', () => {
    expect(pickSequence([1, 0], 1)).toEqual([1, 0]);
    expect(pickSequence([1, 0], 2)).toEqual([1, 0, 1, 0]);
  });

  it('offers any free house with one house each', () => {
    expect(pickable({ blue: 0 }, 1, one)).toEqual(['green', 'red', 'yellow']);
  });

  it("makes a second pick the first one's opposite", () => {
    expect(pickable({ blue: 0, green: 1 }, 0, opp)).toEqual(['red']);
  });

  it("never lets the other person take a house someone's pair needs", () => {
    // Person 0 holds Blue and needs Red, so person 1 can't take Red.
    expect(pickable({ blue: 0 }, 1, opp)).toEqual(['green', 'yellow']);
  });

  it("makes a second pick one of the first one's neighbours", () => {
    expect(pickable({ blue: 0 }, 0, adj)).toEqual(['green', 'yellow']);
    expect(pickable({ blue: 0, green: 1 }, 0, adj)).toEqual(['yellow']);
  });

  it('allows any first pick when neighbours are still free', () => {
    expect(pickable({ blue: 0 }, 1, adj)).toEqual(['green', 'red', 'yellow']);
  });
});

describe('the options preview', () => {
  it('shows two people opposite each other, and empty houses, with one colour each', () => {
    expect(previewLayout(2, one, 0)).toEqual({ blue: 'p1', green: 'empty', red: 'p2', yellow: 'empty' });
  });
  it('fills empty houses with the bots added, in turn order', () => {
    expect(previewLayout(2, one, 1)).toEqual({ blue: 'p1', green: 'bot', red: 'p2', yellow: 'empty' });
    expect(previewLayout(2, one, 2)).toEqual({ blue: 'p1', green: 'bot', red: 'p2', yellow: 'bot' });
  });
  it('gives each person two colours, opposite or side by side', () => {
    expect(previewLayout(2, opp, 0)).toEqual({ blue: 'p1', green: 'p2', red: 'p1', yellow: 'p2' });
    expect(previewLayout(2, adj, 0)).toEqual({ blue: 'p1', green: 'p2', red: 'p2', yellow: 'p1' });
  });
  it('seats three players with or without a bot, and four players in every house', () => {
    expect(previewLayout(3, one, 0)).toEqual({ blue: 'p1', green: 'p2', red: 'p3', yellow: 'empty' });
    expect(previewLayout(3, one, 1)).toEqual({ blue: 'p1', green: 'p2', red: 'p3', yellow: 'bot' });
    expect(previewLayout(4, one, 0)).toEqual({ blue: 'p1', green: 'p2', red: 'p3', yellow: 'p4' });
  });
});

describe('player names', () => {
  it('keeps ordinary names as typed, trimmed', () => {
    expect(cleanName('  Ashu ', 'Player 1')).toBe('Ashu');
    expect(cleanName('Ravi  Kumar', 'Player 2')).toBe('Ravi Kumar');
  });
  it('drops characters that could form markup', () => {
    expect(cleanName('<b>Bo</b>', 'Player 1')).toBe('bBo/b');
    expect(cleanName('"Tom" & \'Jo\'', 'Player 1')).toBe('Tom Jo');
  });
  it('cuts long names and falls back when empty', () => {
    expect(cleanName('Abcdefghijklmnop', 'Player 1')).toHaveLength(NAME_MAX);
    expect(cleanName('   ', 'Player 3')).toBe('Player 3');
    expect(cleanName('<>', 'You')).toBe('You');
  });
  it('names seats Player 1, 2... with friends and You against the computer', () => {
    expect(defaultName('pvp', 1)).toBe('Player 2');
    expect(defaultName('pvc', 0)).toBe('You');
  });
});

describe('quick start seats vs Computer', () => {
  const one: PickRules = { houses: 1, pairing: 'opposite' };
  it('puts you on your colour and the bots in the usual seats turned the same way', () => {
    expect(quickSeats(2, one, 'blue')).toEqual([{ color: 'blue', owner: 0, bot: false }, { color: 'red', owner: 1, bot: true }]);
    expect(quickSeats(2, one, 'green')).toEqual([{ color: 'green', owner: 0, bot: false }, { color: 'yellow', owner: 1, bot: true }]);
    const four = quickSeats(4, one, 'red');
    expect(four.find((s) => !s.bot)!.color).toBe('red');
    expect(four.filter((s) => s.bot)).toHaveLength(3);
  });

  it('gives you two colours each with their partner, opposite or side by side', () => {
    const opp = quickSeats(2, { houses: 2, pairing: 'opposite' }, 'green');
    expect(opp.filter((s) => s.owner === 0).map((s) => s.color).sort()).toEqual(['green', 'yellow']);
    const side = quickSeats(2, { houses: 2, pairing: 'adjacent' }, 'yellow');
    expect(side.filter((s) => s.owner === 0).map((s) => s.color)).toHaveLength(2);
    expect(side.filter((s) => s.owner === 1).every((s) => s.bot)).toBe(true);
  });

  it('turns a layout without changing who sits beside whom', () => {
    const l = previewLayout(3, one, 0);
    expect(turnLayout(l, 'blue')).toEqual(l);
    expect(turnLayout(l, 'green').green).toBe(l.blue);
  });
});
