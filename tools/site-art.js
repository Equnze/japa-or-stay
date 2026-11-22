// Draws the website's icons and link-preview image in the night-city style shared by the game and the Challenge Arena.
// Usage: node tools/site-art.js        (writes site/favicon.svg, then renders the PNGs with headless Chrome or Edge)
// Output: site/favicon.svg, site/icon-512.png, site/icon-192.png, site/apple-touch-icon.png, site/og-image.png
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadGame } = require('../tests/load-game.js');

const root = path.join(__dirname, '..');
const work = path.join(__dirname, 'site-art');
fs.mkdirSync(work, { recursive: true });

// the same palette as the game's :root tokens
const C = { bg: '#07130E', navy: '#17305A', navy2: '#0F1B33', ink: '#F2F5F0', muted: '#A8B8AE', stay: '#23C07C', stay2: '#3CE195', japa: '#8495FF', japa2: '#A9B5FF', gold: '#F3B53A', gold2: '#FFD777', win: '#F3C65A' };

// a deterministic skyline (same generator as the Arena's)
function skyline(w, h, { seed = 7, base = 1, lit = 1 } = {}) {
  let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const layer = (y, hmin, hmax, wmin, wmax, fill, p, domes) => {
    let x = -10, d = '', win = '';
    while (x < w + 10) {
      const bw = Math.round(wmin + r() * (wmax - wmin)), top = Math.round(y - (hmin + r() * (hmax - hmin)));
      d += `M${Math.round(x)} ${h}V${top}h${bw}V${h}z`;
      if (domes && r() < 0.18) d += `M${Math.round(x)} ${top}a${bw / 2} ${Math.round(bw / 2.6)} 0 0 1 ${bw} 0z`;
      for (let wy = top + 8; wy < h - 10; wy += 14) for (let wx = x + 5; wx < x + bw - 6; wx += 11) if (r() < p * lit) win += `M${Math.round(wx)} ${Math.round(wy)}h4v6h-4z`;
      x += bw + r() * 6;
    }
    return `<path fill="${fill}" d="${d}"/>${win ? `<path fill="${C.win}" opacity=".75" d="${win}"/>` : ''}`;
  };
  const k = h / 400 * base;
  return layer(h - 150 * k, 30 * k, 120 * k, 40, 90, '#16264A', 0.05, true) + layer(h - 100 * k, 40 * k, 210 * k, 30, 70, '#0F1C36', 0.1) + layer(h - 50 * k, 20 * k, 80 * k, 50, 120, '#0A1424', 0.06);
}
const stars = (w, h, n, seed = 3) => { let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647; return Array.from({ length: n }, () => `<circle cx="${(r() * w).toFixed(0)}" cy="${(r() * h).toFixed(0)}" r="${(0.6 + r() * 1.3).toFixed(1)}" fill="#fff" opacity="${(0.25 + r() * 0.6).toFixed(2)}"/>`).join(''); };

/* ---------- the icon: J and S over a night skyline, with the Ankara strip ---------- */
function iconSvg({ font = '"Bricolage Grotesque", Arial, Helvetica, sans-serif', detail = true } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.navy}"/><stop offset=".55" stop-color="${C.navy2}"/><stop offset="1" stop-color="${C.bg}"/></linearGradient>
    <radialGradient id="moon" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${C.gold2}"/><stop offset=".45" stop-color="${C.gold}" stop-opacity=".55"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
    <clipPath id="r"><rect width="512" height="512" rx="112"/></clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="512" height="512" fill="url(#bg)"/>
    ${detail ? stars(512, 230, 18) : ''}
    <circle cx="404" cy="104" r="62" fill="url(#moon)"/><circle cx="404" cy="104" r="22" fill="${C.gold2}"/>
    <svg x="0" y="250" width="512" height="190" viewBox="0 0 512 190" preserveAspectRatio="none">${skyline(512, 190, { base: 0.8, lit: detail ? 1 : 0.5 })}</svg>
    <g>${[...Array(11)].map((_, i) => `<rect x="${i * 48 - 8}" y="440" width="30" height="72" fill="${C.stay}"/><rect x="${i * 48 + 22}" y="440" width="9" height="72" fill="${C.gold}"/><rect x="${i * 48 + 31}" y="440" width="9" height="72" fill="${C.japa}"/>`).join('')}</g>
  </g>
  <text x="168" y="318" font-family='${font}' font-weight="800" font-size="250" fill="${C.japa2}" text-anchor="middle">J</text>
  <text x="346" y="318" font-family='${font}' font-weight="800" font-size="250" fill="${C.stay2}" text-anchor="middle">S</text>
