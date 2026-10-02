'use strict';
/* くまもとハザードマップ（試作） — 2D地図＋市町村単位のオフライン保存 */

// ---------- 定数 ----------
const BASE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const HZ_ROOT = 'https://disaportaldata.gsi.go.jp/raster/';
const MIN_SAVE_Z = 10;
const HZ_MAX_Z = 17;

// 浸水深の凡例（ハザードマップポータルサイトの凡例画像から色を取得）
// [R,G,B, 表示ラベル, 下限m, 上限m]
const DEPTH = [
  [255,255,179,'0.3m未満',0,0.3],
  [247,245,169,'0.5m未満',0,0.5],
  [248,225,166,'0.5〜1m',0.5,1],
  [255,216,192,'0.5〜3m',0.5,3],
  [255,183,183,'3〜5m',3,5],
  [255,145,145,'5〜10m',5,10],
  [242,133,201,'10〜20m',10,20],
  [220,122,220,'20m以上',20,24],
];
const LEGEND_DEPTH = [DEPTH[1],DEPTH[3],DEPTH[4],DEPTH[5],DEPTH[6],DEPTH[7]];

const LAYERS = {
  flood:    { label:'洪水',   kind:'depth', paths:['01_flood_l2_shinsuishin_data'], swatch:'#ffb7b7',
              title:'洪水で想定される浸水の深さ', note:'想定最大規模の大雨で川があふれた場合の想定です。' },
  dosha:    { label:'土砂災害', kind:'zone', paths:['05_dosekiryukeikaikuiki','05_kyukeishakeikaikuiki','05_jisuberikeikaikuiki'],
              names:['土石流','がけ崩れ','地すべり'], swatch:'#f2c94c',
              title:'土砂災害警戒区域', note:'大雨のときは、区域の外の頑丈な建物へ早めに避難してください。' },
  tsunami:  { label:'津波',   kind:'depth', paths:['04_tsunami_newlegend_data'], swatch:'#ff9191',
              title:'津波で想定される浸水の深さ', note:'最大クラスの津波が起きた場合の想定です。' },
  takashio: { label:'高潮',   kind:'depth', paths:['03_hightide_l2_shinsuishin_data'], swatch:'#f285c9',
              title:'高潮で想定される浸水の深さ', note:'想定最大規模の台風による高潮の想定です。' },
};
const ALL_HZ_PATHS = Object.values(LAYERS).flatMap(l => l.paths);

// ---------- 小物 ----------
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const tileUrl = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
const hzTpl = path => HZ_ROOT + path + '/{z}/{x}/{y}.png';
const fmtMB = b => !b ? '0MB' : b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + 'GB' : Math.max(0.1, b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0) + 'MB';

// ---------- 状態 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let activeLayer = store.get('hm-layer', 'flood');
let saved = store.get('hm-saved', {});       // code -> {name,maxZ,date,tiles,bytes,failed,done}
let quality = store.get('hm-quality', 15);
let munis = [];                                // GeoJSON features
const jobs = {};                               // code -> {cancel, done, total}

// ---------- 地図 ----------
const map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 18 })
  .setView(store.get('hm-view', [32.65, 130.75]), store.get('hm-zoom', 9));
map.attributionControl.setPrefix(false);
L.tileLayer(BASE_URL, {
  maxNativeZoom: 18, maxZoom: 18,
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>｜出典：<a href="https://disaportal.gsi.go.jp/" target="_blank">ハザードマップポータルサイト</a>',
}).addTo(map);

const hazardGroup = L.layerGroup().addTo(map);
function showLayer(key) {
  activeLayer = key; store.set('hm-layer', key);
  hazardGroup.clearLayers();
  for (const p of LAYERS[key].paths) {
    L.tileLayer(hzTpl(p), { maxNativeZoom: HZ_MAX_Z, maxZoom: 18, opacity: 0.72, crossOrigin: true }).addTo(hazardGroup);
  }
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.key === key));
  renderLegend();
  if (lastTap) inspect(lastTap);
}

