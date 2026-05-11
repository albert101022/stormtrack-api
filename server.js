// StormTrack API Server — Render.com
// Node.js built-in only (except gtwo-outlook which needs jszip + shapefile)

const http = require('http');
const url  = require('url');

// ── Load all handlers ────────────────────────────────────────────────────────
const handlers = {
  'nhc-latest':    require('./api/nhc-latest'),
  'jtwc-latest':   require('./api/jtwc-latest'),
  'spaghetti':     require('./api/spaghetti'),
  'radar-tile':    require('./api/radar-tile'),
  'goes-tile':     require('./api/goes-tile'),
  'sst-tile':      require('./api/sst-tile'),
  'shear-data':    require('./api/shear-data'),
  'shear-image':   require('./api/shear-image'),
  'conditions':    require('./api/conditions'),
  'climate-indices': require('./api/climate-indices'),
  'gtwo-outlook':  require('./api/gtwo-outlook'),
};

const PORT = process.env.PORT || 3000;

// ── Vercel compat shim: adds req.query + res.status().json() / .send() / .end()
function shimResponse(req, res, query) {
  req.query = query;

  res.status = (code) => ({
    json: (obj) => {
      if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(obj));
    },
    send: (buf) => {
      if (!res.headersSent) res.writeHead(code);
      res.end(buf);
    },
    end: () => {
      if (!res.headersSent) res.writeHead(code);
      res.end();
    },
  });

  // res.json() shorthand
  res.json = (obj) => {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };

  // res.send() for binary (tiles, images)
  res.send = (buf) => {
    if (!res.headersSent) res.writeHead(200);
    res.end(buf);
  };

  // res.setHeader passthrough (already native)
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/$/, '');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Health check
  if (pathname === '/health' || pathname === '') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      endpoints: Object.keys(handlers).map(k => `/api/${k}`),
      ts: new Date().toISOString(),
    }));
  }

  // Match /api/<name> or /<name>
  const match = pathname.match(/^(?:\/api)?\/([a-z-]+)$/);
  const handlerName = match?.[1];
  const handler = handlerName && handlers[handlerName];

  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found', path: pathname }));
  }

  shimResponse(req, res, parsed.query);

  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[${handlerName}] Unhandled:`, err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n🌀 StormTrack API — puerto ${PORT}`);
  console.log('Endpoints disponibles:');
  for (const k of Object.keys(handlers)) console.log(`  GET /api/${k}`);
  console.log('  GET /health\n');
});
