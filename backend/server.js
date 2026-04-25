import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const TOKEN_TTL = '7d';

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

// Auto-run schema on boot so first deploy creates tables.
try {
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✅ Schema verified');
} catch (e) {
  console.error('❌ Schema check failed:', e.message);
}

const app = express();
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false })); // CSP set per-page in HTML
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

// ============================================================
// Helpers
// ============================================================
const sign = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, name: user.name },
  JWT_SECRET, { expiresIn: TOKEN_TTL }
);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
const ip = (req) => (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email + password required' });

  const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM team');
  // BOOTSTRAP: first user becomes Admin automatically
  if (count[0].n === 0) {
    const name = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO team (name, email, password_hash, role, title)
       VALUES ($1,$2,$3,'Admin','Founder') RETURNING id, name, email, role, title, color, avatar_url`,
      [name, email, hash]
    );
    const user = rows[0];
    return res.json({ token: sign(user), user, bootstrapped: true });
  }

  const { rows } = await pool.query(
    `SELECT id, name, email, password_hash, role, title, color, avatar_url
     FROM team WHERE LOWER(email) = $1`, [email]
  );
  if (!rows.length) return res.status(401).json({ error: 'No account for that email' });
  const u = rows[0];
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  delete u.password_hash;
  res.json({ token: sign(u), user: u });
});

app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, title, phone, color, avatar_url, joined_at FROM team WHERE id = $1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Account removed' });
  res.json(rows[0]);
});

app.put('/api/me', auth, async (req, res) => {
  const { name, title, email, phone, color, avatar_url } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE team SET name=COALESCE($2,name), title=COALESCE($3,title),
       email=COALESCE($4,email), phone=COALESCE($5,phone),
       color=COALESCE($6,color), avatar_url=COALESCE($7,avatar_url)
     WHERE id=$1 RETURNING id, name, email, role, title, phone, color, avatar_url`,
    [req.user.id, name, title, email, phone, color, avatar_url]
  );
  res.json(rows[0]);
});

app.post('/api/me/password', auth, async (req, res) => {
  const { current, next: newPwd } = req.body || {};
  if (!newPwd || newPwd.length < 4) return res.status(400).json({ error: 'Password too short' });
  const { rows } = await pool.query('SELECT password_hash FROM team WHERE id=$1', [req.user.id]);
  if (!await bcrypt.compare(current || '', rows[0].password_hash)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }
  await pool.query('UPDATE team SET password_hash=$2 WHERE id=$1', [req.user.id, await bcrypt.hash(newPwd, 12)]);
  res.json({ ok: true });
});

// ============================================================
// TEAM
// ============================================================
app.get('/api/team', auth, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, title, phone, color, avatar_url, joined_at FROM team ORDER BY id`
  );
  res.json(rows);
});

app.post('/api/team', auth, adminOnly, async (req, res) => {
  const { name, email, password, role = 'Editor', title = '', phone = '', color = '#d30000' } = req.body || {};
  if (!name || !email || !password || password.length < 4) {
    return res.status(400).json({ error: 'Name, email, and a 4+ char password required' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO team (name, email, password_hash, role, title, phone, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, email, role, title, phone, color, avatar_url, joined_at`,
      [name, email.toLowerCase(), hash, role, title, phone, color]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    throw e;
  }
});

app.put('/api/team/:id', auth, adminOnly, async (req, res) => {
  const { name, email, role, title, phone, color, password } = req.body || {};
  const id = Number(req.params.id);
  await pool.query(
    `UPDATE team SET name=COALESCE($2,name), email=COALESCE($3,email), role=COALESCE($4,role),
       title=COALESCE($5,title), phone=COALESCE($6,phone), color=COALESCE($7,color)
     WHERE id=$1`,
    [id, name, email?.toLowerCase(), role, title, phone, color]
  );
  if (password && password.length >= 4) {
    await pool.query('UPDATE team SET password_hash=$2 WHERE id=$1', [id, await bcrypt.hash(password, 12)]);
  }
  res.json({ ok: true });
});

app.delete('/api/team/:id', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "Can't remove yourself" });
  await pool.query('DELETE FROM team WHERE id=$1', [id]);
  res.json({ ok: true });
});

// ============================================================
// CLIENTS + JOBS + NOTES
// ============================================================
app.get('/api/clients', auth, async (_req, res) => {
  const { rows: clients } = await pool.query(`SELECT * FROM clients ORDER BY id DESC`);
  const { rows: jobs } = await pool.query(`SELECT * FROM jobs ORDER BY id`);
  const { rows: notes } = await pool.query(`SELECT * FROM notes ORDER BY ts DESC`);
  res.json(clients.map(c => ({
    ...c,
    jobs: jobs.filter(j => j.client_id === c.id),
    notes: notes.filter(n => n.client_id === c.id)
  })));
});

