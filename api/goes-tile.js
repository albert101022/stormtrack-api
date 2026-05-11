// ============================================================
// goes-tile.js — GOES-19 Band 13 tile server · rainbow9 + loop + meso
// URLs:
//   ?z=Z&x=X&y=Y                    → frame actual full disk
//   ?z=Z&x=X&y=Y&loop=1&t=N         → frame N loop full disk (4× DS)
//   ?z=Z&x=X&y=Y&meso=1&t=N         → frame N sector Mesoscale
//   ?meta=1                          → timestamps full disk
//   ?meta=1&meso=1                   → info + timestamps sector Meso
// ============================================================
const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

// ── HTTP fetch ───────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 55000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'StormTrack/4.0 (GOES-tile)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

// ── CRC32 + PNG encoder ──────────────────────────────────────────────────────
const _CRC32T = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = _CRC32T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) | 0;
}
function encodePng(rgba) {
  const W = 256, H = 256;
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const out = Buffer.allocUnsafe(12 + data.length);
    out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8);
    out.writeInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
    return out;
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  const raw = Buffer.allocUnsafe(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * W * 4, W * 4).copy(raw, y * (1 + W * 4) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const EMPTY_TILE = encodePng(new Uint8Array(256 * 256 * 4));

// ── PNG tile cache ────────────────────────────────────────────────────────────
// Caches rendered PNG bytes so the same tile is not re-rendered on repeated requests.
// Key includes a "generation" derived from frame.cachedAt so stale PNGs auto-invalidate.
const _PNG_CACHE     = new Map();
const _PNG_CACHE_MAX = 800;
function _pngCacheGet(key)      { return _PNG_CACHE.get(key) || null; }
function _pngCacheSet(key, buf) {
  if (_PNG_CACHE.size >= _PNG_CACHE_MAX)
    _PNG_CACHE.delete(_PNG_CACHE.keys().next().value); // evict oldest
  _PNG_CACHE.set(key, buf);
}
function _pngKey(mode, frame, t, z, x, y) {
  const gen = Math.floor((frame?.cachedAt || 0) / 60000); // changes each time new data is downloaded
  return `${mode}_${gen}_${t}_${z}_${x}_${y}`;
}

// ── Paleta VIS — GOESRBand2.wspal ────────────────────────────────────────────
// stops: { val, left:[R,G,B,A], right:[R,G,B,A] }
// Debajo del primer stop → transparente; entre stops → lerp(stop_i.right, stop_i+1.left)
const _VIS_STOPS = [
  { val:0.125, left:[50,50,50,0],      right:[50,50,50,0]      },
  { val:0.2,   left:[80,80,80,125],    right:[80,80,80,150]    },
  { val:0.95,  left:[255,255,255,255], right:[255,255,255,255] },
];
const _VIS_LUT_N    = 3000;            // 0..1.4999 en pasos de 0.0005
const _VIS_LUT_STEP = 1.5 / _VIS_LUT_N;
const VIS_LUT = new Uint32Array(_VIS_LUT_N);
(function buildVisLut() {
  function lerp4(a, b, f) {
    return [
      Math.round(a[0]+f*(b[0]-a[0])), Math.round(a[1]+f*(b[1]-a[1])),
      Math.round(a[2]+f*(b[2]-a[2])), Math.round(a[3]+f*(b[3]-a[3])),
    ];
  }
  for (let i = 0; i < _VIS_LUT_N; i++) {
    const v = i * _VIS_LUT_STEP;
    let rgba = [0,0,0,0];
    if (v >= _VIS_STOPS[_VIS_STOPS.length-1].val) {
      rgba = _VIS_STOPS[_VIS_STOPS.length-1].right;
    } else if (v >= _VIS_STOPS[0].val) {
      for (let s = 0; s < _VIS_STOPS.length-1; s++) {
        if (v >= _VIS_STOPS[s].val && v < _VIS_STOPS[s+1].val) {
          const f = (v - _VIS_STOPS[s].val) / (_VIS_STOPS[s+1].val - _VIS_STOPS[s].val);
          rgba = lerp4(_VIS_STOPS[s].right, _VIS_STOPS[s+1].left, f);
          break;
        }
      }
    }
    const [r,g,b,a] = rgba;
    VIS_LUT[i] = ((r&0xff)<<24)|((g&0xff)<<16)|((b&0xff)<<8)|(a&0xff);
  }
})();
function refToRgba(ref) {
  const idx = Math.round(ref / _VIS_LUT_STEP);
  if (idx < 0 || idx >= _VIS_LUT_N) return 0;
  return VIS_LUT[idx];
}

// ── Paleta Rainbow9 ──────────────────────────────────────────────────────────
const RB9 = [
  [180,255,255,255,255],[195,255,255,255,255],[205,255,0,0,255],
  [215,200,0,0,255],[225,160,0,0,255],[235,180,80,0,255],
  [245,200,120,0,255],[250,220,160,0,255],[252,255,255,0,255],
  [254,180,255,0,255],[255,0,200,0,255],[256,0,160,120,255],[257,0,200,200,255],
];
const _LUT_OFFSET = 1000, _LUT_SIZE = 2500;
const BT_LUT = new Uint32Array(_LUT_SIZE);
(function buildLut() {
  for (let i = 0; i < _LUT_SIZE; i++) {
    const bt = (i + _LUT_OFFSET) / 10;
    let r=0,g=0,b=0,a=0;
    if (bt < 258) {
      if (bt < RB9[0][0]) { r=255;g=255;b=255;a=255; }
      else {
        for (let s = RB9.length-1; s >= 0; s--) {
          if (bt >= RB9[s][0]) {
            if (s === RB9.length-1) { [,r,g,b,a]=RB9[s]; }
            else {
              const f=(bt-RB9[s][0])/(RB9[s+1][0]-RB9[s][0]);
              r=Math.round(RB9[s][1]+f*(RB9[s+1][1]-RB9[s][1]));
              g=Math.round(RB9[s][2]+f*(RB9[s+1][2]-RB9[s][2]));
              b=Math.round(RB9[s][3]+f*(RB9[s+1][3]-RB9[s][3]));
              a=Math.round(RB9[s][4]+f*(RB9[s+1][4]-RB9[s][4]));
            }
            break;
          }
        }
      }
    }
    BT_LUT[i] = ((r&0xff)<<24)|((g&0xff)<<16)|((b&0xff)<<8)|(a&0xff);
  }
})();
function btToRgba(bt) {
  const idx = Math.round(bt * 10) - _LUT_OFFSET;
  if (idx < 0 || idx >= _LUT_SIZE) return 0;
  return BT_LUT[idx];
}

// ── Proyección GOES ABI ──────────────────────────────────────────────────────
const G = {
  H: 42164160, a: 6378137.0, b: 6356752.31414,
};
// lat/lon → ángulos de escaneo (x=E-W, y=N-S en rad)
function latLonToAng(latDeg, lonDeg, lon0) {
  const { H, a, b } = G;
  const latR = latDeg * Math.PI / 180;
  const lonR = (lonDeg - lon0) * Math.PI / 180;
  const latGeo = Math.atan((b*b)/(a*a) * Math.tan(latR));
  const rc = b / Math.sqrt(1-(1-(b*b)/(a*a))*Math.cos(latGeo)**2);
  const Sx = H - rc*Math.cos(latGeo)*Math.cos(lonR);
  const Sy = -rc*Math.cos(latGeo)*Math.sin(lonR);
  const Sz = rc*Math.sin(latGeo);
  if (H*(H-Sx) < Sy*Sy + (a*a)/(b*b)*Sz*Sz) return null;
  return { x: Math.asin(-Sy/Math.sqrt(Sx*Sx+Sy*Sy+Sz*Sz)), y: Math.atan(Sz/Sx) };
}
// ángulos de escaneo → lat/lon (inversa — para determinar cobertura del sector Meso)
function angToLatLon(x_ang, y_ang, lon0) {
  const { H, a: re, b: rp } = G;
  const cx = Math.cos(x_ang), sx = Math.sin(x_ang);
  const cy = Math.cos(y_ang), sy = Math.sin(y_ang);
  const aq = sx*sx + cx*cx*(cy*cy + (re/rp)*(re/rp)*sy*sy);
  const bq = -2*H*cx*cy;
  const cq = H*H - re*re;
  const disc = bq*bq - 4*aq*cq;
  if (disc < 0) return null;
  const rs = (-bq - Math.sqrt(disc)) / (2*aq);
  const Sx = rs*cx*cy, Sy = -rs*sx, Sz = rs*cx*sy;
  const lat = Math.atan((re*re)/(rp*rp) * Sz / Math.sqrt((H-Sx)*(H-Sx)+Sy*Sy)) * 180/Math.PI;
  const lon = lon0 - Math.atan(Sy/(H-Sx)) * 180/Math.PI;
  return { lat, lon };
}

// ── Parsear NetCDF-4 con h5wasm ──────────────────────────────────────────────
// factor=1 → resolución nativa; factor=N → average N×N blocks
// Retorna: { bt, nx, ny, dx, dy, x0, y0, lon0 }
async function parseAndDownsample(buffer, factor, useFileCoords = false) {
  let h5;
  try { h5 = (await import('h5wasm/node')).default; }
  catch(e1) { try { h5 = (await import('h5wasm')).default; } catch(e2) { h5 = require('h5wasm'); } }
  const { FS } = await h5.ready;
  try { FS.mkdir('/tmp'); } catch(_) {}
  const fname = `/tmp/goes_${Date.now()}.nc`;
  FS.writeFile(fname, new Uint8Array(buffer));

  let bt_ds, lon0 = -75.2, x0 = -0.151844, y0 = 0.151844, dx = 5.6e-5, dy = -5.6e-5;
  try {
    const f = new h5.File(fname, 'r');
    try {
      const proj = f.get('goes_imager_projection');
      lon0 = parseFloat(proj.attrs['longitude_of_projection_origin']?.value ?? -75.2);
    } catch(_) {}

    // Leer coordenadas x/y (aplicar scale_factor/add_offset si son int16 empaquetados)
    if (useFileCoords) {
      try {
        const xVar = f.get('x');
        const xArr = xVar.value;
        const xSf  = parseFloat(xVar.attrs?.['scale_factor']?.value ?? 1);
        const xAo  = parseFloat(xVar.attrs?.['add_offset']?.value  ?? 0);
        x0 = xArr[0] * xSf + xAo;
        if (xArr.length > 1) dx = (xArr[1] - xArr[0]) * xSf;
      } catch(_) {}
      try {
        const yVar = f.get('y');
        const yArr = yVar.value;
        const ySf  = parseFloat(yVar.attrs?.['scale_factor']?.value ?? 1);
        const yAo  = parseFloat(yVar.attrs?.['add_offset']?.value  ?? 0);
        y0 = yArr[0] * ySf + yAo;
        if (yArr.length > 1) dy = (yArr[1] - yArr[0]) * ySf;
      } catch(_) {}
      // Validar: si los valores parecen incorrectos, usar defaults
      if (!isFinite(x0) || Math.abs(x0) > 0.2) x0 = -0.151844;
      if (!isFinite(y0) || Math.abs(y0) > 0.2) y0 =  0.151844;
      if (!isFinite(dx) || dx <= 0 || dx > 1e-3) dx = 5.6e-5;
      if (!isFinite(dy) || dy >= 0 || dy < -1e-3) dy = -5.6e-5;
    }

    const cmi    = f.get('CMI');
    const raw    = cmi.value;
    const sf     = parseFloat(cmi.attrs['scale_factor']?.value ?? 1);
    const ao     = parseFloat(cmi.attrs['add_offset']?.value  ?? 0);
    const fv     = cmi.attrs['_FillValue']?.value;
    const ny_raw = cmi.shape[0], nx_raw = cmi.shape[1];
    f.close();
    FS.unlink(fname);

    const fillVal = fv !== undefined ? Number(fv) : null;

    if (factor === 1) {
      bt_ds = new Float32Array(ny_raw * nx_raw);
      for (let i = 0; i < bt_ds.length; i++) {
        const v = raw[i];
        bt_ds[i] = (fillVal !== null && v === fillVal) ? NaN : (v * sf + ao);
      }
      return { bt: bt_ds, nx: nx_raw, ny: ny_raw, dx, dy, x0, y0, lon0 };
    } else {
      const ny_ds = Math.floor(ny_raw / factor);
      const nx_ds = Math.floor(nx_raw / factor);
      bt_ds = new Float32Array(ny_ds * nx_ds);
      for (let oy = 0; oy < ny_ds; oy++) {
        for (let ox = 0; ox < nx_ds; ox++) {
          let sum = 0, cnt = 0;
          for (let fy = 0; fy < factor; fy++) {
            for (let fx = 0; fx < factor; fx++) {
              const v = raw[(oy*factor+fy)*nx_raw + (ox*factor+fx)];
              if (fillVal === null || v !== fillVal) { sum += v * sf + ao; cnt++; }
            }
          }
          bt_ds[oy*nx_ds + ox] = cnt ? sum/cnt : NaN;
        }
      }
      return { bt: bt_ds, nx: nx_ds, ny: ny_ds, dx: dx*factor, dy: dy*factor, x0, y0, lon0 };
    }
  } catch(e) {
    try { FS.unlink(fname); } catch(_) {}
    throw e;
  }
}

// ── Renderizar tile 256×256 con interpolación bilineal ───────────────────────
// frame debe tener: { bt, nx, ny, dx, dy, x0, y0, lon0 }
function renderTile(z, tx, ty, frame, colorFn = btToRgba) {
  const { bt, nx, ny, dx, dy, x0, y0, lon0 } = frame;
  const n    = 1 << z;
  const rgba = new Uint8Array(256 * 256 * 4);

  for (let py = 0; py < 256; py++) {
    const tileY  = (ty + py / 256) / n;
    const latDeg = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY))) * 180 / Math.PI;
    for (let px = 0; px < 256; px++) {
      const lonDeg = ((tx + px / 256) / n) * 360 - 180;
      const ang = latLonToAng(latDeg, lonDeg, lon0);
      if (!ang) continue;

      const colF = (ang.x - x0) / dx;
      const rowF = (ang.y - y0) / dy;
      const c0 = Math.floor(colF), c1 = c0 + 1;
      const r0 = Math.floor(rowF), r1 = r0 + 1;
      if (c0 < 0 || r0 < 0 || c1 >= nx || r1 >= ny) continue;

      const v00 = bt[r0*nx+c0], v10 = bt[r0*nx+c1];
      const v01 = bt[r1*nx+c0], v11 = bt[r1*nx+c1];
      if (isNaN(v00)||isNaN(v10)||isNaN(v01)||isNaN(v11)) continue;

      const fc = colF-c0, fr = rowF-r0;
      const btVal = v00*(1-fc)*(1-fr) + v10*fc*(1-fr) + v01*(1-fc)*fr + v11*fc*fr;

      const packed = colorFn(btVal);
      if ((packed & 0xff) === 0) continue;
      const i = (py*256+px)*4;
      rgba[i]  =(packed>>>24)&0xff; rgba[i+1]=(packed>>>16)&0xff;
      rgba[i+2]=(packed>>>8)&0xff;  rgba[i+3]= packed      &0xff;
    }
  }
  return encodePng(rgba);
}

