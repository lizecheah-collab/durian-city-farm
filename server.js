"use strict";
/*
 * Durian City Farm — website + booking backend.
 *
 * Serves the static pages in ./public and the API used by book.html and admin.html:
 *   GET  /api/availability                 public availability (dates, slots, products)
 *   POST /api/bookings                     new booking (multipart, with deposit receipt)
 *   POST /api/admin/login | /logout        admin session (password from ADMIN_PASSWORD)
 *   GET  /api/admin/me                     200 when logged in, 401 otherwise
 *   GET  /api/admin/bookings               list, filtered by status / upcoming / q
 *   POST /api/admin/bookings/:ref          change status or private note
 *   GET  /api/admin/bookings/:ref/receipt  view the uploaded receipt
 *   GET  /api/admin/export.csv             all bookings as CSV
 *   GET/POST /api/admin/availability       read / save availability
 *
 * Data lives in DATA_DIR (default ./data): dcf.sqlite plus an uploads/ folder.
 */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const multer = require("multer");
const cookieParser = require("cookie-parser");

/* ---------- config ---------- */
const PORT = Number(process.env.PORT) || 3000;
/* On Railway, an attached volume's path is provided as RAILWAY_VOLUME_MOUNT_PATH. */
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECURE_COOKIE = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT;
const MAX_MB = 10;
const SESSION_DAYS = 7;
/* New-booking email alerts via Resend (https://resend.com). Off unless RESEND_API_KEY is set. */
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";
const MAIL_FROM = process.env.MAIL_FROM || "Durian City Farm <onboarding@resend.dev>";
const SITE_URL = (process.env.SITE_URL || "https://www.duriancityfarm.com").replace(/\/+$/, "");

/* Must match book.html */
const SLOT_HOURS = [9, 11, 13, 15, 17];
const SLOT_LABELS = ["9:00 AM", "11:00 AM", "1:00 PM", "3:00 PM", "5:00 PM"];
const LEAD_MS = 24 * 3600 * 1000;
const DEPOSIT_PER_PAX = 10;
const MAX_PEOPLE = 10;
const PRODUCTS = {
  tour: { name: "Farm Tour & Durian Tasting", season: true, durian: false },
  dinein: { name: "Buy durian · Dine in", season: true, durian: true },
  takeaway: { name: "Buy durian · Take away", season: true, durian: true },
  learning: { name: "Farm Learning", season: false, durian: false },
  buffet: { name: "Durian Buffet", season: true, durian: false },
};
const VARIETIES = ["Black Thorn", "Musang King"];
const STATUSES = ["pending", "confirmed", "completed", "cancelled"];
const DEFAULT_AVAILABILITY = {
  openFrom: "2026-12-25",
  seasonMonths: [2, 5, 8, 11],
  full: [],
  closed: [],
  slotsOff: {},
  productsOff: ["buffet", "learning"],
  varietiesOff: ["Musang King"],
};

/* ---------- storage ---------- */
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "dcf.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS bookings (
    ref TEXT PRIMARY KEY,
    experience TEXT NOT NULL,
    date TEXT NOT NULL,
    slot INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    people INTEGER NOT NULL,
    deposit INTEGER NOT NULL,
    variety TEXT,
    kg TEXT,
    notes TEXT,
    lang TEXT,
    receipt_file TEXT NOT NULL,
    receipt_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
