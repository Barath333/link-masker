const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // set this so only YOU can create links
const BASE_URL = process.env.BASE_URL || "";   // optional, e.g. https://links.yourdomain.com

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- storage ----------
// If Upstash Redis variables are set, links are saved there (survives restarts).
// Otherwise they are saved in links.json (fine for running on your own Mac).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const DB_FILE = path.join(__dirname, "links.json");
const loadFile = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return {}; } };
const saveFile = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const store = useRedis
  ? {
      async get(id) { const v = await redis(["HGET", "links", id]); return v ? JSON.parse(v) : null; },
      async set(id, item) { await redis(["HSET", "links", id, JSON.stringify(item)]); },
      async del(id) { await redis(["HDEL", "links", id]); },
      async all() {
        const arr = (await redis(["HGETALL", "links"])) || [];
        const out = {};
        for (let i = 0; i < arr.length; i += 2) out[arr[i]] = JSON.parse(arr[i + 1]);
        return out;
      },
    }
  : {
      async get(id) { return loadFile()[id] || null; },
      async set(id, item) { const db = loadFile(); db[id] = item; saveFile(db); },
      async del(id) { const db = loadFile(); delete db[id]; saveFile(db); },
      async all() { return loadFile(); },
    };

// ---------- helpers ----------
const newId = () => crypto.randomBytes(5).toString("base64url");
const baseUrl = (req) => BASE_URL || `${req.protocol}://${req.get("host")}`;
const wrap = (fn) => (req, res, next) =>
  fn(req, res, next).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "Server error, please try again" });
  });

const requireAdmin = (req, res, next) => {
  if (ADMIN_KEY && req.get("x-admin-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "Wrong or missing admin key" });
  }
  next();
};

// ---------- create a masked link ----------
app.post("/api/links", requireAdmin, wrap(async (req, res) => {
  const { url, expiresInHours, oneTime, mode } = req.body || {};
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: "Enter a full URL starting with http:// or https://" });
  }

  let id = newId();
  while (await store.get(id)) id = newId();

  const item = {
    target: parsed.href,
    createdAt: Date.now(),
    expiresAt: expiresInHours ? Date.now() + Number(expiresInHours) * 3600 * 1000 : null,
    oneTime: Boolean(oneTime),
    mode: mode === "proxy" ? "proxy" : "redirect",
    clicks: 0,
  };
  await store.set(id, item);
  res.json({ id, link: `${baseUrl(req)}/go/${id}`, ...item });
}));

// ---------- list links ----------
app.get("/api/links", requireAdmin, wrap(async (req, res) => {
  const db = await store.all();
  const list = Object.entries(db)
    .map(([id, v]) => ({ id, link: `${baseUrl(req)}/go/${id}`, ...v }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
}));

// ---------- delete a link ----------
app.delete("/api/links/:id", requireAdmin, wrap(async (req, res) => {
  await store.del(req.params.id);
  res.json({ ok: true });
}));

// ---------- hide the original URL: fetch it on the server and pass it along ----------
async function proxy(item, req, res) {
  try {
    const upstream = await fetch(item.target, {
      redirect: "follow",
      headers: {
        "user-agent": req.get("user-agent") || "Mozilla/5.0",
        ...(req.get("range") ? { range: req.get("range") } : {}),
      },
    });

    const type = upstream.headers.get("content-type") || "application/octet-stream";
    res.status(upstream.status);
    res.set("Content-Type", type);
    for (const h of ["content-disposition", "accept-ranges", "content-range", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }

    if (type.includes("text/html")) {
      let html = await upstream.text();
      const base = `<base href="${upstream.url}">`;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
      return res.send(html);
    }

    const len = upstream.headers.get("content-length");
    if (len && !upstream.headers.get("content-encoding")) res.set("Content-Length", len);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).send("Could not load this content.");
  }
}

// ---------- the public link ----------
app.get("/go/:id", wrap(async (req, res) => {
  const item = await store.get(req.params.id);
  if (!item) return res.status(404).send("This link doesn't exist.");
  if (item.expiresAt && Date.now() > item.expiresAt) {
    return res.status(410).send("This link has expired.");
  }

  // Chat apps (WhatsApp etc.) open links to make previews. Don't count that as a visit.
  const ua = req.get("user-agent") || "";
  if (/whatsapp|telegrambot|facebookexternalhit|slackbot|twitterbot|discordbot|linkedinbot/i.test(ua)) {
    return res.status(200).send("Link preview");
  }

  item.clicks += 1;
  if (item.oneTime) await store.del(req.params.id);
  else await store.set(req.params.id, item);

  res.set("Cache-Control", "no-store");
  if (item.mode === "proxy") return proxy(item, req, res);
  res.redirect(302, item.target);
}));

app.listen(PORT, () => {
  console.log(`Link masker running on port ${PORT} (storage: ${useRedis ? "Upstash Redis" : "links.json file"})`);
  if (!ADMIN_KEY) console.log("Tip: set ADMIN_KEY so only you can create links.");
});