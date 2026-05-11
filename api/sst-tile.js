// sst-tile.js — SST Anomaly proxy (solo anomaly; SST base usa GIBS directo en el frontend)
// Fuente: CoastWatch PFEG ERDDAP (NCEI da 400 para este dataset)
// URL: /api/sst-tile?z=Z&x=X&y=Y&type=anomaly[&date=YYYY-MM-DD]
const https = require('https');

function tile2LatLon(x, y, z) {
  const n = Math.pow(2, z);
  const lonW = x / n * 360 - 180;
  const lonE = (x + 1) / n * 360 - 180;
  const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { latS, lonW, latN, lonE };
}

function httpGetBuf(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StormTrack/4.0 (SST-tile)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGetBuf(res.headers.location, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function defaultDate(lagDays) {
  return new Date(Date.now() - lagDays * 86400000).toISOString().slice(0, 10);
}

function buildWmsUrl(host, dataset, variable, colorBar, bbox, date) {
  return [
    `https://${host}/erddap/wms/${dataset}/request`,
    '?service=WMS&version=1.1.1&request=GetMap',
    `&Layers=${dataset}:${variable}&Styles=`,
    '&Format=image/png&Transparent=true',
    '&WIDTH=256&HEIGHT=256',
    `&SRS=EPSG:4326&BBOX=${bbox}`,
    `&Time=${date}T09:00:00Z`,
    `&.colorBar=${colorBar}`,
  ].join('');
}

// NCEI da HTTP 400 para jplMURSST41anom1day — solo CoastWatch funciona
const HOSTS = [
  'coastwatch.pfeg.noaa.gov',
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');

  const z    = parseInt(req.query.z) || 0;
  const x    = parseInt(req.query.x) || 0;
  const y    = parseInt(req.query.y) || 0;
  const date = (req.query.date || defaultDate(2)).slice(0, 10);

  const { latS, lonW, latN, lonE } = tile2LatLon(x, y, z);
  const bbox = `${lonW.toFixed(6)},${latS.toFixed(6)},${lonE.toFixed(6)},${latN.toFixed(6)}`;

  for (const host of HOSTS) {
    const url = buildWmsUrl(host, 'jplMURSST41anom1day', 'sstAnom', 'RdYlBu|D|Lin|-3|3|', bbox, date);
    try {
      const r = await httpGetBuf(url);
      if (r.status === 200 && r.type.includes('png')) {
        res.setHeader('Content-Type', 'image/png');
        return res.send(r.buf);
      }
    } catch(e) {
      console.warn(`[SSTA] ${host} failed:`, e.message);
    }
  }

  res.status(204).end();
};
