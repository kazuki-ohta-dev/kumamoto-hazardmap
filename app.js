'use strict';
/* くまもとハザードマップ（試作）
   2D地図／タップで浸水深／最寄りの避難場所／浸水深スライダー／オフライン保存（県全体の概略＋地点の周り＋市町村） */

// ---------- 定数 ----------
const BASE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const HZ_ROOT = 'https://disaportaldata.gsi.go.jp/raster/';
const MIN_SAVE_Z = 10;
const HZ_MAX_Z = 17;
const PREF_MAX_Z = 12;          // 県全体の概略地図
const PLACE_MAX_Z = 16;         // 地点の周り（道路まで鮮明）
const KB_PER_TILE = { 10: 68, 11: 68, 12: 68, 13: 40, 14: 40, 15: 38, 16: 24 };

// 浸水深の凡例（ハザードマップポータルサイトの凡例画像から色を取得）[R,G,B, ラベル, 下限m, 上限m]
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
  flood:    { label:'洪水', kind:'depth', paths:['01_flood_l2_shinsuishin_data'], swatch:'#ffb7b7', shelterBit:1,
              title:'洪水で想定される浸水の深さ', note:'想定最大規模の大雨で川があふれた場合の想定です。' },
  dosha:    { label:'土砂災害', kind:'zone', paths:['05_dosekiryukeikaikuiki','05_kyukeishakeikaikuiki','05_jisuberikeikaikuiki'],
              names:['土石流','がけ崩れ','地すべり'], swatch:'#f2c94c', shelterBit:2,
              title:'土砂災害警戒区域', note:'大雨のときは、区域の外の頑丈な建物へ早めに避難してください。' },
  tsunami:  { label:'津波', kind:'depth', paths:['04_tsunami_newlegend_data'], swatch:'#ff9191', shelterBit:8,
              title:'津波で想定される浸水の深さ', note:'最大クラスの津波が起きた場合の想定です。' },
  takashio: { label:'高潮', kind:'depth', paths:['03_hightide_l2_shinsuishin_data'], swatch:'#f285c9', shelterBit:4,
              title:'高潮で想定される浸水の深さ', note:'想定最大規模の台風による高潮の想定です。' },
};
const ALL_HZ_PATHS = Object.values(LAYERS).flatMap(l => l.paths);

// スライダーの目盛り（上から）。null = 絞り込みなし
const STOPS = [
  { m: 20,  label: '20m',  sub: '7階〜',    words: '7階建て以上が水につかる' },
  { m: 10,  label: '10m',  sub: '4〜6階',   words: '4〜6階建てが水につかる' },
  { m: 5,   label: '5m',   sub: '2階屋根',  words: '2階建ての屋根をこえる' },
  { m: 3,   label: '3m',   sub: '1階天井',  words: '1階が天井まで水につかる' },
  { m: 1,   label: '1m',   sub: '腰',       words: '大人の腰より深い' },
  { m: 0.5, label: '0.5m', sub: 'ひざ',     words: '大人のひざより深い' },
  { m: null, label: '全部', sub: '色分け',  words: '' },
];

