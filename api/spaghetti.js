// StormTrack Spaghetti API v2 — Node.js (no Edge runtime needed)
const https = require('https');
const http  = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'StormTrack/4.0 (emergency-management-research)' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetch(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

const SKIP = new Set(['CARQ','BEST','OFCL','OFCP','WRNG','XTRP','LBAR','CLPB','SHIP',
  'SHF5','SHFR','DSHP','LGEM','GUNS','GUNA','GUNX']);

function parseATCF(text) {
  if (!text || text.trimStart().startsWith('<')) return [];
  const byTech = {};
  for (const line of text.split('\n')) {
    const f = line.split(',').map(s => s.trim());
    if (f.length < 9) continue;
    const tech = f[4]; if (!tech || SKIP.has(tech)) continue;
    const dtg = f[2], tau = parseInt(f[5]) || 0;
    const latR = f[6], lonR = f[7];
    if (!latR || !lonR) continue;
    const lat = parseFloat(latR) / 10 * (latR.endsWith('S') ? -1 : 1);
    const lon = parseFloat(lonR) / 10 * (lonR.endsWith('W') ? -1 : 1);
    if (!lat && !lon) continue;
    if (!byTech[tech] || dtg > byTech[tech].dtg) byTech[tech] = { dtg, points: [] };
    if (dtg === byTech[tech].dtg && !byTech[tech].points.find(p => p.tau === tau))
      byTech[tech].points.push({ tau, lat, lon });
  }
  return Object.entries(byTech)
    .map(([m, d]) => ({ model: m, track: d.points.sort((a,b) => a.tau-b.tau).map(p => [p.lon, p.lat]) }))
    .filter(t => t.track.length >= 2);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const stormId = ((req.query.storm) || '').toLowerCase().trim();
  if (!stormId) return res.status(400).json({ tracks: [], error: 'Missing storm param' });

  const basin = stormId.slice(0, 2);
  const urls = ['wp','io','sh'].includes(basin) ? [
    `https://ftp.nhc.noaa.gov/atcf/aid_public/${stormId}.dat`,
    `https://www.nrlmry.navy.mil/atcf_web/docs/current_storms/${stormId}.dat`,
  ] : [
    `https://ftp.nhc.noaa.gov/atcf/aid_public/${stormId}.dat`,
  ];

  for (const src of urls) {
    try {
      console.log('[Spaghetti] Trying:', src);
      const r = await fetch(src);
      console.log('[Spaghetti] Status:', r.status, src);
      if (r.status !== 200) continue;
      const tracks = parseATCF(r.text);
      if (tracks.length)
        return res.status(200).json({ tracks, source: src });
    } catch(e) { console.warn('[Spaghetti] Error:', src, e.message); }
  }

  return res.status(200).json({ tracks: [], message: `No ATCF data for ${stormId}` });
};
