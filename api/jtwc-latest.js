// jtwc-latest.js — JTWC proxy for WPac / IO / SH
// Converted from Vercel Edge to Node.js for Render
const https = require('https');
const http  = require('http');

const UA = 'StormTrack/4.0 (emergency-management-research)';

function nodeFetch(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': UA },
      rejectUnauthorized: false,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return nodeFetch(res.headers.location, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: () => Promise.resolve(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
    req.on('error', reject);
  });
}

function parseJTWCRSS(xml, basin) {
  const yr2 = new Date().getFullYear().toString().slice(-2);
  const yr4 = new Date().getFullYear().toString();
  const basinSuffixes = { wp:['W'], io:['B','A','I'], sh:['S','P','C'] };
  const allowed = basinSuffixes[basin] || [basin.toUpperCase()];

  const storms = [], seen = new Set();
  const descRx = /<description>([\s\S]*?)<\/description>/g;
  let dm;
  while ((dm = descRx.exec(xml)) !== null) {
    const block = dm[1];
    const dtgM   = block.match(/(\d{2})\/(\d{2})(\d{2})Z/i);
    const advDTG = dtgM ? { day:parseInt(dtgM[1]), hour:parseInt(dtgM[2]) } : null;
    const stormRx = /(Super Typhoon|Typhoon|Tropical Storm|Tropical Depression|Cyclone)\s+(\d{2})([A-Z])\s*(?:\(([^)]+)\)\s*)?Warning\s+#?(\d+)/gi;
    let sm;
    while ((sm = stormRx.exec(block)) !== null) {
      const type = sm[1], num = sm[2], suffix = sm[3].toUpperCase();
      const name = sm[4] || '', adv = sm[5];
      if (!allowed.includes(suffix)) continue;
      const jtwcId = basin + num + yr2;
      const atcfId = basin + num + yr4;
      if (seen.has(atcfId)) continue;
      seen.add(atcfId);
      storms.push({ id: atcfId, jtwcId, atcf: atcfId, name: name || `${num}${suffix}`,
        type, adv: adv.padStart(3,'0'),
        title: `${type} ${num}${suffix}${name ? ' ('+name+')' : ''} Warning #${adv}`,
        advDTG });
    }
  }
  return storms;
}

function parseJTWCTcw(text, advDTG) {
  if (!text || text.trimStart().startsWith('<')) return null;
  const byTau = {};
  for (const line of text.split('\n')) {
    const m = line.match(
      /^T(\d{3})\s+(\d{2,4})([NS])\s+(\d{3,4})([EW])\s+(\d+)(?:\s+R(\d{2,3})\s+(\d+)\s+NE\s+QD\s+(\d+)\s+SE\s+QD\s+(\d+)\s+SW\s+QD\s+(\d+)\s+NW\s+QD\s*(\d*))?/
    );
    if (!m) continue;
    const tau  = parseInt(m[1]);
    const lat  = parseInt(m[2]) / 10 * (m[3] === 'S' ? -1 : 1);
    const lon  = parseInt(m[4]) / 10 * (m[5] === 'W' ? -1 : 1);
    const wind = parseInt(m[6]);
    if (!byTau[tau]) byTau[tau] = { tau, lat, lon, wind, r34:[0,0,0,0], r50:[0,0,0,0], r64:[0,0,0,0] };
    if (m[7]) {
      const rk = 'r' + parseInt(m[7]);
      if (rk==='r34'||rk==='r50'||rk==='r64') {
        const maxR = parseInt(m[8]) || 0;
        const ne = parseInt(m[9]) || maxR, se = parseInt(m[10]) || maxR;
        const sw = parseInt(m[11]) || maxR, nw = parseInt(m[12]) || maxR;
        byTau[tau][rk] = [ne, se, sw, nw];
      }
    }
  }
  return buildTrackData(Object.values(byTau).sort((a,b) => a.tau - b.tau), advDTG);
}

