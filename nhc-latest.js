// Vercel Serverless Function — NHC Advisory Proxy v2
// Sin dependencias externas — solo Node.js built-in modules

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 
        'User-Agent': 'StormTrack/1.0',
        'Accept': '*/*'
      }
    }, res => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ 
        status: res.statusCode, 
        data: Buffer.concat(chunks),
        headers: res.headers
      }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Parse NHC RSS XML to find active storms
function parseRSS(xml) {
  const storms = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const item = m[1];
    const title = (item.match(/<title[^>]*>(.*?)<\/title>/) || [])[1] || '';
    const link  = (item.match(/<link>(.*?)<\/link>/)        || [])[1] || '';
    const guid  = (item.match(/<guid[^>]*>(.*?)<\/guid>/)   || [])[1] || '';
    
    // NHC advisory items contain "Advisory" in title
    if (!/advisory/i.test(title)) continue;
    if (!/hurricane|tropical storm|tropical depression/i.test(title)) continue;

    // Extract storm ID from link or guid (e.g. al152017, ep062023)
    const src = link + guid;
    const idMatch  = src.match(/([aecw][plb]\d{6})/i) || title.match(/([aecw][plb]\d{6})/i);
    const advMatch = title.match(/advisory\s+(\d+)/i);
    
    if (idMatch && advMatch) {
      storms.push({
        id:    idMatch[1].toLowerCase(),
        adv:   advMatch[1].padStart(3, '0'),
        title: title.replace(/<[^>]+>/g, '').trim(),
        link:  link.trim()
      });
    }
  }
  return storms;
}

// Parse shapefile .shp binary — polygon type (pgn)
function parseShpPolygon(buf) {
  if (buf.length < 100) return [];
  const view = new DataView(buf.buffer, buf.byteOffset);
  const coords = [];
  let offset = 100; // skip file header
  
  while (offset + 12 < buf.length) {
    // Record header: record number (4 BE) + content length in 16-bit words (4 BE)
    const contentLen = view.getInt32(offset + 4, false) * 2; // bytes
    const shapeType  = view.getInt32(offset + 8, true);
    
    if (shapeType === 5 || shapeType === 15) { // Polygon or PolygonZ
      // Skip bbox (4 doubles = 32 bytes), then numParts + numPoints
      const numParts  = view.getInt32(offset + 44, true);
      const numPoints = view.getInt32(offset + 48, true);
      const ptsOffset = offset + 52 + numParts * 4;
      
      for (let i = 0; i < numPoints && ptsOffset + i*16 + 8 <= buf.length; i++) {
        const x = view.getFloat64(ptsOffset + i * 16,     true);
        const y = view.getFloat64(ptsOffset + i * 16 + 8, true);
        coords.push([Math.round(x * 100000) / 100000, 
                     Math.round(y * 100000) / 100000]);
      }
      break; // take first polygon only
    }
    
    offset += 8 + contentLen;
    if (contentLen <= 0) break;
  }
  return coords;
}

// Parse shapefile .shp binary — polyline type (lin)
function parseShpPolyline(buf) {
  if (buf.length < 100) return [];
  const view = new DataView(buf.buffer, buf.byteOffset);
  const coords = [];
  let offset = 100;
  
  while (offset + 12 < buf.length) {
    const contentLen = view.getInt32(offset + 4, false) * 2;
    const shapeType  = view.getInt32(offset + 8, true);
    
    if (shapeType === 3 || shapeType === 13) { // Polyline or PolylineZ
      const numParts  = view.getInt32(offset + 44, true);
      const numPoints = view.getInt32(offset + 48, true);
      const ptsOffset = offset + 52 + numParts * 4;
      
      for (let i = 0; i < numPoints && ptsOffset + i*16 + 8 <= buf.length; i++) {
        const x = view.getFloat64(ptsOffset + i * 16,     true);
        const y = view.getFloat64(ptsOffset + i * 16 + 8, true);
        coords.push([Math.round(x * 100000) / 100000,
                     Math.round(y * 100000) / 100000]);
      }
      break;
    }
    
    offset += 8 + contentLen;
    if (contentLen <= 0) break;
  }
  return coords;
}

// Parse shapefile .shp binary — points type (pts)
function parseShpPoints(buf) {
  if (buf.length < 100) return [];
  const view = new DataView(buf.buffer, buf.byteOffset);
  const points = [];
  let offset = 100;
  
  while (offset + 12 < buf.length) {
    const contentLen = view.getInt32(offset + 4, false) * 2;
    const shapeType  = view.getInt32(offset + 8, true);
    
    if (shapeType === 1) { // Point
      const x = view.getFloat64(offset + 12, true);
      const y = view.getFloat64(offset + 20, true);
      points.push([Math.round(x * 100000)/100000, 
                   Math.round(y * 100000)/100000]);
    }
    
    offset += 8 + contentLen;
    if (contentLen <= 0) break;
  }
  return points;
}

// Parse DBF file for point attributes
function parseDbf(buf) {
  if (buf.length < 32) return [];
  const view    = new DataView(buf.buffer, buf.byteOffset);
  const numRecs = view.getInt32(4, true);
  const hdrSize = view.getInt16(8, true);
  const recSize = view.getInt16(10, true);
  
  // Parse field descriptors
  const fields = [];
  let fi = 32;
  while (fi < hdrSize - 1 && buf[fi] !== 0x0D) {
    const name = String.fromCharCode(...buf.slice(fi, fi+11)).replace(/\0/g,'').trim();
    const type = String.fromCharCode(buf[fi+11]);
    const len  = buf[fi+16];
    fields.push({ name, type, len });
    fi += 32;
  }
  
  // Parse records
  const records = [];
  for (let r = 0; r < numRecs; r++) {
    const recStart = hdrSize + r * recSize + 1; // +1 for deletion flag
    const rec = {};
    let pos = recStart;
    for (const f of fields) {
      const raw = String.fromCharCode(...buf.slice(pos, pos + f.len)).trim();
      rec[f.name] = f.type === 'N' ? (parseFloat(raw) || 0) : raw;
      pos += f.len;
    }
    records.push(rec);
  }
  return records;
}

