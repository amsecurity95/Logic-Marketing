CREATE TABLE IF NOT EXISTS team (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'Editor',
  title        TEXT DEFAULT '',
  phone        TEXT DEFAULT '',
  color        TEXT DEFAULT '#d30000',
  avatar_url   TEXT DEFAULT '',
  joined_at    DATE DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  contact    TEXT DEFAULT '',
  email      TEXT DEFAULT '',
  phone      TEXT DEFAULT '',
  industry   TEXT DEFAULT '',
  type       TEXT NOT NULL DEFAULT 'client',     -- client | prospect
  status     TEXT NOT NULL DEFAULT 'active',     -- active | pending | archived
  stage      TEXT NOT NULL DEFAULT 'lead',       -- lead | discovery | proposal | in_progress | delivered
  value      NUMERIC DEFAULT 0,
  since      DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id        BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'planned',     -- planned | in_progress | done
  value     NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id   BIGINT REFERENCES team(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  text        TEXT NOT NULL,
  ts          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equipment (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT DEFAULT 'other',
  price      NUMERIC NOT NULL,
  saved      NUMERIC NOT NULL DEFAULT 0,
  img_url    TEXT DEFAULT '',
  acquired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbox (
  id        BIGSERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  email     TEXT NOT NULL,
  company   TEXT DEFAULT '',
  service   TEXT DEFAULT '',
  message   TEXT NOT NULL,
  source    TEXT DEFAULT 'Contact form',
  page      TEXT DEFAULT '',
  referrer  TEXT DEFAULT '',
  ip        INET,
  city      TEXT DEFAULT '',
  country   TEXT DEFAULT '',
  flag      TEXT DEFAULT '',
  language  TEXT DEFAULT '',
  read_at   TIMESTAMPTZ,
  ts        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  channel     TEXT NOT NULL,                     -- 'general' or 'dm:<id>-<id>'
  from_id     BIGINT REFERENCES team(id) ON DELETE SET NULL,
  from_name   TEXT NOT NULL,
  from_color  TEXT DEFAULT '#d30000',
  from_avatar TEXT DEFAULT '',
  text        TEXT NOT NULL,
  ts          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel, ts);

CREATE TABLE IF NOT EXISTS visits (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ DEFAULT now(),
  session_id   TEXT,
  ip           INET,
  city         TEXT DEFAULT '',
  region       TEXT DEFAULT '',
  country      TEXT DEFAULT '',
  country_code TEXT DEFAULT '',
  flag         TEXT DEFAULT '',
  page         TEXT DEFAULT '',
  path         TEXT DEFAULT '',
  referrer     TEXT DEFAULT '',
  user_agent   TEXT DEFAULT '',
  language     TEXT DEFAULT '',
  screen       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_session ON visits(session_id);

CREATE TABLE IF NOT EXISTS clicks (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ DEFAULT now(),
  session_id TEXT,
  ip         INET,
  page       TEXT DEFAULT '',
  target     TEXT DEFAULT '',
  href       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_clicks_ts ON clicks(ts);

-- Finance: company-wide revenue + expenses
CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,                       -- 'revenue' | 'expense'
  amount      NUMERIC NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  description TEXT NOT NULL,
  category    TEXT DEFAULT '',                     -- e.g. 'project', 'software', 'rent', 'travel'
  client_id   BIGINT REFERENCES clients(id) ON DELETE SET NULL,
  occurred_on DATE DEFAULT CURRENT_DATE,
  created_by  BIGINT REFERENCES team(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_kind_date ON transactions(kind, occurred_on);

-- Payroll: payments to team members
CREATE TABLE IF NOT EXISTS payments (
  id          BIGSERIAL PRIMARY KEY,
  team_id     BIGINT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  period      TEXT DEFAULT '',                     -- e.g. '2026-04' or 'one-off'
  description TEXT DEFAULT '',
  paid_on     DATE DEFAULT CURRENT_DATE,
  paid_by     BIGINT REFERENCES team(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_team_date ON payments(team_id, paid_on);

-- Generic shared key/value store used by the front-end cloudSync system.
-- Lets clients/inbox/channels/transactions/payments/todos persist + sync across users
-- without needing per-table CRUD endpoints.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  data  JSONB,
  ts    BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Extend messages with attachments + reactions JSON blobs (idempotent for older DBs).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions   JSONB DEFAULT '{}'::jsonb;

-- Multi-site tracking: tag every visit/click with the originating site.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS site TEXT DEFAULT 'logicmarketing';
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS site TEXT DEFAULT 'logicmarketing';
CREATE INDEX IF NOT EXISTS idx_visits_site_ts ON visits(site, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_site_ts ON clicks(site, ts);
