// climate-indices.js — ENSO (ONI) + MJO (RMM) para temporada de huracanes
// ENSO: NOAA CPC ONI  MJO: Australian BOM RMM
// URL: /api/climate-indices
const https = require('https');

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StormTrack/4.0 (Climate)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ── ENSO ─────────────────────────────────────────────────────────────────────
// ONI: anomalía de SST en el Pacífico ecuatorial (Niño 3.4)
// > +0.5 = El Niño (suprime Atlántico por mayor shear)
// < -0.5 = La Niña (favorece Atlántico por menor shear)
async function fetchEnso() {
  const txt = await httpGet('https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt');
  const lines = txt.trim().split('\n').filter(l => /^\s*\w{3}\s+\d{4}/.test(l));
  const last  = lines[lines.length - 1].trim().split(/\s+/);
  const seas  = last[0];         // e.g. "MJJ"
  const year  = last[1];
  const anom  = parseFloat(last[last.length - 1]);

  let state, color, atlanticImpact;
  if      (anom >=  1.5) { state = 'El Niño fuerte';  color = '#ff4444'; atlanticImpact = 'Suprime fuerte'; }
  else if (anom >=  0.5) { state = 'El Niño';         color = '#ff9944'; atlanticImpact = 'Suprime'; }
  else if (anom <= -1.5) { state = 'La Niña fuerte';  color = '#00cc44'; atlanticImpact = 'Favorece fuerte'; }
  else if (anom <= -0.5) { state = 'La Niña';         color = '#44dd88'; atlanticImpact = 'Favorece'; }
  else                   { state = 'Neutral';          color = '#aaaaaa'; atlanticImpact = 'Neutral'; }

  return { value: anom, state, color, atlanticImpact, period: `${seas} ${year}` };
}


// ── Cache ─────────────────────────────────────────────────────────────────────
let _cache = null, _cacheTs = 0;
const CACHE_MS = 6 * 3600 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=21600');

  if (_cache && Date.now() - _cacheTs < CACHE_MS) return res.json(_cache);

  try {
    const enso = await fetchEnso();
    _cache = { enso, updatedAt: new Date().toISOString() };
    _cacheTs = Date.now();
    res.json(_cache);
  } catch(e) {
    console.error('[Climate]', e.message);
    if (_cache) return res.json(_cache);
    res.status(500).json({ error: e.message });
  }
};