// チップ
const chips = $('#layerChips');
for (const [key, l] of Object.entries(LAYERS)) {
  const b = document.createElement('button');
  b.className = 'chip'; b.dataset.key = key;
  b.innerHTML = `<i style="background:${l.swatch}"></i>${esc(l.label)}`;
  b.onclick = () => showLayer(key);
  chips.appendChild(b);
}

// 凡例
function renderLegend() {
  const l = LAYERS[activeLayer];
  let rows;
  if (l.kind === 'depth') {
    rows = LEGEND_DEPTH.slice().reverse().map(d => `<div class="row"><span class="sw" style="background:rgb(${d[0]},${d[1]},${d[2]})"></span>${d[3]}</div>`).join('');
  } else {
    rows = `<div class="row"><span class="sw" style="background:#f2c94c"></span>警戒区域</div>
            <div class="row"><span class="sw" style="background:#e5534b"></span>特別警戒区域</div>`;
  }
  $('#legend').innerHTML = `<h3>${esc(l.label)}</h3>${rows}`;
}
$('#btnLegend').onclick = () => { const g = $('#legend'); g.hidden = !g.hidden; $('#btnLegend').classList.toggle('active', !g.hidden); };

// ---------- 市町村境界 ----------
let muniLayer;
function muniStyle(f) {
  const s = saved[f.properties.code];
  return s && s.done
    ? { color: '#0a66d8', weight: 1.6, opacity: .8, fill: true, fillColor: '#0a66d8', fillOpacity: .04, interactive: false }
    : { color: '#5d6677', weight: .8, opacity: .55, fill: false, interactive: false };
}
function refreshMuniStyle() { if (muniLayer) muniLayer.setStyle(muniStyle); }

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inFeature(f, lon, lat) {
  const b = f.properties.bbox;
  if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
  return f.geometry.coordinates.some(poly => pointInRing(lon, lat, poly[0]));
}
const muniAt = (lat, lon) => munis.find(f => inFeature(f, lon, lat));

function updatePlace() {
  const c = map.getCenter();
  store.set('hm-view', [c.lat, c.lng]); store.set('hm-zoom', map.getZoom());
  if (map.getZoom() < 10) { $('#placeName').textContent = '熊本県'; return; }
  const f = muniAt(c.lat, c.lng);
  $('#placeName').textContent = f ? f.properties.name : '熊本県外';
}
map.on('moveend', updatePlace);

// ---------- タップでその地点を調べる ----------
let lastTap = null, tapMarker = null, inspectSeq = 0;

async function readPixel(res, px, py) {
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const sx = Math.min(bmp.width - 1, Math.floor(px * bmp.width / 256));
  const sy = Math.min(bmp.height - 1, Math.floor(py * bmp.height / 256));
  return ctx.getImageData(sx, sy, 1, 1).data;
}

// 1つのハザードレイヤーについて、その地点の画素を読む
// 戻り値 {state:'hit', rgba} | {state:'none'} | {state:'unknown'}
async function sample(path, lat, lng) {
  for (let z = HZ_MAX_Z; z >= MIN_SAVE_Z; z--) {
    const fx = lon2x(lng, z), fy = lat2y(lat, z);
    const x = Math.floor(fx), y = Math.floor(fy);
    let res;
    try { res = await fetch(tileUrl(hzTpl(path), z, x, y), { mode: 'cors' }); }
    catch { continue; }
    if (res.headers.get('X-HM-Missing')) continue;          // オフラインで未保存 → 低いズームを試す
    if (res.status === 404 || res.headers.get('X-HM-Empty')) return { state: 'none' };
    if (!res.ok) continue;
    try {
      const px = (fx - x) * 256, py = (fy - y) * 256;
      const d = await readPixel(res, px, py);
      return d[3] < 40 ? { state: 'none' } : { state: 'hit', rgba: d };
    } catch { continue; }
  }
  return { state: 'unknown' };
}

function classifyDepth(rgba) {
  let best = null, bd = 1e9;
  for (const d of DEPTH) {
    const dist = Math.abs(d[0] - rgba[0]) + Math.abs(d[1] - rgba[1]) + Math.abs(d[2] - rgba[2]);
    if (dist < bd) { bd = dist; best = d; }
  }
  return bd <= 45 ? best : null;
}

