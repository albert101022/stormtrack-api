// shear-data.js — Vertical wind shear grid (200hPa - 850hPa) via open-meteo GFS
// Uses POST to avoid URL length limits (2.5° grid, ~969 points).
// Returns GeoJSON FeatureCollection of 2.5°×2.5° filled rectangles with shear in knots.
// URL: /api/shear-data
const https = require('https');

function httpPost(url, body, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': 'StormTrack/4.0 (Shear)',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Grid: 2.5° spacing covering Atlantic + Eastern Pacific hurricane zones (~969 points)
const LATS = [], LONS = [];
for (let lat = 0; lat <= 40; lat += 2.5) LATS.push(Math.round(lat * 10) / 10);
for (let lon = -120; lon <= 20; lon += 2.5) LONS.push(Math.round(lon * 10) / 10);

const GRID = [];
for (const lat of LATS) for (const lon of LONS) GRID.push({ lat, lon });

let _cache = null;
let _cacheTs = 0;
const CACHE_MS = 3 * 3600 * 1000; // 3 hours

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=10800');

  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_MS) return res.json(_cache);

  try {
    const raw = await httpPost('https://api.open-meteo.com/v1/forecast', {
      latitude:  GRID.map(p => p.lat),
      longitude: GRID.map(p => p.lon),
      hourly: ['wind_speed_200hPa', 'wind_direction_200hPa', 'wind_speed_850hPa', 'wind_direction_850hPa'],
      forecast_days: 1,
      wind_speed_unit: 'kn',
      timezone: GRID.map(() => 'UTC'),
    });

    const data = JSON.parse(raw);
    const results = Array.isArray(data) ? data : [data];

    const toRad = deg => deg * Math.PI / 180;
    const features = results.map((d, i) => {
      const pt = GRID[i];
      const spd200 = d.hourly?.wind_speed_200hPa?.[0] ?? 0;
      const dir200 = d.hourly?.wind_direction_200hPa?.[0] ?? 0;
      const spd850 = d.hourly?.wind_speed_850hPa?.[0] ?? 0;
      const dir850 = d.hourly?.wind_direction_850hPa?.[0] ?? 0;

      const u200 = -spd200 * Math.sin(toRad(dir200));
      const v200 = -spd200 * Math.cos(toRad(dir200));
      const u850 = -spd850 * Math.sin(toRad(dir850));
      const v850 = -spd850 * Math.cos(toRad(dir850));

      const shear = Math.sqrt((u200 - u850) ** 2 + (v200 - v850) ** 2);
      const h = 1.25; // half cell size (2.5° / 2)
      const W = pt.lon - h, E = pt.lon + h;
      const S = Math.max(pt.lat - h, -90), N = Math.min(pt.lat + h, 90);
      return {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[W,S],[E,S],[E,N],[W,N],[W,S]]],
        },
        properties: { shear: Math.round(shear * 10) / 10 },
      };
    });

    const geojson = { type: 'FeatureCollection', features };
    _cache = geojson;
    _cacheTs = now;
    res.json(geojson);
  } catch (e) {
    console.error('[Shear]', e.message);
    res.status(500).json({ error: e.message });
  }
};