// ── Parser de timestamp GOES ─────────────────────────────────────────────────
function parseGoesTime(url) {
  const m = url.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, yr, doy, hr, mn] = m.map(Number);
  const d = new Date(Date.UTC(yr, 0, doy));
  d.setUTCHours(hr, mn, 0, 0);
  return d.toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// FULL DISK (CMIPF) — 10 min, 5424×5424
// ════════════════════════════════════════════════════════════════════════════
const MAX_FRAMES = 12;  // 2 horas de loop

async function findRecentFiles(count) {
  const allFiles = [];
  const now = new Date();
  for (let h = 0; h <= 3 && allFiles.length < count * 2; h++) {
    const d   = new Date(now.getTime() - h * 3600000);
    const yr  = d.getUTCFullYear();
    const doy = String(Math.ceil((d - new Date(Date.UTC(yr,0,1)))/86400000)).padStart(3,'0');
    const hr  = String(d.getUTCHours()).padStart(2,'0');
    const prefix  = `ABI-L2-CMIPF/${yr}/${doy}/${hr}/`;
    const listUrl = `https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=${prefix}&max-keys=200`;
    try {
      const r = await httpGet(listUrl, 10000);
      if (r.status !== 200) continue;
      const xml = r.buf.toString('utf8');
      for (const m of xml.matchAll(/OR_ABI-L2-CMIPF-M6C13_G19_[^<]+\.nc/g))
        allFiles.push(`https://noaa-goes19.s3.amazonaws.com/${prefix}${m[0]}`);
    } catch(e) { console.warn('[GOES] list h='+h+':', e.message); }
  }
  allFiles.sort((a, b) => b.localeCompare(a));
  return allFiles.slice(0, count);
}

