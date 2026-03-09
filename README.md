# RSS.Merge (Cloudflare Worker)

A small RSS merge service (rss.app-like “bundle into one feed”).

## Features

- `GET /feed.xml` merge many feeds into one RSS 2.0
- KV cache per-feed fetch results (10–30 min)
- De-dup by `guid`/`link`
- Sort by publish time desc
- Cron pre-warms merged output
- Minimal dashboard at `/admin` to manage feed list

## Deploy

1. Create two KV namespaces in Cloudflare:
   - `rss-merge-config`
   - `rss-merge-cache`
2. Put their ids into `wrangler.toml` (`CONFIG` and `CACHE`).
3. `npm i`
4. `npm run deploy`

## Usage

- Open `/admin` to add/remove feeds.
- Subscribe to `/feed.xml`.

## Auth (optional)

Set `ADMIN_TOKEN` in Worker vars. Then `/admin` and `/api/*` require:

- `Authorization: Bearer <token>`

If `ADMIN_TOKEN` is empty/unset, admin endpoints are open.