</svg>`;
}

/* ---------- the two worlds for the preview card ---------- */
function japaScene(w, h) {
  const houses = [...Array(6)].map((_, i) => { const x = i * 105 - 20; return `<g transform="translate(${x} 0)"><path d="M0 ${h * .45}l50 -46l50 46z" fill="#22344F"/><path d="M-4 ${h * .45 + 2}l54 -50l54 50" stroke="#E8EDF4" stroke-width="7" fill="none" stroke-linejoin="round"/><rect x="6" y="${h * .45}" width="88" height="${h * .36}" fill="#3A3247"/><rect x="16" y="${h * .53}" width="20" height="18" fill="${C.win}"/><rect x="62" y="${h * .53}" width="20" height="18" fill="${C.win}" opacity=".8"/><rect x="40" y="${h * .64}" width="20" height="${h * .17}" fill="#1B2433"/></g>`; }).join('');
  let s = 11; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const snow = [...Array(40)].map(() => `<circle cx="${(r() * w).toFixed(0)}" cy="${(r() * h * .8).toFixed(0)}" r="${(1.5 + r() * 2.5).toFixed(1)}" fill="#fff" opacity=".85"/>`).join('');
  return `<rect width="${w}" height="${h}" fill="#1C2C46"/>${stars(w, h * .4, 10, 5)}${houses}<rect y="${h * .81}" width="${w}" height="${h * .19}" fill="#DCE3EC"/>${snow}`;
}
function stayScene(w, h) {
  let s = 19; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let x = -6, towers = '';
  while (x < w) {
    const bw = 50 + r() * 60, top = 20 + r() * 90;
    towers += `<rect x="${x.toFixed(0)}" y="${top.toFixed(0)}" width="${bw.toFixed(0)}" height="${h}" fill="${r() < .5 ? '#13223D' : '#0F1C36'}"/>`;
    for (let wy = top + 10; wy < h * .72; wy += 18) for (let wx = x + 8; wx < x + bw - 10; wx += 16) if (r() < .3) towers += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="6" height="8" fill="${C.win}" opacity=".85"/>`;
    x += bw + 4;
  }
  const bus = `<g transform="translate(${w * .3} ${h * .62})"><rect width="74" height="30" rx="7" fill="#F2C230"/><rect x="6" y="5" width="62" height="9" rx="2" fill="#1B2433"/><rect y="17" width="74" height="4" fill="#1B1405"/><circle cx="16" cy="31" r="6" fill="#111"/><circle cx="58" cy="31" r="6" fill="#111"/></g>`;
  return `<rect width="${w}" height="${h}" fill="#17305A"/>${stars(w, h * .35, 8, 9)}${towers}<rect y="${h * .74}" width="${w}" height="${h * .05}" fill="#0A1424"/>${bus}<rect y="${h * .79}" width="${w}" height="${h * .21}" fill="#123A52"/><path d="M40 ${h * .88}h50M300 ${h * .9}h40M480 ${h * .87}h44" stroke="${C.gold2}" stroke-opacity=".6" stroke-width="3"/>`;
}

