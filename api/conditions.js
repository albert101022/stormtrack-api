// conditions.js — Índice de condiciones para desarrollo ciclónico
// Combina SST y shear 200-850hPa en 3 regiones del Atlántico
// URL: /api/conditions
const https = require('https');

// ── Regiones ──────────────────────────────────────────────────────────────────
const REGIONS = {
  mdr: {
    name: 'MDR',
    full: 'Región Principal de Desarrollo',
    points: [[10,-70],[12,-60],[15,-50],[15,-40],[18,-55],[12,-45],[20,-30],[10,-55]],
  },
  caribbean: {
    name: 'Caribe',
    full: 'Mar Caribe',
    points: [[12,-72],[14,-80],[17,-75],[20,-70],[14,-65],[19,-85],[22,-76],[16,-68]],
  },
  gulf: {
    name: 'Golfo',
    full: 'Golfo de México',
    points: [[22,-87],[24,-90],[27,-88],[25,-93],[28,-85],[25,-97],[29,-91],[23,-84]],
  },
};

const allPoints = [];
const regionMap = [];
for (const [key, reg] of Object.entries(REGIONS)) {
  for (const pt of reg.points) {
    allPoints.push({ lat: pt[0], lon: pt[1] });
    regionMap.push(key);
  }
}

// ── HTTP POST open-meteo ──────────────────────────────────────────────────────
function httpPost(url, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length,
                 'User-Agent': 'StormTrack/4.0 (Conditions)' },
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const toRad = d => d * Math.PI / 180;

function getShear(d) {
  const s200 = d.hourly?.wind_speed_200hPa?.[0]      ?? 0;
  const r200 = d.hourly?.wind_direction_200hPa?.[0]  ?? 0;
  const s850 = d.hourly?.wind_speed_850hPa?.[0]      ?? 0;
  const r850 = d.hourly?.wind_direction_850hPa?.[0]  ?? 0;
  const u200 = -s200 * Math.sin(toRad(r200)), v200 = -s200 * Math.cos(toRad(r200));
  const u850 = -s850 * Math.sin(toRad(r850)), v850 = -s850 * Math.cos(toRad(r850));
  return Math.sqrt((u200 - u850) ** 2 + (v200 - v850) ** 2);
}

function getSst(d) {
  return d.hourly?.sea_surface_temperature?.[0] ?? null;
}

function avg(arr) {
  const v = arr.filter(x => x !== null && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ── Semáforo ──────────────────────────────────────────────────────────────────
// SST:   ≥28°C → 2pts, 26-28°C → 1pt, <26°C → 0pts
// Shear: ≤15kt → 2pts, 15-25kt → 1pt, >25kt → 0pts
// Total: 4 → favorable, 2-3 → mixto, 0-1 → desfavorable
function semaforo(sst, shear) {
  const sstPts   = sst   === null ? 1 : sst   >= 28 ? 2 : sst   >= 26 ? 1 : 0;
  const shearPts = shear === null ? 1 : shear <= 15 ? 2 : shear <= 25 ? 1 : 0;
  const total    = sstPts + shearPts;
  if (total >= 4) return { label: 'Muy favorable', color: '#00cc44', emoji: '🟢' };
  if (total >= 3) return { label: 'Favorable',     color: '#88cc00', emoji: '🟢' };
  if (total >= 2) return { label: 'Mixto',          color: '#ffaa00', emoji: '🟡' };
  if (total >= 1) return { label: 'Desfavorable',   color: '#ff6600', emoji: '🟠' };
                  return { label: 'Muy desfavorable',color: '#ff2222', emoji: '🔴' };
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cache = null, _cacheTs = 0;
const CACHE_MS = 3 * 3600 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=10800');

  if (_cache && Date.now() - _cacheTs < CACHE_MS) return res.json(_cache);

  try {
    const raw = await httpPost('https://api.open-meteo.com/v1/forecast', {
      latitude:  allPoints.map(p => p.lat),
      longitude: allPoints.map(p => p.lon),
      hourly: [
        'wind_speed_200hPa', 'wind_direction_200hPa',
        'wind_speed_850hPa', 'wind_direction_850hPa',
        'sea_surface_temperature',
      ],
      forecast_days: 1,
      wind_speed_unit: 'kn',
      timezone: allPoints.map(() => 'UTC'),
    });

    const results = JSON.parse(raw);
    if (!Array.isArray(results)) throw new Error(results?.reason || 'bad response');

    // Acumular por región
    const acc = { mdr: { ssts:[], shears:[] }, caribbean: { ssts:[], shears:[] }, gulf: { ssts:[], shears:[] } };
    results.forEach((d, i) => {
      const key = regionMap[i];
      acc[key].ssts.push(getSst(d));
      acc[key].shears.push(getShear(d));
    });

    // Promediar y evaluar
    const regions = {};
    for (const [key, reg] of Object.entries(REGIONS)) {
      const sst   = avg(acc[key].ssts);
      const shear = avg(acc[key].shears);
      const cond  = semaforo(sst, shear);
      regions[key] = {
        name:  reg.name,
        full:  reg.full,
        sst:   sst   !== null ? Math.round(sst * 10) / 10 : null,
        shear: shear !== null ? Math.round(shear)          : null,
        ...cond,
      };
    }

    _cache = { regions, updatedAt: new Date().toISOString() };
    _cacheTs = Date.now();
    res.json(_cache);
  } catch(e) {
    console.error('[Conditions]', e.message);
    if (_cache) return res.json(_cache);
    res.status(500).json({ error: e.message });
  }
};
