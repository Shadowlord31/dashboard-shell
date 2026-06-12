const express = require('express');
const fs = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const CONFIG_FILE = '/data/config.json';

app.use(express.json());
app.use(express.static('src/public'));

// ── CONFIG ───────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch(e) {}
  return { buttons: [], statusEntities: [], ha: { url: '', token: '' }, proxies: [] };
}

function saveConfig(data) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch(e) { console.error('Config save error:', e.message); }
}

// ── HA STATUS POLL ───────────────────────────────────────
async function haRequest(endpoint) {
  const { url, token } = loadConfig().ha;
  if (!url || !token) throw new Error('HA nicht konfiguriert');
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url.replace(/\/$/, '') + endpoint, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  return res.json();
}

// ── API: HA Config ────────────────────────────────────────
app.get('/api/ha/config', (req, res) => res.json(loadConfig().ha || {}));
app.post('/api/ha/config', (req, res) => {
  const c = loadConfig();
  c.ha = { url: req.body.url || '', token: req.body.token || '' };
  saveConfig(c);
  res.json({ success: true });
});

// ── API: HA Status ────────────────────────────────────────
app.get('/api/ha/status', async (req, res) => {
  const c = loadConfig();
  const entities = c.statusEntities || [];
  if (!entities.length) return res.json({ active: [] });
  try {
    const results = await Promise.all(entities.map(async e => {
      try {
        const data = await haRequest('/api/states/' + e.entityId);
        const hideWhen = String(e.hideWhen !== undefined ? e.hideWhen : '0');
        const isActive = String(data.state) !== hideWhen;
        const extra = data.attributes && data.attributes.fenster_liste ? data.attributes.fenster_liste : null;
        return { ...e, state: data.state, active: isActive, extra };
      } catch(e2) { return { ...e, state: 'unknown', active: false, extra: null }; }
    }));
    res.json({ active: results.filter(e => e.active) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: HA Trigger ───────────────────────────────────────
app.post('/api/ha/trigger/:id', async (req, res) => {
  const c = loadConfig();
  const btn = (c.buttons || []).find(b => b.id === req.params.id);
  if (!btn) return res.status(404).json({ error: 'Nicht gefunden' });
  try {
    if (btn.type === 'input_boolean') {
      const fetch = (await import('node-fetch')).default;
      const { url, token } = c.ha;
      await fetch(url.replace(/\/$/, '') + '/api/services/input_boolean/toggle', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: btn.entityId })
      });
    } else if (btn.type === 'script') {
      const fetch = (await import('node-fetch')).default;
      const { url, token } = c.ha;
      await fetch(url.replace(/\/$/, '') + '/api/services/script/turn_on', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: btn.entityId })
      });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Buttons CRUD ─────────────────────────────────────
app.get('/api/buttons', (req, res) => res.json(loadConfig().buttons || []));
app.post('/api/buttons', (req, res) => {
  const { name, type, entityId, iframeUrl, icon, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  const c = loadConfig();
  if (!c.buttons) c.buttons = [];
  const btn = { id: Date.now().toString(), name, type: type || 'iframe_url', entityId: entityId || '', iframeUrl: iframeUrl || '', icon: icon || '▶', color: color || '#6366f1' };
  c.buttons.push(btn);
  saveConfig(c);
  res.json(btn);
});
app.delete('/api/buttons/:id', (req, res) => {
  const c = loadConfig();
  c.buttons = (c.buttons || []).filter(b => b.id !== req.params.id);
  saveConfig(c);
  res.json({ success: true });
});

// ── API: Status Entities CRUD ─────────────────────────────
app.get('/api/status-entities', (req, res) => res.json(loadConfig().statusEntities || []));
app.post('/api/status-entities', (req, res) => {
  const { name, entityId, hideWhen, color } = req.body;
  if (!name || !entityId) return res.status(400).json({ error: 'Name und Entity ID erforderlich' });
  const c = loadConfig();
  if (!c.statusEntities) c.statusEntities = [];
  const entity = { id: Date.now().toString(), name, entityId, hideWhen: hideWhen !== undefined ? hideWhen : '0', color: color || '#fb923c' };
  c.statusEntities.push(entity);
  saveConfig(c);
  res.json(entity);
});
app.delete('/api/status-entities/:id', (req, res) => {
  const c = loadConfig();
  c.statusEntities = (c.statusEntities || []).filter(e => e.id !== req.params.id);
  saveConfig(c);
  res.json({ success: true });
});

// ── API: Proxies CRUD ─────────────────────────────────────
app.get('/api/proxies', (req, res) => res.json(loadConfig().proxies || []));
app.post('/api/proxies', (req, res) => {
  const { name, path: proxyPath, target } = req.body;
  if (!name || !proxyPath || !target) return res.status(400).json({ error: 'Name, Pfad und Ziel erforderlich' });
  const c = loadConfig();
  if (!c.proxies) c.proxies = [];
  const proxy = { id: Date.now().toString(), name, path: proxyPath, target };
  c.proxies.push(proxy);
  saveConfig(c);
  // Note: requires restart to apply
  res.json({ ...proxy, note: 'Neustart erforderlich' });
});
app.delete('/api/proxies/:id', (req, res) => {
  const c = loadConfig();
  c.proxies = (c.proxies || []).filter(p => p.id !== req.params.id);
  saveConfig(c);
  res.json({ success: true });
});

// ── DYNAMIC PROXY ROUTES ──────────────────────────────────
function setupProxies() {
  const c = loadConfig();
  const proxies = c.proxies || [];

  // Built-in: weather-dash
  app.use('/proxy/wetter', createProxyMiddleware({
    target: 'http://192.168.178.114:3014',
    changeOrigin: true,
    pathRewrite: { '^/proxy/wetter': '' },
    on: {
      proxyRes: (proxyRes) => {
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
      }
    },
    ws: true
  }));

  // Dynamic proxies from config
  proxies.forEach(proxy => {
    const mountPath = '/proxy/' + proxy.path.replace(/^\//, '');
    console.log('Mounting proxy:', mountPath, '->', proxy.target);
    app.use(mountPath, createProxyMiddleware({
      target: proxy.target,
      changeOrigin: true,
      pathRewrite: { ['^' + mountPath]: '' },
      selfHandleResponse: true,
      on: {
        proxyRes: async (proxyRes, req, res) => {
          delete proxyRes.headers['x-frame-options'];
          delete proxyRes.headers['content-security-policy'];
          const contentType = proxyRes.headers['content-type'] || '';
          if (contentType.includes('text/html')) {
            let body = '';
            proxyRes.on('data', chunk => body += chunk.toString());
            proxyRes.on('end', () => {
              // Rewrite absolute asset paths to proxy paths
              const base = mountPath.replace(/\/$/, '');
              body = body.replace(/href="\/([^"]+)"/g, (m, p) => p.startsWith('http') ? m : 'href="' + base + '/' + p + '"');
              body = body.replace(/src="\/([^"]+)"/g, (m, p) => p.startsWith('http') ? m : 'src="' + base + '/' + p + '"');
              body = body.replace(/action="\/([^"]+)"/g, (m, p) => 'action="' + base + '/' + p + '"');
              res.set(proxyRes.headers);
              res.removeHeader('x-frame-options');
              res.removeHeader('content-security-policy');
              res.status(proxyRes.statusCode).send(body);
            });
          } else {
            res.set(proxyRes.headers);
            proxyRes.pipe(res);
          }
        }
      },
      ws: true
    }));
  });
}

setupProxies();

const server = app.listen(3000, () => console.log('Dashboard Shell running on port 3000'));

// WebSocket proxy support
server.on('upgrade', (req, socket, head) => {
  console.log('WS upgrade:', req.url);
});