`);

function getAvailability() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'availability'").get();
  if (!row) return structuredClone(DEFAULT_AVAILABILITY);
  try { return Object.assign(structuredClone(DEFAULT_AVAILABILITY), JSON.parse(row.value)); }
  catch { return structuredClone(DEFAULT_AVAILABILITY); }
}
function saveAvailability(a) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('availability', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(a));
}

/* ---------- validation helpers ---------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/* Slot start as an instant, Malaysia time (UTC+8). */
function slotTime(date, i) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, SLOT_HOURS[i] - 8, 0, 0);
}
function todayMY() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function cleanStr(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

/* Normalise availability posted by the admin page. Unknown values are dropped. */
function sanitizeAvailability(a) {
  a = a && typeof a === "object" ? a : {};
  const dates = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter(isDate))].sort();
  const slotsOff = {};
  if (a.slotsOff && typeof a.slotsOff === "object") {
    for (const [d, list] of Object.entries(a.slotsOff)) {
      if (!isDate(d) || !Array.isArray(list)) continue;
      const s = [...new Set(list.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < SLOT_HOURS.length))].sort((x, y) => x - y);
      if (s.length) slotsOff[d] = s;
    }
  }
  return {
    openFrom: isDate(a.openFrom) ? a.openFrom : DEFAULT_AVAILABILITY.openFrom,
    seasonMonths: [...new Set((Array.isArray(a.seasonMonths) ? a.seasonMonths : []).map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 11))].sort((x, y) => x - y),
    full: dates(a.full),
    closed: dates(a.closed),
    slotsOff,
    productsOff: [...new Set((Array.isArray(a.productsOff) ? a.productsOff : []).filter((p) => p in PRODUCTS))],
    varietiesOff: [...new Set((Array.isArray(a.varietiesOff) ? a.varietiesOff : []).filter((v) => VARIETIES.includes(v)))],
  };
}

/* Returns an error code, or null when the booking request is allowed. */
function checkBooking(b, avail) {
  const p = PRODUCTS[b.experience];
  if (!p) return "bad_request";
  const varietiesOn = VARIETIES.filter((v) => !avail.varietiesOff.includes(v));
  if (avail.productsOff.includes(b.experience) || (p.durian && varietiesOn.length === 0)) return "product_unavailable";
  if (!isDate(b.date)) return "bad_request";
  if (!Number.isInteger(b.slot) || b.slot < 0 || b.slot >= SLOT_HOURS.length) return "bad_request";
  if (!b.name) return "bad_request";
  if (b.phone.replace(/\D/g, "").length < 8) return "bad_request";
  if (!Number.isInteger(b.people) || b.people < 1 || b.people > MAX_PEOPLE) return "bad_request";
  if (p.durian && !varietiesOn.includes(b.variety)) return "product_unavailable";

  const maxDate = new Date(Date.now() + 8 * 3600 * 1000);
  maxDate.setUTCMonth(maxDate.getUTCMonth() + 12);
  if (b.date < avail.openFrom || b.date < todayMY() || b.date > maxDate.toISOString().slice(0, 10)) return "date_unavailable";
  if (avail.closed.includes(b.date) || avail.full.includes(b.date)) return "date_unavailable";
  const month = Number(b.date.slice(5, 7)) - 1;
  if (p.season && !avail.seasonMonths.includes(month)) return "date_unavailable";
  const off = avail.slotsOff[b.date] || [];
  if (off.includes(b.slot)) return "slot_unavailable";
  if (slotTime(b.date, b.slot) < Date.now() + LEAD_MS) return "slot_unavailable";
  return null;
}

function htmlEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(d) {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${y}`;
}

/* Email the farm about a new booking, with the receipt attached. Never throws. */
async function notifyNewBooking(bk, receiptPath, receiptName) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) return;
  try {
    const rows = [
      ["Reference", bk.ref],
      ["Experience", PRODUCTS[bk.experience].name],
      ["Date", fmtDate(bk.date)],
      ["Time", SLOT_LABELS[bk.slot]],
      ["Name", bk.name],
      ["WhatsApp", bk.phone],
      ["People", bk.people],
      ["Deposit", "RM" + bk.deposit],
      ...(bk.variety ? [["Durian", bk.variety + (bk.kg ? " · " + bk.kg + " kg" : "")]] : []),
      ...(bk.notes ? [["Notes", bk.notes]] : []),
    ];
    const html =
      `<p>New booking received. Please check the deposit receipt (attached) and confirm it in the admin page.</p>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">` +
      rows.map(([k, v]) => `<tr><td style="color:#6E6052">${htmlEsc(k)}</td><td><b>${htmlEsc(v)}</b></td></tr>`).join("") +
      `</table><p><a href="${SITE_URL}/admin.html">Open bookings admin</a></p>`;
    const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nAdmin: ${SITE_URL}/admin.html`;
    const attachments = [];
    try {
      const buf = await fs.promises.readFile(receiptPath);
      if (buf.length <= 15 * 1024 * 1024) attachments.push({ filename: receiptName, content: buf.toString("base64") });
    } catch {}
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: NOTIFY_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
        subject: `New booking ${bk.ref}: ${PRODUCTS[bk.experience].name}, ${fmtDate(bk.date)} ${SLOT_LABELS[bk.slot]}`,
        html, text, attachments,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.error(`[email] ${bk.ref} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
    else console.log(`[email] ${bk.ref} sent to ${NOTIFY_EMAIL}`);
  } catch (e) {
    console.error(`[email] ${bk.ref} error: ${e.message}`);
  }
}

function newRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const bytes = crypto.randomBytes(6);
    let s = "DCF-";
    for (const x of bytes) s += alphabet[x % alphabet.length];
    if (!db.prepare("SELECT 1 FROM bookings WHERE ref = ?").get(s)) return s;
  }
}

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
app.use(cookieParser());
app.use("/api", express.json({ limit: "200kb" }));

/* Health check for the host */
app.get("/healthz", (req, res) => {
  db.prepare("SELECT 1").get();
  res.set("Cache-Control", "no-store").json({ ok: true });
});

/* Public availability */
app.get("/api/availability", (req, res) => {
  res.set("Cache-Control", "no-store").json(getAvailability());
});

/* Simple in-memory rate limiter (per IP, per bucket). */
const hits = new Map();
function limited(bucket, ip, max, windowMs) {
  const k = bucket + "|" + ip, now = Date.now();
  const h = (hits.get(k) || []).filter((t) => now - t < windowMs);
  h.push(now);
  hits.set(k, h);
  return h.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (!h.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const ALLOWED_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif", "image/gif": ".gif", "application/pdf": ".pdf" };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + (ALLOWED_TYPES[file.mimetype] || "")),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 30, fieldSize: 10 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.fieldname === "receipt" && file.mimetype in ALLOWED_TYPES),
});

