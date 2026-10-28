// API simples da Central Entre Elas. Guarda cada colecao como um "hash" no Redis (Upstash).
// Variaveis de ambiente: TEAM_CODE (codigo da equipe) e as do Upstash/Vercel KV.
const fs = require('fs');
const path = require('path');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const COLLS = ['tasks', 'events', 'shop', 'money', 'partners'];

const mem = {}; // so para teste local, sem Redis
async function redis(cmd) {
  if (!URL_) {
    const [op, key, ...a] = cmd;
    mem[key] = mem[key] || {};
    if (op === 'HGETALL') return Object.entries(mem[key]).flat();
    if (op === 'HSET') { mem[key][a[0]] = a[1]; return 1; }
    if (op === 'HGET') return mem[key][a[0]] ?? null;
    if (op === 'HDEL') { delete mem[key][a[0]]; return 1; }
    if (op === 'GET') return mem[key].v ?? null;
    if (op === 'SET') { mem[key].v = a[0]; return 'OK'; }
    throw new Error('op');
  }
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function merge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.__delete__ !== true) out[k] = merge(out[k] && typeof out[k] === 'object' ? out[k] : {}, v);
    else if (v && v.__delete__ === true) delete out[k];
    else out[k] = v;
  }
  return out;
}

async function seedIfEmpty() {
  if (await redis(['GET', 'meta:seeded'])) return;
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'seed.json'), 'utf8'));
    for (const c of COLLS) for (const [id, doc] of Object.entries(seed[c] || {})) await redis(['HSET', 'col:' + c, id, JSON.stringify(doc)]);
  } catch (_) {}
  await redis(['SET', 'meta:seeded', '1']);
}

async function readAll() {
  const out = {};
  for (const c of COLLS) {
    const flat = (await redis(['HGETALL', 'col:' + c])) || [];
    const o = {};
    for (let i = 0; i < flat.length; i += 2) { try { o[flat[i]] = JSON.parse(flat[i + 1]); } catch (_) {} }
    out[c] = o;
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = process.env.TEAM_CODE;
  if (!code) return res.status(500).json({ error: 'TEAM_CODE nao configurado' });
  if (req.headers['x-team-code'] !== code) return res.status(401).json({ error: 'codigo' });
  try {
    if (req.method === 'GET') {
      await seedIfEmpty();
      return res.status(200).json(await readAll());
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const { c, id, op, data } = b;
      if (!COLLS.includes(c) || !/^[\w.-]{1,80}$/.test(id || '')) return res.status(400).json({ error: 'dados' });
      const key = 'col:' + c;
      if (op === 'delete') await redis(['HDEL', key, id]);
      else if (op === 'set' || op === 'update') {
        let doc = data || {};
        if (op === 'update') { const cur = await redis(['HGET', key, id]); doc = merge(cur ? JSON.parse(cur) : {}, data || {}); }
        const s = JSON.stringify(doc);
        if (s.length > 900000) return res.status(413).json({ error: 'grande' });
        await redis(['HSET', key, id, s]);
      } else return res.status(400).json({ error: 'op' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: 'servidor' });
  }
};