let _urlList = null;
let _urlListProm = null;
async function getRecentUrls() {
  if (_urlList && Date.now() - _urlList.cachedAt < 5*60*1000) return _urlList.urls;
  if (!_urlListProm) {
    _urlListProm = findRecentFiles(MAX_FRAMES).then(urls => {
      _urlList = { urls, cachedAt: Date.now() };
      console.log('[GOES] URLs full disk:', urls.length);
      return urls;
    }).finally(() => { _urlListProm = null; });
  }
  return _urlListProm;
}

let _current = null, _currentProm = null;
async function ensureCurrent() {
  if (_current && Date.now() - _current.cachedAt < 5*60*1000) return;
  if (!_currentProm) {
    _currentProm = (async () => {
      try {
        const urls = await getRecentUrls();
        const url  = urls[0];
        if (!url) throw new Error('No URL');
        if (_current?.url === url) { _current.cachedAt = Date.now(); return; }
        console.log('[GOES] Descargando full disk:', url.split('/').pop());
        const r = await httpGet(url);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        console.log('[GOES] Parseando full disk (' + (r.buf.length/1e6).toFixed(1) + ' MB)...');
        const data = await parseAndDownsample(r.buf, 1);
        _current = { ...data, url, cachedAt: Date.now() };
        console.log(`[GOES] Full disk listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error('[GOES] Error full disk:', e.message); throw e; }
      finally   { _currentProm = null; }
    })();
  }
  await _currentProm;
}

const _loopFrames = new Array(MAX_FRAMES).fill(null);
const _loopProms  = new Array(MAX_FRAMES).fill(null);
async function ensureLoopFrame(t) {
  const frame = _loopFrames[t];
  if (frame && Date.now() - frame.cachedAt < 5*60*1000) return;
  if (!_loopProms[t]) {
    _loopProms[t] = (async () => {
      try {
        const urls = await getRecentUrls();
        const url  = urls[t];
        if (!url) throw new Error(`No URL para t=${t}`);
        if (_loopFrames[t]?.url === url) { _loopFrames[t].cachedAt = Date.now(); return; }
        console.log(`[GOES] Descargando loop t=${t}:`, url.split('/').pop());
        const r = await httpGet(url);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const data = await parseAndDownsample(r.buf, 4);
        _loopFrames[t] = { ...data, url, cachedAt: Date.now() };
        console.log(`[GOES] Loop t=${t} listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error(`[GOES] Error loop t=${t}:`, e.message); throw e; }
      finally   { _loopProms[t] = null; }
    })();
  }
  await _loopProms[t];
}

// ════════════════════════════════════════════════════════════════════════════
// ATLANTIC CROP — mismo CMIPF full disk, recortado al Atlántico
// lon -105° a 5°E, lat -2° a 47°N — resolución nativa 2km, sin downsample
// ════════════════════════════════════════════════════════════════════════════
const MAX_ATL_FRAMES = 12;
const ATL_LAT_MIN = -2, ATL_LAT_MAX = 47;
const ATL_LON_MIN = -105, ATL_LON_MAX = 5;

function computeAtlPixelBounds(lon0, x0, dx, y0, dy, nx, ny) {
  const points = [];
  for (let la = ATL_LAT_MIN; la <= ATL_LAT_MAX; la += 3)
    for (const lo of [ATL_LON_MIN, ATL_LON_MAX, -75, -50, -25])
      points.push({ lat: la, lon: lo });
  for (let lo = ATL_LON_MIN; lo <= ATL_LON_MAX; lo += 5)
    for (const la of [ATL_LAT_MIN, ATL_LAT_MAX])
      points.push({ lat: la, lon: lo });

  let colMin = nx, colMax = 0, rowMin = ny, rowMax = 0;
  for (const { lat, lon } of points) {
    const ang = latLonToAng(lat, lon, lon0);
    if (!ang) continue;
    const col = (ang.x - x0) / dx;
    const row = (ang.y - y0) / dy;
    if (col >= 0 && col < nx) { colMin = Math.min(colMin, col); colMax = Math.max(colMax, col); }
    if (row >= 0 && row < ny) { rowMin = Math.min(rowMin, row); rowMax = Math.max(rowMax, row); }
  }
  const m = 30;
  return {
    c0: Math.max(0, Math.floor(colMin) - m),
    c1: Math.min(nx - 1, Math.ceil(colMax) + m),
    r0: Math.max(0, Math.floor(rowMin) - m),
    r1: Math.min(ny - 1, Math.ceil(rowMax) + m),
  };
}

async function parseAndCropAtlantic(buffer) {
  let h5;
  try { h5 = (await import('h5wasm/node')).default; }
  catch(e1) { try { h5 = (await import('h5wasm')).default; } catch(e2) { h5 = require('h5wasm'); } }
  const { FS } = await h5.ready;
  try { FS.mkdir('/tmp'); } catch(_) {}
  const fname = `/tmp/goes_atl_${Date.now()}.nc`;
  FS.writeFile(fname, new Uint8Array(buffer));

  let lon0 = -75.2, x0 = -0.151844, y0 = 0.151844, dx = 5.6e-5, dy = -5.6e-5;
  try {
    const f = new h5.File(fname, 'r');
    try {
      const proj = f.get('goes_imager_projection');
      lon0 = parseFloat(proj.attrs['longitude_of_projection_origin']?.value ?? -75.2);
    } catch(_) {}
    try {
      const xVar = f.get('x'); const xArr = xVar.value;
      const xSf = parseFloat(xVar.attrs?.['scale_factor']?.value ?? 1);
      const xAo = parseFloat(xVar.attrs?.['add_offset']?.value  ?? 0);
      x0 = xArr[0]*xSf+xAo; if (xArr.length>1) dx=(xArr[1]-xArr[0])*xSf;
    } catch(_) {}
    try {
      const yVar = f.get('y'); const yArr = yVar.value;
      const ySf = parseFloat(yVar.attrs?.['scale_factor']?.value ?? 1);
      const yAo = parseFloat(yVar.attrs?.['add_offset']?.value  ?? 0);
      y0 = yArr[0]*ySf+yAo; if (yArr.length>1) dy=(yArr[1]-yArr[0])*ySf;
    } catch(_) {}
    if (!isFinite(x0)||Math.abs(x0)>0.2) x0=-0.151844;
    if (!isFinite(y0)||Math.abs(y0)>0.2) y0= 0.151844;
    if (!isFinite(dx)||dx<=0||dx>1e-3)   dx= 5.6e-5;
    if (!isFinite(dy)||dy>=0||dy<-1e-3)  dy=-5.6e-5;

    const cmi    = f.get('CMI');
    const raw    = cmi.value;
    const sf     = parseFloat(cmi.attrs['scale_factor']?.value ?? 1);
    const ao     = parseFloat(cmi.attrs['add_offset']?.value  ?? 0);
    const fv     = cmi.attrs['_FillValue']?.value;
    const ny_raw = cmi.shape[0], nx_raw = cmi.shape[1];
    f.close();
    FS.unlink(fname);

    const fillVal = fv !== undefined ? Number(fv) : null;
    const { c0, c1, r0, r1 } = computeAtlPixelBounds(lon0, x0, dx, y0, dy, nx_raw, ny_raw);
    const nx_c = c1-c0+1, ny_c = r1-r0+1;
    console.log(`[ATL] Crop: ${ny_c}×${nx_c}px de ${ny_raw}×${nx_raw} (${Math.round(ny_c*nx_c/ny_raw/nx_raw*100)}%)`);

    const bt = new Float32Array(ny_c * nx_c);
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const v = raw[row*nx_raw+col];
        bt[(row-r0)*nx_c+(col-c0)] = (fillVal!==null&&v===fillVal) ? NaN : (v*sf+ao);
      }

    return { bt, nx: nx_c, ny: ny_c, dx, dy, x0: x0+c0*dx, y0: y0+r0*dy, lon0 };
  } catch(e) {
    try { FS.unlink(fname); } catch(_) {}
    throw e;
  }
}

