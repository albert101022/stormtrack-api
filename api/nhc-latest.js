// StormTrack API v4 — NHC GIS RSS + JTWC ATCF
// Zero external dependencies — Node.js built-in only
// NHC: Atlántico, Pacífico Este, Pacífico Central
// JTWC: Pacífico Occidental, Índico Norte, Hemisferio Sur

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

function fetch(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'StormTrack/4.0 (emergency-management-research)' },
      rejectUnauthorized: false  // JTWC has SSL issues
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetch(res.headers.location, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

// ── NHC GIS RSS parser
function parseGisRSS(xml) {
  const result = { storms: [], forecastZips: {}, windFieldZips: {}, wwZips: {}, wspZips: {}, surgeZips: {} };
  const summaryRx = /<nhc:Cyclone>([\s\S]*?)<\/nhc:Cyclone>/g;
  let m;
  while ((m = summaryRx.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => (block.match(new RegExp(`<nhc:${tag}>(.*?)<\/nhc:${tag}>`)) || [])[1] || '';
    result.storms.push({
      atcf: get('atcf').toLowerCase(), name: get('name'), type: get('type'),
      center: get('center'), pressure: get('pressure'),
      movement: get('movement'), headline: get('headline').replace(/<[^>]+>/g,'').trim(),
      datetime: get('datetime'),
    });
  }
  const forecastRx = /<title>Advisory #(\d+) Forecast \[shp\][^<]*\(([^)]+)\)<\/title>[\s\S]*?<link>(.*?)<\/link>/g;
  while ((m = forecastRx.exec(xml)) !== null) {
    const advNum = m[1].padStart(3,'0'), atcf = m[2].split('/').pop().toLowerCase().trim(), url = m[3].trim();
    if (!result.forecastZips[atcf] || advNum > result.forecastZips[atcf].advNum)
      result.forecastZips[atcf] = { advNum, url };
  }
  // Wind Speed Probability shapefiles
  const wspRx = /<title>Advisory #(\d+)[^<]*Probabilities? \[shp\][^<]*\(([^)]+)\)<\/title>[\s\S]*?<link>(.*?)<\/link>/g;
  while ((m = wspRx.exec(xml)) !== null) {
    const advNum = m[1].padStart(3,'0'), atcf = m[2].split('/').pop().toLowerCase().trim(), url = m[3].trim();
    if (!result.wspZips[atcf] || advNum > result.wspZips[atcf].advNum)
      result.wspZips[atcf] = { advNum, url };
  }
  // Watch/Warning shapefiles
  const wwRx = /<title>Advisory #(\d+) Watches\/Warnings \[shp\][^<]*\(([^)]+)\)<\/title>[\s\S]*?<link>(.*?)<\/link>/g;
  while ((m = wwRx.exec(xml)) !== null) {
    const advNum = m[1].padStart(3,'0'), atcf = m[2].split('/').pop().toLowerCase().trim(), url = m[3].trim();
    if (!result.wwZips[atcf] || advNum > result.wwZips[atcf].advNum)
      result.wwZips[atcf] = { advNum, url };
  }
  // Storm Surge shapefiles
  const surgeRx = /<title>Advisory #(\d+)[^<]*(?:Surge|Storm Surge)[^<]*\[shp\][^<]*\(([^)]+)\)<\/title>[\s\S]*?<link>(.*?)<\/link>/g;
  while ((m = surgeRx.exec(xml)) !== null) {
    const advNum = m[1].padStart(3,'0'), atcf = m[2].split('/').pop().toLowerCase().trim(), url = m[3].trim();
    if (!result.surgeZips[atcf] || advNum > result.surgeZips[atcf].advNum)
      result.surgeZips[atcf] = { advNum, url };
  }
  return result;
}

// ── ZIP parser
function parseZip(buf) {
  const files = {}, view = new DataView(buf.buffer, buf.byteOffset);
  let offset = 0;
  while (offset + 30 < buf.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const method = view.getUint16(offset+8, true), compSize = view.getUint32(offset+18, true);
    const nameLen = view.getUint16(offset+26, true), extraLen = view.getUint16(offset+28, true);
    const name = String.fromCharCode(...buf.slice(offset+30, offset+30+nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const compData = buf.slice(dataStart, dataStart + compSize);
    if (method === 0) files[name] = compData;
    else if (method === 8) { try { files[name] = zlib.inflateRawSync(compData); } catch(e){} }
    offset = dataStart + compSize;
  }
  return files;
}

// ── SHP parsers
function parseShpPolygon(buf) {
  if (!buf || buf.length < 100) return [];
  const view = new DataView(buf.buffer, buf.byteOffset), coords = [];
  let offset = 100;
  while (offset + 12 < buf.length) {
    const contentLen = view.getInt32(offset+4, false)*2, shapeType = view.getInt32(offset+8, true);
    if (shapeType === 5 || shapeType === 15) {
      const numParts = view.getInt32(offset+44, true), numPoints = view.getInt32(offset+48, true);
      const ptsOff = offset + 52 + numParts*4;
      for (let i = 0; i < numPoints && ptsOff+i*16+8 <= buf.length; i++)
        coords.push([Math.round(view.getFloat64(ptsOff+i*16,true)*1e5)/1e5, Math.round(view.getFloat64(ptsOff+i*16+8,true)*1e5)/1e5]);
      break;
    }
    offset += 8 + contentLen; if (contentLen <= 0) break;
  }
  return coords;
}

function parseShpPolyline(buf) {
  if (!buf || buf.length < 100) return [];
  const view = new DataView(buf.buffer, buf.byteOffset), coords = [];
  let offset = 100;
  while (offset + 12 < buf.length) {
    const contentLen = view.getInt32(offset+4, false)*2, shapeType = view.getInt32(offset+8, true);
    if (shapeType === 3 || shapeType === 13) {
      const numParts = view.getInt32(offset+44, true), numPoints = view.getInt32(offset+48, true);
      const ptsOff = offset + 52 + numParts*4;
      for (let i = 0; i < numPoints && ptsOff+i*16+8 <= buf.length; i++)
        coords.push([Math.round(view.getFloat64(ptsOff+i*16,true)*1e5)/1e5, Math.round(view.getFloat64(ptsOff+i*16+8,true)*1e5)/1e5]);
      break;
    }
    offset += 8 + contentLen; if (contentLen <= 0) break;
  }
  return coords;
}

function parseShpPoints(buf) {
  if (!buf || buf.length < 100) return [];
  const view = new DataView(buf.buffer, buf.byteOffset), pts = [];
  let offset = 100;
  while (offset + 28 <= buf.length) {
    const contentLen = view.getInt32(offset+4, false)*2;
    if (view.getInt32(offset+8, true) === 1)
      pts.push([Math.round(view.getFloat64(offset+12,true)*1e5)/1e5, Math.round(view.getFloat64(offset+20,true)*1e5)/1e5]);
    offset += 8 + contentLen; if (contentLen <= 0) break;
  }
  return pts;
}

function parseDbf(buf) {
  if (!buf || buf.length < 32) return [];
  const view = new DataView(buf.buffer, buf.byteOffset);
  const numRecs = view.getInt32(4,true), hdrSize = view.getInt16(8,true), recSize = view.getInt16(10,true);
  const fields = [];
  let fi = 32;
  while (fi < hdrSize-1 && buf[fi] !== 0x0D) {
    fields.push({ name: String.fromCharCode(...buf.slice(fi,fi+11)).replace(/\0/g,'').trim(), type: String.fromCharCode(buf[fi+11]), len: buf[fi+16] });
    fi += 32;
  }
  const records = [];
  for (let r = 0; r < numRecs; r++) {
    let pos = hdrSize + r*recSize + 1; const rec = {};
    for (const f of fields) { const raw = String.fromCharCode(...buf.slice(pos,pos+f.len)).trim(); rec[f.name] = f.type==='N'?(parseFloat(raw)||0):raw; pos+=f.len; }
    records.push(rec);
  }
  return records;
}

// Parses ALL polyline records (one per watch/warning segment) + pairs with DBF
function parseWatchWarning(zipBuf) {
  const files = parseZip(zipBuf);
  const shpKey = Object.keys(files).find(k => /ww.*\.shp$/i.test(k));
  const dbfKey = Object.keys(files).find(k => /ww.*\.dbf$/i.test(k));
  if (!shpKey) return null;

  const buf = files[shpKey];
  if (!buf || buf.length < 100) return null;
  const view = new DataView(buf.buffer, buf.byteOffset);
  const dbfRecs = dbfKey ? parseDbf(files[dbfKey]) : [];
  const features = [];
  let offset = 100, recIdx = 0;

  while (offset + 12 < buf.length) {
    const contentLen = view.getInt32(offset + 4, false) * 2;
    const shapeType  = view.getInt32(offset + 8, true);
    if (shapeType === 3 || shapeType === 13) {
      const numParts  = view.getInt32(offset + 44, true);
      const numPoints = view.getInt32(offset + 48, true);
      const partsOff  = offset + 52;
      const ptsOff    = partsOff + numParts * 4;
      const parts = [];
      for (let p = 0; p < numParts; p++) parts.push(view.getInt32(partsOff + p * 4, true));
      const allPts = [];
      for (let i = 0; i < numPoints && ptsOff + i*16 + 8 <= buf.length; i++)
        allPts.push([
          Math.round(view.getFloat64(ptsOff + i*16,     true) * 1e5) / 1e5,
          Math.round(view.getFloat64(ptsOff + i*16 + 8, true) * 1e5) / 1e5
        ]);
      const attrs = dbfRecs[recIdx] || {};
      const tcww  = (attrs.TCWW || attrs.WARNTYPE || attrs.WW || '').trim();
      // Each part becomes a separate feature (same attributes)
      for (let p = 0; p < parts.length; p++) {
        const start = parts[p], end = p + 1 < parts.length ? parts[p + 1] : allPts.length;
        const coords = allPts.slice(start, end);
        if (coords.length >= 2)
          features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:coords }, properties:{ tcww } });
      }
    }
    recIdx++;
    offset += 8 + contentLen;
    if (contentLen <= 0) break;
  }
  return features.length ? { type:'FeatureCollection', features } : null;
}

// Parses ALL polygon records (multi-record SHP — one per probability contour)
function parseShpPolygonRecords(buf) {
  if (!buf || buf.length < 100) return [];
  const view = new DataView(buf.buffer, buf.byteOffset);
  const records = []; let offset = 100;
  while (offset + 12 < buf.length) {
    const contentLen = view.getInt32(offset + 4, false) * 2;
    const shapeType  = view.getInt32(offset + 8, true);
    if (shapeType === 5 || shapeType === 15) {
      const numParts  = view.getInt32(offset + 44, true);
      const numPoints = view.getInt32(offset + 48, true);
      const partsOff  = offset + 52, ptsOff = partsOff + numParts * 4;
      const parts = [];
      for (let p = 0; p < numParts; p++) parts.push(view.getInt32(partsOff + p*4, true));
      const allPts = [];
      for (let i = 0; i < numPoints && ptsOff + i*16 + 8 <= buf.length; i++)
        allPts.push([Math.round(view.getFloat64(ptsOff+i*16,true)*1e5)/1e5, Math.round(view.getFloat64(ptsOff+i*16+8,true)*1e5)/1e5]);
      const rings = [];
      for (let p = 0; p < parts.length; p++) {
        const start = parts[p], end = p+1 < parts.length ? parts[p+1] : allPts.length;
        rings.push(allPts.slice(start, end));
      }
      records.push(rings);
    } else { records.push(null); }
    offset += 8 + contentLen; if (contentLen <= 0) break;
  }
  return records;
}

function parseWindProbability(zipBuf) {
  const files = parseZip(zipBuf);
  const shpKeys = Object.keys(files).filter(k => k.endsWith('.shp'));
  const features = [];
  for (const shpKey of shpKeys) {
    const dbfKey   = shpKey.replace(/\.shp$/i, '.dbf');
    const records  = parseShpPolygonRecords(files[shpKey]);
    const dbfRecs  = files[dbfKey] ? parseDbf(files[dbfKey]) : [];
    if (dbfRecs[0]) console.log('[WSP] DBF fields in', shpKey, ':', Object.keys(dbfRecs[0]).join(','));
    // Detect wind threshold from filename (e.g. _34.shp, _50.shp, _64.shp) or DBF
    const ktMatch  = shpKey.match(/_(\d{2})(?:kts?)?\.shp$/i);
    const fileKt   = ktMatch ? parseInt(ktMatch[1]) : 0;
    records.forEach((rings, i) => {
      if (!rings?.length) return;
      const attrs   = dbfRecs[i] || {};
      const percent = +(attrs.PERCENT || attrs.PROB || attrs.CUMPROB || attrs.WSPD_PROB || 0);
      const kt      = +(attrs.WINDSPEED || attrs.WIND || attrs.KT || fileKt || 34);
      if (!percent && !kt) return;
      features.push({
        type: 'Feature',
        geometry: rings.length === 1
          ? { type:'Polygon',      coordinates: rings }
          : { type:'MultiPolygon', coordinates: rings.map(r => [r]) },
        properties: { percent, kt, ...attrs }
      });
    });
  }
  console.log('[WSP] Total features:', features.length);
  return features.length ? { type:'FeatureCollection', features } : null;
}

function parseSurgePolygons(zipBuf) {
  const files = parseZip(zipBuf);
  const shpKey = Object.keys(files).find(k => k.endsWith('.shp'));
  const dbfKey = shpKey ? shpKey.replace(/\.shp$/i, '.dbf') : null;
  if (!shpKey) return null;

  const records = parseShpPolygonRecords(files[shpKey]);
  const dbfRecs = dbfKey && files[dbfKey] ? parseDbf(files[dbfKey]) : [];
  if (dbfRecs[0]) console.log('[Surge] DBF fields:', Object.keys(dbfRecs[0]).join(','));

  const features = [];
  records.forEach((rings, i) => {
    if (!rings?.length) return;
    const attrs = dbfRecs[i] || {};
    // NHC surge product uses GRIDCODE for surge height in feet
    const ft = +(attrs.GRIDCODE || attrs.SURGE_FT || attrs.FEET || attrs.FT || attrs.HEIGHT || 0);
    features.push({
      type: 'Feature',
      geometry: rings.length === 1
        ? { type:'Polygon',      coordinates: rings }
        : { type:'MultiPolygon', coordinates: rings.map(r => [r]) },
      properties: { ft, ...attrs }
    });
  });

  console.log('[Surge] Total features:', features.length);
  return features.length ? { type:'FeatureCollection', features } : null;
}

function parseWindField(zipFiles) {
  const fileNames = Object.keys(zipFiles), NMI_KM = 1.852;
  const result = { r34:[0,0,0,0], r50:[0,0,0,0], r64:[0,0,0,0], official:false, byTau:{} };

  // Find DBF — could be named forecastradii.dbf, al152017_fcst_015.dbf, etc.
  const fcstDbf = fileNames.find(f => /forecastradii.*\.dbf$/i.test(f))
                || fileNames.find(f => /fcst.*\.dbf$/i.test(f))
                || fileNames.find(f => f.toLowerCase().endsWith('.dbf') && !f.includes('__MACOSX'));


  if (fcstDbf && zipFiles[fcstDbf]) {
    const recs = parseDbf(zipFiles[fcstDbf]);

    for (const rec of recs) {
      const tau  = Number(rec.TAU  ?? rec.tau  ?? rec.ADVNUM ?? rec.FcstHour ?? 0);
      const rNum = Number(rec.RADII ?? rec.radii ?? rec.WINDSPEED ?? rec.WindSpd ?? rec.RAD ?? 0);
      if (![34,50,64].includes(rNum)) continue;
      if (!result.byTau[tau]) result.byTau[tau] = {r34:[0,0,0,0],r50:[0,0,0,0],r64:[0,0,0,0]};
      const ne = rec.NE ?? rec.ne ?? 0;
      const fac = ne > 0 && ne < 500 ? NMI_KM : 1;
      result.byTau[tau][`r${rNum}`] = [
        Math.round((rec.NE||rec.ne||0)*fac), Math.round((rec.SE||rec.se||0)*fac),
        Math.round((rec.SW||rec.sw||0)*fac), Math.round((rec.NW||rec.nw||0)*fac)
      ];
      result.official = true;
    }
    if (result.byTau[0]) { result.r34=result.byTau[0].r34; result.r50=result.byTau[0].r50; result.r64=result.byTau[0].r64; }
  }
  return result;
}
// ── JTWC ATCF parser
// ATCF format: BASIN,CY,YYYYMMDDHH,TECHNUM,TECH,TAU,LatN/S,LonE/W,VMAX,MSLP,TY,RAD,WINDCODE,RAD1,RAD2,RAD3,RAD4,...
function parseATCF(text, stormId) {
  const lines = text.split('\n').filter(l => l.trim());
  const forecasts = {}, bestTrack = [];
  const NMI_KM = 1.852;

  for (const line of lines) {
    const f = line.split(',').map(s => s.trim());
    if (f.length < 11) continue;
    const basin = f[0], cy = f[1].padStart(2,'0'), dtg = f[2];
    const tech = f[4], tau = parseInt(f[5])||0;
    const latRaw = f[6], lonRaw = f[7];
    const vmax = parseInt(f[8])||0, mslp = parseInt(f[9])||0;
    const ty = f[10], rad = parseInt(f[11])||0;

    // Parse lat/lon
    const lat = parseFloat(latRaw) / 10 * (latRaw.endsWith('S') ? -1 : 1);
    const lon = parseFloat(lonRaw) / 10 * (lonRaw.endsWith('W') ? -1 : 1);

    if (tech === 'OFCL' || tech === 'WRNG') {
      // Official JTWC forecast
      const key = `${dtg}_${tau}`;
      if (!forecasts[key]) {
        forecasts[key] = { tau, lat, lon, wind: vmax, mslp, dtg,
          r34:[0,0,0,0], r50:[0,0,0,0], r64:[0,0,0,0] };
      }
      // Add wind radii
      if ([34,50,64].includes(rad) && f.length >= 16) {
        const r1=Math.round((parseInt(f[13])||0)*NMI_KM);
        const r2=Math.round((parseInt(f[14])||0)*NMI_KM);
        const r3=Math.round((parseInt(f[15])||0)*NMI_KM);
        const r4=f[16]?Math.round((parseInt(f[16])||0)*NMI_KM):r1;
        forecasts[key][`r${rad}`] = [r1,r2,r3,r4];
      }
    }
  }

  // Get most recent forecast cycle
  const dtgs = [...new Set(Object.keys(forecasts).map(k => k.split('_')[0]))].sort();
  const latestDtg = dtgs[dtgs.length-1] || '';
  const fcastPts = Object.entries(forecasts)
    .filter(([k]) => k.startsWith(latestDtg))
    .map(([,v]) => v)
    .sort((a,b) => a.tau - b.tau);

  if (fcastPts.length === 0) return null;

  // Determine storm type and category from VMAX
  const initPt = fcastPts[0];
  const vmax0 = initPt.wind;
  const ssnum = vmax0>=137?5:vmax0>=113?4:vmax0>=96?3:vmax0>=83?2:vmax0>=64?1:0;
  const dvlbl = ssnum>=3?'T':ssnum>=1?'H':vmax0>=34?'S':'D'; // T=Typhoon, H=Hurricane, S=Storm

  // Build cone (estimated — JTWC doesn't publish shapefiles)
  const coneCoords = buildEstimatedCone(fcastPts);
  const trackCoords = fcastPts.map(p => [p.lon, p.lat]);

  // Parse DTG to readable date
  const yr=latestDtg.slice(0,4), mo=latestDtg.slice(4,6), dy=latestDtg.slice(6,8), hr=latestDtg.slice(8,10);
  const dtLabel = `${yr}-${mo}-${dy} ${hr}:00 UTC`;

  return {
    stormId: `${basin.toLowerCase()}${cy}${yr}`,
    basin: basin.toLowerCase(),
    dtg: latestDtg,
    advisoryDate: dtLabel,
    forecastPts: fcastPts.map((p,i) => ({
      lon: p.lon, lat: p.lat, tau: p.tau,
      wind: p.wind, mslp: p.mslp, gust: Math.round(p.wind*1.2),
      ssnum: p.wind>=137?5:p.wind>=113?4:p.wind>=96?3:p.wind>=83?2:p.wind>=64?1:0,
      dvlbl: i===0 ? dvlbl : (p.wind>=130?'T':p.wind>=64?'H':p.wind>=34?'S':'D'),
      datelbl: `TAU +${p.tau}h`,
      tcdvlp: p.wind>=130?'Typhoon':p.wind>=64?'Tropical Storm':'Tropical Depression',
      r34: p.r34, r50: p.r50, r64: p.r64,
    })),
    coneCoords,
    trackCoords,
    officialRadii: { r34:initPt.r34, r50:initPt.r50, r64:initPt.r64, official:true,
      byTau: Object.fromEntries(fcastPts.map(p=>[p.tau,{r34:p.r34,r50:p.r50,r64:p.r64}])) },
    officialRadiiAvailable: true,
  };
}

// Build estimated cone for JTWC (NHC-style error radii)
function buildEstimatedCone(fcastPts) {
  const ERROR_KM = {0:0, 12:50, 24:85, 36:120, 48:155, 72:225, 96:300, 120:375};

  function dest(lat, lon, bearDeg, km) {
    const R=6371, d=km/R, b=bearDeg*Math.PI/180;
    const la1=lat*Math.PI/180, lo1=lon*Math.PI/180;
    const la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(b));
    const lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la1),Math.cos(d)-Math.sin(la1)*Math.sin(la2));
    return [lo2*180/Math.PI, la2*180/Math.PI];
  }
  function bearing(p1, p2) {
    const dL=(p2.lon-p1.lon)*Math.PI/180;
    const la1=p1.lat*Math.PI/180, la2=p2.lat*Math.PI/180;
    return Math.atan2(Math.sin(dL)*Math.cos(la2), Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dL))*180/Math.PI;
  }
  function getR(tau) {
    const ks=Object.keys(ERROR_KM).map(Number).sort((a,b)=>a-b);
    for(let i=0;i<ks.length-1;i++){
      if(tau>=ks[i]&&tau<=ks[i+1]){
        const f=(tau-ks[i])/(ks[i+1]-ks[i]);
        return ERROR_KM[ks[i]]+(ERROR_KM[ks[i+1]]-ERROR_KM[ks[i]])*f;
      }
    }
    return ERROR_KM[120];
  }
  if (fcastPts.length < 2) return [];
  const right=[], left=[];
  for(let i=0;i<fcastPts.length;i++){
    const pt=fcastPts[i], r=getR(pt.tau);
    const b=i<fcastPts.length-1?bearing(pt,fcastPts[i+1]):bearing(fcastPts[i-1],pt);
    right.push(dest(pt.lat,pt.lon,b+90,Math.max(r,1)));
    left.push( dest(pt.lat,pt.lon,b-90,Math.max(r,1)));
  }
  // Cap: arc from +90 to -90 going forward (0°) — fixes the cutoff bug
  const last=fcastPts[fcastPts.length-1], rLast=getR(last.tau);
  const bLast=bearing(fcastPts[fcastPts.length-2],last);
  const cap=[];
  for(let a=90;a>=-90;a-=6) cap.push(dest(last.lat,last.lon,bLast+a,Math.max(rLast,1)));
  return [...right,...cap,...[...left].reverse(),right[0]];
}
// ── JMA RSMC Tokyo — W.Pacific official source
async function getJMAStorms() {
  const listUrl = 'https://www.jma.go.jp/bosai/information/data/typhoon.json';
  const listRes = await fetch(listUrl);
  if (listRes.status !== 200) throw new Error(`JMA list HTTP ${listRes.status}`);

  const items = JSON.parse(listRes.data.toString('utf8'));
  if (!items || items.length === 0) return [];

  // Get most recent advisory per eventId
  const eventMap = {};
  for (const item of items) {
    const id = item.eventId;
    if (!id) continue;
    if (!eventMap[id] || Number(item.serial) > Number(eventMap[id].serial))
      eventMap[id] = item;
  }
  const eventIds = Object.keys(eventMap);
  console.log('[JMA] Active eventIds:', eventIds.join(', '));

  const storms = [];
  for (const eventId of eventIds) {
    try {
      const specUrl = `https://www.jma.go.jp/bosai/typhoon/data/${eventId}/specifications.json`;
      const specRes = await fetch(specUrl);
      if (specRes.status !== 200) { console.warn(`[JMA] specs HTTP ${specRes.status} for ${eventId}`); continue; }
      const spec = JSON.parse(specRes.data.toString('utf8'));
      const storm = parseJMASpec(spec, eventId, eventMap[eventId]);
      if (storm) storms.push(storm);
    } catch(e) { console.warn(`[JMA] Error parsing ${eventId}:`, e.message); }
  }
  return storms;
}

