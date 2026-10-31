// The result card: an image of the final places, drawn on the device (works offline), shared through
// Android's share menu, the Web Share API, or downloaded where neither exists.
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { Color } from '../engine';
import { PALETTE } from './art';
import { AVATARS } from './avatars';

export const SITE = 'https://jutebags.github.io/Tag-Team-Ludo/';
const W = 1080;
const H = 1350;
const MEDAL = ['#ffd23f', '#d9e2ee', '#f0a868', '#8fb4ff'];

export interface CardRow {
  name: string;
  color: Color;
  /** e.g. "4 / 4 home" */
  detail: string;
}

const image = (svg: string) =>
  new Promise<HTMLImageElement>((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

function round(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Draws the card and returns it as a PNG data URL. */
export async function drawCard(title: string, mode: string, rows: CardRow[]): Promise<string> {
  await Promise.all([document.fonts.load('80px "Lilita One"'), document.fonts.load('800 40px Nunito')]).catch(() => undefined);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;

  // Background: the app's blue, lighter at the top.
  const bg = ctx.createRadialGradient(W / 2, 260, 80, W / 2, 500, 1100);
  bg.addColorStop(0, '#3f86ff');
  bg.addColorStop(0.55, '#1a4fc4');
  bg.addColorStop(1, '#0a2470');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  for (let x = -H; x < W; x += 90) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + H, H);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Logo.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const logo = (text: string, y: number, size: number, top: string, bottom: string) => {
    ctx.font = `${size}px "Lilita One"`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.2;
    ctx.strokeStyle = '#0a2470';
    ctx.strokeText(text, W / 2, y);
    const g = ctx.createLinearGradient(0, y - size, 0, y);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillText(text, W / 2, y);
  };
  logo('TAG TEAM', 150, 80, '#ffffff', '#7cc0ff');
  logo('LUDO', 290, 150, '#fffbe2', '#ff8a1a');

  // Title ribbon.
  ctx.font = '72px "Lilita One"';
  const tw = Math.min(ctx.measureText(title).width + 120, W - 120);
  round(ctx, (W - tw) / 2, 340, tw, 120, 30);
  const rib = ctx.createLinearGradient(0, 340, 0, 460);
  rib.addColorStop(0, '#ff6f9a');
  rib.addColorStop(1, '#d21f57');
  ctx.fillStyle = rib;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(title, W / 2, 425, W - 180);
  ctx.font = '800 32px Nunito';
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.fillText(mode, W / 2, 515);

  // Places.
  const avatars = await Promise.all(rows.map((r) => image(AVATARS[r.color]).catch(() => null)));
  // Rows fit between the title (ends ~520) and the footer (from ~1190): four rows are shorter.
  const rowH = rows.length > 3 ? 128 : 150;
  const gap = rows.length > 3 ? 16 : 22;
  const top = 556 + (4 - rows.length) * 40;
  rows.forEach((r, i) => {
    const y = top + i * (rowH + gap);
    round(ctx, 90, y, W - 180, rowH, 34);
    ctx.fillStyle = i === 0 ? 'rgba(255,214,90,.28)' : 'rgba(255,255,255,.12)';
    ctx.fill();
    if (i === 0) {
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#ffd65a';
      ctx.stroke();
    }
    // Medal.
    ctx.beginPath();
    ctx.arc(170, y + rowH / 2, 44, 0, Math.PI * 2);
    ctx.fillStyle = MEDAL[Math.min(i, 3)]!;
    ctx.fill();
    ctx.fillStyle = '#5a2d00';
    ctx.font = '56px "Lilita One"';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), 170, y + rowH / 2 + 20);
    // Avatar in the player's colour.
    ctx.beginPath();
    ctx.arc(300, y + rowH / 2, 56, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE[r.color].m;
    ctx.fill();
    const av = avatars[i];
    if (av) ctx.drawImage(av, 248, y + rowH / 2 - 52, 104, 104);
    // Name and detail.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = '60px "Lilita One"';
    ctx.fillText(r.name, 386, y + rowH * 0.52, 400);
    ctx.font = '800 30px Nunito';
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillText(r.detail, 386, y + rowH * 0.8, 400);
    ctx.textAlign = 'right';
    ctx.font = '44px "Lilita One"';
    ctx.fillStyle = i === 0 ? '#ffd65a' : 'rgba(255,255,255,.6)';
    ctx.fillText(['1ST', '2ND', '3RD', '4TH'][i]!, W - 130, y + rowH / 2 + 16);
    ctx.textAlign = 'center';
  });

  // Footer: where to get the game.
  ctx.fillStyle = '#ffd65a';
  ctx.font = '48px "Lilita One"';
  ctx.fillText('Play free on Android and the web', W / 2, H - 110);
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  ctx.font = '800 32px Nunito';
  ctx.fillText(SITE.replace('https://', ''), W / 2, H - 58);
  return cv.toDataURL('image/png');
}

/** Shares the card: the share menu on Android, the Web Share API, or a download. */
export async function shareCard(png: string, text: string) {
  const base64 = png.slice(png.indexOf(',') + 1);
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({ path: 'tag-team-ludo-result.png', data: base64, directory: Directory.Cache });
    await Share.share({ title: 'Tag Team Ludo', text: `${text} ${SITE}`, files: [file.uri], dialogTitle: 'Share your result' });
    return;
  }
  const blob = await (await fetch(png)).blob();
  const file = new File([blob], 'tag-team-ludo-result.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: 'Tag Team Ludo', text: `${text} ${SITE}` });
    return;
  }
  const a = document.createElement('a');
  a.href = png;
  a.download = file.name;
  a.click();
}
