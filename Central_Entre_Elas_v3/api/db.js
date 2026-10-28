// API da Central Entre Elas. Guarda os dados numa tabela "docs" do Supabase (Postgres).
// Variaveis de ambiente: TEAM_CODE, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (a integracao da Vercel cria as duas ultimas).
const fs = require('fs');
const path = require('path');

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const COLLS = ['tasks', 'events', 'shop', 'money', 'partners'];

const mem = {}; // so para teste local, sem Supabase
async function sb(method, query, body, prefer) {
  if (!SB_URL) { // modo memoria (teste)
    const q = new URLSearchParams(query || '');
    const eq = k => (q.get(k) || '').replace(/^eq\./, '');
    if (method === 'GET') {
      const c = eq('coll');
      return Object.entries(mem).filter(([k]) => !c || k.startsWith(c + '/')).map(([k, data]) => ({ coll: k.split('/')[0], id: k.split('/')[1], data }));
    }
    if (method === 'POST') { for (const r of body) mem[r.coll + '/' + r.id] = r.data; return null; }
    if (method === 'DELETE') { delete mem[eq('coll') + '/' + eq('id')]; return null; }
  }
  const r = await fetch(SB_URL + '/rest/v1/docs' + (query ? '?' + query : ''), {
    method,
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: prefer || 'return=minimal' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return method === 'GET' ? r.json() : null;
}

function merge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && v.__delete__ === true) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(out[k] && typeof out[k] === 'object' ? out[k] : {}, v);
    else out[k] = v;
  }
  return out;
}

async function seedIfEmpty() {
  const m = await sb('GET', 'select=id&coll=eq.meta&id=eq.seeded');
  if (m && m.length) return;
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'seed.json'), 'utf8'));
    const rows = [];
    for (const c of COLLS) for (const [id, doc] of Object.entries(seed[c] || {})) rows.push({ coll: c, id, data: doc });
    if (rows.length) await sb('POST', 'on_conflict=coll,id', rows, 'resolution=ignore-duplicates,return=minimal');
  } catch (_) {}
  await sb('POST', 'on_conflict=coll,id', [{ coll: 'meta', id: 'seeded', data: { ok: true } }], 'resolution=ignore-duplicates,return=minimal');
}

async function readAll() {
  const rows = (await sb('GET', 'select=coll,id,data&coll=in.(' + COLLS.join(',') + ')&limit=5000')) || [];
  const out = {}; COLLS.forEach(c => out[c] = {});
  for (const r of rows) if (out[r.coll]) out[r.coll][r.id] = r.data;
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = process.env.TEAM_CODE || require('./config.js').code;
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
      if (op === 'delete') await sb('DELETE', 'coll=eq.' + c + '&id=eq.' + encodeURIComponent(id));
      else if (op === 'set' || op === 'update') {
        let doc = data || {};
        if (op === 'update') {
          const cur = await sb('GET', 'select=data&coll=eq.' + c + '&id=eq.' + encodeURIComponent(id));
          doc = merge(cur && cur[0] ? cur[0].data : {}, data || {});
        }
        if (JSON.stringify(doc).length > 900000) return res.status(413).json({ error: 'grande' });
        await sb('POST', 'on_conflict=coll,id', [{ coll: c, id, data: doc }], 'resolution=merge-duplicates,return=minimal');
      } else return res.status(400).json({ error: 'op' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: 'servidor' });
  }
};