function ogHtml(avatarSvg) {
  const W = 1200, H = 630, cw = 500, ch = 210;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Figtree:wght@500;600;700&display=block">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { position: relative; background: radial-gradient(120% 90% at 30% 0%, ${C.navy} 0%, ${C.navy2} 42%, ${C.bg} 85%); color: ${C.ink}; font-family: Figtree, sans-serif; }
  .ankara { position: absolute; top: 0; left: 0; right: 0; height: 16px; background: repeating-linear-gradient(90deg, ${C.stay} 0 27px, ${C.gold} 27px 36px, ${C.japa} 36px 63px, ${C.gold} 63px 72px); }
  .bgsvg { position: absolute; inset: 0; }
  .left { position: absolute; left: 66px; top: 96px; width: 560px; }
  h1 { font: 800 104px/1 "Bricolage Grotesque", sans-serif; letter-spacing: -.03em; margin: 0; }
  h1 em { font-style: normal; background: linear-gradient(90deg, ${C.gold2}, ${C.gold} 50%, #FF9E57); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .q { font: 700 33px Figtree, sans-serif; margin: 26px 0 8px; }
  .t { font: 500 27px Figtree, sans-serif; color: ${C.muted}; margin: 0; }
  .new { display: inline-flex; align-items: center; gap: 10px; margin-top: 30px; padding: 9px 16px; border-radius: 99px; background: rgba(243,181,58,.14); border: 1.5px solid rgba(243,181,58,.55); font: 700 21px Figtree, sans-serif; color: ${C.gold2}; }
  .cta { position: absolute; left: 66px; bottom: 62px; padding: 17px 30px; border-radius: 16px; background: linear-gradient(180deg, ${C.gold2}, ${C.gold}); color: #1B1405; font: 700 26px Figtree, sans-serif; box-shadow: 0 12px 34px -10px rgba(243,181,58,.8); }
  .card { position: absolute; left: 650px; width: ${cw}px; height: ${ch}px; border-radius: 22px; overflow: hidden; border: 1.5px solid rgba(255,255,255,.18); box-shadow: 0 20px 50px -20px rgba(0,0,0,.7); }
  .card svg { display: block; }
  .pill { position: absolute; left: 16px; top: 16px; padding: 7px 18px; border-radius: 99px; font: 800 20px Figtree, sans-serif; letter-spacing: .08em; color: #fff; }
  .me { position: absolute; left: ${650 + cw / 2 - 74}px; top: ${H / 2 - 74}px; width: 148px; height: 148px; border-radius: 50%; overflow: hidden; background: #DCE8DF; box-shadow: 0 0 0 6px ${C.gold}, 0 0 40px rgba(243,181,58,.55); }
  .me svg { width: 100%; height: 100%; display: block; }
</style></head><body>
<svg class="bgsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${stars(W, H * .55, 60, 4)}
  <svg x="0" y="${H - 190}" width="${W}" height="190" viewBox="0 0 ${W} 190" preserveAspectRatio="none" opacity=".75">${skyline(W, 190, { base: .8 })}</svg></svg>
<div class="ankara"></div>
<div class="left">
  <h1>Japa <em>or</em> Stay</h1>
  <p class="q">Leave Nigeria or build at home?</p>
  <p class="t">Two years. One choice. Your life.</p>
  <div class="new">🏆 New: Multiplayer Arena · challenge your friends</div>
</div>
<div class="cta">Free · English &amp; Pidgin · Play now</div>
<div class="card" style="top:70px"><svg width="${cw}" height="${ch}">${japaScene(cw, ch)}</svg><span class="pill" style="background:#4F5FD0">JAPA</span></div>
<div class="card" style="top:${H - 70 - ch}px"><svg width="${cw}" height="${ch}">${stayScene(cw, ch)}</svg><span class="pill" style="background:#13985E">STAY</span></div>
<div class="me">${avatarSvg}</div>
</body></html>`;
}

function iconHtml(size, pad = 0) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&display=block">
<style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:${pad ? C.bg : 'transparent'}}svg{display:block;width:${size - 2 * pad}px;height:${size - 2 * pad}px;margin:${pad}px}</style></head><body>${iconSvg({ detail: size >= 150 })}</body></html>`;
}

function findBrowser() {
  const c = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const b = c.find(p => p && fs.existsSync(p));
  if (!b) throw new Error('Set CHROME_PATH to a Chrome or Edge executable.');
  return b;
}
function shoot(browser, html, out, w, h) {
  const file = path.join(work, path.basename(out, '.png') + '.html');
  fs.writeFileSync(file, html);
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--default-background-color=00000000',
    '--virtual-time-budget=6000', `--window-size=${w},${h}`, `--screenshot=${out}`, 'file:///' + file.replace(/\\/g, '/')], { stdio: 'ignore' });
  console.log('wrote', path.relative(root, out));
}

// the favicon stays a tiny vector file: no web font, fewer details
fs.writeFileSync(path.join(root, 'site', 'favicon.svg'), iconSvg({ font: 'Arial Black, Arial, Helvetica, sans-serif', detail: false }) + '\n');
console.log('wrote site/favicon.svg');

const G = loadGame();
const av = G.run('avatar')({ ...G.run('AV_DEFAULT'), body: 'f', hair: 'braids', skin: 2, outfit: 'ankara', earrings: true }, '');
const browser = findBrowser();
shoot(browser, ogHtml(av), path.join(root, 'site', 'og-image.png'), 1200, 630);
shoot(browser, iconHtml(512), path.join(root, 'site', 'icon-512.png'), 512, 512);
shoot(browser, iconHtml(192), path.join(root, 'site', 'icon-192.png'), 192, 192);
// iOS rounds the corners itself and shows transparency as black, so the touch icon is full-bleed
shoot(browser, iconHtml(180, 0).replace('<rect width="512" height="512" rx="112"/>', '<rect width="512" height="512"/>'), path.join(root, 'site', 'apple-touch-icon.png'), 180, 180);
