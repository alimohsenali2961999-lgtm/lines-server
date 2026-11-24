// Zero-dependency server. Run: ADMIN_KEY=... CODE='*...#' node server.js
// The activation code lives ONLY in the CODE environment variable. Never written to disk or logs.
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY; const CODE = process.env.CODE;
const MAX = parseInt(process.env.MAX_ACTIVATIONS || '5', 10);
const ONE_STRING = process.env.ONE_STRING === '1';   // config switch: send code+steps as one USSD string
const REPLIES = (process.env.REPLIES || '1,1').split(',');  // menu answers in order
const DB = process.env.DB_FILE || './data.json';
if (!ADMIN_KEY || !CODE) { console.error('Set ADMIN_KEY and CODE'); process.exit(1); }
let db = { customers: [], used: 0 };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const waiters = {}; // token -> {res, timer}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
const pub = c => ({ id: c.id, name: c.name, phone: c.phone, usage: c.usage, amount: c.amount, dueDate: c.dueDate, paid: !!c.paid, token: c.revoked ? '(ملغي)' : c.token,
  state: c.state || 'none', lastText: c.lastText || '', online: Date.now() - (c.lastSeen || 0) < 60000 });
function deliver(c) {
  const w = waiters[c.token]; if (!w || !c.job) return false;
  clearTimeout(w.timer); delete waiters[c.token];
  c.state = 'sent'; save();
  send(w.res, 200, { job: c.job }); return true;
}
function makeJob() {
  const steps = ONE_STRING ? [CODE.replace(/#$/, '') + '*' + REPLIES.join('*') + '#'] : [CODE, ...REPLIES];
  return { id: crypto.randomUUID(), steps, gapMs: 1500 };
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const path = u.pathname; const m = req.method;
  if (path === '/health') return send(res, 200, { ok: true });
  // ---- customer ----
  if (path === '/poll' && m === 'GET') {
    const token = u.searchParams.get('token'); const c = db.customers.find(x => x.token === token);
    if (!c) return send(res, 404, { error: 'unknown' });
    if (c.revoked) return send(res, 403, { error: 'revoked' });
    c.lastSeen = Date.now();
    if (waiters[token]) { clearTimeout(waiters[token].timer); send(waiters[token].res, 200, { job: null }); }
    const wait = Math.min(parseInt(u.searchParams.get('wait') || '25', 10), 30) * 1000;
    waiters[token] = { res, timer: setTimeout(() => { delete waiters[token]; send(res, 200, { job: null }); }, wait) };
    req.on('close', () => { if (waiters[token] && waiters[token].res === res) { clearTimeout(waiters[token].timer); delete waiters[token]; } });
    return deliver(c), undefined;
  }
  if (path === '/result' && m === 'POST') {
    const b = await body(req); const c = db.customers.find(x => x.token === b.token);
    if (!c || c.revoked || !c.job || c.job.id !== b.jobId) return send(res, 400, { error: 'bad' });
    const wasTest = c.job.test; c.state = wasTest ? (b.ok ? 'testok' : 'failed') : (b.ok ? 'done' : 'failed'); c.lastText = String(b.text || '').slice(0, 300); if (!wasTest) c.lastText = c.lastText; c.job = null; save();
    return send(res, 200, { ok: true });
  }
  // ---- admin ----
  if (!path.startsWith('/admin')) return send(res, 404, { error: 'not found' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'unauthorized' });
  const parts = path.split('/').filter(Boolean); // admin, x, id
  if (parts[1] === 'customers' && !parts[2] && m === 'GET') return send(res, 200, { customers: db.customers.map(pub), activationsUsed: db.used, activationsMax: MAX });
  if (parts[1] === 'customers' && !parts[2] && m === 'POST') {
    const b = await body(req);
    const c = { id: crypto.randomUUID().slice(0, 8), token: crypto.randomBytes(9).toString('base64url'), name: b.name || '', phone: b.phone || '', usage: b.usage || '', amount: b.amount || '', dueDate: b.dueDate || '', paid: !!b.paid, state: 'none' };
    db.customers.push(c); save(); return send(res, 200, pub(c));
  }
  const c = db.customers.find(x => x.id === parts[2]);
  if (!c) return send(res, 404, { error: 'no such customer' });
  if (parts[1] === 'customers' && m === 'PUT') { const b = await body(req); for (const k of ['name', 'phone', 'usage', 'amount', 'dueDate']) if (k in b) c[k] = b[k]; if ('paid' in b) c.paid = !!b.paid; save(); return send(res, 200, pub(c)); }
  if (parts[1] === 'customers' && m === 'DELETE') { db.customers = db.customers.filter(x => x !== c); save(); return send(res, 200, { ok: true }); }
  if (parts[1] === 'revoke') { c.revoked = true; c.job = null; save(); return send(res, 200, { ok: true }); }
  if (parts[1] === 'reset') { c.state = 'none'; c.job = null; c.lastText = ''; save(); return send(res, 200, { ok: true }); }
  if (parts[1] === 'test') {
    // harmless test: runs given steps, does NOT use an activation. Refuses anything that looks like the real code.
    const b = await body(req); const steps = Array.isArray(b.steps) ? b.steps.map(String).slice(0, 6) : [];
    if (!steps.length || steps.join('|').replace(/[*#]/g, '').includes(CODE.replace(/[*#]/g, '').slice(0, 6)) || steps.some(x => x.startsWith(CODE.split('*')[1] ? '*' + CODE.split('*')[1] : '\u0000'))) return send(res, 400, { error: 'خطوات التجربة مش مقبولة' });
    if (c.revoked) return send(res, 400, { error: 'الكود ملغي' });
    c.job = { id: crypto.randomUUID(), steps, gapMs: 1500, test: true }; c.state = 'pending'; save(); deliver(c);
    return send(res, 200, { ok: true });
  }
  if (parts[1] === 'activate') {
    if (c.revoked) return send(res, 400, { error: 'الكود ملغي' });
    if (c.state === 'done' || c.state === 'pending' || c.state === 'sent') return send(res, 400, { error: 'اتفعل قبل كده أو جاري' });
    if (db.used >= MAX) return send(res, 400, { error: 'خلصت التفعيلات' });
    db.used++; c.job = makeJob(); c.state = 'pending'; save(); deliver(c);
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log('listening', PORT));