function parseJMASpec(spec, eventId, meta) {
  if (!Array.isArray(spec) || spec.length < 2) return null;
  const NMI_KM = 1.852;
  const forecastPts = [], byTau = {};
  const titleBlock = spec[0];
  const stormNameEn = titleBlock?.name?.en || `TC${eventId}`;

  for (let i = 1; i < spec.length; i++) {
    const step = spec[i];
    if (!step?.position?.deg) continue;
    const lat  = parseFloat(step.position.deg[0]) || 0;
    const lon  = parseFloat(step.position.deg[1]) || 0;
    const tau  = parseInt(step.advancedHours) || 0;
    const mslp = parseInt(step.pressure) || 0;
    const windKt = parseInt(step.maximumWind?.sustained?.kt) || 0;
    const r34 = parseJMARadii(step.galeWarning);
    const r50 = parseJMARadii(step.stormWarning);
    const r64 = [0,0,0,0];
    forecastPts.push({
      lon, lat, tau, wind: windKt, mslp,
      gust: parseInt(step.maximumWind?.gust?.kt) || Math.round(windKt*1.2),
      ssnum: windKt>=137?5:windKt>=113?4:windKt>=96?3:windKt>=83?2:windKt>=64?1:0,
      dvlbl: windKt>=130?'T':windKt>=64?'H':windKt>=34?'S':'D',
      datelbl: tau===0?'Posición actual':`+${tau}h`,
      tcdvlp: windKt>=130?'Tifón':windKt>=64?'Tifón':windKt>=34?'Tormenta tropical':'Depresión tropical',
      r34, r50, r64,
    });
    byTau[String(tau)] = { r34, r50, r64 };
  }
  if (forecastPts.length === 0) return null;
  forecastPts.sort((a,b) => a.tau - b.tau);

  // Forward-fill radii — JMA only publishes radii for TAU=0 (current position)
  // Future TAUs inherit TAU=0 radii (official, not estimated)
  const initR34 = byTau['0']?.r34 || [0,0,0,0];
  const initR50 = byTau['0']?.r50 || [0,0,0,0];
  for (const pt of forecastPts) {
    if (pt.tau > 0) {
      if (Math.max(...pt.r34) < 1) pt.r34 = initR34.slice();
      if (Math.max(...pt.r50) < 1) pt.r50 = initR50.slice();
      byTau[String(pt.tau)] = { r34: pt.r34, r50: pt.r50, r64: pt.r64 };
    }
  }

  const rawDt = spec[1]?.validtime?.UTC || meta?.targetDatetime || '';
  const advisoryDate = rawDt ? new Date(rawDt).toISOString() : new Date().toISOString();

  // Derive ATCF ID from JMA eventId for spaghetti feed
  // JMA format: TC2605 → wp052026 (wp + 2-digit-num + 4-digit-year)
  let atcfId = null;
  const jmaIdM = eventId.match(/^TC(\d{2})(\d{2})$/i);
  if (jmaIdM) {
    const yearFull = `20${jmaIdM[1]}`;
    const num = jmaIdM[2];
    atcfId = `wp${num}${yearFull}`;
  }

  return {
    stormId: eventId, stormName: stormNameEn.toUpperCase(),
    atcfId,  // e.g. "wp052026" — for spaghetti ATCF feed
    advisoryDate, advisoryNum: meta?.serial || '—',
    forecastPts,
    coneCoords: buildEstimatedCone(forecastPts),
    trackCoords: forecastPts.map(p => [p.lon, p.lat]),
    officialRadii: { ...(byTau['0'] || {r34:[0,0,0,0],r50:[0,0,0,0],r64:[0,0,0,0]}), official:true, byTau },
    officialRadiiAvailable: true,
    officialRadiiByTau: byTau,
    dataSource: 'JMA RSMC Tokyo',
  };
}

