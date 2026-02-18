const express = require("express");
const cors = require("cors");

const app = express();

// ================== MIDDLEWARE ==================
app.use(express.json({ limit: "1mb" }));

// Phase 1: allow all origins (tighten later with allowlist)
app.use(cors({ origin: true }));

// ================== IN-MEMORY STORE (Phase 1) ==================
// siteStore key = siteKey (domain or siteId fallback)
const siteStore = new Map(); // { pages: [{id,title,url,text}], updatedAt: number }
const chatLogs = []; // last N chats

// Simple rate limiter: per IP
const RATE_WINDOW_MS = 60_000; // 1 min
const RATE_MAX = 60; // 60 req/min/IP
const rateMap = new Map(); // ip -> { count, resetAt }

// ================== HELPERS ==================
function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function rateLimit(req, res, next) {
  const ip = getIP(req);
  const now = Date.now();
  const entry = rateMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }

  entry.count += 1;

  if (entry.count > RATE_MAX) {
    return res.status(429).json({
      replyText: "Too many requests. Please try again in a minute.",
    });
  }

  return next();
}

function cleanHtmlToText(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isWakePhrase(text = "") {
  const t = String(text).trim().toLowerCase();
  return t === "hey jarvis" || t === "hey jarvis." || t === "hey jarvis!";
}

function isBookingIntent(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("book") ||
    t.includes("booking") ||
    t.includes("appointment") ||
    t.includes("schedule") ||
    t.includes("reserve") ||
    t.includes("consultation") ||
    t.includes("call") && t.includes("book")
  );
}

function getSiteKey({ siteId = "", domain = "" }) {
  // Prefer domain. Fallback to siteId.
  return (domain || siteId || "default").toLowerCase();
}

function scoreDoc(query, docText) {
  // Phase 1: lightweight keyword scoring
  const q = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const d = String(docText).toLowerCase();
  let score = 0;
  for (const w of q) {
    if (w.length < 3) continue;
    if (d.includes(w)) score += 2;
  }
  return score;
}

function pickTopDocs(siteKey, query, topK = 3) {
  const site = siteStore.get(siteKey);
  if (!site || !Array.isArray(site.pages) || site.pages.length === 0) return [];

  const scored = site.pages
    .map((p) => ({ ...p, _score: scoreDoc(query, p.text) }))
    .filter((p) => p._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topK);

  return scored;
}

// ================== ROUTES ==================

