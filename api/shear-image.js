// shear-image.js — Wind shear as a smooth PNG raster (bilinear interpolation)
// Fetches GFS wind at 200/850hPa from open-meteo, computes shear, renders PNG.
// MapLibre displays it as an 'image' source overlaid on the map.
// URL: /api/shear-image
const https = require('https');
const zlib  = require('zlib');

// ── Minimal PNG encoder (no external deps) ──────────────────────────────────
const _CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function _crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = _CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function _chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(_crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePNG(w, h, getPixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rowBytes = 1 + w * 4;
  const raw = Buffer.alloc(h * rowBytes);
  for (let y = 0; y < h; y++) {
    raw[y * rowBytes] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const o = y * rowBytes + 1 + x * 4;
      raw[o] = r; raw[o+1] = g; raw[o+2] = b; raw[o+3] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    _chunk('IHDR', ihdr),
    _chunk('IDAT', idat),
    _chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Color scale: shear (kt) → [R, G, B, A] ─────────────────────────────────
const STOPS = [
  [0,  [0,   204,  68]],
  [10, [170, 221,   0]],
  [20, [255, 210,   0]],
  [30, [255, 110,   0]],
  [40, [255,  20,   0]],
  [60, [140,   0,   0]],
];
function shearColor(s) {
  let i = 0;
  while (i < STOPS.length - 2 && s >= STOPS[i + 1][0]) i++;
  const [v0, c0] = STOPS[i];
  const [v1, c1] = STOPS[i + 1];
  const t = Math.max(0, Math.min(1, (s - v0) / (v1 - v0)));
  return [
    Math.round(c0[0] + t * (c1[0] - c0[0])),
    Math.round(c0[1] + t * (c1[1] - c0[1])),
    Math.round(c0[2] + t * (c1[2] - c0[2])),
    200, // ~78% alpha
  ];
}

// ── open-meteo POST ──────────────────────────────────────────────────────────
function httpPost(url, body, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'StormTrack/4.0 (Shear-img)' },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// ── Source grid: 2.5° spacing ───────────────────────────────────────────────
const STEP = 2.5;
const LAT_MIN = 0, LAT_MAX = 40, LON_MIN = -120, LON_MAX = 20;
const NLAT = Math.round((LAT_MAX - LAT_MIN) / STEP) + 1; // 17
const NLON = Math.round((LON_MAX - LON_MIN) / STEP) + 1; // 57
const GRID = [];
for (let i = 0; i < NLAT; i++)
  for (let j = 0; j < NLON; j++)
    GRID.push({ lat: LAT_MIN + i * STEP, lon: LON_MIN + j * STEP });

// ── Cache ────────────────────────────────────────────────────────────────────
let _cache = null, _cacheTs = 0;
const CACHE_MS = 3 * 3600 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=10800');
  res.setHeader('Content-Type', 'image/png');

  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_MS) return res.send(_cache);

  try {
    const raw = await httpPost('https://api.open-meteo.com/v1/forecast', {
      latitude:  GRID.map(p => p.lat),
      longitude: GRID.map(p => p.lon),
      hourly: ['wind_speed_200hPa','wind_direction_200hPa','wind_speed_850hPa','wind_direction_850hPa'],
      forecast_days: 1,
      wind_speed_unit: 'kn',
      timezone: GRID.map(() => 'UTC'),
    });

    const results = JSON.parse(raw);
    if (!Array.isArray(results)) throw new Error(results?.reason || 'bad response');

    // Build 2D shear grid [latIdx][lonIdx]
    const toRad = d => d * Math.PI / 180;
    const sg = Array.from({ length: NLAT }, () => new Float32Array(NLON));
    results.forEach((d, idx) => {
      const i = Math.floor(idx / NLON), j = idx % NLON;
      const s200 = d.hourly?.wind_speed_200hPa?.[0] ?? 0;
      const r200 = d.hourly?.wind_direction_200hPa?.[0] ?? 0;
      const s850 = d.hourly?.wind_speed_850hPa?.[0] ?? 0;
      const r850 = d.hourly?.wind_direction_850hPa?.[0] ?? 0;
      const u200 = -s200 * Math.sin(toRad(r200)), v200 = -s200 * Math.cos(toRad(r200));
      const u850 = -s850 * Math.sin(toRad(r850)), v850 = -s850 * Math.cos(toRad(r850));
      sg[i][j] = Math.sqrt((u200 - u850) ** 2 + (v200 - v850) ** 2);
    });

    // Bilinear interpolation
    function sample(lat, lon) {
      const fi = (lat - LAT_MIN) / STEP;
      const fj = (lon - LON_MIN) / STEP;
      const i0 = Math.max(0, Math.min(NLAT - 2, Math.floor(fi)));
      const j0 = Math.max(0, Math.min(NLON - 2, Math.floor(fj)));
      const fy = fi - i0, fx = fj - j0;
      return (1-fx)*(1-fy)*sg[i0][j0] + fx*(1-fy)*sg[i0][j0+1]
           + (1-fx)*fy*sg[i0+1][j0] + fx*fy*sg[i0+1][j0+1];
    }

    // Render: 6px per degree → 840×240 image
    const PPD = 6;
    const W = (LON_MAX - LON_MIN) * PPD; // 840
    const H = (LAT_MAX - LAT_MIN) * PPD; // 240

    const png = makePNG(W, H, (px, py) => {
      const lon = LON_MIN + (px + 0.5) / PPD;
      const lat = LAT_MAX - (py + 0.5) / PPD; // py=0 → top → LAT_MAX
      return shearColor(sample(lat, lon));
    });

    _cache = png;
    _cacheTs = now;
    res.send(png);
  } catch (e) {
    console.error('[Shear-img]', e.message);
    res.status(500).end();
  }
};