// ---------- 小物 ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer;
function toast(msg, ms = 2800) {
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
const fmtDist = m => m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearingDeg(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const DIR8 = ['北','北東','東','南東','南','南西','西','北西'];
const dirName = deg => DIR8[Math.round(deg / 45) % 8];

// ---------- 状態 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let activeLayer = store.get('hm-layer', 'flood');
let quality = store.get('hm-quality', 15);
let threshold = null;                         // スライダーのしきい値[m]。null=絞り込みなし
let munis = [];                               // 市町村 GeoJSON features
let shelters = [];                            // [name, address, lat, lon, bitmask]
const jobs = {};                              // key -> {cancel, done, total, bytes, failed}

// 保存台帳：'pref' | 'm:<市町村コード>' | 'p:<id>'
let saved = store.get('hm-saved', {});
for (const k of Object.keys(saved)) {         // 旧形式（市町村コードのみ）を移行
  if (/^\d+$/.test(k)) { saved['m:' + k] = { kind: 'muni', code: k, ...saved[k] }; delete saved[k]; }
}
const saveLedger = () => store.set('hm-saved', saved);
saveLedger();

// ---------- 地図 ----------
const map = L.map('map', { zoomControl: false, minZoom: 5, maxZoom: 18, tapHold: true })
  .setView(store.get('hm-view', [32.65, 130.75]), store.get('hm-zoom', 9));
map.attributionControl.setPrefix(false);
L.tileLayer(BASE_URL, {
  maxNativeZoom: 18, maxZoom: 18,
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>｜出典：<a href="https://disaportal.gsi.go.jp/" target="_blank">ハザードマップポータルサイト</a>・<a href="https://www.gsi.go.jp/bousaichiri/hinanbasho.html" target="_blank">指定緊急避難場所データ</a>',
}).addTo(map);

map.createPane('places'); map.getPane('places').style.zIndex = 420;
map.createPane('shelters'); map.getPane('shelters').style.zIndex = 640;
const hazardGroup = L.layerGroup().addTo(map);
const placeGroup = L.layerGroup().addTo(map);
const shelterDots = L.layerGroup().addTo(map);
const routeGroup = L.layerGroup().addTo(map);

// ---------- タイル画素の読み取り（キャッシュ付き） ----------
const pixCache = new Map();                   // url -> Promise<{state, w, h, data}>
const PIX_MAX = 500;
const pxCanvas = document.createElement('canvas');
const pxCtx = pxCanvas.getContext('2d', { willReadFrequently: true });
addEventListener('online', () => pixCache.clear());

function getTilePixels(url) {
  if (pixCache.has(url)) { const p = pixCache.get(url); pixCache.delete(url); pixCache.set(url, p); return p; }
  const p = (async () => {
    let res;
    try { res = await fetch(url, { mode: 'cors' }); } catch { return { state: 'missing' }; }
    if (res.headers.get('X-HM-Missing')) return { state: 'missing' };
    if (res.status === 404 || res.headers.get('X-HM-Empty')) return { state: 'empty' };
    if (!res.ok) return { state: 'missing' };
    try {
      const bmp = await createImageBitmap(await res.blob());
      pxCanvas.width = bmp.width; pxCanvas.height = bmp.height;
      pxCtx.clearRect(0, 0, bmp.width, bmp.height);
      pxCtx.drawImage(bmp, 0, 0);
      return { state: 'img', w: bmp.width, h: bmp.height, data: pxCtx.getImageData(0, 0, bmp.width, bmp.height).data };
    } catch { return { state: 'missing' }; }
  })();
  pixCache.set(url, p);
  p.then(v => { if (v.state === 'missing' && navigator.onLine) pixCache.delete(url); });
  if (pixCache.size > PIX_MAX) pixCache.delete(pixCache.keys().next().value);
  return p;
}

// あるハザードの、その地点の画素。{state:'hit'|'none'|'unknown', rgba, z}
async function sample(path, lat, lng) {
  for (let z = HZ_MAX_Z; z >= MIN_SAVE_Z; z--) {
    const fx = lon2x(lng, z), fy = lat2y(lat, z);
    const x = Math.floor(fx), y = Math.floor(fy);
    const v = await getTilePixels(tileUrl(hzTpl(path), z, x, y));
    if (v.state === 'missing') continue;
    if (v.state === 'empty') return { state: 'none', z };
    const px = Math.min(v.w - 1, Math.floor((fx - x) * v.w)), py = Math.min(v.h - 1, Math.floor((fy - y) * v.h));
    const i = (py * v.w + px) * 4;
    const d = v.data;
    return d[i + 3] < 40 ? { state: 'none', z } : { state: 'hit', rgba: [d[i], d[i + 1], d[i + 2], d[i + 3]], z };
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

// ---------- 浸水深スライダー（洪水のみ） ----------
// 赤＝確実にしきい値以上／橙＝しきい値以上の可能性（区分がまたがる）／灰＝しきい値未満
const COL_RED = [217, 48, 37, 205], COL_ORANGE = [245, 124, 0, 190], COL_GRAY = [120, 120, 120, 55];
let classMemo = new Map();
function thresholdColor(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let c = classMemo.get(key);
  if (c === undefined) {
    const d = classifyDepth([r, g, b]);
    if (!d) c = COL_ORANGE;
    else if (d[4] >= threshold) c = COL_RED;
    else if (d[5] > threshold) c = COL_ORANGE;
    else c = COL_GRAY;
    classMemo.set(key, c);
  }
  return c;
}
const ThresholdLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const dz = Math.max(0, coords.z - HZ_MAX_Z), sz = coords.z - dz, scale = 1 << dz;
    const sx = coords.x >> dz, sy = coords.y >> dz;
    const ox = (coords.x - (sx << dz)) * 256 / scale, oy = (coords.y - (sy << dz)) * 256 / scale;
    getTilePixels(tileUrl(hzTpl(this.options.path), sz, sx, sy)).then(v => {
      if (v.state === 'img') {
        const ctx = c.getContext('2d'), out = ctx.createImageData(256, 256), o = out.data, src = v.data, f = v.w / 256;
        for (let y = 0; y < 256; y++) {
          const syy = Math.min(v.h - 1, Math.floor((oy + y / scale) * f));
          for (let x = 0; x < 256; x++) {
            const sxx = Math.min(v.w - 1, Math.floor((ox + x / scale) * f));
            const i = (syy * v.w + sxx) * 4;
            if (src[i + 3] < 40) continue;
            const col = thresholdColor(src[i], src[i + 1], src[i + 2]), j = (y * 256 + x) * 4;
            o[j] = col[0]; o[j + 1] = col[1]; o[j + 2] = col[2]; o[j + 3] = col[3];
          }
        }
        ctx.putImageData(out, 0, 0);
      }
      done(null, c);
    });
    return c;
  },
});

function renderSlider() {
  const show = activeLayer === 'flood';
  $('#depthSlider').hidden = !show;
  if (!show) { $('#dsBanner').hidden = true; return; }
  $('#dsTrack').innerHTML = STOPS.map((s, i) =>
    `<div class="ds-stop${s.m === threshold ? ' on' : ''}${s.m === null ? ' off' : ''}" data-i="${i}"><b>${s.label}</b><small>${s.sub}</small></div>`).join('');
  const b = $('#dsBanner');
  if (threshold === null) { b.hidden = true; return; }
  const s = STOPS.find(x => x.m === threshold);
  b.innerHTML = `<b>${s.label}以上（${s.words}）の地域</b><br>
    <span class="k"><i style="background:rgb(${COL_RED.slice(0,3)})"></i>${s.label}以上</span><span class="k"><i style="background:rgb(${COL_ORANGE.slice(0,3)})"></i>以上の可能性</span><span class="k"><i style="background:rgba(120,120,120,.5)"></i>${s.label}未満</span>`;
  b.hidden = false;
}
function setThreshold(m) {
  if (m === threshold) return;
  threshold = m; classMemo = new Map();
  showLayer(activeLayer, true);
}
(() => {               // ドラッグ・タップで目盛りを選ぶ
  const track = $('#dsTrack');
  const pick = e => {
    const stops = [...track.querySelectorAll('.ds-stop')];
    let best = 0, bd = 1e9;
    stops.forEach((el, i) => { const r = el.getBoundingClientRect(), d = Math.abs(e.clientY - (r.top + r.height / 2)); if (d < bd) { bd = d; best = i; } });
    setThreshold(STOPS[best].m);
  };
  let dragging = false;
  track.addEventListener('pointerdown', e => { dragging = true; track.setPointerCapture(e.pointerId); pick(e); e.preventDefault(); });
  track.addEventListener('pointermove', e => { if (dragging) pick(e); });
  track.addEventListener('pointerup', () => dragging = false);
  track.addEventListener('pointercancel', () => dragging = false);
  L.DomEvent.disableClickPropagation($('#depthSlider'));
  L.DomEvent.disableScrollPropagation($('#depthSlider'));
})();

// ---------- レイヤー切替 ----------
function showLayer(key, keepSheet) {
  activeLayer = key; store.set('hm-layer', key);
  hazardGroup.clearLayers();
  const l = LAYERS[key];
  if (key === 'flood' && threshold !== null) {
    new ThresholdLayer({ path: l.paths[0], maxZoom: 18, tileSize: 256 }).addTo(hazardGroup);
  } else {
    for (const p of l.paths) L.tileLayer(hzTpl(p), { maxNativeZoom: HZ_MAX_Z, maxZoom: 18, opacity: 0.72, crossOrigin: true }).addTo(hazardGroup);
  }
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.key === key));
  renderLegend(); renderSlider(); drawShelterDots();
  if (lastTap && !keepSheet) inspect(lastTap);
}

