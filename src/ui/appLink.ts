// Room and friend links on Android's browser (#238): the game opened on the web from a link offers to move it into the
// app (an intent:// link to com.jutebags.ludo, which goes back to the web game when the app isn't installed), or to
// play here. Verified App Links, which open the app straight away, wait for our own domain.
import { Capacitor } from '@capacitor/core';
import { intentUrl, type LinkAction } from './replay';
import { SITE } from './shareCard';

/** Whether this is a browser on Android (not the app itself), where "Open in the app" makes sense. */
export const androidWeb = () => !Capacitor.isNativePlatform() && /Android/i.test(navigator.userAgent);

/** "Open in the app" or "Play here": resolves true for Play here (carry on in the browser), false for the app. */
export function openHere(stage: HTMLElement, action: LinkAction): Promise<boolean> {
  return new Promise((res) => {
    const ov = document.createElement('div');
    ov.className = 'menu-ov applink-ov';
    const what = 'join' in action ? `room <b class="disp">${action.join}</b>` : 'your friend’s link';
    ov.innerHTML = `<div class="box"><h2>Open in the app?</h2><p class="sub">Open ${what} in the Tag Team Ludo app, or play here in the browser.</p>
      <a class="b3 green disp" data-act="app" href="${intentUrl(action, SITE)}">OPEN IN THE APP</a><button class="later" data-act="here">Play here</button></div>`;
    ov.addEventListener('click', (e) => {
      const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act !== 'app' && act !== 'here') return;
      ov.remove();
      res(act === 'here');
    });
    stage.appendChild(ov);
  });
}