function depthWords(lo, hi) {
  if (hi <= 0.5) return '大人のひざくらいまで。床下まで水が来るおそれがあります。';
  if (hi <= 1)   return '大人の腰の高さまで。1階の床上まで水が来るおそれがあります。';
  if (hi <= 3)   return '1階の天井近くまで。1階は水につかるおそれがあります。';
  if (hi <= 5)   return '2階の床上まで。2階まで水が来るおそれがあります。';
  if (hi <= 10)  return '2階建ての屋根をこえる深さです。';
  if (hi <= 20)  return '4〜6階建ての建物に相当する深さです。';
  return '7階建て以上の建物に相当する深さです。';
}
function depthAdvice(hi) {
  if (hi > 3) return '2階に上がるだけでは不十分なおそれがあります。早めに避難所など安全な場所へ。';
  if (hi > 0.5) return '水が来る前に、避難所や浸水しない場所への避難を検討してください。';
  return '';
}

// 水の深さを、人（170cm）と2階建ての家と並べて描く
function depthSVG(lo, hi) {
  const W = 320, H = 170, G = 150;                 // G = 地面のy
  const top = Math.max(7.5, hi * 1.15);            // 図の上端[m]
  const k = (G - 12) / top;                        // 1mあたりpx
  const yAt = m => G - m * k;
  const hx = 150, hw = 92, wallTop = yAt(5.8), roof = yAt(7.2);
  const px = 82, ph = 1.7 * k;
  const person = `<g fill="#1d2433">
      <circle cx="${px}" cy="${G - ph + ph * 0.09}" r="${ph * 0.09}"/>
      <rect x="${px - ph * 0.085}" y="${G - ph + ph * 0.2}" width="${ph * 0.17}" height="${ph * 0.42}" rx="${ph * 0.05}"/>
      <rect x="${px - ph * 0.08}" y="${G - ph * 0.4}" width="${ph * 0.07}" height="${ph * 0.4}"/>
      <rect x="${px + ph * 0.01}" y="${G - ph * 0.4}" width="${ph * 0.07}" height="${ph * 0.4}"/></g>`;
  const house = `<g stroke="#5d6677" stroke-width="1.5" fill="#fff">
      <rect x="${hx}" y="${wallTop}" width="${hw}" height="${G - wallTop}"/>
      <path d="M${hx - 8} ${wallTop} L${hx + hw / 2} ${roof} L${hx + hw + 8} ${wallTop} Z" fill="#e9edf3"/>
      <line x1="${hx}" y1="${yAt(2.9)}" x2="${hx + hw}" y2="${yAt(2.9)}" stroke-dasharray="3 3"/>
      <rect x="${hx + 14}" y="${yAt(2.2)}" width="20" height="${1.2 * k}" fill="#dfe8f5"/>
      <rect x="${hx + 58}" y="${yAt(5.0)}" width="20" height="${1.2 * k}" fill="#dfe8f5"/></g>
      <text x="${hx + hw + 4}" y="${yAt(1.4)}" font-size="10" fill="#5d6677">1階</text>
      <text x="${hx + hw + 4}" y="${yAt(4.3)}" font-size="10" fill="#5d6677">2階</text>`;
  const water = `
      <rect x="0" y="${yAt(hi)}" width="${W}" height="${G - yAt(hi)}" fill="#3d8bfd" opacity=".22"/>
      <rect x="0" y="${yAt(lo)}" width="${W}" height="${G - yAt(lo)}" fill="#3d8bfd" opacity=".38"/>
      <line x1="0" y1="${yAt(hi)}" x2="${W}" y2="${yAt(hi)}" stroke="#1a5fd0" stroke-width="2"/>
      <text x="8" y="${yAt(hi) - 5}" font-size="12" font-weight="700" fill="#1a5fd0">最大 ${hi >= 24 ? '20m以上' : hi + 'm'}</text>`;
  const scale = `<text x="${px + ph * 0.18}" y="${G - ph + 4}" font-size="10" fill="#5d6677">170cm</text>`;
  return `<svg class="depthviz" viewBox="0 0 ${W} ${H}" role="img" aria-label="浸水の深さと人・家の比較">
    ${house}${person}${scale}${water}
    <line x1="0" y1="${G}" x2="${W}" y2="${G}" stroke="#8a93a3" stroke-width="2"/>
    <rect x="0" y="${G}" width="${W}" height="${H - G}" fill="#e3e7ee"/></svg>`;
}

