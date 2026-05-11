// gtwo-outlook.js — NHC Graphical Tropical Weather Outlook polygon areas
// Fetches live shapefile from NHC, returns GeoJSON with 2-day / 7-day formation
// probability polygons and disturbance center points.
// URL: /api/gtwo-outlook
const https   = require('https');
const JSZip   = require('jszip');
const shapefile = require('shapefile');

function httpGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StormTrack/4.0 (GTWO)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function parseLayer(zip, prefix) {
  const shpName = Object.keys(zip.files).find(n => n.includes(prefix) && n.endsWith('.shp'));
  if (!shpName) return [];
  const dbfName = shpName.replace('.shp', '.dbf');
  const shpBuf = await zip.files[shpName].async('nodebuffer');
  const dbfBuf = zip.files[dbfName] ? await zip.files[dbfName].async('nodebuffer') : null;
  const features = [];
  const src = await shapefile.open(shpBuf, dbfBuf || undefined);
  let result;
  while (!(result = await src.read()).done) {
    if (result.value?.geometry) features.push(result.value);
  }
  return features;
}

let _cache = null;
let _cacheTs = 0;
const CACHE_MS = 20 * 60 * 1000; // 20 min

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=1200, stale-while-revalidate=600');

  try {
    const now = Date.now();
    if (_cache && (now - _cacheTs) < CACHE_MS) return res.json(_cache);

    const r = await httpGet('https://www.nhc.noaa.gov/xgtwo/gtwo_shapefiles.zip');
    if (r.status !== 200) throw new Error(`NHC HTTP ${r.status}`);

    const zip = await JSZip.loadAsync(r.buf);

    // Timestamp from filename (yyyymmddhhmm)
    const areaFile = Object.keys(zip.files).find(n => n.includes('gtwo_areas_') && n.endsWith('.shp'));
    const timestamp = areaFile?.match(/(\d{12})/)?.[1] ?? null;

    const areas  = await parseLayer(zip, 'gtwo_areas_');
    const points = await parseLayer(zip, 'gtwo_points_');

    areas.forEach(f  => { f.properties._type = 'area';  });
    points.forEach(f => { f.properties._type = 'point'; });

    const geojson = { type: 'FeatureCollection', timestamp, features: [...areas, ...points] };
    _cache   = geojson;
    _cacheTs = now;
    res.json(geojson);
  } catch (e) {
    console.error('[GTWO]', e.message);
    // Return empty collection on error so the frontend doesn't break
    res.status(200).json({ type: 'FeatureCollection', timestamp: null, features: [] });
  }
};