function parseJMARadii(warningObj) {
  if (!warningObj) return [0,0,0,0];
  const entries = Array.isArray(warningObj) ? warningObj : [warningObj];
  let ne=0, se=0, sw=0, nw=0;
  for (const entry of entries) {
    const km = parseFloat(entry?.range?.km) || 0;
    if (km === 0) continue;
    const area = entry?.area || '全域';
    if (area==='全域'||area==='ALL') { ne=se=sw=nw=km; break; }
    if (area==='北'||area==='N')  { ne=km; nw=km; }
    else if (area==='南'||area==='S')  { se=km; sw=km; }
    else if (area==='東'||area==='E')  { ne=km; se=km; }
    else if (area==='西'||area==='W')  { sw=km; nw=km; }
    else if (area==='北東'||area==='NE') ne=km;
    else if (area==='南東'||area==='SE') se=km;
    else if (area==='南西'||area==='SW') sw=km;
    else if (area==='北西'||area==='NW') nw=km;
    else { ne=se=sw=nw=km; }
  }
  return [ne, se, sw, nw];
}

// Get active storms by basin
async function getJTWCStorms(basin) {
  // Western Pacific: use JMA RSMC Tokyo (official WMO RSMC for WPAC)
  if (basin === 'wp') {
    console.log('[JMA] Fetching W.Pacific storms from RSMC Tokyo...');
    return await getJMAStorms();
  }

  // Indian Ocean / S.Hemisphere: use GDACS
  console.log(`[GDACS] Fetching ${basin} storms...`);
  const gdacsUrl = 'https://www.gdacs.org/xml/rss_TC.xml';
  const res = await fetch(gdacsUrl);
  if (res.status !== 200) throw new Error(`GDACS HTTP ${res.status}`);
  const xml = res.data.toString('utf8');
  const basinBounds = {
    io: { lonMin:40, lonMax:100, latMin:-30, latMax:30 },
    sh: { lonMin:40, lonMax:180, latMin:-50, latMax:0 },
  };
  const bounds = basinBounds[basin];
  const storms = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const item = m[1];
    const getTag = tag => (item.match(new RegExp('<'+tag+'[^>]*>([^<]*)</'+tag+'>')) || [])[1] || '';
    const title = getTag('title');
    if (!title || !/cyclone|typhoon|hurricane|storm/i.test(title)) continue;
    const lat = parseFloat(getTag('geo:lat')) || 0;
    const lon = parseFloat(getTag('geo:long')||getTag('geo:lon')) || 0;
    if (!lat && !lon) continue;
    if (bounds && (lon<bounds.lonMin||lon>bounds.lonMax||lat<bounds.latMin||lat>bounds.latMax)) continue;
    const windKt = parseFloat((getTag('gdacs:severity')||'').match(/[\d.]+/)?.[0]||0);
    const name = (title.match(/(?:CYCLONE|TYPHOON|STORM)\s+(\S+)/i)||[])[1]||'TC';
    const forecastPts = [{lon,lat,tau:0,wind:windKt,mslp:0,gust:Math.round(windKt*1.2),
      ssnum:windKt>=137?5:windKt>=113?4:windKt>=96?3:windKt>=83?2:windKt>=64?1:0,
      dvlbl:windKt>=64?'H':windKt>=34?'S':'D',
      datelbl:'Posición actual',tcdvlp:windKt>=64?'Ciclón tropical':'Tormenta tropical',
      r34:[0,0,0,0],r50:[0,0,0,0],r64:[0,0,0,0]}];
    storms.push({
      stormId:`gdacs-${name}`,stormName:name.toUpperCase(),
      advisoryDate:new Date().toISOString(),advisoryNum:'—',
      forecastPts,coneCoords:buildEstimatedCone(forecastPts),
      trackCoords:[[lon,lat]],
      officialRadii:null,officialRadiiAvailable:false,officialRadiiByTau:{},
      dataSource:'GDACS',
    });
  }
  return storms;
}

