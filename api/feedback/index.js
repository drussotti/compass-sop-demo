/**
 * /api/feedback  -- durable feedback capture for the Compass demo.
 *
 *   GET    -> every item ever submitted, newest first (the Dev inbox)
 *   POST   -> save one item      { name, email, cat, page, msg, role, target, selector }
 *   PATCH  -> persist triage     { ids: [...], status?: 'New'|'Process'|'Ignore', archived?: bool }
 *
 * Storage is Azure Table Storage ('feedback' table). The connection string comes
 * from the FEEDBACK_CONN app setting on the Static Web App -- never from the repo.
 */
const { TableClient } = require('@azure/data-tables');

const TABLE = 'feedback';
const PK = 'demo';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

let _client = null;
let _ensured = false;

async function table() {
  if (!_client) {
    const cs = process.env.FEEDBACK_CONN;
    if (!cs) throw new Error('FEEDBACK_CONN app setting is not configured');
    _client = TableClient.fromConnectionString(cs, TABLE);
  }
  if (!_ensured) {
    try { await _client.createTable(); } catch (e) { /* already exists */ }
    _ensured = true;
  }
  return _client;
}

const clip = (v, n) => (v === null || v === undefined ? '' : String(v)).slice(0, n);
const CATS = ['Bug', 'Idea', 'Question'];
const STATUSES = ['New', 'Process', 'Ignore'];

function toItem(e) {
  return {
    id: e.rowKey,
    createdAt: e.createdAt || '',
    from: e.name || '(anonymous)',
    email: e.email || '',
    role: e.role || '',
    cat: e.cat || 'Idea',
    page: e.page || '',
    msg: e.msg || '',
    target: e.target || null,
    selector: e.selector || null,
    status: e.status || 'New',
    archived: !!e.archived
  };
}

async function list(t) {
  const out = [];
  for await (const e of t.listEntities()) out.push(toItem(e));
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

async function save(t, b) {
  const msg = clip(b.msg, 4000).trim();
  const name = clip(b.name, 120).trim();
  if (!msg) { const e = new Error('Feedback text is required'); e.status = 400; throw e; }
  if (!name) { const e = new Error('Your name is required'); e.status = 400; throw e; }
  const now = new Date().toISOString();
  const rowKey = now.replace(/[^0-9]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
  const entity = {
    partitionKey: PK,
    rowKey,
    createdAt: now,
    name,
    email: clip(b.email, 160).trim(),
    role: clip(b.role, 20),
    cat: CATS.includes(b.cat) ? b.cat : 'Idea',
    page: clip(b.page, 120),
    msg,
    target: clip(b.target, 300),
    selector: clip(b.selector, 400),
    status: 'New',
    archived: false
  };
  await t.createEntity(entity);
  return toItem(entity);
}

async function patch(t, b) {
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
  if (!ids.length) { const e = new Error('No ids supplied'); e.status = 400; throw e; }
  const change = {};
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) { const e = new Error('Bad status'); e.status = 400; throw e; }
    change.status = b.status;
  }
  if (b.archived !== undefined) change.archived = !!b.archived;
  if (!Object.keys(change).length) { const e = new Error('Nothing to change'); e.status = 400; throw e; }
  let n = 0;
  for (const id of ids) {
    try {
      await t.updateEntity({ partitionKey: PK, rowKey: String(id), ...change }, 'Merge');
      n++;
    } catch (e) { /* skip rows that vanished */ }
  }
  return n;
}

module.exports = async function (context, req) {
  const send = (status, body) => {
    context.res = { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
  };
  try {
    const t = await table();
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') return send(200, { items: await list(t) });
    if (method === 'POST') return send(200, { item: await save(t, req.body || {}) });
    if (method === 'PATCH') return send(200, { updated: await patch(t, req.body || {}) });
    return send(405, { error: 'Method not allowed' });
  } catch (err) {
    context.log('feedback error: ' + (err && err.stack ? err.stack : err));
    return send(err && err.status ? err.status : 500, { error: String((err && err.message) || err) });
  }
};
