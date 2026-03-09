export interface Env {
  CONFIG: KVNamespace;
  CACHE: KVNamespace;
  ADMIN_TOKEN?: string;
  FEED_TTL_MINUTES?: string;
  MERGED_TTL_MINUTES?: string;
  TITLE?: string;
  DESCRIPTION?: string;
  SITE_URL?: string;
}

type FeedConfig = { feeds: string[] };

type Item = {
  id: string; // guid/link fallback
  link: string;
  title: string;
  date: number; // ms
  description?: string;
};

const CONFIG_KEY = "feeds:v1";
const MERGED_KEY = "merged:v1";

const ADMIN_HTML = `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RSS.Merge Admin</title>
<style>
  body{font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; max-width: 860px; margin: 2rem auto; padding: 0 1rem;}
  code,input,button,textarea{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;}
  input{width: 100%; padding:.6rem;}
  button{padding:.6rem 1rem; cursor:pointer;}
  li{margin:.35rem 0;}
  .row{display:flex; gap:.5rem; align-items:center;}
  .row > *{flex: 1;}
</style>
<h1>RSS.Merge</h1>
<p>Subscribe: <a href="/feed.xml">/feed.xml</a></p>
<div class="row">
  <input id="url" placeholder="https://example.com/feed.xml" />
  <button id="add">Add</button>
</div>
<h2>Feeds</h2>
<ul id="list"></ul>
<details style="margin-top:1rem">
  <summary>Auth</summary>
  <p>If ADMIN_TOKEN is set, paste it here:</p>
  <input id="token" placeholder="ADMIN_TOKEN" />
</details>
<script>
const $ = (s) => document.querySelector(s);
function authHeaders(){
  const t = $('#token').value.trim();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}
async function load(){
  const r = await fetch('/api/feeds', { headers: authHeaders() });
  if(!r.ok){ $('#list').innerHTML = '<li><code>GET /api/feeds</code> failed: ' + r.status + '</li>'; return; }
  const j = await r.json();
  const feeds = j.feeds || [];
  $('#list').innerHTML = feeds.map(u =>
    '<li><code>' + u + '</code> ' +
    '<button data-del="' + encodeURIComponent(u) + '">Remove</button></li>'
  ).join('');
  document.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const url = decodeURIComponent(btn.getAttribute('data-del'));
      await fetch('/api/feeds', { method:'DELETE', headers: { ...authHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify({ url }) });
      await load();
    };
  });
}
$('#add').onclick = async () => {
  const url = $('#url').value.trim();
  if(!url) return;
  await fetch('/api/feeds', { method:'POST', headers: { ...authHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify({ url }) });
  $('#url').value='';
  await load();
};
load();
</script>`;

function now() {
  return Date.now();
}

