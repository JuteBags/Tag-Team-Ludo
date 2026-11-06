// The website's Privacy note and Terms of use (#208): docs/privacy.html and docs/terms.html, made from
// legal/PRIVACY.md and legal/TERMS.md with the app's own renderer (src/ui/legalText.ts), styled like
// docs/index.html. After changing a text, run it and commit the pages (tests/legal.test.ts fails while they differ):
//   node tools/legal-site.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { legalHtml, legalTitle, legalVersionOf } from '../src/ui/legalText.ts';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const PAGES = [
  { md: 'legal/PRIVACY.md', html: 'docs/privacy.html', name: 'Privacy note' },
  { md: 'legal/TERMS.md', html: 'docs/terms.html', name: 'Terms of use' },
];

/** A page, from its Markdown. */
export function sitePage(md, name) {
  const title = legalTitle(md);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Made by tools/legal-site.mjs from legal/*.md: edit those and run it, not this page. -->
<meta name="legal-version" content="${legalVersionOf(md)}">
<title>${title}</title>
<meta name="description" content="Tag Team Ludo: ${name.toLowerCase()}.">
<meta name="theme-color" content="#0c2a74">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lilita+One&family=Nunito:wght@700;800;900&display=swap" rel="stylesheet">
<style>
:root{--bg:#071a4f;--panel:#123a92;--line:rgba(140,180,255,.28);--text:#ffffff;--muted:#c7d6ff;--gold:#ffd65a}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Nunito',system-ui,sans-serif;color:var(--text);background-color:var(--bg);line-height:1.6;-webkit-font-smoothing:antialiased;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56' viewBox='0 0 56 56'%3E%3Cg fill='none' stroke='%23a8c8ff' stroke-opacity='.08' stroke-width='2'%3E%3Crect x='15' y='15' width='26' height='26' rx='6' transform='rotate(45 28 28)'/%3E%3C/g%3E%3C/svg%3E"),
    radial-gradient(120% 70% at 50% 0%,#2a62d6 0%,#123a92 40%,#071a4f 100%);background-attachment:fixed}
a{color:var(--gold)}
.disp{font-family:'Lilita One',sans-serif;font-weight:400;letter-spacing:.4px}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:10;background:rgba(7,26,79,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
nav{display:flex;align-items:center;gap:18px;height:64px;max-width:1120px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-size:26px;color:#fff;white-space:nowrap}
.brand img{width:34px;height:34px}
nav .links{display:flex;gap:20px;margin-left:auto;font-weight:800;font-size:15px}
nav .links a{text-decoration:none;color:var(--muted)}
nav .links a:hover{color:#fff}
article{margin:36px auto;padding:28px 26px;border-radius:24px;background:rgba(18,58,146,.55);border:1px solid var(--line)}
article h1{font-family:'Lilita One',sans-serif;font-weight:400;font-size:clamp(30px,5vw,42px);line-height:1.15;margin-bottom:6px}
article h2{font-family:'Lilita One',sans-serif;font-weight:400;font-size:22px;color:var(--gold);margin:24px 0 6px}
article p,article li{font-weight:700;color:#e4ecff}
article b{font-weight:900;color:#fff}
article p{margin:8px 0}
article ul{margin:6px 0 8px;padding-left:22px}
article li{margin:5px 0}
article a{word-break:break-word}
footer{padding:24px 0 48px;color:#8fa6d8;font-weight:700;font-size:14px;text-align:center}
footer a{color:#cfe0ff}
@media (max-width:640px){nav .links{gap:14px;font-size:14px}article{padding:22px 18px}}
@media (max-width:480px){.brand{font-size:19px;gap:8px}.brand img{width:28px;height:28px}nav{gap:10px}nav .links{gap:12px;font-size:13.5px}nav .links .play{display:none}}
</style>
</head>
<body>
<header><nav class="wrap">
  <a class="brand disp" href="./"><img src="favicon.svg" alt="">TAG TEAM LUDO</a>
  <div class="links"><a class="play" href="./#play">Play</a><a href="privacy.html">Privacy</a><a href="terms.html">Terms</a></div>
</nav></header>
<main class="wrap">
<article>
${legalHtml(md, 2, true)}
</article>
</main>
<footer class="wrap">
  <p>Tag Team Ludo by JuteBags · <a href="privacy.html">Privacy note</a> · <a href="terms.html">Terms of use</a> · <a href="https://github.com/JuteBags/Tag-Team-Ludo">source on GitHub</a></p>
</footer>
</body>
</html>
`;
}

/** Every page: its path and its HTML. */
export const sitePages = () => PAGES.map((p) => ({ path: p.html, html: sitePage(read(p.md), p.name) }));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const p of sitePages()) {
    writeFileSync(new URL(p.path, root), p.html);
    console.log(`wrote ${p.path}`);
  }
}
