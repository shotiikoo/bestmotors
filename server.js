// Best Motors — store + admin server. No dependencies: plain Node.js 18+.
// Run: ADMIN_PASSWORD=yourpassword node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// On Render, point DATA_DIR at a persistent disk (e.g. /var/data) so data survives restarts.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD environment variable is required.');
  process.exit(1);
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.copyFileSync(SEED_FILE, DB_FILE);

/* ---------- storage ---------- */
let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
let writing = Promise.resolve();
function save() {
  // Writes are queued and atomic (temp file + rename), so a crash never leaves a half-written file.
  const snapshot = JSON.stringify(db, null, 1);
  writing = writing.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DB_FILE);
  }).catch(e => console.error('DB write failed:', e));
  return writing;
}

/* ---------- helpers ---------- */
const CATS = ['brakes', 'filters', 'oil', 'ignition', 'battery', 'suspension', 'lighting', 'engine'];
const STATUSES = ['new', 'confirmed', 'ready', 'done', 'cancelled'];
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, min = 0, max = 1e7) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };
const phoneOk = p => /^(\+?995)?5\d{8}$/.test(String(p).replace(/[\s\-()]/g, ''));
const code = prefix => prefix + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

function publicProduct(p) {
  const { active, ...rest } = p;
  return rest;
}
function cleanProduct(b, existing = {}) {
  const stock = {};
  for (const br of db.branches) stock[br.id] = Math.round(num(b.stock?.[br.id], 0, 100000) ?? 0);
  const specs = {};
  if (b.specs && typeof b.specs === 'object') {
    for (const [k, v] of Object.entries(b.specs).slice(0, 20)) { const kk = str(k, 60), vv = str(String(v), 120); if (kk && vv) specs[kk] = vv; }
  }
  const fits = Array.isArray(b.fits) ? b.fits.map(f => str(f, 40)).filter(Boolean).slice(0, 60) : [];
  return {
    ...existing,
    name: str(b.name, 160),
    brand: str(b.brand, 60),
    cat: CATS.includes(b.cat) ? b.cat : 'engine',
    oem: str(b.oem, 60),
    price: num(b.price, 0, 1e6) ?? 0,
    old: num(b.old, 0, 1e6) || null,
    fits: fits.length ? fits : ['*'],
    stock,
    specs,
    pop: Math.round(num(b.pop, 0, 1000) ?? 50),
    image: str(b.image, 300),
    active: b.active !== false,
  };
}

/* ---------- tiny router (no Express needed) ---------- */
const routes = [];
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  app[m] = (pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method: m.toUpperCase(), re, keys, handlers });
  };
}
function enhance(req, res) {
  res.status = c => { res.statusCode = c; return res; };
  res.set = (k, v) => { res.setHeader(k, v); return res; };
  res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
}
function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function sendFile(res, file, maxAge = 0) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-cache');
    fs.createReadStream(file).pipe(res);
  });
}
function serveStatic(root, urlPath, res, maxAge) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { rel = urlPath; }
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
  sendFile(res, file, maxAge);
}

// Simple in-memory rate limiter
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* ----- public API ----- */
app.get('/api/catalog', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    products: db.products.filter(p => p.active !== false).map(publicProduct),
    branches: db.branches,
    settings: db.settings,
  });
});

app.post('/api/orders', async (req, res) => {
  if (limit('order:' + ip(req), 8, 10 * 60e3)) return res.status(429).json({ error: 'ძალიან ბევრი მოთხოვნა. სცადე რამდენიმე წუთში.' });
  const b = req.body || {};
  const name = str(b.name, 80), phone = str(b.phone, 30), mode = b.mode === 'delivery' ? 'delivery' : 'pickup';
  if (!name) return res.status(400).json({ error: 'შეიყვანე სახელი.' });
  if (!phoneOk(phone)) return res.status(400).json({ error: 'შეიყვანე ტელეფონი ფორმატით 5XX XX XX XX.' });
  let branch = null, address = '';
  if (mode === 'pickup') {
    branch = db.branches.find(x => x.id === b.branch);
    if (!branch) return res.status(400).json({ error: 'აირჩიე ფილიალი.' });
  } else {
    address = str(b.address, 200);
    if (!address) return res.status(400).json({ error: 'მიუთითე მიწოდების მისამართი.' });
  }
  // Prices always come from the database, never from the browser.
  const items = [];
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 50) : []) {
    const p = db.products.find(x => x.id === Number(it.id) && x.active !== false);
    const qty = Math.round(num(it.qty, 1, 99) ?? 0);
    if (p && qty) items.push({ id: p.id, name: p.name, brand: p.brand, oem: p.oem, price: p.price, qty });
  }
  if (!items.length) return res.status(400).json({ error: 'კალათა ცარიელია.' });
  const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
  const delivery = mode === 'delivery' && subtotal < (db.settings.freeDeliveryFrom ?? 150) ? (db.settings.deliveryFee ?? 5) : 0;
  const order = {
    id: code('BM'), createdAt: new Date().toISOString(), status: 'new',
    name, phone, mode, branch: branch ? branch.id : null, branchName: branch ? branch.name : null, address,
    comment: str(b.comment, 500), items, subtotal, delivery, total: subtotal + delivery, note: '',
  };
  db.orders.unshift(order);
  await save();
  res.json({ ok: true, id: order.id, total: order.total });
});

