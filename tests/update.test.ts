// The update prompt's rules (src/ui/update.ts): which versions count as newer, and when "Not now" holds.
import { describe, expect, it } from 'vitest';
import { headline, isNewer, shouldPrompt } from '../src/ui/update';

describe('update prompt', () => {
  it('compares versions by major, minor, then patch', () => {
    expect(isNewer('2.5.0', '2.0.0')).toBe(true);
    expect(isNewer('2.0.1', '2.0.0')).toBe(true);
    expect(isNewer('10.0.0', '9.9.9')).toBe(true);
    expect(isNewer('2.0.0', '2.0.0')).toBe(false);
    expect(isNewer('1.9.0', '2.0.0')).toBe(false);
  });

  it('offers a newer version, and "Not now" holds that version back for a day', () => {
    const day = 24 * 3600 * 1000;
    const v = { version: '2.5.0' };
    expect(shouldPrompt(v, '2.0.0', null, 0)).toBe(true);
    expect(shouldPrompt(v, '2.5.0', null, 0)).toBe(false);
    expect(shouldPrompt(v, '2.0.0', { version: '2.5.0', at: 0 }, day - 1)).toBe(false);
    expect(shouldPrompt(v, '2.0.0', { version: '2.5.0', at: 0 }, day)).toBe(true);
    // A put-off older version doesn't hold back a newer one.
    expect(shouldPrompt({ version: '2.6.0' }, '2.0.0', { version: '2.5.0', at: 0 }, 1)).toBe(true);
  });

  it('shows the first line of the release notes without markdown', () => {
    expect(headline('Tag Team Ludo 2.5: **four bot levels**.\n\n## More\n- x')).toBe('Tag Team Ludo 2.5: four bot levels.');
    expect(headline('## Title\n- **Bold** item')).toBe('Bold item');
    expect(headline()).toBe('');
  });
});
