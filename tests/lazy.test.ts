// Lazily loaded screens (src/ui/lazy.ts, #98): a failed import shows a retry (never a blank screen), a retry
// imports again, and the idle prefetch loads every screen and ignores failures.
import { describe, expect, it, vi } from 'vitest';
import { lazy, prefetchAtIdle, setScreen, show } from '../src/ui/lazy';

/** Just enough of an element for loadFailed(): its markup, and the buttons found in it. */
class FakeEl {
  className = '';
  innerHTML = '';
  private on = new Map<string, () => void>();
  querySelector(sel: string) {
    const act = /data-act=(\w+)/.exec(sel)?.[1];
    if (!act || !this.innerHTML.includes(`data-act="${act}"`)) return null;
    return { addEventListener: (_: string, f: () => void) => this.on.set(act, f) };
  }
  press(act: string) {
    this.on.get(act)!();
  }
}
vi.stubGlobal('document', { createElement: () => new FakeEl() });

/** The stage: whatever was put on it last. */
const stage = () => {
  const s = { now: null as unknown, replaceChildren: (el: unknown) => (s.now = el) };
  return s;
};

describe('lazy screens', () => {
  it('imports once, and imports again after a failure', async () => {
    let calls = 0;
    const load = lazy(async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return 'screen';
    });
    await expect(load()).rejects.toThrow('offline');
    expect(await load()).toBe('screen');
    expect(await load()).toBe('screen');
    expect(calls).toBe(2);
  });

  it('shows "Couldn\'t load this screen" with a retry when the import fails, then the screen on retry', async () => {
    let online = false;
    const load = lazy(async () => {
      if (!online) throw new Error('offline');
      return { screen: () => 'the store' };
    });
    const back = vi.fn();
    const s = stage();
    await show(s as unknown as HTMLElement, load, (m) => m.screen() as unknown as HTMLElement, back);
    const fail = s.now as FakeEl;
    expect(fail.className).toContain('loadfail');
    expect(fail.innerHTML).toContain("Couldn't load this screen");
    // Back goes back; Try again, once online, shows the screen.
    fail.press('back');
    expect(back).toHaveBeenCalledOnce();
    online = true;
    fail.press('retry');
    await vi.waitFor(() => expect(s.now).toBe('the store'));
  });

  it('drops a lazy screen that arrives after the player moved on, success or failure', async () => {
    for (const outcome of ['loads', 'fails'] as const) {
      let finish!: () => void;
      const gate = new Promise<void>((r) => (finish = r));
      const load = lazy(async () => {
        await gate;
        if (outcome === 'fails') throw new Error('offline');
        return { screen: () => 'the store' };
      });
      const s = stage();
      // Tap Store; while its chunk loads, start a game.
      const pending = show(s as unknown as HTMLElement, load, (m) => m.screen() as unknown as HTMLElement, () => {});
      setScreen(s as unknown as HTMLElement, 'the game' as unknown as HTMLElement);
      finish();
      await pending;
      expect(s.now).toBe('the game');
    }
  });

  it('prefetches every screen at idle and ignores a failure', async () => {
    vi.useFakeTimers();
    const a = vi.fn(() => Promise.resolve(1));
    const b = vi.fn(() => Promise.reject(new Error('offline')));
    prefetchAtIdle([a, b]);
    expect(a).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
