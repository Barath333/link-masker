const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "Summa@123";
const BASE_URL = process.env.BASE_URL || "";   // e.g. https://links.yourdomain.com
const DB_FILE = path.join(__dirname, "links.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- tiny JSON "database" ---
const load = () => {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return {}; }
};
const save = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const newId = () => crypto.randomBytes(5).toString("base64url"); // e.g. "k3Fx9aQ"

const baseUrl = (req) => BASE_URL || `${req.protocol}://${req.get("host")}`;

const requireAdmin = (req, res, next) => {
  if (ADMIN_KEY && req.get("x-admin-key") !== ADMIN_KEY) {
    return res.status(401).json({ error: "Wrong or missing admin key" });
  }
  next();
};

// --- create a masked link ---
app.post("/api/links", requireAdmin, (req, res) => {
  const { url, expiresInHours, oneTime, mode } = req.body || {};
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: "Enter a full URL starting with http:// or https://" });
  }

  const db = load();
  let id = newId();
  while (db[id]) id = newId();

  db[id] = {
    target: parsed.href,
    createdAt: Date.now(),
    expiresAt: expiresInHours ? Date.now() + Number(expiresInHours) * 3600 * 1000 : null,
    oneTime: Boolean(oneTime),
    mode: mode === "proxy" ? "proxy" : "redirect",
    clicks: 0,
  };
  save(db);

  res.json({ id, link: `${baseUrl(req)}/go/${id}`, ...db[id] });
});

// --- list links (for the UI) ---
app.get("/api/links", requireAdmin, (req, res) => {
  const db = load();
  const list = Object.entries(db)
    .map(([id, v]) => ({ id, link: `${baseUrl(req)}/go/${id}`, ...v }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// --- delete a link ---
app.delete("/api/links/:id", requireAdmin, (req, res) => {
  const db = load();
  delete db[req.params.id];
  save(db);
  res.json({ ok: true });
});

// --- hide the original URL: fetch it on the server and pass it along ---
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

    // Web pages: add a <base> tag so images, CSS and scripts still load from the real site
    if (type.includes("text/html")) {
      let html = await upstream.text();
      const base = `<base href="${upstream.url}">`;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
      return res.send(html);
    }

    // Files, images, PDFs, video: stream straight through
    const len = upstream.headers.get("content-length");
    if (len && !upstream.headers.get("content-encoding")) res.set("Content-Length", len);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).send("Could not load this content.");
  }
}

// --- the public link ---
app.get("/go/:id", (req, res) => {
  const db = load();
  const item = db[req.params.id];

  if (!item) return res.status(404).send("This link doesn't exist.");
  if (item.expiresAt && Date.now() > item.expiresAt) {
    return res.status(410).send("This link has expired.");
  }

  item.clicks += 1;
  if (item.oneTime) delete db[req.params.id];
  save(db);

  res.set("Cache-Control", "no-store");
  if (item.mode === "proxy") return proxy(item, req, res);
  res.redirect(302, item.target);
});

app.listen(PORT, () => {
  console.log(`Link masker running on http://localhost:${PORT}`);
  if (!ADMIN_KEY) console.log("Tip: set ADMIN_KEY so only you can create links.");
});