// ── Tropical Weather Outlook — invest positions + formation probability
async function getInvests(basin) {
  const basinKey = basin.slice(0,2).toLowerCase();
  const urls = {
    al: 'https://www.nhc.noaa.gov/text/TWDAT.shtml',
    ep: 'https://www.nhc.noaa.gov/text/TWOEP.shtml',
    cp: 'https://www.nhc.noaa.gov/text/TWOCP.shtml',
  };
  const url = urls[basinKey] || urls.al;
  try {
    const res = await fetch(url);
    if (res.status !== 200) { console.warn('[TWO] HTTP', res.status); return []; }
    const html = res.data.toString('utf8');
    const invests = parseTWO(html);
    console.log('[TWO] Disturbances found:', invests.length);
    return invests;
  } catch(e) { console.warn('[TWO] Error:', e.message); return []; }
}

function parseTWO(html) {
  // Strip HTML tags, decode entities
  let text = html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
                 .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ');

  const invests = [];
  // Split on numbered disturbance entries
  const blocks = text.split(/(?=\d+\.\s+(?:DISTURBANCE|REMNANTS|AREA\s+OF\s+LOW|TROPICAL))/i);

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Position: "LOCATED NEAR 14.5N 38.0W" or "NEAR 14.5N 38.0W"
    const posM = block.match(/(?:LOCATED\s+)?NEAR\s+([\d.]+)\s*([NS])\s+([\d.]+)\s*([EW])/i);
    if (!posM) continue;
    const lat = parseFloat(posM[1]) * (posM[2].toUpperCase()==='S' ? -1 : 1);
    const lon = parseFloat(posM[3]) * (posM[4].toUpperCase()==='W' ? -1 : 1);

    // 48-hour / 2-day formation chance
    const p2m = block.match(/(?:48\s*HOUR|2[\s-]DAY)[^.]*?(LOW|MEDIUM|HIGH)[^.]*?(\d+)\s*PERCENT/i)
             || block.match(/(?:48\s*HOUR|2[\s-]DAY)[^.]*?(\d+)\s*PERCENT/i);
    // 7-day formation chance
    const p7m = block.match(/7[\s-]DAY[^.]*?(LOW|MEDIUM|HIGH)[^.]*?(\d+)\s*PERCENT/i)
             || block.match(/7[\s-]DAY[^.]*?(\d+)\s*PERCENT/i);

    const prob2d  = p2m ? parseInt(p2m[2] ?? p2m[1]) || 0 : null;
    const prob7d  = p7m ? parseInt(p7m[2] ?? p7m[1]) || 0 : null;
    const level2d = p2m?.[1]?.toUpperCase() || null;
    const level7d = p7m?.[1]?.toUpperCase() || null;

    // Invest ID if mentioned (e.g., "INVEST 91L", "97L")
    const idM = block.match(/(?:INVEST\s+)?(\d{2}[A-Z])/i);
    const id  = idM ? idM[1].toUpperCase() : null;

    // Short description (first sentence up to 80 chars)
    const desc = block.replace(/^\d+\.\s*/,'').split(/\.\s/)[0].trim().slice(0,100);

    invests.push({ lat, lon, prob2d, prob7d, level2d, level7d, id, desc });
  }
  return invests;
}