async function inspect(latlng) {
  lastTap = latlng;
  const seq = ++inspectSeq;
  if (!tapMarker) tapMarker = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#d93025', fillOpacity: 1 }).addTo(map);
  else tapMarker.setLatLng(latlng);
  const m = muniAt(latlng.lat, latlng.lng);
  const place = m ? m.properties.name : '熊本県外';
  openSheet(`<div class="res-place">${esc(place)}</div><div class="spinner"></div>`);

  const l = LAYERS[activeLayer];
  let html = `<div class="res-place">${esc(place)}　<span style="opacity:.7">${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}</span></div>
              <div class="res-title">${esc(l.title)}</div>`;
  if (l.kind === 'depth') {
    const r = await sample(l.paths[0], latlng.lat, latlng.lng);
    if (seq !== inspectSeq) return;
    if (r.state === 'hit') {
      const d = classifyDepth(r.rgba);
      if (d) {
        html += `<p class="res-depth">${d[3]}</p><p class="res-desc">${depthWords(d[4], d[5])}</p>${depthSVG(d[4], d[5])}`;
        const adv = depthAdvice(d[5]); if (adv) html += `<p class="res-desc" style="margin-top:10px"><b>${adv}</b></p>`;
      } else html += `<p class="res-depth">浸水の想定あり</p><p class="res-desc">深さの区分は読み取れませんでした。</p>`;
    } else if (r.state === 'none') {
      html += `<p class="res-depth none">想定区域の外です</p><p class="res-desc">この地点は${esc(l.label)}の浸水想定区域に入っていません。ただし、想定をこえる災害が起きることもあります。</p>`;
    } else {
      html += `<p class="res-depth unknown">判定できません</p><p class="res-desc">電波がなく、この地域はまだ保存されていません。「保存」から市町村を保存すると、電波がなくても判定できます。</p>`;
    }
  } else {
    const rs = await Promise.all(l.paths.map(p => sample(p, latlng.lat, latlng.lng)));
    if (seq !== inspectSeq) return;
    const hits = rs.map((r, i) => r.state === 'hit' ? { name: l.names[i], red: r.rgba[0] > 200 && r.rgba[1] < 140 } : null).filter(Boolean);
    if (hits.length) {
      const special = hits.some(h => h.red);
      html += `<p class="res-depth" style="color:${special ? '#d93025' : '#b7791f'}">${special ? '特別警戒区域' : '警戒区域'}</p>
               <p class="res-desc">${hits.map(h => esc(h.name)).join('・')}のおそれがある区域です。</p>`;
    } else if (rs.some(r => r.state === 'unknown')) {
      html += `<p class="res-depth unknown">判定できません</p><p class="res-desc">電波がなく、この地域はまだ保存されていません。</p>`;
    } else {
      html += `<p class="res-depth none">区域の外です</p><p class="res-desc">この地点は土砂災害警戒区域に入っていません。</p>`;
    }
  }
  html += `<p class="res-note">${esc(l.note)} 実際の避難の判断は、市町村の発表に従ってください。</p>`;
  html += `<div class="others" id="others"></div>`;
  openSheet(html);
  summarizeOthers(latlng, seq);
}

// 他の災害もまとめて一言で
async function summarizeOthers(latlng, seq) {
  const tags = [];
  for (const [key, l] of Object.entries(LAYERS)) {
    if (key === activeLayer) continue;
    if (l.kind === 'depth') {
      const r = await sample(l.paths[0], latlng.lat, latlng.lng);
      if (r.state === 'hit') { const d = classifyDepth(r.rgba); tags.push(`${l.label}：${d ? d[3] : 'あり'}`); }
    } else {
      const rs = await Promise.all(l.paths.map(p => sample(p, latlng.lat, latlng.lng)));
      if (rs.some(r => r.state === 'hit')) tags.push(`${l.label}：区域内`);
    }
  }
  if (seq !== inspectSeq) return;
  const el = $('#others');
  if (el && tags.length) el.innerHTML = '<span style="background:none;padding-left:0">ほかの災害</span>' + tags.map(t => `<span>${esc(t)}</span>`).join('');
}