const chips = $('#layerChips');
for (const [key, l] of Object.entries(LAYERS)) {
  const b = document.createElement('button');
  b.className = 'chip'; b.dataset.key = key;
  b.innerHTML = `<i style="background:${l.swatch}"></i>${esc(l.label)}`;
  b.onclick = () => showLayer(key);
  chips.appendChild(b);
}

function renderLegend() {
  const l = LAYERS[activeLayer];
  let rows;
  if (l.kind === 'depth') {
    rows = LEGEND_DEPTH.slice().reverse().map(d => `<div class="row"><span class="sw" style="background:rgb(${d[0]},${d[1]},${d[2]})"></span>${d[3]}</div>`).join('');
  } else {
    rows = `<div class="row"><span class="sw" style="background:#f2c94c"></span>警戒区域</div>
            <div class="row"><span class="sw" style="background:#e5534b"></span>特別警戒区域</div>`;
  }
  rows += `<div class="row" style="margin-top:6px"><span class="shel-dot"></span>避難場所（${esc(l.label)}に対応）</div>`;
  $('#legend').innerHTML = `<h3>${esc(l.label)}</h3>${rows}`;
}
$('#btnLegend').onclick = () => { const g = $('#legend'); g.hidden = !g.hidden; $('#btnLegend').classList.toggle('active', !g.hidden); };

// ---------- 市町村境界 ----------
let muniLayer;
function muniStyle(f) {
  const s = saved['m:' + f.properties.code];
  return s && s.done
    ? { color: '#0a66d8', weight: 1.6, opacity: .8, fill: true, fillColor: '#0a66d8', fillOpacity: .04, interactive: false }
    : { color: '#5d6677', weight: .8, opacity: .55, fill: false, interactive: false };
}
const refreshMuniStyle = () => { if (muniLayer) muniLayer.setStyle(muniStyle); };
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
map.on('moveend', () => { updatePlace(); drawShelterDots(); });

// ---------- 避難場所 ----------
const shelterIcon = L.divIcon({ className: '', html: '<div class="shel-dot"></div>', iconSize: [12, 12] });
function drawShelterDots() {
  shelterDots.clearLayers();
  if (!shelters.length || map.getZoom() < 13) return;
  const b = map.getBounds().pad(0.1), bit = LAYERS[activeLayer].shelterBit;
  for (const s of shelters) {
    if (!(s[4] & bit) || !b.contains([s[2], s[3]])) continue;
    L.marker([s[2], s[3]], { icon: shelterIcon, pane: 'shelters' })
      .bindPopup(`<b>${esc(s[0])}</b><br><small>${esc(s[1])}</small>`).addTo(shelterDots);
  }
}
function nearestShelters(lat, lng, bit, n = 3) {
  const out = [];
  for (const s of shelters) {
    if (!(s[4] & bit)) continue;
    const d = distM(lat, lng, s[2], s[3]);
    if (out.length < n || d < out[out.length - 1].d) {
      out.push({ s, d }); out.sort((a, b) => a.d - b.d); if (out.length > n) out.pop();
    }
  }
  return out;
}
// 避難場所までの直線上で、いちばん深い浸水（深さレイヤーのみ）
async function maxDepthAlong(path, lat1, lon1, lat2, lon2) {
  const d = distM(lat1, lon1, lat2, lon2), steps = Math.min(120, Math.max(4, Math.ceil(d / 40)));
  let worst = null;
  for (let i = 1; i < steps; i++) {
    const t = i / steps, r = await sample(path, lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t);
    if (r.state === 'hit') { const c = classifyDepth(r.rgba); if (c && (!worst || c[5] > worst[5])) worst = c; }
  }
  return worst;
}
const arrowSVG = deg => `<svg viewBox="0 0 24 24" style="transform:rotate(${deg}deg)"><path d="M12 2l6 18-6-4-6 4z"/></svg>`;

