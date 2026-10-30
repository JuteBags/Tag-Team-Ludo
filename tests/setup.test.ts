import { describe, expect, it } from 'vitest';
import { pickSequence, pickable, rankRolls, type PickRules } from '../src/ui/setup';

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
