# Logic Marketing — Backend (Express + Postgres)

Node.js API + static site host for the Logic Marketing internal control panel. Replaces the localStorage-only setup with real server-side auth (bcrypt + JWT), persistent storage, and cross-device sync.

## Stack
- **Node 18+ / Express** — API + static file server
- **Postgres (Railway)** — single source of truth for all data
- **bcryptjs / jsonwebtoken** — password hashing + session tokens
- **helmet / CORS** — basic security headers

## Project layout
```
backend/
├── server.js        # All routes
├── schema.sql       # Tables (auto-applied on boot)
├── migrate.js       # Standalone schema runner (optional)
├── package.json
├── .env.example
└── public/          # admin.html, login.html, index.html + assets
```

## Deploy to Railway

1. **Create the service.** In your Railway project → New → Empty Service → name it `logic-marketing-api`.
2. **Connect this repo / folder.** Either push the `backend/` folder to a GitHub repo and link it, or `railway link` from this directory and `railway up`.
3. **Set variables** in the Railway dashboard → Variables tab:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | (already set by Railway when you add Postgres) |
   | `JWT_SECRET` | a long random string (use `openssl rand -hex 32`) |
   | `PORT` | `3000` (Railway sets this automatically) |
   | `PGSSL` | leave unset, or `true` |

   The `DATABASE_URL` you provided uses `postgres.railway.internal` — that's the **private** hostname. It only resolves from inside Railway's private network, so the API service must be in the same Railway project as the Postgres database. Add the Postgres database as a service in this project, then attach it to your API service so `DATABASE_URL` is injected automatically.

4. **Deploy.** Railway will run `npm install && npm start`. On first boot the server applies `schema.sql` automatically — no separate migration step needed.

5. **First login = your Admin account.** Open `https://YOUR-RAILWAY-URL/login.html` and sign in with any email + password ≥ 4 chars. The first sign-in creates the Admin account in the `team` table. Returning users must use those credentials. Add more team members from inside the panel under **Team → + Add Member**.

## Local dev (against a separate Postgres)

```bash
cd backend
cp .env.example .env
# edit .env to point at a local Postgres or a dev branch on Railway
npm install
npm run migrate     # one-time table create (optional — server.js also runs it)
npm start
```

Visit `http://localhost:3000/login.html`.

## API endpoints

### Auth
- `POST /api/auth/login` `{email, password}` → `{token, user, bootstrapped?}`
- `GET  /api/me` (auth)
- `PUT  /api/me` (auth) — update profile
- `POST /api/me/password` (auth) `{current, next}`

### Team (Admin only for write)
- `GET    /api/team`
- `POST   /api/team` `{name,email,password,role,title,phone,color}`
- `PUT    /api/team/:id`
- `DELETE /api/team/:id`

### CRM
- `GET    /api/clients` — returns clients with their jobs[] and notes[] joined
- `POST   /api/clients` `{name,contact,email,phone,industry,type,status,stage,value,since,firstJob}`
- `PUT    /api/clients/:id`
- `DELETE /api/clients/:id`
- `POST   /api/clients/:id/jobs` `{title,status,value}`
- `PUT    /api/jobs/:id`
- `DELETE /api/jobs/:id`
- `POST   /api/clients/:id/notes` `{text}`
- `DELETE /api/notes/:id`

### Equipment
- `GET    /api/equipment`
- `POST   /api/equipment` `{name,category,price,saved,img_url}`
- `PUT    /api/equipment/:id`
- `DELETE /api/equipment/:id`

### Inbox
- `POST  /api/inbox` — **PUBLIC** (used by the website contact form)
- `GET   /api/inbox` (auth)
- `PATCH /api/inbox/:id/read` (auth)
- `POST  /api/inbox/read-all` (auth)
- `DELETE /api/inbox/:id` (auth)

### Chat
- `GET  /api/messages?channel=general&since=<ms>` (auth)
- `POST /api/messages` `{channel,text}` (auth)

### Analytics
- `POST /api/track/visit` — **PUBLIC** (called by every website page load)
- `POST /api/track/click` — **PUBLIC**
- `GET  /api/analytics/overview` (auth) — aggregated KPIs, daily counts, top locations, top pages, recent visitors

## Front-end migration status

| Surface | Storage now |
|---|---|
| Login | ✅ API |
| Public contact form (`index.html`) | ✅ API (offline cache fallback) |
| Visitor / click tracking | ✅ API (offline cache fallback) |
| Admin panel — Clients, Equipment, Inbox view, Team, Chat, Profile | ⚠️ still localStorage |

The admin panel is still localStorage-driven for the day-to-day UI. To complete the migration, swap each `load(KEYS.x)` and `save(KEYS.x, ...)` call inside `admin.html` for the matching `fetch('/api/x')` call (the endpoints already exist). I can do that pass next — say the word.

## Security notes

- All passwords stored as bcrypt hashes (cost 12).
- JWTs are HS256, 7-day TTL, signed with `JWT_SECRET`.
- All auth-protected endpoints validate `Authorization: Bearer <token>`.
- Public endpoints (`/api/inbox`, `/api/track/*`) **must** be the only unauthenticated routes — they only insert into their own tables, never read other data.
- Visitor IPs are read from `X-Forwarded-For` (Railway sets this) and stored in the `INET` column. Disclose this in your privacy page.
- The contact form does not require auth — that's intentional (public submissions). To prevent spam, add rate limiting (e.g. `express-rate-limit`) before going live.