function parseJTWCAtcf(text, advDTG) {
  if (!text || text.trimStart().startsWith('<')) return null;
  const byKey = {};
  for (const line of text.split('\n')) {
    const f = line.split(',').map(s => s.trim());
    if (f.length < 11 || f[4] !== 'OFCL') continue;
    const dtg = f[2], tau = parseInt(f[5])||0;
    const latR = f[6], lonR = f[7];
    if (!latR || !lonR) continue;
    const lat = parseFloat(latR)/10 * (latR.endsWith('S')?-1:1);
    const lon = parseFloat(lonR)/10 * (lonR.endsWith('W')?-1:1);
    if (!lat && !lon) continue;
    const wind = parseInt(f[8])||0, mslp = parseInt(f[9])||0, ty = (f[10]||'').trim();
    const rad = parseInt(f[11])||0;
    const k = `${dtg}_${tau}`;
    if (!byKey[k]) byKey[k] = { tau, lat, lon, wind, mslp, ty, dtg, r34:[0,0,0,0], r50:[0,0,0,0], r64:[0,0,0,0] };
    if ((rad===34||rad===50||rad===64) && f.length>=17)
      byKey[k][`r${rad}`] = [parseInt(f[13])||0, parseInt(f[14])||0, parseInt(f[15])||0, parseInt(f[16])||0];
  }
  const all = Object.values(byKey);
  if (!all.length) return null;
  const latestDtg = all.reduce((mx,p) => p.dtg > mx ? p.dtg : mx, '');
  return buildTrackData(all.filter(p => p.dtg===latestDtg).sort((a,b) => a.tau-b.tau), advDTG);
}

function makeDateLabels(pts, advDTG) {
  if (!advDTG) return pts.map(() => '');
  const now    = new Date();
  const baseMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), advDTG.day, advDTG.hour, 0, 0);
  const DAYS_ES   = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const MONTHS_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return pts.map(p => {
    const ms = baseMs + p.tau * 3600000;
    const d  = new Date(ms);
    return `${DAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()]} ${d.getUTCHours().toString().padStart(2,'0')}Z`;
  });
}