function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  const s = $('#sheet'); s.hidden = false;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => document.body.style.setProperty('--sheet-h', s.offsetHeight + 'px'));
}
function closeSheet() {
  $('#sheet').hidden = true; document.body.classList.remove('sheet-open');
  lastTap = null; inspectSeq++;
  if (tapMarker) { map.removeLayer(tapMarker); tapMarker = null; }
}
$('#sheetClose').onclick = closeSheet;
map.on('click', e => inspect(e.latlng));

// ---------- 現在地 ----------
let meMarker = null;
$('#btnLocate').onclick = () => {
  if (!navigator.geolocation) return toast('この端末では現在地を取得できません');
  toast('現在地を取得しています…', 1500);
  navigator.geolocation.getCurrentPosition(p => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }) }).addTo(map);
    else meMarker.setLatLng(ll);
    map.setView(ll, Math.max(map.getZoom(), 15));
    inspect(L.latLng(ll));
  }, () => toast('現在地を取得できませんでした。位置情報の許可を確認してください'), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
};

// ---------- オンライン表示 ----------
function updateNet() {
  const on = navigator.onLine, b = $('#netBadge');
  b.textContent = on ? 'オンライン' : 'オフライン';
  b.className = 'badge ' + (on ? 'online' : 'offline');
}
addEventListener('online', updateNet);
addEventListener('offline', () => { updateNet(); toast('オフラインです。保存済みの地域だけ表示できます'); });
updateNet();

// ---------- オフライン保存 ----------
const TILE_CACHE = 'hm-tiles-v1';
const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), c => c.charCodeAt(0));

// その市町村にかかるタイルを列挙
function tilesFor(f, maxZ) {
  const out = [];
  const [w, s, e, n] = f.properties.bbox;
  const rings = f.geometry.coordinates.map(p => p[0]);
  const inside = (lon, lat) => rings.some(r => pointInRing(lon, lat, r));
  for (let z = MIN_SAVE_Z; z <= maxZ; z++) {
    const x0 = Math.floor(lon2x(w, z)), x1 = Math.floor(lon2x(e, z));
    const y0 = Math.floor(lat2y(n, z)), y1 = Math.floor(lat2y(s, z));
    const vset = new Set();
    for (const r of rings) for (const [lon, lat] of r) vset.add(Math.floor(lon2x(lon, z)) + ',' + Math.floor(lat2y(lat, z)));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (z <= 12 || vset.has(x + ',' + y)) { out.push([z, x, y]); continue; }
      const lw = x2lon(x, z), le = x2lon(x + 1, z), ln = y2lat(y, z), ls = y2lat(y + 1, z);
      if (inside((lw + le) / 2, (ln + ls) / 2) || inside(lw, ln) || inside(le, ln) || inside(lw, ls) || inside(le, ls)) out.push([z, x, y]);
    }
  }
  return out;
}
const tileCountCache = {};
function countFor(f, maxZ) {
  const k = f.properties.code + '@' + maxZ;
  return tileCountCache[k] ??= tilesFor(f, maxZ).length;
}
// 容量の目安（実測：淡色地図は1枚 約25〜45KB、ハザードは多くが空）
const estBytes = (f, maxZ) => {
  let b = 0;
  for (let z = MIN_SAVE_Z; z <= maxZ; z++) {
    const n = f.properties.tiles[z] || 0;
    b += n * (z >= 16 ? 24 : 38) * 1024;
  }
  const ratio = countFor(f, maxZ) / Object.entries(f.properties.tiles).filter(([z]) => z <= maxZ).reduce((a, [, v]) => a + v, 0);
  return b * Math.min(1, ratio) * 1.12;
};