async function renderShelters(latlng, seq) {
  const el = $('#shelters'); if (!el) return;
  const l = LAYERS[activeLayer];
  if (!shelters.length) { el.innerHTML = '<div class="shel-info">避難場所データを読み込み中です</div>'; return; }
  const near = nearestShelters(latlng.lat, latlng.lng, l.shelterBit, 3);
  routeGroup.clearLayers();
  if (!near.length) { el.innerHTML = `<h4>近くの避難場所</h4><div class="shel-info">${esc(l.label)}に対応した避難場所が見つかりません。</div>`; return; }
  near.forEach((n, i) => {
    const ll = [n.s[2], n.s[3]];
    if (i === 0) L.polyline([latlng, ll], { color: '#1e8e3e', weight: 3, dashArray: '6 6', opacity: .9, interactive: false }).addTo(routeGroup);
    L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="shel-pin">${i + 1}</div>`, iconSize: [24, 24] }), pane: 'shelters', zIndexOffset: 1000 })
      .bindPopup(`<b>${esc(n.s[0])}</b><br><small>${esc(n.s[1])}</small>`).addTo(routeGroup);
  });
  el.innerHTML = `<h4>近くの避難場所（${esc(l.label)}に対応）</h4>` + near.map((n, i) => {
    const deg = bearingDeg(latlng.lat, latlng.lng, n.s[2], n.s[3]);
    return `<button class="shel-row" data-i="${i}"><span class="shel-no">${i + 1}</span><span class="shel-main">
      <div class="shel-name">${esc(n.s[0])}</div>
      <div class="shel-dist">${arrowSVG(deg)}${dirName(deg)}へ ${fmtDist(n.d)}<span style="color:var(--sub);font-size:11.5px">（直線）</span></div>
      <div class="shel-info" id="shi${i}">${esc(n.s[1])}</div><div class="shel-warn" id="shw${i}"></div></span></button>`;
  }).join('') + `<div class="shel-info" style="margin-top:4px">距離は直線です。実際の道のりや、通行できるかは現地の状況を確認してください。</div>`;
  el.querySelectorAll('.shel-row').forEach(b => b.onclick = () => {
    const n = near[+b.dataset.i];
    map.fitBounds(L.latLngBounds([latlng, [n.s[2], n.s[3]]]).pad(0.35), { paddingBottomRight: [0, $('#sheet').offsetHeight * 0.6] });
  });
  if (l.kind !== 'depth') return;
  const origin = await sample(l.paths[0], latlng.lat, latlng.lng);
  const originHi = origin.state === 'hit' ? (classifyDepth(origin.rgba)?.[5] ?? 0) : 0;
  for (let i = 0; i < near.length; i++) {          // 避難場所自体と、途中の浸水
    const n = near[i];
    const [here, worst] = await Promise.all([
      sample(l.paths[0], n.s[2], n.s[3]),
      maxDepthAlong(l.paths[0], latlng.lat, latlng.lng, n.s[2], n.s[3]),
    ]);
    if (seq !== inspectSeq) return;
    const info = $('#shi' + i), warn = $('#shw' + i);
    const c = here.state === 'hit' ? classifyDepth(here.rgba) : null;
    if (here.state === 'hit') info.textContent = `この避難場所の敷地も浸水想定 ${c ? c[3] : 'あり'}（上の階へ避難する施設の場合があります）`;
    // 今いる場所・避難場所のどちらよりも深い浸水域を横切るときだけ警告
    if (worst && worst[5] > Math.max(originHi, c ? c[5] : 0)) warn.textContent = `⚠ 途中に、今いる場所より深い浸水想定（${worst[3]}）の場所があります。浸水が始まる前に移動してください。`;
  }
}

// ---------- タップでその地点を調べる ----------
let lastTap = null, tapMarker = null, inspectSeq = 0;

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
  if (hi > 3) return '2階に上がるだけでは不十分なおそれがあります。早めに避難場所など安全な場所へ。';
  if (hi > 0.5) return '水が来る前に、避難場所や浸水しない場所への避難を検討してください。';
  return '';
}
function depthSVG(lo, hi) {
  const W = 320, H = 170, G = 150, top = Math.max(7.5, hi * 1.15), k = (G - 12) / top, yAt = m => G - m * k;
  const hx = 150, hw = 92, wallTop = yAt(5.8), roof = yAt(7.2), px = 82, ph = 1.7 * k;
  const person = `<g fill="#1d2433"><circle cx="${px}" cy="${G - ph + ph * 0.09}" r="${ph * 0.09}"/>
      <rect x="${px - ph * 0.085}" y="${G - ph + ph * 0.2}" width="${ph * 0.17}" height="${ph * 0.42}" rx="${ph * 0.05}"/>
      <rect x="${px - ph * 0.08}" y="${G - ph * 0.4}" width="${ph * 0.07}" height="${ph * 0.4}"/>
      <rect x="${px + ph * 0.01}" y="${G - ph * 0.4}" width="${ph * 0.07}" height="${ph * 0.4}"/></g>`;
  const house = `<g stroke="#5d6677" stroke-width="1.5" fill="#fff"><rect x="${hx}" y="${wallTop}" width="${hw}" height="${G - wallTop}"/>
      <path d="M${hx - 8} ${wallTop} L${hx + hw / 2} ${roof} L${hx + hw + 8} ${wallTop} Z" fill="#e9edf3"/>
      <line x1="${hx}" y1="${yAt(2.9)}" x2="${hx + hw}" y2="${yAt(2.9)}" stroke-dasharray="3 3"/>
      <rect x="${hx + 14}" y="${yAt(2.2)}" width="20" height="${1.2 * k}" fill="#dfe8f5"/>
      <rect x="${hx + 58}" y="${yAt(5.0)}" width="20" height="${1.2 * k}" fill="#dfe8f5"/></g>
      <text x="${hx + hw + 4}" y="${yAt(1.4)}" font-size="10" fill="#5d6677">1階</text>
      <text x="${hx + hw + 4}" y="${yAt(4.3)}" font-size="10" fill="#5d6677">2階</text>`;
  const water = `<rect x="0" y="${yAt(hi)}" width="${W}" height="${G - yAt(hi)}" fill="#3d8bfd" opacity=".22"/>
      <rect x="0" y="${yAt(lo)}" width="${W}" height="${G - yAt(lo)}" fill="#3d8bfd" opacity=".38"/>
      <line x1="0" y1="${yAt(hi)}" x2="${W}" y2="${yAt(hi)}" stroke="#1a5fd0" stroke-width="2"/>
      <text x="8" y="${yAt(hi) - 5}" font-size="12" font-weight="700" fill="#1a5fd0">最大 ${hi >= 24 ? '20m以上' : hi + 'm'}</text>`;
  return `<svg class="depthviz" viewBox="0 0 ${W} ${H}" role="img" aria-label="浸水の深さと人・家の比較">${house}${person}
    <text x="${px + ph * 0.18}" y="${G - ph + 4}" font-size="10" fill="#5d6677">170cm</text>${water}
    <line x1="0" y1="${G}" x2="${W}" y2="${G}" stroke="#8a93a3" stroke-width="2"/><rect x="0" y="${G}" width="${W}" height="${H - G}" fill="#e3e7ee"/></svg>`;
}
const coarseNote = z => z !== undefined && z <= PREF_MAX_Z ? `<p class="res-note">※電波がないため、県全体の概略地図で判定しています。境界付近は誤差があります。</p>` : '';

async function inspect(latlng) {
  lastTap = latlng;
  const seq = ++inspectSeq;
  if (!tapMarker) tapMarker = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#d93025', fillOpacity: 1 }).addTo(map);
  else tapMarker.setLatLng(latlng);
  routeGroup.clearLayers();
  const m = muniAt(latlng.lat, latlng.lng);
  const place = m ? m.properties.name : '熊本県外';
  openSheet(`<div class="res-place">${esc(place)}</div><div class="spinner"></div>`);

  const l = LAYERS[activeLayer];
  let figure = '';
  let html = `<div class="res-place">${esc(place)}　<span style="opacity:.7">${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}</span></div>
              <div class="res-title">${esc(l.title)}</div>`;
  if (l.kind === 'depth') {
    const r = await sample(l.paths[0], latlng.lat, latlng.lng);
    if (seq !== inspectSeq) return;
    if (r.state === 'hit') {
      const d = classifyDepth(r.rgba);
      if (d) {
        const adv = depthAdvice(d[5]);
        html += `<p class="res-depth">${d[3]}</p><p class="res-desc">${depthWords(d[4], d[5])}${adv ? `<br><b>${adv}</b>` : ''}</p>`;
        figure = depthSVG(d[4], d[5]);
      } else html += `<p class="res-depth">浸水の想定あり</p><p class="res-desc">深さの区分は読み取れませんでした。</p>`;
      html += coarseNote(r.z);
    } else if (r.state === 'none') {
      html += `<p class="res-depth none">想定区域の外です</p><p class="res-desc">この地点は${esc(l.label)}の浸水想定区域に入っていません。ただし、想定をこえる災害が起きることもあります。</p>${coarseNote(r.z)}`;
    } else {
      html += `<p class="res-depth unknown">判定できません</p><p class="res-desc">電波がなく、この地域の地図が保存されていません。「保存」から地点を保存すると、電波がなくても判定できます。</p>`;
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
      html += `<p class="res-depth unknown">判定できません</p><p class="res-desc">電波がなく、この地域の地図が保存されていません。</p>`;
    } else {
      html += `<p class="res-depth none">区域の外です</p><p class="res-desc">この地点は土砂災害警戒区域に入っていません。</p>`;
    }
  }
  html += `<div class="others" id="others"></div>
           <div class="shel" id="shelters"><div class="spinner"></div></div>
           ${figure ? `<div class="shel"><h4>深さのイメージ</h4>${figure}</div>` : ''}
           <p class="res-note">${esc(l.note)} 実際の避難の判断は、市町村の発表に従ってください。</p>
           <button class="btn-line" id="savePlaceHere">この地点の周りを保存（電波がなくても見られるように）</button>`;
  openSheet(html);
  $('#savePlaceHere').onclick = () => openSaveSheet(latlng);
  renderShelters(latlng, seq);
  summarizeOthers(latlng, seq);
}

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
  const s = $('#sheet'); s.hidden = false; s.scrollTop = 0;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => document.body.style.setProperty('--sheet-h', s.offsetHeight + 'px'));
}
function closeSheet() {
  $('#sheet').hidden = true; document.body.classList.remove('sheet-open');
  lastTap = null; inspectSeq++;
  routeGroup.clearLayers();
  if (tapMarker) { map.removeLayer(tapMarker); tapMarker = null; }
}
$('#sheetClose').onclick = closeSheet;
map.on('click', e => inspect(e.latlng));
map.on('contextmenu', e => openSaveSheet(e.latlng));     // 長押しで「この地点の周りを保存」

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
addEventListener('online', () => { updateNet(); maybeAutoSavePref(); });
addEventListener('offline', () => { updateNet(); toast('オフラインです。保存した地域だけ表示できます'); });
updateNet();

// ---------- オフライン保存：タイルの列挙 ----------
const TILE_CACHE = 'hm-tiles-v1';
const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), c => c.charCodeAt(0));

function tilesForFeature(f, maxZ, minZ = MIN_SAVE_Z) {
  const out = [];
  const [w, s, e, n] = f.properties.bbox;
  const rings = f.geometry.coordinates.map(p => p[0]);
  const inside = (lon, lat) => rings.some(r => pointInRing(lon, lat, r));
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = Math.floor(lon2x(w, z)), x1 = Math.floor(lon2x(e, z));
    const y0 = Math.floor(lat2y(n, z)), y1 = Math.floor(lat2y(s, z));
    const vset = new Set();
    for (const r of rings) for (const [lon, lat] of r) vset.add(Math.floor(lon2x(lon, z)) + ',' + Math.floor(lat2y(lat, z)));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (z <= 11 || vset.has(x + ',' + y)) { out.push([z, x, y]); continue; }
      const lw = x2lon(x, z), le = x2lon(x + 1, z), ln = y2lat(y, z), ls = y2lat(y + 1, z);
      if (inside((lw + le) / 2, (ln + ls) / 2) || inside(lw, ln) || inside(le, ln) || inside(lw, ls) || inside(le, ls)) out.push([z, x, y]);
    }
  }
  return out;
}
function tilesForCircle(lat, lon, rKm, maxZ) {
  const out = [], kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  for (let z = MIN_SAVE_Z; z <= maxZ; z++) {
    const dLon = rKm / kx, dLat = rKm / ky;
    const x0 = Math.floor(lon2x(lon - dLon, z)), x1 = Math.floor(lon2x(lon + dLon, z));
    const y0 = Math.floor(lat2y(lat + dLat, z)), y1 = Math.floor(lat2y(lat - dLat, z));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const lw = x2lon(x, z), le = x2lon(x + 1, z), ln = y2lat(y, z), ls = y2lat(y + 1, z);
      const cx = Math.max(lw, Math.min(lon, le)), cy = Math.max(ls, Math.min(lat, ln));     // 円の中心に一番近いタイル上の点
      if (Math.hypot((cx - lon) * kx, (cy - lat) * ky) <= rKm) out.push([z, x, y]);
    }
  }
  return out;
}
function tilesForPref() {
  const seen = new Set(), out = [];
  for (const f of munis) for (const t of tilesForFeature(f, PREF_MAX_Z)) {
    const k = t.join('/'); if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}
function tilesForEntry(key, e) {
  if (e.kind === 'pref') return tilesForPref();
  if (e.kind === 'place') return tilesForCircle(e.lat, e.lon, e.r, e.maxZ);
  const f = munis.find(m => m.properties.code === e.code);
  return f ? tilesForFeature(f, e.maxZ) : [];
}
const estTilesBytes = tiles => tiles.reduce((a, [z]) => a + (KB_PER_TILE[z] || 30) * 1024, 0) * 1.12;
const estCache = {};
const estFor = (k, fn) => estCache[k] ??= estTilesBytes(fn());

// ---------- オフライン保存：ダウンロード・削除 ----------
async function downloadArea(key, entry) {
  if (jobs[key]) return;
  if (!navigator.onLine) return toast('保存にはインターネット接続が必要です');
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const cache = await caches.open(TILE_CACHE);
  const tiles = tilesForEntry(key, entry);
  const urls = [];
  for (const [z, x, y] of tiles) {
    urls.push(tileUrl(BASE_URL, z, x, y));
    if (z <= HZ_MAX_Z) for (const p of ALL_HZ_PATHS) urls.push(tileUrl(hzTpl(p), z, x, y));
  }
  const job = jobs[key] = { cancel: false, done: 0, total: urls.length, bytes: 0, failed: 0 };
  saved[key] = { ...entry, date: Date.now(), tiles: tiles.length, bytes: saved[key]?.bytes || 0, done: false, partial: false };
  saveLedger(); renderPanel(); drawPlaces();

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
      if (job.done % 30 === 0) renderPanel();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const cancelled = job.cancel;
  delete jobs[key];
  if (!saved[key]) return;                       // 保存中に削除された
  saved[key].bytes += job.bytes;
  saved[key].failed = job.failed;
  saved[key].done = !cancelled && job.failed === 0;
  saved[key].partial = !saved[key].done;
  saveLedger(); pixCache.clear();
  refreshMuniStyle(); drawPlaces(); renderPanel(); updateStorage();
  const name = entry.name;
  if (cancelled) toast(`${name}の保存を中断しました（もう一度押すと続きから再開）`);
  else if (job.failed) toast(`${name}：${job.failed}件取得できませんでした。もう一度押すと再試行します`);
  else toast(`${name}を保存しました。電波がなくても使えます`);
}

async function deleteArea(key) {
  const e = saved[key]; if (!e) return;
  if (jobs[key]) jobs[key].cancel = true;
  const keep = new Set();
  for (const [k, s] of Object.entries(saved)) {
    if (k === key) continue;
    for (const t of tilesForEntry(k, s)) keep.add(t.join('/'));
  }
  const tiles = tilesForEntry(key, e);
  delete saved[key]; saveLedger();
  const cache = await caches.open(TILE_CACHE);
  for (const t of tiles) {
    if (keep.has(t.join('/'))) continue;
    const [z, x, y] = t;
    await cache.delete(tileUrl(BASE_URL, z, x, y));
    for (const p of ALL_HZ_PATHS) await cache.delete(tileUrl(hzTpl(p), z, x, y));
  }
  pixCache.clear();
  refreshMuniStyle(); drawPlaces(); renderPanel(); updateStorage();
  toast(`${e.name}の保存データを削除しました`);
}

// 初回起動時に県全体の概略地図（約13MB）を自動保存
function maybeAutoSavePref() {
  if (!munis.length || !navigator.onLine || jobs.pref) return;
  const p = saved.pref;
  if (p && p.done) return;
  setTimeout(() => {
    if (!saved.pref) toast('電波がなくても使えるよう、県全体の概略地図（約18MB）を保存しています', 3500);
    downloadArea('pref', { kind: 'pref', name: '熊本県全体の概略地図', maxZ: PREF_MAX_Z });
  }, 2500);
}

// ---------- 地点の周りを保存 ----------
const NAME_PRESETS = ['自宅', '職場', '実家', '学校'];
const RADII = [1, 2, 3];
function openSaveSheet(latlng) {
  inspectSeq++;
  if (!tapMarker) tapMarker = L.circleMarker(latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#0a66d8', fillOpacity: 1 }).addTo(map);
  else tapMarker.setLatLng(latlng);
  routeGroup.clearLayers();
  let name = NAME_PRESETS[0], r = 2;
  const preview = L.circle(latlng, { radius: r * 1000, color: '#0a66d8', weight: 2, dashArray: '6 6', fillOpacity: .06, interactive: false }).addTo(routeGroup);
  const sizeOf = rr => fmtMB(estFor(`c${rr}@${latlng.lat.toFixed(2)}`, () => tilesForCircle(latlng.lat, latlng.lng, rr, PLACE_MAX_Z)));
  const render = () => {
    openSheet(`<div class="res-title" style="margin-top:2px">この地点の周りを保存</div>
      <p class="res-desc" style="margin:2px 0 4px">電波がなくても、道路まで鮮明な地図とハザード情報を見られるようにします。</p>
      <div class="namechips">${NAME_PRESETS.map(n => `<button data-n="${n}" class="${n === name ? 'on' : ''}">${n}</button>`).join('')}</div>
      <input class="namein" id="placeName2" placeholder="名前を入力（例：祖母の家）" value="${NAME_PRESETS.includes(name) ? '' : esc(name)}">
      <div class="res-title">保存する範囲</div>
      <div class="seg" style="margin-top:6px">${RADII.map(x => `<button data-r="${x}" class="${x === r ? 'on' : ''}">半径${x}km<small>約${sizeOf(x)}</small></button>`).join('')}</div>
      <button class="primary" id="doSavePlace">保存する</button>`);
    document.querySelectorAll('.namechips button').forEach(b => b.onclick = () => { name = b.dataset.n; render(); });
    $('#placeName2').oninput = e => { const v = e.target.value.trim(); name = v || NAME_PRESETS[0]; document.querySelectorAll('.namechips button').forEach(b => b.classList.toggle('on', !v && b.dataset.n === name)); };
    document.querySelectorAll('.seg button[data-r]').forEach(b => b.onclick = () => { r = +b.dataset.r; preview.setRadius(r * 1000); render(); });
    $('#doSavePlace').onclick = () => {
      const id = 'p:' + Date.now().toString(36);
      closeSheet();
      downloadArea(id, { kind: 'place', name, lat: +latlng.lat.toFixed(6), lon: +latlng.lng.toFixed(6), r, maxZ: PLACE_MAX_Z });
      toast(`${name}の周り（半径${r}km）を保存しています…`);
    };
  };
  render();
  map.fitBounds(preview.getBounds(), { paddingBottomRight: [0, 320] });
}

// 保存した地点を地図に描く
function drawPlaces() {
  placeGroup.clearLayers();
  for (const [k, e] of Object.entries(saved)) {
    if (e.kind !== 'place') continue;
    L.circle([e.lat, e.lon], { radius: e.r * 1000, pane: 'places', color: '#0a66d8', weight: 1.5, opacity: .7, dashArray: e.done ? null : '4 6', fillOpacity: .03, interactive: false }).addTo(placeGroup);
    L.marker([e.lat, e.lon], { pane: 'places', icon: L.divIcon({ className: '', html: '', iconSize: [0, 0] }), interactive: false })
      .bindTooltip(esc(e.name) + (e.done ? '' : '（保存中）'), { permanent: true, direction: 'top', className: 'place-label', offset: [0, -4] }).addTo(placeGroup);
  }
}

// ---------- 保存パネルUI ----------
function statusBtn(key, e) {
  const j = jobs[key];
  if (j) {
    const pct = Math.floor(j.done / j.total * 100);
    return { sub: `保存中… ${pct}%（${fmtMB(j.bytes)}）`, btn: `<button class="dlbtn busy" data-act="stop" data-key="${key}"><i class="prog" style="width:${pct}%"></i><span>中断</span></button>` };
  }
  if (e && e.done) return { sub: null, btn: `<button class="dlbtn saved" data-act="menu" data-key="${key}"><span>✓ 保存済み</span></button>` };
  if (e && e.partial) return { sub: `途中まで保存（${fmtMB(e.bytes)}）`, btn: `<button class="dlbtn" data-act="resume" data-key="${key}"><span>続きから</span></button>` };
  return null;
}
const dateStr = t => new Date(t).toLocaleDateString('ja-JP');

function renderPanel() {
  if ($('#dlPanel').hidden) return;
  // 県全体
  {
    const e = saved.pref, st = statusBtn('pref', e);
    const est = munis.length ? estFor('pref', tilesForPref) : 0;
    const sub = st?.sub ?? (e?.done ? `保存済み・${fmtMB(e.bytes)}・${dateStr(e.date)}` : `約${fmtMB(est)}・市町村の区別がつく程度の縮尺`);
    const btn = st?.btn ?? `<button class="dlbtn" data-act="pref"><span>保存</span></button>`;
    $('#prefList').innerHTML = `<li><div class="meta"><div class="name">熊本県全体</div><div class="sub">${sub}</div></div>${btn}</li>`;
  }
  // 地点
  const places = Object.entries(saved).filter(([, e]) => e.kind === 'place');
  $('#placeList').innerHTML = places.length ? places.map(([k, e]) => {
    const st = statusBtn(k, e);
    const sub = st?.sub ?? `半径${e.r}km・${fmtMB(e.bytes)}・${dateStr(e.date)}`;
    return `<li><div class="meta"><div class="name">${esc(e.name)}</div><div class="sub">${sub}</div></div>${st?.btn ?? ''}</li>`;
  }).join('') : `<li><div class="meta"><div class="sub">まだありません。自宅や職場などを保存しておくと、電波がなくても道路まで鮮明に見られます。</div></div></li>`;
  // 市町村
  if ($('#muniDetails').open) renderMuniList();
}
let hereCode = null;
function renderMuniList() {
  const q = $('#dlSearch').value.trim();
  const c = map.getCenter(); const here = muniAt(c.lat, c.lng); hereCode = here ? here.properties.code : null;
  const list = munis.filter(f => !q || f.properties.name.includes(q));
  list.sort((a, b) => (b.properties.code === hereCode) - (a.properties.code === hereCode));
  $('#dlList').innerHTML = list.map(f => {
    const p = f.properties, key = 'm:' + p.code, e = saved[key], st = statusBtn(key, e);
    const sub = st?.sub ?? (e?.done ? `保存済み・${e.maxZ >= 16 ? '詳細' : '標準'}・${fmtMB(e.bytes)}` : `約${fmtMB(estFor(key + '@' + quality, () => tilesForFeature(f, quality)))}`);
    const btn = st?.btn ?? `<button class="dlbtn" data-act="muni" data-key="${key}"><span>保存</span></button>`;
    return `<li><div class="meta"><div class="name">${esc(p.name)}${p.code === hereCode ? '<em>表示中</em>' : ''}</div><div class="sub">${sub}</div></div>${btn}</li>`;
  }).join('');
}
$('#muniDetails').addEventListener('toggle', () => { if ($('#muniDetails').open) renderMuniList(); });

$('#dlPanel').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const act = b.dataset.act, key = b.dataset.key;
  if (act === 'pref') downloadArea('pref', { kind: 'pref', name: '熊本県全体の概略地図', maxZ: PREF_MAX_Z });
  else if (act === 'muni') {
    const f = munis.find(m => 'm:' + m.properties.code === key);
    downloadArea(key, { kind: 'muni', code: f.properties.code, name: f.properties.name, maxZ: quality });
  } else if (act === 'resume') downloadArea(key, saved[key]);
  else if (act === 'stop') jobs[key].cancel = true;
  else if (act === 'menu') {
    const s = saved[key];
    if (confirm(`「${s.name}」の保存データを削除しますか？\n（「キャンセル」で地図に移動します）`)) deleteArea(key);
    else {
      $('#dlPanel').hidden = true;
      if (s.kind === 'place') map.fitBounds(L.latLng(s.lat, s.lon).toBounds(s.r * 2000));
      else if (s.kind === 'muni') { const b = munis.find(m => m.properties.code === s.code).properties.bbox; map.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }
      else map.setView([32.65, 130.75], 9);
    }
  }
});
$('#addPlace').onclick = () => {
  $('#dlPanel').hidden = true;
  toast('保存したい場所を地図で長押しするか、タップして「この地点の周りを保存」を押してください', 4500);
};
$('#dlSearch').addEventListener('input', renderMuniList);
document.querySelectorAll('#muniDetails .seg button').forEach(b => {
  b.classList.toggle('on', +b.dataset.q === quality);
  b.onclick = () => {
    quality = +b.dataset.q; store.set('hm-quality', quality);
    document.querySelectorAll('#muniDetails .seg button').forEach(x => x.classList.toggle('on', x === b));
    renderMuniList();
  };
});
$('#btnDownload').onclick = () => { $('#dlPanel').hidden = false; renderPanel(); updateStorage(); };
$('#dlClose').onclick = () => { $('#dlPanel').hidden = true; };

async function updateStorage() {
  const el = $('#storageInfo');
  const total = Object.values(saved).reduce((a, s) => a + (s.bytes || 0), 0);
  let line = `保存済み ${fmtMB(total)}`, bar = '';
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
Promise.all([
  fetch('data/kumamoto_municipalities.geojson').then(r => r.json()),
  fetch('data/shelters_kumamoto.json').then(r => r.json()),
]).then(([g, sh]) => {
  munis = g.features;
  shelters = sh.items;
  muniLayer = L.geoJSON(g, { style: muniStyle, interactive: false }).addTo(map);
  updatePlace(); drawShelterDots(); drawPlaces(); renderPanel();
  if (store.get('hm-agreed', false)) maybeAutoSavePref();
});
showLayer(LAYERS[activeLayer] ? activeLayer : 'flood');

if (!store.get('hm-agreed', false)) $('#modal').hidden = false;
$('#modalOk').onclick = () => { $('#modal').hidden = true; store.set('hm-agreed', true); maybeAutoSavePref(); };

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW登録失敗', e));
}
