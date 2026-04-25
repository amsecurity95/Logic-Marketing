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
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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

    // Public contact form intake — no auth required.
    if (url.pathname === '/api/inbox' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return err('Bad JSON', 400); }
      if (!body || typeof body !== 'object') return err('Bad body', 400);
      // Honeypot
      if (typeof body.website === 'string' && body.website.length > 0) {
        return json({ ok: true });
      }
      const clean = (s, max = 1000) => String(s == null ? '' : s).slice(0, max);
      const name = clean(body.name, 200).trim();
      const email = clean(body.email, 200).trim();
      const message = clean(body.message, 4000).trim();
      if (!name || !email || !message) return err('Missing required fields', 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email', 400);

      const prefix = env.PREFIX || 'logic-marketing/';
      const objectKey = `${prefix}inbox.json`;
      const existing = await env.STORE.get(objectKey);
      let payload = { ts: 0, data: [] };
      if (existing) {
        try {
          payload = JSON.parse(await existing.text());
          if (!Array.isArray(payload.data)) payload.data = [];
        } catch { payload = { ts: 0, data: [] }; }
      }
      const now = Date.now();
      const entry = {
        id: now,
        from: name,
        email,
        company: clean(body.company, 200).trim(),
        service: clean(body.service, 100).trim(),
        subject: clean(body.subject, 200).trim() || (clean(body.service, 100).trim() || 'Contact form'),
        body: message,
        message,
        source: clean(body.source, 200).trim() || 'Contact form',
        page: clean(body.page, 200).trim(),
        referrer: clean(body.referrer, 500).trim() || (req.headers.get('Referer') || 'direct'),
        ip: req.headers.get('CF-Connecting-IP') || '',
        city: req.headers.get('CF-IPCity') || '',
        country: req.headers.get('CF-IPCountry') || '',
        ua: clean(req.headers.get('User-Agent') || '', 300),
        lang: clean(body.lang, 20),
        read: false,
        ts: now,
      };
      payload.data.unshift(entry);
      // Cap at 1000 entries to keep blob small
      if (payload.data.length > 1000) payload.data.length = 1000;
      payload.ts = now;
      await env.STORE.put(objectKey, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true });
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