// ── Reconnaissance fixes from ATCF adeck (tau=0 non-model entries = observed fixes)
async function getReconFixes(stormId) {
  const MODEL_SKIP = new Set([
    'BEST','OFCL','OFCP','WRNG','XTRP','LBAR','CLPB','SHIP','SHF5','SHFR','DSHP','LGEM',
    'GUNS','GUNA','GUNX','GFS','GFSI','GFEX','EMXI','EMXE','EGRI','NVGM','HWFI','HWFE',
    'HWRF','HMON','HMNI','CTCX','CTC2','UKM','EGRR','UKMET','CMC','CMCI','JGSM','JGSI',
    'AEMI','AFAI','NAM','NAMI','NGX','ICON','DRCL',
  ]);
  // Try adeck (all obs+models) first, fall back to aid_public (CARQ only)
  const urls = [
    { url:`https://ftp.nhc.noaa.gov/atcf/adeck/${stormId}.dat`, adeck:true },
    { url:`https://ftp.nhc.noaa.gov/atcf/aid_public/${stormId}.dat`, adeck:false },
  ];
  for (const { url, adeck } of urls) {
    try {
      const res = await fetch(url);
      if (res.status !== 200) continue;
      const text = res.data.toString('utf8');
      const fixes = [];
      const seen  = new Set();
      for (const line of text.split('\n')) {
        const f = line.split(',').map(s => s.trim());
        if (f.length < 10) continue;
        const tech = f[4]; if (!tech) continue;
        if (adeck && MODEL_SKIP.has(tech)) continue;
        if (!adeck && tech !== 'CARQ') continue; // aid_public: only CARQ (official fix)
        const tau = parseInt(f[5]) || 0; if (tau > 0) continue;
        const dtg = f[2];
        const latR=f[6], lonR=f[7]; if (!latR||!lonR) continue;
        const lat = parseFloat(latR)/10 * (latR.endsWith('S')?-1:1);
        const lon = parseFloat(lonR)/10 * (lonR.endsWith('W')?-1:1);
        if (!lat&&!lon) continue;
        const wind=parseInt(f[8])||0, mslp=parseInt(f[9])||0;
        const key=`${tech}_${dtg}`; if (seen.has(key)) continue; seen.add(key);
        const yr=dtg.slice(0,4),mo=dtg.slice(4,6),dy=dtg.slice(6,8),hr=dtg.slice(8,10)||'00';
        fixes.push({ tech, lat, lon, wind, mslp, dtg, datetime:`${yr}-${mo}-${dy}T${hr}:00:00Z` });
      }
      if (fixes.length) {
        console.log('[Recon] Found', fixes.length, 'fixes from', adeck?'adeck':'aid_public (CARQ)');
        return fixes.sort((a,b) => b.dtg.localeCompare(a.dtg));
      }
    } catch(e) { console.warn('[Recon]', e.message); }
  }
  return [];
}