app.post("/api/bookings", (req, res) => {
  if (limited("book", req.ip, 10, 3600e3)) return res.status(429).json({ ok: false, error: "rate_limited" });
  upload.single("receipt")(req, res, (err) => {
    const drop = () => { if (req.file) fs.rm(req.file.path, { force: true }, () => {}); };
    if (err) {
      drop();
      return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "bad_request" });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: "bad_file" });

    const f = req.body || {};
    const b = {
      experience: cleanStr(f.experience, 30),
      date: cleanStr(f.date, 10),
      slot: Number(f.slot),
      name: cleanStr(f.name, 120),
      phone: cleanStr(f.phone, 40),
      people: Number(f.people),
      variety: cleanStr(f.variety, 40),
      kg: cleanStr(f.kg, 20),
      notes: cleanStr(f.notes, 2000),
      lang: f.lang === "ms" ? "ms" : "en",
    };
    if (f.ack !== "1") { drop(); return res.status(400).json({ ok: false, error: "bad_request" }); }
    const code = checkBooking(b, getAvailability());
    if (code) { drop(); return res.status(code === "bad_request" ? 400 : 409).json({ ok: false, error: code }); }

    const durian = PRODUCTS[b.experience].durian;
    const ref = newRef();
    db.prepare(`INSERT INTO bookings (ref, experience, date, slot, name, phone, people, deposit, variety, kg, notes, lang, receipt_file, receipt_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ref, b.experience, b.date, b.slot, b.name, b.phone, b.people, b.people * DEPOSIT_PER_PAX,
        durian ? b.variety : null, durian ? b.kg : null, b.notes, b.lang,
        path.basename(req.file.path), req.file.mimetype, new Date().toISOString());
    console.log(`[booking] ${ref} ${b.experience} ${b.date} ${SLOT_LABELS[b.slot]} x${b.people}`);
    res.json({ ok: true, ref });
    const ext = ALLOWED_TYPES[req.file.mimetype] || "";
    notifyNewBooking({ ...b, ref, deposit: b.people * DEPOSIT_PER_PAX, variety: durian ? b.variety : "", kg: durian ? b.kg : "" },
      req.file.path, `receipt-${ref}${ext}`);
  });
});

/* ---------- admin ---------- */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  const t = req.cookies && req.cookies.dcf_admin;
  if (t) {
    const row = db.prepare("SELECT expires FROM sessions WHERE token = ?").get(t);
    if (row && row.expires > Date.now()) return next();
  }
  res.status(401).json({ ok: false, error: "unauthorized" });
}

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: "admin_not_configured" });
  if (limited("login", req.ip, 5, 15 * 60e3)) return res.status(429).json({ ok: false, error: "rate_limited" });
  const pw = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!safeEqual(pw, ADMIN_PASSWORD)) return res.status(401).json({ ok: false, error: "wrong_password" });
  hits.delete("login|" + req.ip);
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token, expires) VALUES (?, ?)").run(token, expires);
  res.cookie("dcf_admin", token, { httpOnly: true, sameSite: "strict", secure: SECURE_COOKIE, maxAge: SESSION_DAYS * 864e5, path: "/" });
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => {
  const t = req.cookies && req.cookies.dcf_admin;
  if (t) db.prepare("DELETE FROM sessions WHERE token = ?").run(t);
  res.clearCookie("dcf_admin", { path: "/" }).json({ ok: true });
});
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true }));

const productNames = Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [k, { name: v.name }]));

app.get("/api/admin/bookings", requireAdmin, (req, res) => {
  const where = [], args = [];
  const status = String(req.query.status || "all");
  if (STATUSES.includes(status)) { where.push("status = ?"); args.push(status); }
  if (req.query.upcoming === "1") { where.push("date >= ?"); args.push(todayMY()); }
  const q = cleanStr(req.query.q, 100);
  if (q) {
    where.push("(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR ref LIKE ? ESCAPE '\\')");
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    args.push(like, like, like);
  }
  const sql = "SELECT ref, experience, date, slot, name, phone, people, deposit, variety, kg, notes, lang, status, admin_note, created_at FROM bookings" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY date ASC, slot ASC, created_at ASC LIMIT 1000";
  res.set("Cache-Control", "no-store").json({ bookings: db.prepare(sql).all(...args), slots: SLOT_LABELS, products: productNames });
});

app.post("/api/admin/bookings/:ref", requireAdmin, (req, res) => {
  const ref = String(req.params.ref);
  if (!db.prepare("SELECT 1 FROM bookings WHERE ref = ?").get(ref)) return res.status(404).json({ ok: false, error: "not_found" });
  const body = req.body || {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ ok: false, error: "bad_request" });
    db.prepare("UPDATE bookings SET status = ? WHERE ref = ?").run(body.status, ref);
  }
  if (body.admin_note !== undefined) db.prepare("UPDATE bookings SET admin_note = ? WHERE ref = ?").run(cleanStr(body.admin_note, 2000), ref);
  res.json({ ok: true });
});

app.get("/api/admin/bookings/:ref/receipt", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT receipt_file, receipt_type FROM bookings WHERE ref = ?").get(String(req.params.ref));
  if (!row) return res.status(404).send("Not found");
  const file = path.join(UPLOAD_DIR, path.basename(row.receipt_file));
  if (!fs.existsSync(file)) return res.status(404).send("Receipt file missing");
  res.set("Content-Type", row.receipt_type).set("Content-Disposition", "inline").set("Cache-Control", "private, no-store").sendFile(file);
});

app.get("/api/admin/export.csv", requireAdmin, (req, res) => {
  const cols = ["ref", "status", "experience", "date", "slot", "name", "phone", "people", "deposit", "variety", "kg", "notes", "admin_note", "lang", "created_at"];
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = db.prepare("SELECT * FROM bookings ORDER BY date, slot").all().map((r) =>
    cols.map((c) => cell(c === "slot" ? SLOT_LABELS[r.slot] : c === "experience" ? PRODUCTS[r.experience]?.name || r.experience : r[c])).join(","));
  res.set("Content-Type", "text/csv; charset=utf-8")
    .set("Content-Disposition", `attachment; filename="dcf-bookings-${todayMY()}.csv"`)
    .send("﻿" + [cols.join(","), ...rows].join("\r\n"));
});

app.get("/api/admin/availability", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store").json({ availability: getAvailability(), products: productNames, varieties: VARIETIES, slots: SLOT_LABELS });
});
app.post("/api/admin/availability", requireAdmin, (req, res) => {
  const a = sanitizeAvailability(req.body);
  saveAvailability(a);
  res.json({ ok: true, availability: a });
});

app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "not_found" }));

/* ---------- static site ---------- */
/* the installable farm app must always load fresh (no 1-hour browser cache) */
const FARM_APP_FILES = new Set(["/farm", "/farm.html", "/farm.webmanifest", "/farm-sw.js"]);
app.use((req, res, next) => { if (FARM_APP_FILES.has(req.path) || (req.hostname === "farm.duriancityfarm.com" && req.path === "/")) res.set("Cache-Control", "no-cache"); next(); });

/* farm.duriancityfarm.com shows only the farm records dashboard (public/farm.html) */
const FARM_HOST = "farm.duriancityfarm.com";
app.use((req, res, next) => {
  if (req.hostname !== FARM_HOST) return next();
  if (req.path === "/" || req.path === "/farm" || req.path === "/farm.html") return res.sendFile(path.join(PUBLIC_DIR, "farm.html"));
  return res.redirect(302, "/");
});
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "1h" }));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html")));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Durian City Farm running on http://localhost:${PORT}`);
    if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set: the admin page will refuse to log in.");
  });
}

module.exports = { app, checkBooking, sanitizeAvailability, DEFAULT_AVAILABILITY };
