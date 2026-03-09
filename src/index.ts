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

type CollectionConfig = {
  collections: string[];
};

type Item = {
  id: string; // guid/link fallback
  link: string;
  title: string;
  date: number; // ms
  description?: string;
};

const COLLECTIONS_KEY = "collections:v1";
const CONFIG_PREFIX = "feeds:v1:"; // + collection
const MERGED_PREFIX = "merged:v1:"; // + collection

const ADMIN_HTML = `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RSS.Merge Admin</title>
<style>
  body{font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; max-width: 960px; margin: 2rem auto; padding: 0 1rem;}
  code,input,button,textarea,select{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;}
  input,select{width: 100%; padding:.6rem;}
  button{padding:.6rem 1rem; cursor:pointer;}
  li{margin:.35rem 0;}
  .row{display:flex; gap:.5rem; align-items:center;}
  .row > *{flex: 1;}
  .muted{color:#666; font-size:.9rem}
</style>
<h1>RSS.Merge</h1>
<p class="muted">Each collection has its own feed URL: <code>/{name}.xml</code> (e.g. <a href="/default.xml">/default.xml</a>).</p>

<h2>Collection</h2>
<div class="row">
  <select id="col"></select>
  <input id="newcol" placeholder="new collection name (e.g. hn)" />
  <button id="createCol">Create</button>
</div>
<p class="muted">Current feed: <a id="feedLink" href="#">(select a collection)</a></p>

<h2>Add feed URL</h2>
<div class="row">
  <input id="url" placeholder="https://example.com/feed.xml" />
  <button id="add">Add</button>
</div>

<h2>Feeds</h2>
<ul id="list"></ul>

<details style="margin-top:1rem">
  <summary>Auth</summary>
  <p>If <code>ADMIN_TOKEN</code> is set, paste it here:</p>
  <input id="token" placeholder="ADMIN_TOKEN" />
</details>

<script>
const $ = (s) => document.querySelector(s);
function authHeaders(){
  const t = $('#token').value.trim();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}
function currentCol(){
  return $('#col').value || 'default';
}
async function loadCollections(){
  const r = await fetch('/api/collections', { headers: authHeaders() });
  if(!r.ok){ $('#col').innerHTML = '<option>default</option>'; return; }
  const j = await r.json();
  const cols = j.collections || ['default'];
  $('#col').innerHTML = cols.map(c => '<option value="' + c + '">' + c + '</option>').join('');
}
async function loadFeeds(){
  const col = currentCol();
  $('#feedLink').textContent = '/' + col + '.xml';
  $('#feedLink').setAttribute('href', '/' + col + '.xml');

  const r = await fetch('/api/feeds?collection=' + encodeURIComponent(col), { headers: authHeaders() });
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
      await fetch('/api/feeds?collection=' + encodeURIComponent(col), { method:'DELETE', headers: { ...authHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify({ url }) });
      await loadFeeds();
    };
  });
}
$('#createCol').onclick = async () => {
  const name = $('#newcol').value.trim();
  if(!name) return;
  await fetch('/api/collections', { method:'POST', headers: { ...authHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify({ name }) });
  $('#newcol').value='';
  await loadCollections();
  $('#col').value = name;
  await loadFeeds();
};
$('#add').onclick = async () => {
  const col = currentCol();
  const url = $('#url').value.trim();
  if(!url) return;
  await fetch('/api/feeds?collection=' + encodeURIComponent(col), { method:'POST', headers: { ...authHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify({ url }) });
  $('#url').value='';
  await loadFeeds();
};
$('#col').onchange = loadFeeds;

(async function boot(){
  await loadCollections();
  await loadFeeds();
})();
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

function normalizeCollection(raw: string | null): string {
  const v = (raw || "default").trim();
  const cleaned = v.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  return cleaned || "default";
}

async function getCollections(env: Env): Promise<CollectionConfig> {
  const raw = await env.CONFIG.get(COLLECTIONS_KEY);
  if (!raw) return { collections: ["default"] };
  try {
    const parsed = JSON.parse(raw);
    const collections = Array.isArray(parsed?.collections)
      ? parsed.collections.filter((x: any) => typeof x === "string" && x.trim())
      : [];
    const uniq = Array.from(
      new Set(["default", ...collections.map((s: string) => normalizeCollection(s))]),
    );
    return { collections: uniq };
  } catch {
    return { collections: ["default"] };
  }
}

async function addCollection(env: Env, name: string) {
  const cfg = await getCollections(env);
  cfg.collections.push(normalizeCollection(name));
  const uniq = Array.from(new Set(cfg.collections));
  await env.CONFIG.put(COLLECTIONS_KEY, JSON.stringify({ collections: uniq }));
}

async function getConfig(env: Env, collection: string): Promise<FeedConfig> {
  const raw = await env.CONFIG.get(CONFIG_PREFIX + collection);
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

async function setConfig(env: Env, collection: string, cfg: FeedConfig) {
  const uniq = Array.from(new Set(cfg.feeds.map((s) => s.trim()).filter(Boolean)));
  await env.CONFIG.put(CONFIG_PREFIX + collection, JSON.stringify({ feeds: uniq }));
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

async function buildMerged(env: Env, collection: string): Promise<string> {
  const cfg = await getConfig(env, collection);
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

async function getMergedCached(env: Env, collection: string): Promise<string> {
  const ttlMin = mins(env, "MERGED_TTL_MINUTES", 10);
  const key = MERGED_PREFIX + collection;
  const cached = await env.CACHE.get(key);
  const tsRaw = await env.CACHE.get(key + ":ts");
  if (cached && tsRaw) {
    const age = now() - Number(tsRaw);
    if (age < ttlMin * 60_000) return cached;
  }
  const xml = await buildMerged(env, collection);
  await env.CACHE.put(key, xml, { expirationTtl: ttlMin * 60 });
  await env.CACHE.put(key + ":ts", String(now()), { expirationTtl: ttlMin * 60 });
  return xml;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `RSS.Merge\n\n- Feed (legacy): ${url.origin}/feed.xml\n- Feed: ${url.origin}/default.xml\n- Admin: ${url.origin}/admin\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    // Feed endpoints:
    // - /feed.xml (legacy default)
    // - /{collection}.xml
    if (url.pathname === "/feed.xml") {
      const xml = await getMergedCached(env, "default");
      return new Response(xml, {
        headers: { "content-type": "application/rss+xml; charset=utf-8" },
      });
    }
    if (url.pathname.endsWith(".xml") && url.pathname.length > 5) {
      const name = url.pathname.slice(1, -4); // trim / and .xml
      const collection = normalizeCollection(name);
      const xml = await getMergedCached(env, collection);
      return new Response(xml, {
        headers: { "content-type": "application/rss+xml; charset=utf-8" },
      });
    }

    if (url.pathname === "/admin") {
      if (!isAuthed(req, env)) return new Response("Unauthorized", { status: 401 });
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/collections") {
      if (!isAuthed(req, env))
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      if (req.method === "GET") {
        return Response.json(await getCollections(env));
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => null)) as any;
        const name = String(body?.name || "").trim();
        if (!name) return new Response(JSON.stringify({ error: "missing name" }), { status: 400 });
        await addCollection(env, name);
        return Response.json({ ok: true });
      }
      return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
    }

    if (url.pathname === "/api/feeds") {
      if (!isAuthed(req, env))
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      const collection = normalizeCollection(url.searchParams.get("collection"));

      if (req.method === "GET") {
        return Response.json(await getConfig(env, collection));
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => null)) as any;
        const u = String(body?.url || "").trim();
        if (!u) return new Response(JSON.stringify({ error: "missing url" }), { status: 400 });
        const cfg = await getConfig(env, collection);
        cfg.feeds.push(u);
        await setConfig(env, collection, cfg);
        // bust merged cache
        const key = MERGED_PREFIX + collection;
        ctx.waitUntil(env.CACHE.delete(key));
        ctx.waitUntil(env.CACHE.delete(key + ":ts"));
        return Response.json({ ok: true });
      }
      if (req.method === "DELETE") {
        const body = (await req.json().catch(() => null)) as any;
        const u = String(body?.url || "").trim();
        const cfg = await getConfig(env, collection);
        cfg.feeds = cfg.feeds.filter((x) => x !== u);
        await setConfig(env, collection, cfg);
        const key = MERGED_PREFIX + collection;
        ctx.waitUntil(env.CACHE.delete(key));
        ctx.waitUntil(env.CACHE.delete(key + ":ts"));
        return Response.json({ ok: true });
      }
      return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Pre-warm merged feed cache for all collections.
    const cols = await getCollections(env);
    for (const c of cols.collections) {
      ctx.waitUntil(getMergedCached(env, c).then(() => void 0));
    }
  },
};