const _atlFrames = new Array(MAX_ATL_FRAMES).fill(null);
const _atlProms  = new Array(MAX_ATL_FRAMES).fill(null);
let _atlCurrent = null, _atlCurrentProm = null;

async function ensureAtlCurrent() {
  if (_atlCurrent && Date.now()-_atlCurrent.cachedAt < 8*60*1000) return;
  if (!_atlCurrentProm) {
    _atlCurrentProm = (async () => {
      try {
        const urls = await getRecentUrls();
        const url  = urls[0]; if (!url) throw new Error('No URL');
        if (_atlCurrent?.url===url) { _atlCurrent.cachedAt=Date.now(); return; }
        console.log('[ATL] Descargando estático:', url.split('/').pop());
        const r = await httpGet(url);
        if (r.status!==200) throw new Error('HTTP '+r.status);
        const data = await parseAndCropAtlantic(r.buf);
        _atlCurrent = { ...data, url, cachedAt: Date.now() };
        console.log(`[ATL] Estático listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error('[ATL] Error estático:', e.message); throw e; }
      finally    { _atlCurrentProm = null; }
    })();
  }
  await _atlCurrentProm;
}

async function ensureAtlFrame(t) {
  const frame = _atlFrames[t];
  if (frame && Date.now()-frame.cachedAt < 8*60*1000) return;
  if (!_atlProms[t]) {
    _atlProms[t] = (async () => {
      try {
        const urls = await getRecentUrls();
        const url  = urls[t]; if (!url) throw new Error(`No URL t=${t}`);
        if (_atlFrames[t]?.url===url) { _atlFrames[t].cachedAt=Date.now(); return; }
        console.log(`[ATL] Descargando t=${t}:`, url.split('/').pop());
        const r = await httpGet(url);
        if (r.status!==200) throw new Error('HTTP '+r.status);
        const data = await parseAndCropAtlantic(r.buf);
        _atlFrames[t] = { ...data, url, cachedAt: Date.now() };
        console.log(`[ATL] t=${t} listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error(`[ATL] Error t=${t}:`, e.message); throw e; }
      finally    { _atlProms[t] = null; }
    })();
  }
  await _atlProms[t];
}

// ════════════════════════════════════════════════════════════════════════════
// CONUS (CMIPC) — 5 min, ~1500×2500 px, sin downsample
// ════════════════════════════════════════════════════════════════════════════
const MAX_CONUS_FRAMES = 24;  // 2 horas (5 min/frame)

async function findConusFiles(count) {
  const allFiles = [];
  const now = new Date();
  for (let h = 0; h <= 3 && allFiles.length < count * 2; h++) {
    const d   = new Date(now.getTime() - h * 3600000);
    const yr  = d.getUTCFullYear();
    const doy = String(Math.ceil((d - new Date(Date.UTC(yr,0,1)))/86400000)).padStart(3,'0');
    const hr  = String(d.getUTCHours()).padStart(2,'0');
    const prefix  = `ABI-L2-CMIPC/${yr}/${doy}/${hr}/`;
    const listUrl = `https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=${prefix}&max-keys=200`;
    try {
      const r = await httpGet(listUrl, 10000);
      if (r.status !== 200) continue;
      const xml = r.buf.toString('utf8');
      for (const m of xml.matchAll(/OR_ABI-L2-CMIPC-M6C13_G19_[^<]+\.nc/g))
        allFiles.push(`https://noaa-goes19.s3.amazonaws.com/${prefix}${m[0]}`);
    } catch(e) { console.warn('[CONUS] list h='+h+':', e.message); }
  }
  allFiles.sort((a, b) => b.localeCompare(a));
  return allFiles.slice(0, count);
}

let _conusUrlList = null;
let _conusUrlProm = null;
async function getConusUrls() {
  if (_conusUrlList && Date.now() - _conusUrlList.cachedAt < 3*60*1000) return _conusUrlList.urls;
  if (!_conusUrlProm) {
    _conusUrlProm = findConusFiles(MAX_CONUS_FRAMES).then(urls => {
      _conusUrlList = { urls, cachedAt: Date.now() };
      console.log('[CONUS] URLs:', urls.length);
      return urls;
    }).finally(() => { _conusUrlProm = null; });
  }
  return _conusUrlProm;
}

const _conusFrames = new Array(MAX_CONUS_FRAMES).fill(null);
const _conusProms  = new Array(MAX_CONUS_FRAMES).fill(null);
async function ensureConusFrame(t) {
  const frame = _conusFrames[t];
  if (frame && Date.now() - frame.cachedAt < 5*60*1000) return;
  if (!_conusProms[t]) {
    _conusProms[t] = (async () => {
      try {
        const urls = await getConusUrls();
        const url  = urls[t];
        if (!url) throw new Error(`No URL CONUS t=${t}`);
        if (_conusFrames[t]?.url === url) { _conusFrames[t].cachedAt = Date.now(); return; }
        console.log(`[CONUS] Descargando t=${t}:`, url.split('/').pop());
        const r = await httpGet(url, 40000);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        console.log(`[CONUS] Parseando t=${t} (${(r.buf.length/1e6).toFixed(1)} MB)...`);
        const data = await parseAndDownsample(r.buf, 1, true);  // sin downsample, leer x/y del archivo
        _conusFrames[t] = { ...data, url, cachedAt: Date.now() };
        console.log(`[CONUS] t=${t} listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error(`[CONUS] Error t=${t}:`, e.message); throw e; }
      finally   { _conusProms[t] = null; }
    })();
  }
  await _conusProms[t];
}

// ════════════════════════════════════════════════════════════════════════════
// CONUS VIS (CMIPC Band 2) — 5 min, ~5000×3000 px nativo → factor=4 DS
// ════════════════════════════════════════════════════════════════════════════
const MAX_CONUS_VIS_FRAMES = 24;  // 2 horas

async function findConusVisFiles(count) {
  const allFiles = [];
  const now = new Date();
  for (let h = 0; h <= 3 && allFiles.length < count * 2; h++) {
    const d   = new Date(now.getTime() - h * 3600000);
    const yr  = d.getUTCFullYear();
    const doy = String(Math.ceil((d - new Date(Date.UTC(yr,0,1)))/86400000)).padStart(3,'0');
    const hr  = String(d.getUTCHours()).padStart(2,'0');
    const prefix  = `ABI-L2-CMIPC/${yr}/${doy}/${hr}/`;
    const listUrl = `https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=${prefix}&max-keys=200`;
    try {
      const r = await httpGet(listUrl, 10000);
      if (r.status !== 200) continue;
      const xml = r.buf.toString('utf8');
      for (const m of xml.matchAll(/OR_ABI-L2-CMIPC-M6C02_G19_[^<]+\.nc/g))
        allFiles.push(`https://noaa-goes19.s3.amazonaws.com/${prefix}${m[0]}`);
    } catch(e) { console.warn('[CONUS-VIS] list h='+h+':', e.message); }
  }
  allFiles.sort((a, b) => b.localeCompare(a));
  return allFiles.slice(0, count);
}

let _conusVisUrlList = null;
let _conusVisProm    = null;
async function getConusVisUrls() {
  if (_conusVisUrlList && Date.now() - _conusVisUrlList.cachedAt < 3*60*1000) return _conusVisUrlList.urls;
  if (!_conusVisProm) {
    _conusVisProm = findConusVisFiles(MAX_CONUS_VIS_FRAMES).then(urls => {
      _conusVisUrlList = { urls, cachedAt: Date.now() };
      console.log('[CONUS-VIS] URLs:', urls.length);
      return urls;
    }).finally(() => { _conusVisProm = null; });
  }
  return _conusVisProm;
}

const _conusVisFrames = new Array(MAX_CONUS_VIS_FRAMES).fill(null);
const _conusVisProms  = new Array(MAX_CONUS_VIS_FRAMES).fill(null);
async function ensureConusVisFrame(t) {
  const frame = _conusVisFrames[t];
  if (frame && Date.now() - frame.cachedAt < 5*60*1000) return;
  if (!_conusVisProms[t]) {
    _conusVisProms[t] = (async () => {
      try {
        const urls = await getConusVisUrls();
        const url  = urls[t];
        if (!url) throw new Error(`No URL CONUS-VIS t=${t}`);
        if (_conusVisFrames[t]?.url === url) { _conusVisFrames[t].cachedAt = Date.now(); return; }
        console.log(`[CONUS-VIS] Descargando t=${t}:`, url.split('/').pop());
        const r = await httpGet(url, 40000);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        console.log(`[CONUS-VIS] Parseando t=${t} (${(r.buf.length/1e6).toFixed(1)} MB)...`);
        // C02 CONUS: resolución nativa ~5000×3000 → downsample 4× para rendimiento
        const data = await parseAndDownsample(r.buf, 4, true);
        _conusVisFrames[t] = { ...data, url, cachedAt: Date.now() };
        console.log(`[CONUS-VIS] t=${t} listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error(`[CONUS-VIS] Error t=${t}:`, e.message); throw e; }
      finally   { _conusVisProms[t] = null; }
    })();
  }
  await _conusVisProms[t];
}

// ════════════════════════════════════════════════════════════════════════════
// MESOSCALE (CMIPM1 / CMIPM2) — ~1 min, 1000×1000
// ════════════════════════════════════════════════════════════════════════════
const MAX_MESO_FRAMES = 30;  // 30 minutos

async function findMesoFiles(sector, count) {
  const allFiles = [];
  const now = new Date();
  // Los archivos Meso se generan cada ~60 seg, buscamos en las últimas 2 horas
  for (let h = 0; h <= 1 && allFiles.length < count * 3; h++) {
    const d   = new Date(now.getTime() - h * 3600000);
    const yr  = d.getUTCFullYear();
    const doy = String(Math.ceil((d - new Date(Date.UTC(yr,0,1)))/86400000)).padStart(3,'0');
    const hr  = String(d.getUTCHours()).padStart(2,'0');
    // M1 → CMIPM1, M2 → CMIPM2
    const product = sector === 'M1' ? 'ABI-L2-CMIPM1' : 'ABI-L2-CMIPM2';
    const prefix  = `${product}/${yr}/${doy}/${hr}/`;
    const listUrl = `https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=${prefix}&max-keys=200`;
    try {
      const r = await httpGet(listUrl, 10000);
      if (r.status !== 200) continue;
      const xml = r.buf.toString('utf8');
      const pat = sector === 'M1'
        ? /OR_ABI-L2-CMIPM1-M6C13_G19_[^<]+\.nc/g
        : /OR_ABI-L2-CMIPM2-M6C13_G19_[^<]+\.nc/g;
      for (const m of xml.matchAll(pat))
        allFiles.push(`https://noaa-goes19.s3.amazonaws.com/${prefix}${m[0]}`);
    } catch(e) { console.warn(`[MESO] list ${sector} h=${h}:`, e.message); }
  }
  allFiles.sort((a, b) => b.localeCompare(a));
  return allFiles.slice(0, count);
}

// Estado global del sector Meso
let _mesoSector   = null;   // 'M1' | 'M2' | null
let _mesoUrls     = null;   // { urls, cachedAt }
let _mesoUrlProm  = null;
let _mesoCenterLat = null;
let _mesoCenterLon = null;
const _mesoFrames = new Array(MAX_MESO_FRAMES).fill(null);
const _mesoProms  = new Array(MAX_MESO_FRAMES).fill(null);

// Determina si una lat/lon cae en el Atlántico/Caribe/Golfo (región de interés)
function isAtlanticBasin(lat, lon) {
  return lat >= -5 && lat <= 55 && lon >= -110 && lon <= -10;
}

// Obtiene URLs del mejor sector Meso disponible (M1 preferido → M2)
async function getMesoUrls() {
  if (_mesoUrls && Date.now() - _mesoUrls.cachedAt < 60*1000) return _mesoUrls;
  if (!_mesoUrlProm) {
    _mesoUrlProm = (async () => {
      for (const sector of ['M1', 'M2']) {
        try {
          const urls = await findMesoFiles(sector, MAX_MESO_FRAMES);
          if (!urls.length) continue;
          // Si ya teníamos frames del sector anterior, invalidar si cambió
          if (_mesoSector !== sector) {
            _mesoFrames.fill(null);
            _mesoProms.fill(null);
            _mesoCenterLat = null;
            _mesoCenterLon = null;
          }
          _mesoSector = sector;
          _mesoUrls   = { urls, cachedAt: Date.now() };
          console.log(`[MESO] Sector ${sector}: ${urls.length} archivos`);
          return _mesoUrls;
        } catch(e) { console.warn(`[MESO] Error buscando ${sector}:`, e.message); }
      }
      _mesoUrls = { urls: [], cachedAt: Date.now() };
      return _mesoUrls;
    })().finally(() => { _mesoUrlProm = null; });
  }
  return _mesoUrlProm;
}

async function ensureMesoFrame(t) {
  const frame = _mesoFrames[t];
  if (frame && Date.now() - frame.cachedAt < 60*1000) return;  // TTL 1 min
  if (!_mesoProms[t]) {
    _mesoProms[t] = (async () => {
      try {
        const state = await getMesoUrls();
        const url   = state.urls[t];
        if (!url) throw new Error(`No URL meso t=${t}`);
        if (_mesoFrames[t]?.url === url) { _mesoFrames[t].cachedAt = Date.now(); return; }
        console.log(`[MESO] Descargando t=${t}:`, url.split('/').pop());
        const r = await httpGet(url, 30000);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        console.log(`[MESO] Parseando t=${t} (${(r.buf.length/1e6).toFixed(1)} MB)...`);
        // Meso es 1000×1000 (~10MB) — usamos factor=1 (sin downsample)
        const data = await parseAndDownsample(r.buf, 1, true);  // leer x/y del archivo
        _mesoFrames[t] = { ...data, url, cachedAt: Date.now() };
        // Calcular centro del sector para el frame t=0 (más reciente)
        if (t === 0 && _mesoCenterLat === null) {
          const xc = data.x0 + (data.nx / 2) * data.dx;
          const yc = data.y0 + (data.ny / 2) * data.dy;
          const ctr = angToLatLon(xc, yc, data.lon0);
          if (ctr) { _mesoCenterLat = ctr.lat; _mesoCenterLon = ctr.lon; }
          console.log(`[MESO] Centro: ${_mesoCenterLat?.toFixed(1)}°N ${_mesoCenterLon?.toFixed(1)}°`);
        }
        console.log(`[MESO] t=${t} listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error(`[MESO] Error t=${t}:`, e.message); throw e; }
      finally   { _mesoProms[t] = null; }
    })();
  }
  await _mesoProms[t];
}

// ════════════════════════════════════════════════════════════════════════════
// HIMAWARI-9 (via Cloudflare R2) — Full Disk, Band 13 (IR 10.4 µm)
// Pipeline: local satpy → GOES-CMI NetCDF → R2 → tile server
// manifest.json en R2 lista los frames disponibles (actualizado cada 10 min)
// ════════════════════════════════════════════════════════════════════════════
const MAX_HIMA_FRAMES = 12;
const R2_PUBLIC_URL   = 'https://pub-0cf3e052fca94ea5ad87c3a7f6f3c4c5.r2.dev';

// ── Manifest cache ────────────────────────────────────────────────────────────
let _himaManifest = null, _himaManifestProm = null;

async function getHimaManifest() {
  if (_himaManifest && Date.now() - _himaManifest._at < 8*60*1000) return _himaManifest;
  if (!_himaManifestProm) {
    _himaManifestProm = (async () => {
      try {
        const r = await httpGet(`${R2_PUBLIC_URL}/manifest.json`, 10000);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const m = JSON.parse(r.buf.toString('utf8'));
        m._at = Date.now();
        _himaManifest = m;
        console.log(`[HIMA] Manifest: ${(m.frames||[]).length} frames, updated: ${m.updated}`);
      } catch(e) {
        console.error('[HIMA] Manifest error:', e.message);
        // Mantener manifest viejo si existe, o crear vacío
        if (!_himaManifest) _himaManifest = { frames: [], _at: Date.now() };
        else _himaManifest._at = Date.now(); // evitar retry loop
      }
      _himaManifestProm = null;
    })();
  }
  await _himaManifestProm;
  return _himaManifest || { frames: [] };
}

// ── Frame cache ───────────────────────────────────────────────────────────────
const _himaFrames = new Array(MAX_HIMA_FRAMES).fill(null);
const _himaProms  = new Array(MAX_HIMA_FRAMES).fill(null);
let _himaCurrent = null, _himaCurrentProm = null;

async function ensureHimaCurrent() {
  if (_himaCurrent && Date.now() - _himaCurrent.cachedAt < 8*60*1000) return;
  if (!_himaCurrentProm) {
    _himaCurrentProm = (async () => {
      try {
        const manifest = await getHimaManifest();
        const entry = (manifest.frames || [])[0];
        if (!entry) throw new Error('No frame en manifest');
        const url = `${R2_PUBLIC_URL}/${entry.file}`;
        if (_himaCurrent?.url === url) { _himaCurrent.cachedAt = Date.now(); return; }
        console.log(`[HIMA] Descargando estático: ${entry.file}`);
        const r = await httpGet(url, 55000);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        console.log(`[HIMA] Parseando estático (${(r.buf.length/1e6).toFixed(1)} MB)...`);
        const data = await parseAndDownsample(r.buf, 1, true);
        _himaCurrent = { ...data, url, cachedAt: Date.now() };
        console.log(`[HIMA] Estático listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error('[HIMA] Error estático:', e.message); throw e; }
      finally    { _himaCurrentProm = null; }
    })();
  }
  await _himaCurrentProm;
}

async function ensureHimaFrame(t) {
  const frame = _himaFrames[t];
  if (frame && Date.now() - frame.cachedAt < 8*60*1000) return;
  if (!_himaProms[t]) {
    _himaProms[t] = (async () => {
      try {
        const manifest = await getHimaManifest();
        const entry = (manifest.frames || [])[t];
        if (!entry) throw new Error('No frame en manifest para t=' + t);
        const url = `${R2_PUBLIC_URL}/${entry.file}`;
        if (_himaFrames[t]?.url === url) { _himaFrames[t].cachedAt = Date.now(); return; }
        console.log(`[HIMA] Descargando t=${t}: ${entry.file}`);
        const r = await httpGet(url, 55000);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        console.log(`[HIMA] Parseando t=${t} (${(r.buf.length/1e6).toFixed(1)} MB)...`);
        const data = await parseAndDownsample(r.buf, 2, true);
        _himaFrames[t] = { ...data, url, cachedAt: Date.now() };
        console.log(`[HIMA] t=${t} listo: ${data.nx}×${data.ny}px`);
      } catch(e) { console.error(`[HIMA] Error t=${t}:`, e.message); throw e; }
      finally    { _himaProms[t] = null; }
    })();
  }
  await _himaProms[t];
}

// ── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Keepalive ping ────────────────────────────────────────────────────────────
  if (req.query.ping === '1') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, ts: Date.now() });
  }

  const isMeso  = req.query.meso  === '1';
  const isConus = req.query.conus === '1';
  const isVis   = req.query.vis   === '1';
  const isHima  = req.query.hima  === '1';
  const isAtl   = req.query.atl   === '1';


  // ── Meta endpoint ──────────────────────────────────────────────────────────
  if (req.query.meta === '1') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=30');

    async function metaFrames(getUrlsFn, cachedList) {
      let urls = [];
      try {
        urls = await Promise.race([
          getUrlsFn(),
          new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 10000))
        ]);
      } catch(e) { urls = cachedList?.urls || []; }
      return urls.map((url, t) => ({ t, iso: parseGoesTime(url), file: url.split('/').pop().replace('.nc','') }));
    }

    if (isMeso) {
      let state = { urls: [] };
      try {
        state = await Promise.race([getMesoUrls(), new Promise((_,r) => setTimeout(()=>r(new Error('timeout')),10000))]);
      } catch(e) { state = _mesoUrls || { urls: [] }; }
      const frames = state.urls.map((url, t) => ({ t, iso: parseGoesTime(url), file: url.split('/').pop().replace('.nc','') }));
      return res.status(200).json({
        available: state.urls.length > 0, sector: _mesoSector,
        centerLat: _mesoCenterLat, centerLon: _mesoCenterLon,
        inAtlantic: _mesoCenterLat !== null ? isAtlanticBasin(_mesoCenterLat, _mesoCenterLon) : null,
        frames, updatedAt: new Date().toISOString()
      });
    } else if (isHima) {
      try {
        const manifest = await Promise.race([
          getHimaManifest(),
          new Promise((_,r) => setTimeout(() => r(new Error('timeout')), 12000))
        ]);
        const frames = (manifest.frames || []).map((f, t) => ({ t, iso: f.iso, file: f.file }));
        return res.status(200).json({ frames, updatedAt: manifest.updated || new Date().toISOString() });
      } catch(e) { return res.status(200).json({ frames: [], updatedAt: new Date().toISOString() }); }
    } else if (isAtl) {
      const frames = await metaFrames(getRecentUrls, _urlList);
      return res.status(200).json({ frames, updatedAt: new Date().toISOString() });
    } else if (isConus && isVis) {
      const frames = await metaFrames(getConusVisUrls, _conusVisUrlList);
      return res.status(200).json({ frames, updatedAt: new Date().toISOString() });
    } else if (isConus) {
      const frames = await metaFrames(getConusUrls, _conusUrlList);
      return res.status(200).json({ frames, updatedAt: new Date().toISOString() });
    } else {
      const frames = await metaFrames(getRecentUrls, _urlList);
      return res.status(200).json({ frames, updatedAt: new Date().toISOString() });
    }
  }

  // ── Tile endpoint ──────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=60');

  const z = parseInt(req.query.z);
  const x = parseInt(req.query.x);
  const y = parseInt(req.query.y);
  if (isNaN(z) || isNaN(x) || isNaN(y)) return res.status(400).end(EMPTY_TILE);

  const isLoop = req.query.loop === '1';

  if (isHima) {
    // ── Himawari-9 Full Disk ──────────────────────────────────────────────
    if (isLoop) {
      // Loop: factor=2 (2750×2750), hasta 12 frames
      const t = Math.max(0, Math.min(MAX_HIMA_FRAMES-1, parseInt(req.query.t ?? '0') || 0));
      try {
        await Promise.race([
          ensureHimaFrame(t),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
        ]);
      } catch(e) { console.warn('[HIMA] loop timeout/error:', e.message); }
      const frame = _himaFrames[t];
      if (!frame) return res.status(200).end(EMPTY_TILE);
      try {
        const ck = _pngKey('hima-loop', frame, t, z, x, y);
        const hit = _pngCacheGet(ck);
        if (hit) return res.status(200).end(hit);
        const png = renderTile(z, x, y, frame);
        _pngCacheSet(ck, png);
        return res.status(200).end(png);
      } catch(e) { console.error('[HIMA] loop render error:', e.message); return res.status(200).end(EMPTY_TILE); }
    } else {
      // Estático: factor=1 (5500×5500), frame más reciente
      try {
        await Promise.race([
          ensureHimaCurrent(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
        ]);
      } catch(e) { console.warn('[HIMA] static timeout:', e.message); }
      const frame = _himaCurrent;
      if (!frame) return res.status(200).end(EMPTY_TILE);
      try {
        const ck = _pngKey('hima-static', frame, 0, z, x, y);
        const hit = _pngCacheGet(ck);
        if (hit) return res.status(200).end(hit);
        const png = renderTile(z, x, y, frame);
        _pngCacheSet(ck, png);
        return res.status(200).end(png);
      } catch(e) { console.error('[HIMA] static render error:', e.message); return res.status(200).end(EMPTY_TILE); }
    }

  } else if (isAtl) {
    // ── Atlantic crop — full disk recortado al Atlántico, resolución nativa ──
    if (isLoop) {
      const t = Math.max(0, Math.min(MAX_ATL_FRAMES-1, parseInt(req.query.t ?? '0') || 0));
      try {
        await Promise.race([
          ensureAtlFrame(t),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
        ]);
      } catch(e) { console.warn('[ATL] loop timeout/error:', e.message); }
      const frame = _atlFrames[t];
      if (!frame) return res.status(200).end(EMPTY_TILE);
      try {
        const ck = _pngKey('atl-loop', frame, t, z, x, y);
        const hit = _pngCacheGet(ck);
        if (hit) return res.status(200).end(hit);
        const png = renderTile(z, x, y, frame);
        _pngCacheSet(ck, png);
        return res.status(200).end(png);
      } catch(e) { console.error('[ATL] loop render error:', e.message); return res.status(200).end(EMPTY_TILE); }
    } else {
      try {
        await Promise.race([
          ensureAtlCurrent(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
        ]);
      } catch(e) { console.warn('[ATL] static timeout:', e.message); }
      const frame = _atlCurrent;
      if (!frame) return res.status(200).end(EMPTY_TILE);
      try {
        const ck = _pngKey('atl-static', frame, 0, z, x, y);
        const hit = _pngCacheGet(ck);
        if (hit) return res.status(200).end(hit);
        const png = renderTile(z, x, y, frame);
        _pngCacheSet(ck, png);
        return res.status(200).end(png);
      } catch(e) { console.error('[ATL] static render error:', e.message); return res.status(200).end(EMPTY_TILE); }
    }

  } else if (isConus && isVis) {
    // ── CONUS VIS (Band 2) ────────────────────────────────────────────────
    const t = Math.max(0, Math.min(MAX_CONUS_VIS_FRAMES-1, parseInt(req.query.t ?? '0') || 0));
    try {
      await Promise.race([
        ensureConusVisFrame(t),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
      ]);
    } catch(e) { console.warn('[CONUS-VIS] timeout/error:', e.message); }
    const frame = _conusVisFrames[t];
    if (!frame) return res.status(200).end(EMPTY_TILE);
    try {
      const ck = _pngKey('cvis', frame, t, z, x, y);
      const hit = _pngCacheGet(ck);
      if (hit) return res.status(200).end(hit);
      const png = renderTile(z, x, y, frame, refToRgba);
      _pngCacheSet(ck, png);
      return res.status(200).end(png);
    } catch(e) { console.error('[CONUS-VIS] render error:', e.message); return res.status(200).end(EMPTY_TILE); }

  } else if (isConus) {
    // ── CONUS IR ──────────────────────────────────────────────────────────
    const t = Math.max(0, Math.min(MAX_CONUS_FRAMES-1, parseInt(req.query.t ?? '0') || 0));
    try {
      await Promise.race([
        ensureConusFrame(t),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
      ]);
    } catch(e) { console.warn('[CONUS] timeout/error:', e.message); }
    const frame = _conusFrames[t];
    if (!frame) return res.status(200).end(EMPTY_TILE);
    try {
      const ck = _pngKey('conus', frame, t, z, x, y);
      const hit = _pngCacheGet(ck);
      if (hit) return res.status(200).end(hit);
      const png = renderTile(z, x, y, frame);
      _pngCacheSet(ck, png);
      return res.status(200).end(png);
    } catch(e) { console.error('[CONUS] render error:', e.message); return res.status(200).end(EMPTY_TILE); }

  } else if (isMeso) {
    // ── Sector Mesoscale ──────────────────────────────────────────────────
    const t = Math.max(0, Math.min(MAX_MESO_FRAMES-1, parseInt(req.query.t ?? '0') || 0));
    try {
      await Promise.race([
        ensureMesoFrame(t),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
      ]);
    } catch(e) { console.warn('[MESO] timeout/error:', e.message); }
    const frame = _mesoFrames[t];
    if (!frame) return res.status(200).end(EMPTY_TILE);
    try {
      const ck = _pngKey('meso', frame, t, z, x, y);
      const hit = _pngCacheGet(ck);
      if (hit) return res.status(200).end(hit);
      const png = renderTile(z, x, y, frame);
      _pngCacheSet(ck, png);
      return res.status(200).end(png);
    } catch(e) { console.error('[MESO] render error:', e.message); return res.status(200).end(EMPTY_TILE); }

  } else {
    // ── Full disk ─────────────────────────────────────────────────────────
    const t = Math.max(0, Math.min(MAX_FRAMES-1, parseInt(req.query.t ?? '0') || 0));
    try {
      await Promise.race([
        isLoop ? ensureLoopFrame(t) : ensureCurrent(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 55000))
      ]);
    } catch(e) { console.warn('[GOES] timeout/error:', e.message); }
    const frame = isLoop ? _loopFrames[t] : _current;
    if (!frame) return res.status(200).end(EMPTY_TILE);
    try {
      const mode = isLoop ? 'loop' : 'disk';
      const ck = _pngKey(mode, frame, t, z, x, y);
      const hit = _pngCacheGet(ck);
      if (hit) return res.status(200).end(hit);
      const png = renderTile(z, x, y, frame);
      _pngCacheSet(ck, png);
      return res.status(200).end(png);
    } catch(e) { console.error('[GOES] render error:', e.message); return res.status(200).end(EMPTY_TILE); }
  }
};