async function downloadMuni(f, maxZ) {
  const code = f.properties.code;
  if (jobs[code]) return;
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const cache = await caches.open(TILE_CACHE);
  const tiles = tilesFor(f, maxZ);
  const urls = [];
  for (const [z, x, y] of tiles) {
    urls.push(tileUrl(BASE_URL, z, x, y));
    if (z <= HZ_MAX_Z) for (const p of ALL_HZ_PATHS) urls.push(tileUrl(hzTpl(p), z, x, y));
  }
  const job = jobs[code] = { cancel: false, done: 0, total: urls.length, bytes: 0, failed: 0 };
  saved[code] = { name: f.properties.name, maxZ, date: Date.now(), tiles: tiles.length, bytes: 0, done: false };
  store.set('hm-saved', saved); renderList();

  let i = 0;
  const worker = async () => {
    while (i < urls.length && !job.cancel) {
      const url = urls[i++];
      try {
        if (!(await cache.match(url))) {
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            try {
              const r = await fetch(url, { mode: 'cors' });
              if (r.ok) {
                const buf = await r.arrayBuffer(); job.bytes += buf.byteLength;
                await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'image/png' } }));
                ok = true;
              } else if (r.status === 404) {
                await cache.put(url, new Response(EMPTY_PNG, { headers: { 'Content-Type': 'image/png', 'X-HM-Empty': '1' } }));
                ok = true;
              }
            } catch { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
          }
          if (!ok) job.failed++;
        }
      } catch (e) { job.failed++; if (e && e.name === 'QuotaExceededError') { job.cancel = true; toast('端末の空き容量が足りません'); } }
      job.done++;
      if (job.done % 25 === 0) updateRow(code);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const cancelled = job.cancel;
  delete jobs[code];
  saved[code].bytes += job.bytes;
  saved[code].failed = job.failed;
  saved[code].done = !cancelled && job.failed === 0;
  saved[code].partial = cancelled || job.failed > 0;
  store.set('hm-saved', saved);
  refreshMuniStyle(); renderList(); updateStorage();
  if (cancelled) toast(`${f.properties.name}の保存を中断しました（もう一度押すと続きから再開）`);
  else if (job.failed) toast(`${f.properties.name}：${job.failed}件取得できませんでした。もう一度押すと再試行します`);
  else toast(`${f.properties.name}を保存しました。電波がなくても使えます`);
}

async function deleteMuni(f) {
  const code = f.properties.code;
  const keep = new Set();
  for (const [c, s] of Object.entries(saved)) {
    if (c === code) continue;
    const g = munis.find(m => m.properties.code === c);
    if (g) for (const [z, x, y] of tilesFor(g, s.maxZ)) keep.add(z + '/' + x + '/' + y);
  }
  const cache = await caches.open(TILE_CACHE);
  const s = saved[code];
  for (const [z, x, y] of tilesFor(f, s ? s.maxZ : 16)) {
    if (keep.has(z + '/' + x + '/' + y)) continue;
    await cache.delete(tileUrl(BASE_URL, z, x, y));
    for (const p of ALL_HZ_PATHS) await cache.delete(tileUrl(hzTpl(p), z, x, y));
  }
  delete saved[code]; store.set('hm-saved', saved);
  refreshMuniStyle(); renderList(); updateStorage();
  toast(`${f.properties.name}の保存データを削除しました`);
}