// Parse ZIP file in memory (no external deps)
function parseZip(buf) {
  const files = {};
  const view  = new DataView(buf.buffer, buf.byteOffset);
  let offset  = 0;
  
  while (offset + 30 < buf.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // local file header signature
    
    const flags      = view.getUint16(offset + 6,  true);
    const method     = view.getUint16(offset + 8,  true);
    const compSize   = view.getUint32(offset + 18, true);
    const uncompSize = view.getUint32(offset + 22, true);
    const nameLen    = view.getUint16(offset + 26, true);
    const extraLen   = view.getUint16(offset + 28, true);
    
    const nameBytes  = buf.slice(offset + 30, offset + 30 + nameLen);
    const name       = String.fromCharCode(...nameBytes);
    const dataStart  = offset + 30 + nameLen + extraLen;
    const compData   = buf.slice(dataStart, dataStart + compSize);
    
    if (method === 0) {
      // Stored (no compression)
      files[name] = compData;
    } else if (method === 8) {
      // Deflate
      try {
        files[name] = zlib.inflateRawSync(compData);
      } catch(e) {
        // skip unreadable entries
      }
    }
    
    offset = dataStart + compSize;
  }
  return files;
}

// Main Vercel handler
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const basin  = (req.query.basin || 'at').toLowerCase();
  const rssUrl = `https://www.nhc.noaa.gov/index-${basin}.xml`;

  try {
    // 1. Fetch RSS
    console.log('[StormTrack] Fetching RSS:', rssUrl);
    const rssRes = await fetch(rssUrl);
    if (rssRes.status !== 200) {
      throw new Error(`NHC RSS returned HTTP ${rssRes.status}`);
    }
    const rssXml = rssRes.data.toString('utf8');
    
    // 2. Parse active storms
    const storms = parseRSS(rssXml);
    console.log('[StormTrack] Active storms:', storms.length, storms.map(s => s.id));
    
    if (storms.length === 0) {
      return res.status(200).json({
        active:  false,
        basin,
        message: 'No active advisories',
        storms:  [],
        rssUrl
      });
    }

    // 3. Fetch shapefile ZIP for first storm
    const storm  = storms[0];
    const zipUrl = `https://www.nhc.noaa.gov/gis/forecast/archive/${storm.id}_5day_${storm.adv}.zip`;
    console.log('[StormTrack] Fetching ZIP:', zipUrl);
    
    const zipRes = await fetch(zipUrl);
    if (zipRes.status !== 200) {
      throw new Error(`Shapefile ZIP not found: HTTP ${zipRes.status} — ${zipUrl}`);
    }

    // 4. Parse ZIP in memory
    const zipFiles  = parseZip(zipRes.data);
    const fileNames = Object.keys(zipFiles);
    console.log('[StormTrack] ZIP contents:', fileNames);

    const pgnShp = fileNames.find(f => /pgn.*\.shp$/i.test(f));
    const linShp = fileNames.find(f => /lin.*\.shp$/i.test(f));
    const ptsShp = fileNames.find(f => /pts.*\.shp$/i.test(f));
    const ptsDbf = fileNames.find(f => /pts.*\.dbf$/i.test(f));

    if (!pgnShp) throw new Error(`pgn.shp not found in ZIP. Files: ${fileNames.join(', ')}`);

    // 5. Parse shapefiles
    const coneCoords  = parseShpPolygon(zipFiles[pgnShp]);
    const trackCoords = linShp ? parseShpPolyline(zipFiles[linShp]) : [];
    const ptCoords    = ptsShp ? parseShpPoints(zipFiles[ptsShp])   : [];
    const ptAttribs   = ptsDbf ? parseDbf(zipFiles[ptsDbf])         : [];

    // Merge point coords with attributes
    const forecastPts = ptCoords.map((coord, i) => {
      const attr = ptAttribs[i] || {};
      return {
        lon:      coord[0],
        lat:      coord[1],
        tau:      attr.TAU      || 0,
        wind:     attr.MAXWIND  || 0,
        gust:     attr.GUST     || 0,
        mslp:     attr.MSLP !== 9999 ? (attr.MSLP || 0) : 0,
        ssnum:    attr.SSNUM    || 0,
        dvlbl:    attr.DVLBL    || 'X',
        datelbl:  attr.DATELBL  || '',
        tcdvlp:   attr.TCDVLP   || '',
        validtime: attr.VALIDTIME || '',
      };
    });

    console.log(`[StormTrack] Done — cone:${coneCoords.length}pts track:${trackCoords.length}pts forecast:${forecastPts.length}pts`);

    return res.status(200).json({
      active:      true,
      basin,
      stormId:     storm.id,
      advisoryNum: storm.adv,
      title:       storm.title,
      fetchedAt:   new Date().toISOString(),
      allStorms:   storms,
      coneCoords,
      trackCoords,
      forecastPts,
    });

  } catch (err) {
    console.error('[StormTrack] Error:', err.message);
    return res.status(500).json({
      active:  false,
      error:   err.message,
      basin,
      message: 'Failed to fetch NHC data'
    });
  }
};