function mins(env: Env, key: "FEED_TTL_MINUTES" | "MERGED_TTL_MINUTES", fallback: number) {
  const raw = env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isAuthed(req: Request, env: Env) {
  const token = (env.ADMIN_TOKEN || "").trim();
  if (!token) return true;
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${token}`;
}

async function getConfig(env: Env): Promise<FeedConfig> {
  const raw = await env.CONFIG.get(CONFIG_KEY);
  if (!raw) return { feeds: [] };
  try {
    const parsed = JSON.parse(raw);
    const feeds = Array.isArray(parsed?.feeds)
      ? parsed.feeds.filter((x: any) => typeof x === "string")
      : [];
    return { feeds };
  } catch {
    return { feeds: [] };
  }
}

async function setConfig(env: Env, cfg: FeedConfig) {
  const uniq = Array.from(new Set(cfg.feeds.map((s) => s.trim()).filter(Boolean)));
  await env.CONFIG.put(CONFIG_KEY, JSON.stringify({ feeds: uniq }));
}

function xmlText(el: Element | null): string {
  return (el?.textContent || "").trim();
}

function pickLink(itemEl: Element): string {
  // RSS: <link>https://..</link>
  const rssLink = xmlText(itemEl.querySelector("link"));
  if (rssLink) return rssLink;
  // Atom: <link href="..." rel="alternate"/>
  const atomLink =
    itemEl.querySelector('link[rel="alternate"]') || itemEl.querySelector("link[href]");
  const href = atomLink?.getAttribute("href") || "";
  return href.trim();
}

function pickId(itemEl: Element, link: string): string {
  const guid = xmlText(itemEl.querySelector("guid"));
  if (guid) return guid;
  const id = xmlText(itemEl.querySelector("id"));
  if (id) return id;
  return link;
}

function pickTitle(itemEl: Element): string {
  return xmlText(itemEl.querySelector("title")) || "(untitled)";
}

function parseDate(itemEl: Element): number {
  const candidates = [
    xmlText(itemEl.querySelector("pubDate")),
    xmlText(itemEl.querySelector("published")),
    xmlText(itemEl.querySelector("updated")),
    xmlText(itemEl.querySelector("dc\\:date")),
  ].filter(Boolean);
  for (const c of candidates) {
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function pickDesc(itemEl: Element): string {
  return (
    xmlText(itemEl.querySelector("description")) ||
    xmlText(itemEl.querySelector("summary")) ||
    xmlText(itemEl.querySelector("content"))
  );
}

function parseFeedXml(xml: string): Item[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const hasParserError = doc.querySelector("parsererror");
  if (hasParserError) return [];

  // RSS
  const rssItems = Array.from(doc.querySelectorAll("rss channel item"));
  if (rssItems.length) {
    return rssItems
      .map((el) => {
        const link = pickLink(el);
        const id = pickId(el, link);
        const title = pickTitle(el);
        const date = parseDate(el);
        return { id, link, title, date, description: pickDesc(el) };
      })
      .filter((x) => x.link && x.id);
  }

  // Atom
  const atomEntries = Array.from(doc.querySelectorAll("feed entry"));
  return atomEntries
    .map((el) => {
      const link = pickLink(el);
      const id = pickId(el, link);
      const title = pickTitle(el);
      const date = parseDate(el);
      return { id, link, title, date, description: pickDesc(el) };
    })
    .filter((x) => x.link && x.id);
}

function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return crypto.subtle.digest("SHA-1", data).then((buf) => {
    const bytes = new Uint8Array(buf);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
}

async function getFeedItemsCached(env: Env, feedUrl: string): Promise<Item[]> {
  const ttlMin = mins(env, "FEED_TTL_MINUTES", 20);
  const key = `feed:${await sha1Hex(feedUrl)}`;
  const cached = await env.CACHE.get(key, { type: "json" });
  if (cached && typeof cached === "object" && (cached as any).ts && (cached as any).items) {
    const age = now() - Number((cached as any).ts);
    if (age < ttlMin * 60_000) return (cached as any).items as Item[];
  }

  const resp = await fetch(feedUrl, {
    headers: {
      "user-agent": "RSS.Merge/1.0",
      accept: "application/xml,text/xml,application/rss+xml,application/atom+xml,*/*;q=0.8",
    },
    cf: { cacheTtl: ttlMin * 60, cacheEverything: false },
  });
  if (!resp.ok) return [];
  const xml = await resp.text();
  const items = parseFeedXml(xml);
  await env.CACHE.put(key, JSON.stringify({ ts: now(), items }), { expirationTtl: ttlMin * 60 });
  return items;
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toRss2(env: Env, items: Item[]): string {
  const title = env.TITLE || "Merged Feed";
  const desc = env.DESCRIPTION || "Merged RSS feed";
  const site = env.SITE_URL || "";

  const itemXml = items
    .map((it) => {
      const pub = it.date ? new Date(it.date).toUTCString() : new Date().toUTCString();
      const guid = escapeXml(it.id);
      const link = escapeXml(it.link);
      const t = escapeXml(it.title || "(untitled)");
      const d = it.description
        ? `\n      <description><![CDATA[${it.description}]]></description>`
        : "";
      return `\n    <item>\n      <title>${t}</title>\n      <link>${link}</link>\n      <guid isPermaLink="false">${guid}</guid>\n      <pubDate>${pub}</pubDate>${d}\n    </item>`;
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0">\n` +
    `  <channel>\n` +
    `    <title>${escapeXml(title)}</title>\n` +
    `    <link>${escapeXml(site || "")}</link>\n` +
    `    <description>${escapeXml(desc)}</description>\n` +
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>` +
    itemXml +
    `\n  </channel>\n</rss>\n`
  );
}

async function buildMerged(env: Env): Promise<string> {
  const cfg = await getConfig(env);
  const feeds = cfg.feeds;
  const all = (await Promise.all(feeds.map((u) => getFeedItemsCached(env, u)))).flat();

  const byId = new Map<string, Item>();
  for (const it of all) {
    const key = it.id || it.link;
    if (!key) continue;
    if (!byId.has(key)) byId.set(key, it);
  }

  const merged = Array.from(byId.values()).sort((a, b) => (b.date || 0) - (a.date || 0));
  const limited = merged.slice(0, 400);
  return toRss2(env, limited);
}

async function getMergedCached(env: Env): Promise<string> {
  const ttlMin = mins(env, "MERGED_TTL_MINUTES", 10);
  const cached = await env.CACHE.get(MERGED_KEY);
  const tsRaw = await env.CACHE.get(MERGED_KEY + ":ts");
  if (cached && tsRaw) {
    const age = now() - Number(tsRaw);
    if (age < ttlMin * 60_000) return cached;
  }
  const xml = await buildMerged(env);
  await env.CACHE.put(MERGED_KEY, xml, { expirationTtl: ttlMin * 60 });
  await env.CACHE.put(MERGED_KEY + ":ts", String(now()), { expirationTtl: ttlMin * 60 });
  return xml;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `RSS.Merge\n\n- Feed: ${url.origin}/feed.xml\n- Admin: ${url.origin}/admin\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (url.pathname === "/feed.xml") {
      const xml = await getMergedCached(env);
      return new Response(xml, {
        headers: { "content-type": "application/rss+xml; charset=utf-8" },
      });
    }

    if (url.pathname === "/admin") {
      if (!isAuthed(req, env)) return new Response("Unauthorized", { status: 401 });
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/feeds") {
      if (!isAuthed(req, env))
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      if (req.method === "GET") {
        return Response.json(await getConfig(env));
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => null)) as any;
        const u = String(body?.url || "").trim();
        if (!u) return new Response(JSON.stringify({ error: "missing url" }), { status: 400 });
        const cfg = await getConfig(env);
        cfg.feeds.push(u);
        await setConfig(env, cfg);
        // bust merged cache
        ctx.waitUntil(env.CACHE.delete(MERGED_KEY));
        ctx.waitUntil(env.CACHE.delete(MERGED_KEY + ":ts"));
        return Response.json({ ok: true });
      }
      if (req.method === "DELETE") {
        const body = (await req.json().catch(() => null)) as any;
        const u = String(body?.url || "").trim();
        const cfg = await getConfig(env);
        cfg.feeds = cfg.feeds.filter((x) => x !== u);
        await setConfig(env, cfg);
        ctx.waitUntil(env.CACHE.delete(MERGED_KEY));
        ctx.waitUntil(env.CACHE.delete(MERGED_KEY + ":ts"));
        return Response.json({ ok: true });
      }
      return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Pre-warm merged feed cache.
    ctx.waitUntil(getMergedCached(env).then(() => void 0));
  },
};