app.post('/api/clients', auth, async (req, res) => {
  const c = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO clients (name, contact, email, phone, industry, type, status, stage, value, since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,CURRENT_DATE)) RETURNING *`,
    [c.name, c.contact || '', c.email || '', c.phone || '', c.industry || '',
     c.type || 'client', c.status || 'active', c.stage || 'lead', c.value || 0, c.since]
  );
  if (c.firstJob) {
    await pool.query(`INSERT INTO jobs (client_id, title) VALUES ($1, $2)`, [rows[0].id, c.firstJob]);
  }
  await pool.query(
    `INSERT INTO notes (client_id, author_id, author_name, text)
     VALUES ($1, $2, $3, $4)`,
    [rows[0].id, req.user.id, req.user.name, `Added as ${c.type || 'client'}.`]
  );
  res.json(rows[0]);
});

app.put('/api/clients/:id', auth, async (req, res) => {
  const c = req.body || {};
  const id = Number(req.params.id);
  await pool.query(
    `UPDATE clients SET name=COALESCE($2,name), contact=COALESCE($3,contact), email=COALESCE($4,email),
       phone=COALESCE($5,phone), industry=COALESCE($6,industry), type=COALESCE($7,type),
       status=COALESCE($8,status), stage=COALESCE($9,stage), value=COALESCE($10,value)
     WHERE id=$1`,
    [id, c.name, c.contact, c.email, c.phone, c.industry, c.type, c.status, c.stage, c.value]
  );
  res.json({ ok: true });
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post('/api/clients/:id/jobs', auth, async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO jobs (client_id, title, status, value) VALUES ($1, $2, $3, $4) RETURNING *`,
    [Number(req.params.id), req.body.title, req.body.status || 'planned', req.body.value || 0]
  );
  res.json(rows[0]);
});
app.put('/api/jobs/:id', auth, async (req, res) => {
  await pool.query(
    `UPDATE jobs SET title=COALESCE($2,title), status=COALESCE($3,status), value=COALESCE($4,value) WHERE id=$1`,
    [Number(req.params.id), req.body.title, req.body.status, req.body.value]
  );
  res.json({ ok: true });
});
app.delete('/api/jobs/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM jobs WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post('/api/clients/:id/notes', auth, async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO notes (client_id, author_id, author_name, text) VALUES ($1, $2, $3, $4) RETURNING *`,
    [Number(req.params.id), req.user.id, req.user.name, req.body.text]
  );
  res.json(rows[0]);
});
app.delete('/api/notes/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM notes WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================
// EQUIPMENT
// ============================================================
app.get('/api/equipment', auth, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM equipment ORDER BY id DESC');
  res.json(rows);
});
app.post('/api/equipment', auth, async (req, res) => {
  const e = req.body || {};
  const acquired = (e.saved >= e.price) ? 'now()' : 'NULL';
  const { rows } = await pool.query(
    `INSERT INTO equipment (name, category, price, saved, img_url, acquired_at)
     VALUES ($1, $2, $3, $4, $5, ${acquired === 'NULL' ? 'NULL' : 'now()'}) RETURNING *`,
    [e.name, e.category || 'other', e.price, e.saved || 0, e.img_url || '']
  );
  res.json(rows[0]);
});
app.put('/api/equipment/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const e = req.body || {};
  // Recompute acquired_at when saved crosses price
  const existing = (await pool.query('SELECT price, saved, acquired_at FROM equipment WHERE id=$1', [id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const nextSaved = e.saved != null ? e.saved : existing.saved;
  const nextPrice = e.price != null ? e.price : existing.price;
  const acquired = nextSaved >= nextPrice ? (existing.acquired_at || new Date()) : null;
  await pool.query(
    `UPDATE equipment SET name=COALESCE($2,name), category=COALESCE($3,category),
       price=COALESCE($4,price), saved=COALESCE($5,saved), img_url=COALESCE($6,img_url),
       acquired_at=$7
     WHERE id=$1`,
    [id, e.name, e.category, e.price, e.saved, e.img_url, acquired]
  );
  res.json({ ok: true });
});
app.delete('/api/equipment/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM equipment WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================
// INBOX  (POST is PUBLIC — used by website contact form)
// ============================================================
app.post('/api/inbox', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email || !b.message) return res.status(400).json({ error: 'Missing fields' });
  const { rows } = await pool.query(
    `INSERT INTO inbox (name, email, company, service, message, source, page, referrer, ip, city, country, flag, language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, ts`,
    [b.name, b.email, b.company || '', b.service || '', b.message,
     b.source || 'Contact form', b.page || '', b.referrer || '',
     ip(req) || null, b.city || '', b.country || '', b.flag || '', b.language || '']
  );
  res.json(rows[0]);
});

app.get('/api/inbox', auth, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM inbox ORDER BY ts DESC LIMIT 500');
  res.json(rows);
});
app.patch('/api/inbox/:id/read', auth, async (req, res) => {
  await pool.query('UPDATE inbox SET read_at=now() WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});
app.post('/api/inbox/read-all', auth, async (_req, res) => {
  await pool.query('UPDATE inbox SET read_at=now() WHERE read_at IS NULL');
  res.json({ ok: true });
});
app.delete('/api/inbox/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM inbox WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================
// MESSAGES (chat)
// ============================================================
app.get('/api/messages', auth, async (req, res) => {
  const channel = String(req.query.channel || 'general');
  const since = req.query.since ? new Date(Number(req.query.since)) : new Date(0);
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE channel=$1 AND ts > $2 ORDER BY ts ASC LIMIT 500`,
    [channel, since]
  );
  res.json(rows);
});
app.post('/api/messages', auth, async (req, res) => {
  const me = (await pool.query('SELECT name, color, avatar_url FROM team WHERE id=$1', [req.user.id])).rows[0];
  const { rows } = await pool.query(
    `INSERT INTO messages (channel, from_id, from_name, from_color, from_avatar, text)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.body.channel, req.user.id, me.name, me.color, me.avatar_url, req.body.text]
  );
  res.json(rows[0]);
});

// ============================================================
// TRACKING (PUBLIC — called from website)
// ============================================================
app.post('/api/track/visit', async (req, res) => {
  const v = req.body || {};
  await pool.query(
    `INSERT INTO visits (session_id, ip, city, region, country, country_code, flag, page, path, referrer, user_agent, language, screen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [v.sessionId, ip(req) || null, v.city || '', v.region || '', v.country || '',
     v.country_code || '', v.flag || '', v.page || '', v.path || '',
     v.referrer || '', (v.ua || '').slice(0, 300), v.lang || '', v.screen || '']
  );
  res.json({ ok: true });
});
app.post('/api/track/click', async (req, res) => {
  const c = req.body || {};
  await pool.query(
    `INSERT INTO clicks (session_id, ip, page, target, href) VALUES ($1,$2,$3,$4,$5)`,
    [c.sessionId, ip(req) || null, c.page || '', (c.target || '').slice(0, 200), (c.href || '').slice(0, 500)]
  );
  res.json({ ok: true });
});

// ============================================================
// ANALYTICS aggregation
// ============================================================
app.get('/api/analytics/overview', auth, async (_req, res) => {
  const since30 = "now() - interval '30 days'";
  const [{ rows: vTotal }, { rows: sessTotal }, { rows: clkTotal }, { rows: daily }, { rows: geo }, { rows: pages }, { rows: recent }] =
    await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM visits WHERE ts > ${since30}`),
      pool.query(`SELECT COUNT(DISTINCT session_id)::int AS n FROM visits WHERE ts > ${since30}`),
      pool.query(`SELECT COUNT(*)::int AS n FROM clicks WHERE ts > ${since30}`),
      pool.query(`
        SELECT date_trunc('day', ts) AS day, COUNT(DISTINCT session_id)::int AS sessions
        FROM visits WHERE ts > ${since30} GROUP BY 1 ORDER BY 1`),
      pool.query(`
        SELECT city, country, flag, COUNT(*)::int AS n FROM visits
        WHERE ts > ${since30} AND city <> ''
        GROUP BY city, country, flag ORDER BY n DESC LIMIT 10`),
      pool.query(`
        SELECT v.page,
          COUNT(*)::int AS views,
          (SELECT COUNT(*)::int FROM clicks c WHERE c.page = v.page AND c.ts > ${since30}) AS clicks
        FROM visits v WHERE ts > ${since30}
        GROUP BY v.page ORDER BY views DESC LIMIT 10`),
      pool.query(`SELECT ip, city, country, flag, page, referrer, ts FROM visits ORDER BY ts DESC LIMIT 25`)
    ]);
  res.json({
    pageViews: vTotal[0].n,
    sessions: sessTotal[0].n,
    clicks: clkTotal[0].n,
    daily, geo, pages, recent
  });
});