app.post('/api/requests', async (req, res) => {
  if (limit('req:' + ip(req), 6, 10 * 60e3)) return res.status(429).json({ error: 'ძალიან ბევრი მოთხოვნა. სცადე რამდენიმე წუთში.' });
  const b = req.body || {};
  const r = { id: code('RQ'), createdAt: new Date().toISOString(), done: false,
    name: str(b.name, 80), phone: str(b.phone, 30), car: str(b.car, 100), vin: str(b.vin, 20).toUpperCase(), message: str(b.message, 1500) };
  if (!r.name || !r.message) return res.status(400).json({ error: 'შეავსე სახელი და შეტყობინება.' });
  if (!phoneOk(r.phone)) return res.status(400).json({ error: 'შეიყვანე ტელეფონი ფორმატით 5XX XX XX XX.' });
  db.requests.unshift(r);
  await save();
  res.json({ ok: true, id: r.id });
});

// VIN lookup through the official NHTSA database (free, no key). Best for US-market cars.
const vinCache = new Map();
app.get('/api/vin/:vin', async (req, res) => {
  const vin = String(req.params.vin).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return res.status(400).json({ error: 'bad vin' });
  if (vinCache.has(vin)) return res.json(vinCache.get(vin));
  if (limit('vin:' + ip(req), 30, 60e3)) return res.status(429).json({ error: 'rate' });
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    const x = (j.Results && j.Results[0]) || {};
    const out = { make: x.Make || '', model: x.Model || '', year: x.ModelYear || '', trim: x.Trim || '', engine: [x.DisplacementL && x.DisplacementL + ' L', x.FuelTypePrimary].filter(Boolean).join(', '), body: x.BodyClass || '' };
    vinCache.set(vin, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: 'lookup failed' });
  }
});

/* ----- admin auth ----- */
const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 3600e3;
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.post('/api/admin/login', (req, res) => {
  if (limit('login:' + ip(req), 8, 15 * 60e3)) return res.status(429).json({ error: 'ძალიან ბევრი მცდელობა. სცადე 15 წუთში.' });
  if (!safeEqual(req.body?.password || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'პაროლი არასწორია.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.json({ token });
});
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return res.status(401).json({ error: 'საჭიროა ხელახლა შესვლა.' }); }
  sessions.set(token, Date.now() + SESSION_MS);
  req.token = token;
  next();
}
app.post('/api/admin/logout', auth, (req, res) => { sessions.delete(req.token); res.json({ ok: true }); });

/* ----- admin API ----- */
app.get('/api/admin/data', auth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ products: db.products, branches: db.branches, settings: db.settings, orders: db.orders, requests: db.requests });
});

app.post('/api/admin/products', auth, async (req, res) => {
  const p = cleanProduct(req.body || {});
  if (!p.name) return res.status(400).json({ error: 'შეიყვანე დასახელება.' });
  p.id = db.nextId++;
  db.products.unshift(p);
  await save();
  res.json(p);
});
app.put('/api/admin/products/:id', auth, async (req, res) => {
  const i = db.products.findIndex(p => p.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'პროდუქტი ვერ მოიძებნა.' });
  const p = cleanProduct(req.body || {}, db.products[i]);
  if (!p.name) return res.status(400).json({ error: 'შეიყვანე დასახელება.' });
  db.products[i] = p;
  await save();
  res.json(p);
});
app.delete('/api/admin/products/:id', auth, async (req, res) => {
  db.products = db.products.filter(p => p.id !== Number(req.params.id));
  await save();
  res.json({ ok: true });
});

