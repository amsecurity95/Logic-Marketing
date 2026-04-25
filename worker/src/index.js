// Logic Marketing — R2-backed JSON store
// Routes:
//   GET  /api/store           → { keys: [...], updatedAt: {...} }   (manifest)
//   GET  /api/store/:key      → { ts, data }                        (single blob)
//   PUT  /api/store/:key      body { ts, data }                     (write blob)
//   GET  /api/health          → "ok"
//
// All /api/store requests require:   Authorization: Bearer <AUTH_TOKEN>

const ALLOWED_KEYS = new Set([
  'clients', 'equipment', 'inbox', 'team', 'messages',
  'channels', 'transactions', 'payments'
]);

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(extra) },
  });
const err = (msg, status) => json({ error: msg }, status);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(req.url);
    if (url.pathname === '/api/health') {
      return new Response('ok', { headers: cors({ 'Content-Type': 'text/plain' }) });
    }
    if (!url.pathname.startsWith('/api/store')) return err('Not found', 404);

    const auth = req.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.AUTH_TOKEN}`) return err('Unauthorized', 401);

    const prefix = env.PREFIX || 'logic-marketing/';
    const segments = url.pathname.replace('/api/store', '').split('/').filter(Boolean);

    // Manifest: GET /api/store
    if (segments.length === 0 && req.method === 'GET') {
      const list = await env.STORE.list({ prefix });
      const updatedAt = {};
      for (const obj of list.objects) {
        const key = obj.key.slice(prefix.length).replace(/\.json$/, '');
        if (ALLOWED_KEYS.has(key)) updatedAt[key] = obj.uploaded.getTime();
      }
      return json({ keys: Object.keys(updatedAt), updatedAt });
    }

    if (segments.length !== 1) return err('Bad path', 400);
    const key = segments[0];
    if (!ALLOWED_KEYS.has(key)) return err('Unknown key', 400);
    const objectKey = `${prefix}${key}.json`;

    if (req.method === 'GET') {
      const obj = await env.STORE.get(objectKey);
      if (!obj) return json({ ts: 0, data: null });
      const text = await obj.text();
      try { return json(JSON.parse(text)); }
      catch { return json({ ts: obj.uploaded.getTime(), data: null }); }
    }

    if (req.method === 'PUT') {
      let body;
      try { body = await req.json(); }
      catch { return err('Bad JSON', 400); }
      if (typeof body !== 'object' || body === null) return err('Bad body', 400);
      const payload = { ts: Number(body.ts) || Date.now(), data: body.data ?? null };
      await env.STORE.put(objectKey, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true, ts: payload.ts });
    }

    return err('Method not allowed', 405);
  },
};