// ---------- 保存パネルUI ----------
function rowHTML(f) {
  const p = f.properties, s = saved[p.code], j = jobs[p.code];
  let sub, btn;
  if (j) {
    const pct = Math.floor(j.done / j.total * 100);
    sub = `保存中… ${pct}%（${fmtMB(j.bytes)}）`;
    btn = `<button class="dlbtn busy" data-act="stop" data-code="${p.code}"><i class="prog" style="width:${pct}%"></i><span>中断</span></button>`;
  } else if (s && s.done) {
    sub = `保存済み・${s.maxZ >= 16 ? '詳細' : '標準'}・${fmtMB(s.bytes)}・${new Date(s.date).toLocaleDateString('ja-JP')}`;
    btn = `<button class="dlbtn saved" data-act="menu" data-code="${p.code}"><span>✓ 保存済み</span></button>`;
  } else if (s && s.partial) {
    sub = `途中まで保存（${fmtMB(s.bytes)}）`;
    btn = `<button class="dlbtn" data-act="get" data-code="${p.code}"><span>続きから</span></button>`;
  } else {
    sub = `約${fmtMB(estBytes(f, quality))}`;
    btn = `<button class="dlbtn" data-act="get" data-code="${p.code}"><span>保存</span></button>`;
  }
  return `<li data-code="${p.code}"><div class="meta"><div class="name">${esc(p.name)}${p.code === hereCode ? '<em>表示中</em>' : ''}</div><div class="sub">${sub}</div></div>${btn}</li>`;
}
let hereCode = null;
function renderList() {
  if ($('#dlPanel').hidden) return;
  const q = $('#dlSearch').value.trim();
  const c = map.getCenter(); const here = muniAt(c.lat, c.lng); hereCode = here ? here.properties.code : null;
  const list = munis.filter(f => !q || f.properties.name.includes(q));
  const savedOnes = list.filter(f => saved[f.properties.code] || jobs[f.properties.code]);
  const rest = list.filter(f => !saved[f.properties.code] && !jobs[f.properties.code]);
  rest.sort((a, b) => (b.properties.code === hereCode) - (a.properties.code === hereCode));
  let html = '';
  if (savedOnes.length) html += `<li class="section">保存した地域</li>` + savedOnes.map(rowHTML).join('');
  html += `<li class="section">熊本県の市町村（${rest.length}）</li>` + rest.map(rowHTML).join('');
  $('#dlList').innerHTML = html;
}
function updateRow(code) {
  const li = document.querySelector(`#dlList li[data-code="${code}"]`);
  const f = munis.find(m => m.properties.code === code);
  if (li && f) li.outerHTML = rowHTML(f);
}
$('#dlList').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const f = munis.find(m => m.properties.code === b.dataset.code); if (!f) return;
  const act = b.dataset.act;
  if (act === 'get') {
    if (!navigator.onLine) return toast('保存にはインターネット接続が必要です');
    const s = saved[f.properties.code];
    downloadMuni(f, s && s.partial ? s.maxZ : quality);
  } else if (act === 'stop') {
    jobs[f.properties.code].cancel = true;
  } else if (act === 'menu') {
    if (confirm(`${f.properties.name}の保存データを削除しますか？\n（「キャンセル」で地図に移動します）`)) deleteMuni(f);
    else { const b = f.properties.bbox; $('#dlPanel').hidden = true; map.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }
  }
});
$('#dlSearch').addEventListener('input', renderList);
document.querySelectorAll('.seg button').forEach(b => {
  b.classList.toggle('on', +b.dataset.q === quality);
  b.onclick = () => {
    quality = +b.dataset.q; store.set('hm-quality', quality);
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    renderList();
  };
});
$('#btnDownload').onclick = () => { $('#dlPanel').hidden = false; renderList(); updateStorage(); };
$('#dlClose').onclick = () => { $('#dlPanel').hidden = true; };

async function updateStorage() {
  const el = $('#storageInfo');
  const total = Object.values(saved).reduce((a, s) => a + (s.bytes || 0), 0);
  const n = Object.values(saved).filter(s => s.done).length;
  let line = `保存済み ${n}市町村・${fmtMB(total)}`;
  let bar = '';
  try {
    const est = await navigator.storage.estimate();
    if (est.quota) {
      line += `<span style="float:right;color:var(--sub)">空き 約${fmtMB(est.quota - est.usage)}</span>`;
      bar = `<div class="bar"><i style="width:${Math.min(100, est.usage / est.quota * 100).toFixed(1)}%"></i></div>`;
    }
  } catch {}
  el.innerHTML = line + bar;
}

// ---------- 起動 ----------
fetch('data/kumamoto_municipalities.geojson').then(r => r.json()).then(g => {
  munis = g.features;
  muniLayer = L.geoJSON(g, { style: muniStyle }).addTo(map);
  updatePlace(); renderList();
});
showLayer(LAYERS[activeLayer] ? activeLayer : 'flood');

if (!store.get('hm-agreed', false)) $('#modal').hidden = false;
$('#modalOk').onclick = () => { $('#modal').hidden = true; store.set('hm-agreed', true); };

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW登録失敗', e));
}
