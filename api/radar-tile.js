// radar-tile.js — Radar híbrido: TJUA→IEM Level 3 | CONUS→NOAA MRMS WMS
// Puerto Rico: IEM ridge::TJUA-N0Q (XYZ→TMS) con filtro haversine 230 km
// CONUS: opengeo.ncep.noaa.gov MRMS bref_qcd WMS EPSG:3857 (pr_bref_qcd = 404)
// URL: /api/radar-tile?z=Z&x=X&y=Y&station=TJUA&t=0
const https = require('https');

// ── Configuración por estación ────────────────────────────────────────────────
const STATIONS = {
  // Puerto Rico — usa IEM Level 3 ridge (MRMS no tiene workspace PR)
  TJUA: { lat: 18.12, lon: -66.08, source: 'iem', km: 230 },

  // CONUS — usa NOAA MRMS GeoServer WMS
  KAMX: { lat: 25.61, lon: -80.41, source: 'mrms' }, // Miami FL
  KBYX: { lat: 24.60, lon: -81.70, source: 'mrms' }, // Key West FL
  KHGX: { lat: 29.47, lon: -95.08, source: 'mrms' }, // Houston TX
  KMHX: { lat: 34.78, lon: -76.88, source: 'mrms' }, // Morehead City NC
  KLTX: { lat: 33.99, lon: -78.43, source: 'mrms' }, // Wilmington NC
  KCLX: { lat: 32.66, lon: -81.04, source: 'mrms' }, // Charleston SC
  KMLB: { lat: 28.11, lon: -80.65, source: 'mrms' }, // Melbourne FL
  KTBW: { lat: 27.71, lon: -82.40, source: 'mrms' }, // Tampa FL
  KEVX: { lat: 30.56, lon: -85.92, source: 'mrms' }, // Eglin AFB FL
  KMOB: { lat: 30.68, lon: -88.24, source: 'mrms' }, // Mobile AL
  KLIX: { lat: 30.34, lon: -89.83, source: 'mrms' }, // New Orleans LA
  KLCH: { lat: 30.12, lon: -93.22, source: 'mrms' }, // Lake Charles LA
  KCRP: { lat: 27.78, lon: -97.51, source: 'mrms' }, // Corpus Christi TX
  KBRO: { lat: 25.92, lon: -97.42, source: 'mrms' }, // Brownsville TX
};

// ── Helpers geométricos ───────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tileCenter(z, x, y) {
  const n = Math.pow(2, z);
  const lon = (x + 0.5) / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
  return { lat, lon };
}

// XYZ → EPSG:3857 BBOX (para MRMS WMS)
function tileToBBox(z, x, y) {
  const R = 20037508.342789244;
  const sz = 2 * R / Math.pow(2, z);
  return `${(x*sz-R).toFixed(2)},${(R-(y+1)*sz).toFixed(2)},${((x+1)*sz-R).toFixed(2)},${(R-y*sz).toFixed(2)}`;
}

// TIME ISO redondeado a 2 min para MRMS WMS
function mrmsTime(minutesAgo) {
  const target = Date.now() - (minutesAgo + 4) * 60000; // 4 min lag publicación
  return new Date(Math.floor(target / 120000) * 120000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function httpGetBuf(url, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StormTrack/4.0 (radar-tile)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGetBuf(res.headers.location, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        type:   res.headers['content-type'] || '',
        buf:    Buffer.concat(chunks),
      }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=60');

  const z    = parseInt(req.query.z)       || 0;
  const x    = parseInt(req.query.x)       || 0;
  const y    = parseInt(req.query.y)       || 0;
  const code = (req.query.station || 'TJUA').toUpperCase().slice(0, 4);
  const t    = parseInt(req.query.t)       || 0;

  const station = STATIONS[code];
  if (!station) return res.status(400).json({ error: 'unknown station' });

  try {
    // ── TJUA: IEM Level 3 ridge con filtro geográfico ─────────────────────────
    if (station.source === 'iem') {
      const center = tileCenter(z, x, y);
      const dist   = haversineKm(station.lat, station.lon, center.lat, center.lon);
      // Filtro conservador: solo tiles dentro del rango real de precipitación
      if (dist > station.km) return res.status(204).end();

      const yTMS   = Math.pow(2, z) - 1 - y;
      const suffix = t > 0 ? `-m${String(t).padStart(2, '0')}m` : '';
      const layer  = `ridge::${code}-N0Q${suffix}`;
      const url    = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${layer}/${z}/${x}/${yTMS}.png`;

      const r = await httpGetBuf(url);
      if (r.status !== 200) return res.status(204).end();

      // Dentro del filtro de 230 km, IEM devuelve tiles válidos (transparentes o con datos)
      // Umbral mínimo para descartar respuestas vacías/truncadas
      if (r.buf.length < 100) return res.status(204).end();

      res.setHeader('Content-Type', 'image/png');
      return res.send(r.buf);
    }

    // ── CONUS: NOAA MRMS GeoServer WMS ────────────────────────────────────────
    const layer = 'conus_bref_qcd';
    const bbox  = tileToBBox(z, x, y);
    const time  = mrmsTime(t);

    const url = [
      `https://opengeo.ncep.noaa.gov/geoserver/conus/${layer}/ows`,
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap',
      `&LAYERS=${layer}&STYLES=`,
      '&FORMAT=image/png&TRANSPARENT=TRUE',
      '&WIDTH=256&HEIGHT=256',
      `&SRS=EPSG:3857&BBOX=${bbox}`,
      `&TIME=${time}`,
    ].join('');

    const r = await httpGetBuf(url);
    if (r.status !== 200 || !r.type.includes('png')) return res.status(204).end();
    if (r.buf.length < 200) return res.status(204).end();

    res.setHeader('Content-Type', 'image/png');
    res.send(r.buf);

  } catch (e) {
    console.warn('[radar-tile]', code, z, x, y, e.message);
    res.status(204).end();
  }
};