// ============================================================
// FINANCE — Transactions (revenue + expenses)
// ============================================================
app.get('/api/finance/overview', auth, adminOnly, async (_req, res) => {
  const [{ rows: rev }, { rows: exp }, { rows: pay }, { rows: byMember }, { rows: monthly }] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM transactions WHERE kind='revenue'`),
    pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM transactions WHERE kind='expense'`),
    pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments`),
    pool.query(`
      SELECT t.id, t.name, t.email, t.color, t.avatar_url,
        COALESCE(SUM(p.amount),0)::numeric AS paid
      FROM team t LEFT JOIN payments p ON p.team_id = t.id
      GROUP BY t.id ORDER BY paid DESC NULLS LAST, t.name`),
    pool.query(`
      SELECT to_char(date_trunc('month', occurred_on), 'YYYY-MM') AS month,
        SUM(CASE WHEN kind='revenue' THEN amount ELSE 0 END)::numeric AS revenue,
        SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END)::numeric AS expense
      FROM transactions
      WHERE occurred_on > now() - interval '12 months'
      GROUP BY 1 ORDER BY 1`)
  ]);
  const revenue = Number(rev[0].total);
  const expenses = Number(exp[0].total);
  const payroll = Number(pay[0].total);
  res.json({
    revenue, expenses, payroll,
    netProfit: revenue - expenses - payroll,
    byMember: byMember.map(r => ({ ...r, paid: Number(r.paid) })),
    monthly: monthly.map(r => ({ month: r.month, revenue: Number(r.revenue), expense: Number(r.expense) }))
  });
});

app.get('/api/finance/transactions', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT t.*, c.name AS client_name, u.name AS created_by_name
    FROM transactions t
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN team u ON u.id = t.created_by
    ORDER BY occurred_on DESC, id DESC LIMIT 500`);
  res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
});