function buildTrackData(pts, advDTG) {
  if (!pts.length) return null;
  const ssFromWind = w => w>=137?5:w>=113?4:w>=96?3:w>=83?2:w>=64?1:w>=34?'ts':'td';
  const dateLabels = makeDateLabels(pts, advDTG);
  const forecastPts = pts.map((p, i) => ({
    lon:p.lon, lat:p.lat, tau:p.tau, wind:p.wind, gust:Math.round(p.wind*1.12),
    mslp:p.mslp||0, ssnum:ssFromWind(p.wind), dvlbl:p.tau===0?'X':'F',
    datelbl:dateLabels[i], tcdvlp:p.ty||'',
    r34:p.r34, r50:p.r50, r64:p.r64, radiiOfficial:true,
  }));
  const trackCoords = pts.map(p => [p.lon, p.lat]);
  const side1=[], side2=[];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const halfDeg = Math.min(30 + p.tau * 1.5, 230) / 60;
    const prev = pts[Math.max(0, i-1)], next = pts[Math.min(pts.length-1, i+1)];
    const dx = next.lon - prev.lon, dy = next.lat - prev.lat;
    const len = Math.sqrt(dx*dx + dy*dy) || 1;
    const px = -dy/len, py = dx/len;
    const cosLat = Math.cos(p.lat * Math.PI / 180) || 0.001;
    side1.push([p.lon + px*halfDeg/cosLat, p.lat + py*halfDeg]);
    side2.push([p.lon - px*halfDeg/cosLat, p.lat - py*halfDeg]);
  }
  const coneCoords = [...side1, ...[...side2].reverse(), side1[0]];
  return { forecastPts, trackCoords, coneCoords };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const basin = (req.query.basin || 'wp').toLowerCase();
  const noStorms = msg => res.status(200).json({ active:false, basin, message:msg, storms:[] });

  let storms = [];
  try {
    const r = await nodeFetch('https://www.metoc.navy.mil/jtwc/rss/jtwc.rss');
    if (r.ok) { storms = parseJTWCRSS(await r.text(), basin); }
  } catch(e) { console.warn('[JTWC RSS]', e.message); }

  if (!storms.length) return noStorms('No active JTWC advisories for ' + basin.toUpperCase());

  const storm = storms[0];
  const webTxtUrl = `https://www.metoc.navy.mil/jtwc/products/${storm.jtwcId}web.txt`;
  const tcwUrl    = `https://www.metoc.navy.mil/jtwc/products/${storm.jtwcId}.tcw`;

  const [wtRes, tcwRes] = await Promise.allSettled([
    nodeFetch(webTxtUrl),
    nodeFetch(tcwUrl),
  ]);

  let mslpFromText = 0;
  if (wtRes.status === 'fulfilled' && wtRes.value.ok) {
    try {
      const txt = await wtRes.value.text();
      const mm  = txt.match(/MINIMUM CENTRAL PRESSURE\s+(?:AT\s+\d+Z\s+)?IS\s+(\d{3,4})\s*MB/i);
      if (mm) mslpFromText = parseInt(mm[1]);
    } catch(e) { console.warn('[JTWC web.txt]', e.message); }
  }

  const mslpEst = wind => Math.round(1013 - 0.55 * wind);
  function resolveMslp(trackData) {
    const pt0 = trackData.forecastPts[0];
    const atcfMslp = pt0?.mslp && pt0.mslp < 9000 ? pt0.mslp : 0;
    return atcfMslp || mslpFromText || mslpEst(pt0?.wind || 0);
  }

  const fallbackUrls = [
    { url: `https://www.metoc.navy.mil/jtwc/products/${storm.jtwcId}.dat`,  parser: parseJTWCAtcf },
    { url: `https://www.nrlmry.navy.mil/atcf_web/docs/current_storms/${storm.id}.dat`, parser: parseJTWCAtcf },
    { url: `https://www.metoc.navy.mil/jtwc/products/${storm.id}.dat`,      parser: parseJTWCAtcf },
  ];

  if (tcwRes.status === 'fulfilled' && tcwRes.value.ok) {
    try {
      const trackData = parseJTWCTcw(await tcwRes.value.text(), storm.advDTG);
      if (trackData) {
        const mslp0 = resolveMslp(trackData);
        trackData.forecastPts[0] = { ...trackData.forecastPts[0], mslp: mslp0 };
        return res.status(200).json({
          active:true, basin, stormId:storm.id, stormName:storm.name.toUpperCase(),
          advisoryNum:storm.adv, title:storm.title, mslp:mslp0,
          fetchedAt:new Date().toISOString(), allStorms:storms,
          coneCoords:trackData.coneCoords, trackCoords:trackData.trackCoords,
          forecastPts:trackData.forecastPts,
        });
      }
    } catch(e) { console.warn('[JTWC TCW]', e.message); }
  }

  for (const { url, parser } of fallbackUrls) {
    try {
      const r = await nodeFetch(url);
      if (!r.ok) continue;
      const trackData = parser(await r.text(), storm.advDTG);
      if (!trackData) continue;
      const mslp0 = resolveMslp(trackData);
      trackData.forecastPts[0] = { ...trackData.forecastPts[0], mslp: mslp0 };
      return res.status(200).json({
        active:true, basin, stormId:storm.id, stormName:storm.name.toUpperCase(),
        advisoryNum:storm.adv, title:storm.title, mslp:mslp0,
        fetchedAt:new Date().toISOString(), allStorms:storms,
        coneCoords:trackData.coneCoords, trackCoords:trackData.trackCoords,
        forecastPts:trackData.forecastPts,
      });
    } catch(e) { console.warn('[JTWC]', url, e.message); }
  }

  return noStorms('JTWC track data unavailable');
};