app.get("/", (req, res) => {
  res.send("Jarvis API is running ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * Phase 1 site sync
 * Input: { siteUrl, siteId, domain }
 * Action: fetch WP pages/posts via REST and store cleaned text
 */
app.post("/v1/site/sync", rateLimit, async (req, res) => {
  const { siteUrl = "", siteId = "", domain = "" } = req.body || {};
  const base = String(siteUrl).replace(/\/$/, "");

  if (!base) {
    return res.status(400).json({ ok: false, error: "siteUrl is required" });
  }

  const siteKey = getSiteKey({ siteId, domain: domain || new URL(base).host });

  try {
    // Pull pages + posts
    const pagesUrl = `${base}/wp-json/wp/v2/pages?per_page=100&_fields=id,link,title,content`;
    const postsUrl = `${base}/wp-json/wp/v2/posts?per_page=100&_fields=id,link,title,content`;

    const [pagesRes, postsRes] = await Promise.all([
      fetch(pagesUrl),
      fetch(postsUrl),
    ]);

    if (!pagesRes.ok || !postsRes.ok) {
      const t1 = await pagesRes.text().catch(() => "");
      const t2 = await postsRes.text().catch(() => "");
      return res.status(400).json({
        ok: false,
        error: "Failed to fetch WP REST content. Ensure site is public and REST API is accessible.",
        details: { pages: t1.slice(0, 200), posts: t2.slice(0, 200) },
      });
    }

    const pagesJson = await pagesRes.json();
    const postsJson = await postsRes.json();

    const docs = [];

    for (const p of [...pagesJson, ...postsJson]) {
      const title = p?.title?.rendered || "Untitled";
      const url = p?.link || "";
      const html = p?.content?.rendered || "";
      const text = cleanHtmlToText(html);

      if (text.length < 40) continue;

      docs.push({
        id: p.id,
        title,
        url,
        text,
      });
    }

    siteStore.set(siteKey, { pages: docs, updatedAt: Date.now(), siteUrl: base });

    return res.json({
      ok: true,
      siteKey,
      count: docs.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Sync failed", details: String(e) });
  }
});

/**
 * Chat endpoint
 * Input: { siteId, domain, sessionId, text, bookingUrl, pageUrl }
 * Output: { replyText, actions?, sources? }
 */
app.post("/v1/chat", rateLimit, async (req, res) => {
  const {
    text = "",
    bookingUrl = "",
    siteId = "",
    domain = "",
    sessionId = "",
    pageUrl = "",
  } = req.body || {};

  const userText = String(text || "").trim();
  const siteKey = getSiteKey({ siteId, domain });

  // Basic log (last 200)
  chatLogs.push({
    ts: Date.now(),
    siteKey,
    sessionId: String(sessionId || "").slice(0, 80),
    text: userText.slice(0, 400),
    pageUrl: String(pageUrl || "").slice(0, 200),
  });
  if (chatLogs.length > 200) chatLogs.shift();

  // Wake phrase
  if (isWakePhrase(userText)) {
    return res.json({
      replyText: "How can I help you?",
    });
  }

  // Booking intent
  if (isBookingIntent(userText)) {
    const url = String(bookingUrl || "").trim();
    if (url) {
      return res.json({
        replyText: "Sure — I’m taking you to the booking page now.",
        actions: [{ type: "open_url", url }],
      });
    }
    return res.json({
      replyText:
        "Sure — I can help you book. Please set your Booking Page URL in WordPress → Jarvis settings.",
    });
  }

  // Site Q&A (Phase 1 retrieval)
  const topDocs = pickTopDocs(siteKey, userText, 3);

  // If we have site content, give a grounded answer summary
  if (topDocs.length > 0) {
    const bullets = topDocs
      .map((d) => `• ${d.title}${d.url ? ` — ${d.url}` : ""}`)
      .join("\n");

    // Phase 1: simple answer by quoting relevant snippet (short)
    const best = topDocs[0];
    const snippet = best.text.slice(0, 320);

    return res.json({
      replyText:
        `Here’s what I found on this website:\n\n${snippet}${best.text.length > 320 ? "…" : ""}\n\nIf you tell me what you want (pricing, services, location, contact), I’ll guide you.`,
      sources: topDocs.map((d) => ({ title: d.title, url: d.url })),
      meta: {
        learned: true,
        siteKey,
        updatedAt: siteStore.get(siteKey)?.updatedAt || null,
        found: topDocs.length,
      },
    });
  }

  // If no content synced yet, guide the admin to sync
  const site = siteStore.get(siteKey);
  const hasSynced = !!(site && Array.isArray(site.pages) && site.pages.length);

  if (!hasSynced) {
    return res.json({
      replyText:
        "I’m not trained on this website yet. Ask the admin to run a Site Sync so I can learn the site pages and answer accurately.",
      meta: { learned: false, siteKey },
    });
  }

  // Fallback
  return res.json({
    replyText:
      "I can help answer questions about this website or help you book a service. What would you like to do?",
  });
});

// Optional: admin/debug endpoint (remove later)
app.get("/v1/debug/sites", (req, res) => {
  const out = [];
  for (const [k, v] of siteStore.entries()) {
    out.push({
      siteKey: k,
      count: v.pages?.length || 0,
      updatedAt: v.updatedAt ? new Date(v.updatedAt).toISOString() : null,
      siteUrl: v.siteUrl || null,
    });
  }
  res.json({ sites: out });
});

// Optional: view recent logs
app.get("/v1/debug/logs", (req, res) => {
  res.json({ logs: chatLogs.slice(-50) });
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Jarvis API running on port", PORT));