// ── Best track (observed positions) from NHC ATCF btk file
async function getBestTrack(stormId) {
  // Current season: /atcf/btk/  — Historical: /atcf/archive/YYYY/
  const year = stormId.slice(-4);
  const currentYear = new Date().getUTCFullYear().toString();
  const urls = year === currentYear
    ? [ `https://ftp.nhc.noaa.gov/atcf/btk/b${stormId}.dat` ]
    : [
        `https://ftp.nhc.noaa.gov/atcf/archive/${year}/b${stormId}.dat.gz`,
        `https://ftp.nhc.noaa.gov/atcf/archive/${year}/b${stormId}.dat`,
      ];

  function parseLines(text) {
    const seen = new Set(), pts = [];
    for (const line of text.split('\n')) {
      const f = line.split(',').map(s => s.trim());
      if (f.length < 11 || f[4] !== 'BEST') continue;
      const dtg = f[2]; if (seen.has(dtg)) continue; seen.add(dtg);
      const latR = f[6], lonR = f[7]; if (!latR || !lonR) continue;
      const lat = parseFloat(latR) / 10 * (latR.endsWith('S') ? -1 : 1);
      const lon = parseFloat(lonR) / 10 * (lonR.endsWith('W') ? -1 : 1);
      if (!lat && !lon) continue;
      const wind = parseInt(f[8]) || 0, mslp = parseInt(f[9]) || 0;
      const type = (f[10] || '').trim();
      const yr = dtg.slice(0,4), mo = dtg.slice(4,6), dy = dtg.slice(6,8), hr = dtg.slice(8,10);
      pts.push({ lat, lon, wind, mslp, type, dtg, datetime: `${yr}-${mo}-${dy}T${hr}:00:00Z` });
    }
    return pts;
  }

  for (const url of urls) {
    try {
      console.log('[BTK] Fetching:', url);
      const res = await fetch(url);
      if (res.status !== 200) { console.warn('[BTK] HTTP', res.status, url); continue; }
      const text = url.endsWith('.gz')
        ? zlib.gunzipSync(res.data).toString('utf8')
        : res.data.toString('utf8');
      const pts = parseLines(text);
      console.log('[BTK] Points:', pts.length, 'from', url);
      if (pts.length > 0) return pts;
    } catch(e) { console.warn('[BTK] Error:', url, e.message); }
  }
  return null;
}

// ── Main handler
// ── ARCHIVE: load a specific NHC historical advisory
// stormId = 'al152017', advNum = '015'
async function loadArchiveAdvisory(stormId, advNum) {
  const base    = `https://www.nhc.noaa.gov/gis/forecast/archive`;
  const padded  = advNum.padStart(3, '0');
  const coneUrl = `${base}/${stormId}_5day_${padded}.zip`;
  const radiiUrl= `${base}/${stormId}_fcst_${padded}.zip`;

  // Download cone ZIP
  const coneRes = await fetch(coneUrl);
  if (coneRes.status !== 200) throw new Error(`Cone ZIP HTTP ${coneRes.status} — advisory #${padded} may not exist`);
  const coneFiles = parseZip(coneRes.data);
  const fcastNames = Object.keys(coneFiles);

  const pgnShp = fcastNames.find(f => /pgn.*\.shp$/i.test(f));
  const linShp = fcastNames.find(f => /lin.*\.shp$/i.test(f));
  const ptsShp = fcastNames.find(f => /pts.*\.shp$/i.test(f));
  const ptsDbf = fcastNames.find(f => /pts.*\.dbf$/i.test(f));
  if (!pgnShp) throw new Error(`pgn.shp not found in ${coneUrl}`);

  const coneCoords  = parseShpPolygon(coneFiles[pgnShp]);
  const trackCoords = linShp ? parseShpPolyline(coneFiles[linShp]) : [];
  const ptCoords    = ptsShp ? parseShpPoints(coneFiles[ptsShp])   : [];
  const ptAttribs   = ptsDbf ? parseDbf(coneFiles[ptsDbf])         : [];

  const forecastPts = ptCoords.map((coord, i) => {
    const a = ptAttribs[i] || {};
    return {
      lon: coord[0], lat: coord[1],
      tau:    a.TAU     || 0,
      wind:   a.MAXWIND || 0,
      gust:   a.GUST    || 0,
      mslp:   a.MSLP !== 9999 ? (a.MSLP || 0) : 0,
      ssnum:  a.SSNUM   || 0,
      dvlbl:  a.DVLBL   || '',
      datelbl:a.DATELBL || '',
      tcdvlp: a.TCDVLP  || '',
    };
  });

  // Download wind radii ZIP
  let officialRadii = null;
  try {
    let radiiRes = await fetch(radiiUrl);
    if (radiiRes.status === 404) radiiRes = await fetch(radiiUrl.replace(/(_fcst_\d+)(\.zip)$/i,'$1A$2'));
    if (radiiRes.status === 200) {
      officialRadii = parseWindField(parseZip(radiiRes.data));
    }
  } catch(e) { console.warn('[Archive] Radii error:', e.message); }

  // Watch/Warning shapefile for this advisory
  let watchWarning = null;
  try {
    const wwUrl = `${base}/${stormId}_ww_${padded}.zip`;
    const wwRes = await fetch(wwUrl);
    if (wwRes.status === 200) {
      watchWarning = parseWatchWarning(wwRes.data);
      console.log('[Archive] Watch/Warning features:', watchWarning?.features?.length ?? 0);
    }
  } catch(e) { console.warn('[Archive] WW error:', e.message); }

  // Wind Speed Probability shapefile for this advisory
  let windProbability = null;
  try {
    const wspUrl = `${base}/${stormId}_prob_${padded}.zip`;
    const wspRes = await fetch(wspUrl);
    if (wspRes.status === 200) {
      windProbability = parseWindProbability(wspRes.data);
      console.log('[Archive] WSP features:', windProbability?.features?.length ?? 0);
    }
  } catch(e) { console.warn('[Archive] WSP error:', e.message); }

  // Storm Surge shapefile for this advisory
  let surgeZones = null;
  try {
    const surgeUrl = `${base}/${stormId}_surge_${padded}.zip`;
    const surgeRes = await fetch(surgeUrl);
    if (surgeRes.status === 200) {
      surgeZones = parseSurgePolygons(surgeRes.data);
      console.log('[Archive] Surge features:', surgeZones?.features?.length ?? 0);
    }
  } catch(e) { console.warn('[Archive] Surge error:', e.message); }

  // Best track — NHC keeps historical btk files indefinitely
  let bestTrack = null;
  try {
    bestTrack = await getBestTrack(stormId);
    console.log('[Archive] Best track points:', bestTrack?.length ?? 0);
  } catch(e) { console.warn('[Archive] Best track error:', e.message); }

  // Merge official radii into each forecastPt — all values in km
  // byTau from _fcst_ ZIP is already in km (parseWindField converts nmi→km)
  // pts DBF radii are in nmi — convert here so client always gets km
  const NMI_KM = 1.852;
  const nmi2km = arr => (arr || [0,0,0,0]).map(r => r > 0 ? Math.round(r * NMI_KM) : 0);
  const byTau = officialRadii?.byTau || {};
  const initR = byTau['0'] || (officialRadii?.official ? { r34: officialRadii.r34, r50: officialRadii.r50, r64: officialRadii.r64 } : null);
  const forecastPtsWithRadii = forecastPts.map(f => {
    const tau = String(f.tau);
    // Priority 1: _fcst_ ZIP byTau (already km)
    if (byTau[tau]) {
      return { ...f, r34: byTau[tau].r34, r50: byTau[tau].r50, r64: byTau[tau].r64 };
    }
    // Priority 2: pts DBF radii (nmi → km)
    if (f.r34 && Math.max(...(f.r34||[])) > 0) {
      return { ...f, r34: nmi2km(f.r34), r50: nmi2km(f.r50), r64: nmi2km(f.r64) };
    }
    // Priority 3: forward-fill from TAU=0
    return { ...f, r34: initR?.r34 || [0,0,0,0], r50: initR?.r50 || [0,0,0,0], r64: initR?.r64 || [0,0,0,0] };
  });

  // Advisory metadata from the forecast point attributes
  const initPt    = forecastPts[0] || {};
  const advDate   = initPt.datelbl || '';
  const stormName = stormId.replace(/^[a-z]{2}\d{2}(\d{4})$/, '').toUpperCase();

  return {
    active: true,
    mode:   'archive',
    stormId, advisoryNum: padded,
    stormName: stormName || stormId.toUpperCase(),
    advisoryDate: advDate,
    coneUrl, radiiUrl,
    coneCoords, trackCoords,
    forecastPts: forecastPtsWithRadii,
    officialRadii,
    officialRadiiAvailable: !!(officialRadii?.official),
    officialRadiiByTau: byTau,
    watchWarning, windProbability, surgeZones, bestTrack,
    dataSource: `NHC Archive · ${stormId.toUpperCase()} · Adv #${padded}`,
  };
}