app.patch('/api/admin/orders/:id', auth, async (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'შეკვეთა ვერ მოიძებნა.' });
  if (req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'უცნობი სტატუსი.' });
    // Stock is taken off when an order is completed, and returned if a completed order is reopened.
    const was = o.status, now = req.body.status;
    if (was !== 'done' && now === 'done') adjustStock(o, -1);
    if (was === 'done' && now !== 'done') adjustStock(o, +1);
    o.status = now;
  }
  if (req.body.note !== undefined) o.note = str(req.body.note, 1000);
  o.updatedAt = new Date().toISOString();
  await save();
  res.json(o);
});
function adjustStock(o, sign) {
  const brId = o.branch || db.branches[0]?.id;
  for (const it of o.items) {
    const p = db.products.find(x => x.id === it.id);
    if (p && brId) p.stock[brId] = Math.max(0, (p.stock[brId] || 0) + sign * it.qty);
  }
}
app.delete('/api/admin/orders/:id', auth, async (req, res) => {
  db.orders = db.orders.filter(o => o.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

app.patch('/api/admin/requests/:id', auth, async (req, res) => {
  const r = db.requests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'ვერ მოიძებნა.' });
  if (typeof req.body.done === 'boolean') r.done = req.body.done;
  await save();
  res.json(r);
});
app.delete('/api/admin/requests/:id', auth, async (req, res) => {
  db.requests = db.requests.filter(r => r.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

app.put('/api/admin/branches', auth, async (req, res) => {
  const list = Array.isArray(req.body) ? req.body.slice(0, 30) : null;
  if (!list) return res.status(400).json({ error: 'არასწორი მონაცემები.' });
  const hours = h => (Array.isArray(h) && h.length === 2) ? [num(h[0], 0, 24) ?? 9, num(h[1], 0, 24) ?? 19] : null;
  const branches = list.map(b => ({
    id: /^[a-z0-9_-]{1,20}$/.test(b.id) ? b.id : 'b' + crypto.randomBytes(3).toString('hex'),
    city: str(b.city, 40) || 'ზუგდიდი', name: str(b.name, 60), addr: str(b.addr, 120), phone: str(b.phone, 30),
    wk: hours(b.wk) || [9, 19], sun: hours(b.sun),
  })).filter(b => b.name);
  if (!branches.length) return res.status(400).json({ error: 'საჭიროა მინიმუმ ერთი ფილიალი.' });
  db.branches = branches;
  for (const p of db.products) { const s = {}; for (const b of branches) s[b.id] = p.stock[b.id] || 0; p.stock = s; }
  await save();
  res.json(db.branches);
});

app.put('/api/admin/settings', auth, async (req, res) => {
  const b = req.body || {};
  db.settings = {
    hotline: str(b.hotline, 40), email: str(b.email, 80), facebook: str(b.facebook, 120), hotlineHours: str(b.hotlineHours, 80),
    deliveryFee: num(b.deliveryFee, 0, 1000) ?? 5, freeDeliveryFrom: num(b.freeDeliveryFrom, 0, 100000) ?? 150, deliveryNote: str(b.deliveryNote, 160),
  };
  await save();
  res.json(db.settings);
});

app.post('/api/admin/upload', auth, async (req, res) => {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(req.body?.dataUrl || '');
  if (!m) return res.status(400).json({ error: 'ატვირთე PNG, JPG ან WEBP სურათი.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'სურათი 3 MB-ზე დიდია.' });
  const name = crypto.randomBytes(8).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buf);
  res.json({ url: '/uploads/' + name });
});

/* ----- HTTP server ----- */
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  enhance(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const p = new URL(req.url, 'http://localhost').pathname;
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
        req.body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        let i = 0;
        const next = async () => { const h = r.handlers[i++]; if (h) await h(req, res, next); };
        return await next();
      }
      return res.status(404).json({ error: 'not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    if (p.startsWith('/uploads/')) return serveStatic(UPLOAD_DIR, p.slice('/uploads'.length), res, 2592000);
    if (p === '/admin' || p === '/admin/') return sendFile(res, path.join(PUBLIC, 'admin.html'));
    if (p === '/') return sendFile(res, path.join(PUBLIC, 'index.html'));
    return serveStatic(PUBLIC, p, res, 3600);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.status === 413 ? 'ფაილი ძალიან დიდია.' : e.status === 400 ? 'არასწორი მოთხოვნა.' : 'სერვერის შეცდომა.' });
  }
});
server.listen(PORT, () => console.log(`Best Motors running on http://localhost:${PORT}  (admin: /admin)`));
