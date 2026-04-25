# Logic Marketing — R2 Sync Worker

A tiny Cloudflare Worker that lets the static admin (`logicmarketing.co/admin.html`) save and load JSON blobs from the existing `gloryaimar` R2 bucket. Every device that opens the admin sees the same data and a refresh never loses anything.

## One-time deploy

From this folder:

```bash
# 1. Log in once if you haven't
npx wrangler login

# 2. Set the bearer token the admin will use to talk to the worker.
#    Use the same value you put in admin.html's LM_SYNC_TOKEN.
echo "lm-store-2026-aimar" | npx wrangler secret put AUTH_TOKEN

# 3. Deploy
npx wrangler deploy
```

That last command prints something like:

```
Published logic-marketing-store
  https://logic-marketing-store.<your-subdomain>.workers.dev
```

If `<your-subdomain>` is **not** `aimarmwembo1`, open `admin.html` and change `LM_SYNC_URL` to match. (Or set a custom route on `logicmarketing.co/api/*` in the Cloudflare dashboard.)

## How it works

- Bucket: `gloryaimar` (shared with LinksGlow / LinkHub)
- Prefix: `logic-marketing/` — keeps these blobs out of the way of other apps
- One JSON blob per collection: `clients.json`, `messages.json`, `equipment.json`, `team.json`, `inbox.json`, `channels.json`, `transactions.json`, `payments.json`
- Local-first: admin writes localStorage immediately, then debounces a PUT 800 ms later
- On page load and on tab focus (and every 30 s in the background), admin GETs the manifest and pulls any blob whose remote `ts` is newer than the local one

## Endpoints

```
GET  /api/health                   → "ok"
GET  /api/store                    → { keys, updatedAt }
GET  /api/store/<key>              → { ts, data }
PUT  /api/store/<key>  body { ts, data }
```

All `/api/store*` calls require `Authorization: Bearer <AUTH_TOKEN>`.