// ── Spaghetti models: parse ATCF aids file for all dynamical model tracks
const SKIP_TECHS = new Set(['CARQ','BEST','OFCL','OFCP','WRNG','XTRP','LBAR','CLPB','SHIP','SHF5','SHFR','DSHP','LGEM','XTRP','GUNS','GUNA','GUNX']);

function parseSpaghettiATCF(text) {
  // Reject HTML pages (NRL redirects cloud IPs to their homepage)
  if (text.trimStart().startsWith('<')) return [];
  const lines = text.split('\n').filter(l => l.trim());
  const byTech = {};
  const allTechs = new Set();

  for (const line of lines) {
    const f = line.split(',').map(s => s.trim());
    if (f.length < 9) continue;
    const tech = f[4]; if (!tech) continue;
    allTechs.add(tech);
    if (SKIP_TECHS.has(tech)) continue;
    const dtg  = f[2]; const tau = parseInt(f[5]) || 0;
    const latR = f[6], lonR = f[7];
    if (!latR || !lonR) continue;
    const lat = parseFloat(latR) / 10 * (latR.endsWith('S') ? -1 : 1);
    const lon = parseFloat(lonR) / 10 * (lonR.endsWith('W') ? -1 : 1);
    if (!lat && !lon) continue;
    const wind = parseInt(f[8]) || 0;

    if (!byTech[tech] || dtg > byTech[tech].dtg) byTech[tech] = { dtg, points: [] };
    if (dtg === byTech[tech].dtg && !byTech[tech].points.find(p => p.tau === tau))
      byTech[tech].points.push({ tau, lat, lon, wind });
  }

  console.log('[Spaghetti] Técnicas en archivo:', [...allTechs].join(', '));
  console.log('[Spaghetti] Técnicas usadas:', Object.keys(byTech).join(', '));

  const tracks = Object.entries(byTech)
    .map(([model, d]) => ({ model, track: d.points.sort((a,b) => a.tau - b.tau).map(p => [p.lon, p.lat]) }))
    .filter(t => t.track.length >= 2);

  console.log('[Spaghetti] Tracks generados:', tracks.length, '| Líneas totales:', lines.length);
  return tracks;
}