app.post('/api/finance/transactions', auth, adminOnly, async (req, res) => {
  const t = req.body || {};
  if (!['revenue', 'expense'].includes(t.kind)) return res.status(400).json({ error: 'Invalid kind' });
  if (!t.amount || !t.description) return res.status(400).json({ error: 'Amount and description required' });
  const { rows } = await pool.query(
    `INSERT INTO transactions (kind, amount, currency, description, category, client_id, occurred_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),$8) RETURNING *`,
    [t.kind, t.amount, t.currency || 'USD', t.description, t.category || '', t.client_id || null, t.occurred_on || null, req.user.id]
  );
  res.json(rows[0]);
});

app.delete('/api/finance/transactions/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM transactions WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================
// FINANCE — Payments (payroll). Admin sees/edits all; others only their own.
// ============================================================
app.get('/api/finance/payments', auth, async (req, res) => {
  if (req.user.role === 'Admin') {
    const { rows } = await pool.query(`
      SELECT p.*, t.name AS team_name, t.email AS team_email,
        b.name AS paid_by_name
      FROM payments p
      LEFT JOIN team t ON t.id = p.team_id
      LEFT JOIN team b ON b.id = p.paid_by
      ORDER BY paid_on DESC, id DESC LIMIT 500`);
    res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
  } else {
    const { rows } = await pool.query(
      `SELECT id, amount, currency, period, description, paid_on FROM payments
       WHERE team_id=$1 ORDER BY paid_on DESC, id DESC`,
      [req.user.id]
    );
    res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
  }
});

app.post('/api/finance/payments', auth, adminOnly, async (req, res) => {
  const p = req.body || {};
  if (!p.team_id || !p.amount) return res.status(400).json({ error: 'team_id and amount required' });
  const { rows } = await pool.query(
    `INSERT INTO payments (team_id, amount, currency, period, description, paid_on, paid_by)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,CURRENT_DATE),$7) RETURNING *`,
    [p.team_id, p.amount, p.currency || 'USD', p.period || '', p.description || '', p.paid_on || null, req.user.id]
  );
  res.json(rows[0]);
});

app.delete('/api/finance/payments/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM payments WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// Personal earnings — accessible to any authenticated user.
app.get('/api/finance/my-earnings', auth, async (req, res) => {
  const { rows: total } = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM payments WHERE team_id=$1`,
    [req.user.id]
  );
  const { rows: history } = await pool.query(
    `SELECT id, amount, currency, period, description, paid_on FROM payments
     WHERE team_id=$1 ORDER BY paid_on DESC, id DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({
    total: Number(total[0].total),
    history: history.map(r => ({ ...r, amount: Number(r.amount) }))
  });
});

// ============================================================
// STATIC SITE — clean URLs (no .html, no /index.html)
// ============================================================
// 301-redirect ugly URLs to clean ones so the address bar always shows
// the canonical path.
app.get(['/index.html', '/index'], (_req, res) => res.redirect(301, '/'));
app.get('/:page.html', (req, res, next) => {
  // Redirect /admin.html → /admin, /login.html → /login, etc.
  // Skip if the file doesn't exist so 404s still surface.
  const file = path.join(__dirname, 'public', req.params.page + '.html');
  if (!existsSync(file)) return next();
  res.redirect(301, '/' + req.params.page);
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`🚀 Logic Marketing API on :${PORT}`));