async function getSpaghetti(stormId) {
  const basin = stormId.slice(0, 2).toLowerCase();
  // Extract components for URL building
  const num2 = stormId.slice(2, 4);   // "05"
  const yr4  = stormId.slice(4);       // "2026"
  const yr2  = yr4.slice(2);           // "26"
  const BASIN = basin.toUpperCase();   // "WP"

  const nrlDirect = `https://www.nrlmry.navy.mil/atcf_web/docs/current_storms/${stormId}.dat`;
  const metocDirect = `https://www.metoc.navy.mil/jtwc/products/${stormId}.dat`;

  const urls = ['wp','io','sh'].includes(basin) ? [
    // Direct (403 from cloud IPs, kept for completeness)
    nrlDirect,
    metocDirect,
    // Relay via allorigins.win (non-cloud IP, bypasses NRL 403)
    `https://api.allorigins.win/raw?url=${encodeURIComponent(nrlDirect)}`,
    // Relay via corsproxy.io
    `https://corsproxy.io/?url=${encodeURIComponent(nrlDirect)}`,
  ] : [
    `https://ftp.nhc.noaa.gov/atcf/aid_public/${stormId}.dat.gz`,
    `https://ftp.nhc.noaa.gov/atcf/aid_public/${stormId}.dat`,
  ];

  for (const url of urls) {
    try {
      console.log('[Spaghetti] Intentando:', url);
      const res = await fetch(url, 8000);
      console.log('[Spaghetti] Status:', res.status, url);
      if (res.status !== 200) continue;
      const text = url.endsWith('.gz')
        ? zlib.gunzipSync(res.data).toString('utf8')
        : res.data.toString('utf8');
      const tracks = parseSpaghettiATCF(text);
      if (tracks.length > 0) return { tracks, source: url };
    } catch(e) { console.warn('[Spaghetti] Failed:', url, e.message); }
  }
  throw new Error(`No ATCF aids data found for ${stormId}`);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const basin        = (req.query.basin    || 'at').toLowerCase();
  const requestedAtcf = (req.query.storm   || '').toLowerCase().trim();
  const mode         = (req.query.mode     || '').toLowerCase();
  const advNum       = (req.query.advisory || '').padStart(3, '0');

  // ── SPAGHETTI MODE: model tracks from ATCF aids file
  // e.g. ?mode=spaghetti&storm=wp052026
  if (mode === 'spaghetti' && requestedAtcf) {
    try {
      const result = await getSpaghetti(requestedAtcf);
      return res.status(200).json(result);
    } catch(err) {
      console.error('[Spaghetti] Error:', err.message);
      return res.status(200).json({ tracks: [], message: err.message });
    }
  }

  // ── ARCHIVE MODE: load a specific historical advisory by number
  // e.g. ?mode=archive&storm=al152017&advisory=007
  if (mode === 'archive' && requestedAtcf && advNum) {
    try {
      const result = await loadArchiveAdvisory(requestedAtcf, advNum);
      return res.status(200).json(result);
    } catch(err) {
      console.error('[Archive] Error:', err.message);
      return res.status(500).json({ error: err.message, mode: 'archive' });
    }
  }

  // ── JTWC basins
  if (['wp','io','sh'].includes(basin)) {
    try {
      console.log(`[StormTrack] JTWC basin: ${basin}`);
      const storms = await getJTWCStorms(basin);
      if (storms.length === 0) {
        return res.status(200).json({ active:false, basin, message:'No active storms', storms:[] });
      }
      const storm = requestedAtcf
        ? (storms.find(s => s.stormId.includes(requestedAtcf)) || storms[0])
        : storms[0];

      // Get WP invests from RSMC Tokyo typhoon list (systems not yet named)
      let invests = [];
      try {
        const allStormsList = await getJMAStorms();
        // Systems with wind < 34kt are "invests" / disturbances
        invests = allStormsList
          .filter(s => (s.forecastPts[0]?.wind || 0) < 34)
          .map(s => ({
            id: s.stormId, lat: s.forecastPts[0]?.lat, lon: s.forecastPts[0]?.lon,
            prob2d: null, prob7d: null, level2d: null, level7d: null,
            desc: `Disturbio tropical · ${s.forecastPts[0]?.wind || '?'}kt`,
          }));
      } catch(e) { console.warn('[JMA invests]', e.message); }

      return res.status(200).json({
        active: true, basin,
        stormId: storm.stormId,
        atcfId: storm.atcfId || null,  // ATCF format for spaghetti
        stormName: storm.stormName || storm.stormId,
        stormType: storm.forecastPts[0]?.tcdvlp || 'Tropical System',
        advisoryNum: '—',
        advisoryDate: storm.advisoryDate,
        headline: `${storm.stormName} · ${storm.forecastPts[0]?.tcdvlp} · ${storm.forecastPts[0]?.wind}kt`,
        pressure: storm.forecastPts[0]?.mslp ? `${storm.forecastPts[0].mslp} mb` : '—',
        fetchedAt: new Date().toISOString(),
        allStorms: storms.map(s => ({
          atcf: s.stormId, name: s.stormName,
          type: s.forecastPts[0]?.tcdvlp,
          wind: s.forecastPts[0]?.wind,
          datetime: s.advisoryDate,
        })),
        coneCoords: storm.coneCoords,
        trackCoords: storm.trackCoords,
        forecastPts: storm.forecastPts,
        officialRadii: storm.officialRadii,
        officialRadiiAvailable: storm.officialRadiiAvailable,
        officialRadiiByTau: storm.officialRadiiByTau || {},
        dataSource: storm.dataSource || 'JMA RSMC Tokyo',
        invests,
      });
    } catch(err) {
      console.error('[JTWC] Error:', err.message);
      return res.status(500).json({ active:false, error:err.message, basin });
    }
  }

  // ── NHC basins (at, ep, cp)
  const gisRssUrl = `https://www.nhc.noaa.gov/gis-${basin}.xml`;
  try {
    console.log('[NHC] Fetching GIS RSS:', gisRssUrl);
    const rssRes = await fetch(gisRssUrl);
    if (rssRes.status !== 200) throw new Error(`GIS RSS HTTP ${rssRes.status}`);
    const gisData = parseGisRSS(rssRes.data.toString('utf8'));

    if (gisData.storms.length === 0) {
      let invests = [];
      try { invests = await getInvests(basin); } catch(e) {}
      return res.status(200).json({ active:false, basin, message:'No active storms', storms:[], rssUrl:gisRssUrl, invests });
    }

    const storm = requestedAtcf
      ? (gisData.storms.find(s => s.atcf === requestedAtcf) || gisData.storms[0])
      : gisData.storms[0];
    const atcf = storm.atcf;
    const fcastInfo = gisData.forecastZips[atcf];
    if (!fcastInfo) throw new Error(`No forecast ZIP for ${atcf}`);

    const windFieldUrl = fcastInfo.url.replace(/_5day_(\d+)\.zip$/i, '_fcst_$1.zip');

    const fcastRes = await fetch(fcastInfo.url);
    if (fcastRes.status !== 200) throw new Error(`Forecast ZIP HTTP ${fcastRes.status}`);
    const fcastFiles = parseZip(fcastRes.data);
    const fcastNames = Object.keys(fcastFiles);

    const pgnShp = fcastNames.find(f => /pgn.*\.shp$/i.test(f));
    const linShp = fcastNames.find(f => /lin.*\.shp$/i.test(f));
    const ptsShp = fcastNames.find(f => /pts.*\.shp$/i.test(f));
    const ptsDbf = fcastNames.find(f => /pts.*\.dbf$/i.test(f));
    if (!pgnShp) throw new Error(`pgn.shp not found. Files: ${fcastNames.join(', ')}`);

    const coneCoords  = parseShpPolygon(fcastFiles[pgnShp]);
    const trackCoords = linShp ? parseShpPolyline(fcastFiles[linShp]) : [];
    const ptCoords    = ptsShp ? parseShpPoints(fcastFiles[ptsShp])   : [];
    const ptAttribs   = ptsDbf ? parseDbf(fcastFiles[ptsDbf])         : [];
    const forecastPts = ptCoords.map((coord,i) => {
      const a = ptAttribs[i]||{};
      return { lon:coord[0], lat:coord[1], tau:a.TAU||0, wind:a.MAXWIND||0, gust:a.GUST||0,
        mslp:a.MSLP!==9999?(a.MSLP||0):0, ssnum:a.SSNUM||0, dvlbl:a.DVLBL||'X',
        datelbl:a.DATELBL||'', tcdvlp:a.TCDVLP||'', validtime:a.VALIDTIME||'' };
    });

    let officialRadii = null;
    try {
      let windRes = await fetch(windFieldUrl);
      if (windRes.status === 404) windRes = await fetch(windFieldUrl.replace(/(_fcst_\d+)(\.zip)$/i,'$1A$2'));
      if (windRes.status === 200) {
        officialRadii = parseWindField(parseZip(windRes.data));
      }
    } catch(e) { console.warn('[NHC] Wind field error:', e.message); }

    let bestTrack = null;
    try { bestTrack = await getBestTrack(atcf); } catch(e) { console.warn('[BTK]', e.message); }

    let reconFixes = [];
    try { reconFixes = await getReconFixes(atcf); } catch(e) { console.warn('[Recon]', e.message); }

    let invests = [];
    try { invests = await getInvests(basin); } catch(e) { console.warn('[TWO]', e.message); }

    let watchWarning = null;
    const wwInfo = gisData.wwZips[atcf];
    if (wwInfo) {
      try {
        const wwRes = await fetch(wwInfo.url);
        if (wwRes.status === 200) watchWarning = parseWatchWarning(wwRes.data);
        console.log('[NHC] Watch/Warning features:', watchWarning?.features?.length ?? 0);
      } catch(e) { console.warn('[NHC] Watch/Warning error:', e.message); }
    }

    let windProbability = null;
    const wspInfo = gisData.wspZips[atcf];
    if (wspInfo) {
      try {
        console.log('[WSP] Fetching:', wspInfo.url);
        const wspRes = await fetch(wspInfo.url);
        if (wspRes.status === 200) windProbability = parseWindProbability(wspRes.data);
        console.log('[WSP] Features:', windProbability?.features?.length ?? 0);
      } catch(e) { console.warn('[WSP] Error:', e.message); }
    }

    let surgeZones = null;
    const surgeInfo = gisData.surgeZips[atcf];
    if (surgeInfo) {
      try {
        console.log('[Surge] Fetching:', surgeInfo.url);
        const surgeRes = await fetch(surgeInfo.url);
        if (surgeRes.status === 200) surgeZones = parseSurgePolygons(surgeRes.data);
        console.log('[Surge] Features:', surgeZones?.features?.length ?? 0);
      } catch(e) { console.warn('[Surge] Error:', e.message); }
    }

    const centerMatch = storm.center?.match(/([\d.]+),\s*([-\d.]+)/);
    return res.status(200).json({
      active:true, basin, stormId:atcf, stormName:storm.name, stormType:storm.type,
      advisoryNum:fcastInfo.advNum, advisoryDate:storm.datetime,
      headline:storm.headline, pressure:storm.pressure, movement:storm.movement,
      centerLat:centerMatch?parseFloat(centerMatch[1]):null,
      centerLon:centerMatch?parseFloat(centerMatch[2]):null,
      fetchedAt:new Date().toISOString(),
      allStorms:gisData.storms,
      coneCoords, trackCoords, forecastPts, officialRadii,
      officialRadiiAvailable:!!officialRadii?.official,
      watchWarning, windProbability, surgeZones, bestTrack, reconFixes, invests,
      dataSource:'NHC GIS RSS + Shapefiles',
    });
  } catch(err) {
    console.error('[NHC] Error:', err.message);
    return res.status(500).json({ active:false, error:err.message, basin });
  }
};
