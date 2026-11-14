"use strict";
/*
 * Public pages for search engines and AI crawlers.
 *
 * - Serves each public page in English (/events.html) and Bahasa Melayu (/ms/events.html).
 *   The Malay version is the same file with its text swapped using the page's own I18N_MS
 *   dictionary, so crawlers that don't run JavaScript still see real Malay text.
 * - Adds canonical, hreflang, Open Graph and Twitter tags, and the page language flag
 *   (window.DCF_PAGE_LANG) used by the language buttons.
 * - Rebuilds FAQPage structured data from the questions actually shown on the page.
 * - Serves robots.txt and sitemap.xml, redirects duplicate addresses to one canonical URL.
 *
 * Blocks wrapped in <!--lang:en-->…<!--/lang:en--> or <!--lang:ms-->…<!--/lang:ms--> are kept
 * only in that language's version.
 */
const fs = require("node:fs");
const path = require("node:path");

const ORIGIN = (process.env.SITE_URL || "https://www.duriancityfarm.com").replace(/\/+$/, "");
const OG_IMAGE = "/img/og-durian-city-farm.jpg";

/* file -> English path. Order = sitemap order. */
const PAGES = [
  ["index.html", "/"],
  ["book.html", "/book.html"],
  ["events.html", "/events.html"],
  ["retreat.html", "/retreat.html"],
  ["partner.html", "/partner.html"],
  ["faq.html", "/faq.html"],
];
const BY_FILE = Object.fromEntries(PAGES);

const META_MS = {
  "index.html": {
    title: "Durian City Farm | Kebun Durian & Agro-Pelancongan di Johor Bahru",
    desc: "Lawati Durian City Farm di Bandar Seri Alam, Johor Bahru. Rasa durian Black Thorn kami, jelajah kebun, belajar cara durian ditanam dan adakan acara anda di kebun. Lawatan melalui temu janji.",
  },
  "book.html": {
    title: "Tempah lawatan anda | Durian City Farm",
    desc: "Tempah lawatan kebun dengan rasa durian, beli durian untuk makan di kebun atau bungkus, atau atur lawatan pembelajaran di Durian City Farm, Bandar Seri Alam, Johor Bahru.",
  },
  "events.html": {
    title: "Acara & Parti Durian | Durian City Farm",
    desc: "Adakan acara korporat, sambutan dan majlis durian peribadi di Durian City Farm, Johor Bahru, atau tempah parti durian di pejabat anda.",
  },
  "retreat.html": {
    title: "Durian City Farm Retreat (Akan Datang) | Durian City Farm",
    desc: "Durian City Farm Retreat akan datang: bermalam di antara pokok durian di Bandar Seri Alam, Johor Bahru. Daftar minat anda.",
  },
  "partner.html": {
    title: "Kerjasama Dengan Kami | Durian City Farm",
    desc: "Durian City Farm terbuka untuk kerjasama dengan rakan pelancongan, korporat, pendidikan, F&B dan media, serta mengalu-alukan sesiapa yang ingin menyertai pasukan kami.",
  },
  "faq.html": {
    title: "Soalan Lazim | Durian City Farm",
    desc: "Jawapan tentang lawatan ke Durian City Farm di Johor Bahru: musim durian, Black Thorn, lawatan kebun, deposit, masa tempahan, acara dan arah ke kebun.",
  },
};

const enPath = (file) => BY_FILE[file];
const msPath = (file) => (BY_FILE[file] === "/" ? "/ms/" : "/ms" + BY_FILE[file]);

/* ---------- small HTML helpers ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: "\u00a0" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}
const encText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const encAttr = (s) => encText(s).replace(/"/g, "&quot;");
const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function stripLangBlocks(s, lang) {
  const other = lang === "ms" ? "en" : "ms";
  s = s.replace(new RegExp(`<!--lang:${other}-->[\\s\\S]*?<!--/lang:${other}-->`, "g"), "");
  return s.replace(new RegExp(`<!--/?lang:${lang}-->`, "g"), "");
}

/* Swap visible text in <body> using the page's I18N_MS dictionary (same matching rule as the in-page switch). */
function translateBody(s) {
  const dm = s.match(/var I18N_MS = (\{.*?\});\r?\n/s);
  if (!dm) return s;
  let dict;
  try { dict = JSON.parse(dm[1]); } catch { return s; }
  const bodyAt = s.search(/<body[\s>]/);
  if (bodyAt < 0) return s;
  const head = s.slice(0, bodyAt), body = s.slice(bodyAt);
  const out = body.replace(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]+>)|([^<]+)/g, (m, tag, text) => {
    if (tag !== undefined) return tag;
    const key = decode(text).trim().replace(/\s+/g, " ");
    if (!key || !dict[key]) return text;
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    return lead + encText(dict[key]) + trail;
  });
  return head + out;
}

/* FAQPage JSON-LD built from the <details><summary> questions shown on the page. */
function rebuildFaqLd(s) {
  if (!/"@type"\s*:\s*"FAQPage"/.test(s)) return s;
  const qa = [...s.matchAll(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map((m) => ({ q: plain(m[1]), a: plain(m[2]) })).filter((x) => x.q && x.a);
  if (!qa.length) return s;
  const ld = {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: qa.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })),
  };
  return s.replace(/<script type="application\/ld\+json">\s*\{[^<]*?"@type"\s*:\s*"FAQPage"[\s\S]*?<\/script>/,
    () => `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`);
}

function headTags(file, lang, title, desc) {
  const self = ORIGIN + (lang === "ms" ? msPath(file) : enPath(file));
  return [
    `<link rel="canonical" href="${self}">`,
    `<link rel="alternate" hreflang="en" href="${ORIGIN + enPath(file)}">`,
    `<link rel="alternate" hreflang="ms" href="${ORIGIN + msPath(file)}">`,
    `<link rel="alternate" hreflang="x-default" href="${ORIGIN + enPath(file)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Durian City Farm">`,
    `<meta property="og:locale" content="${lang === "ms" ? "ms_MY" : "en_MY"}">`,
    `<meta property="og:locale:alternate" content="${lang === "ms" ? "en_MY" : "ms_MY"}">`,
    `<meta property="og:url" content="${self}">`,
    `<meta property="og:title" content="${encAttr(title)}">`,
    `<meta property="og:description" content="${encAttr(desc)}">`,
    `<meta property="og:image" content="${ORIGIN + OG_IMAGE}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Opened Black Thorn durians in a basket at Durian City Farm, Johor Bahru">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${encAttr(title)}">`,
    `<meta name="twitter:description" content="${encAttr(desc)}">`,
    `<meta name="twitter:image" content="${ORIGIN + OG_IMAGE}">`,
    `<script>window.DCF_PAGE_LANG=${JSON.stringify(lang)};</script>`,
  ].join("\n");
}

function render(file, lang) {
  let s = fs.readFileSync(path.join(module.exports.PUBLIC_DIR, file), "utf8");
  s = stripLangBlocks(s, lang);
  if (lang === "ms") {
    s = translateBody(s);
    s = s.replace(/<html lang="en"/, '<html lang="ms"');
    const m = META_MS[file];
    s = s.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${encText(m.title)}</title>`);
    s = s.replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${encAttr(m.desc)}">`);
  }
  s = rebuildFaqLd(s);
  const title = decode((s.match(/<title>([\s\S]*?)<\/title>/) || [, "Durian City Farm"])[1]).trim();
  const desc = decode((s.match(/<meta name="description" content="([^"]*)">/) || [, ""])[1]);
  return s.replace(/(<meta name="viewport"[^>]*>)/, (v) => v + "\n" + headTags(file, lang, title, desc));
}

/* Cache rendered pages; re-render when the file changes. */
const cache = new Map();
function page(file, lang) {
  const st = fs.statSync(path.join(module.exports.PUBLIC_DIR, file));
  const key = file + "|" + lang, hit = cache.get(key);
  if (hit && hit.mtime === st.mtimeMs) return hit.html;
  const html = render(file, lang);
  cache.set(key, { mtime: st.mtimeMs, html });
  return html;
}

function sitemap() {
  const urls = PAGES.map(([file]) => {
    const alt = `<xhtml:link rel="alternate" hreflang="en" href="${ORIGIN + enPath(file)}"/><xhtml:link rel="alternate" hreflang="ms" href="${ORIGIN + msPath(file)}"/><xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN + enPath(file)}"/>`;
    const mod = new Date(fs.statSync(path.join(module.exports.PUBLIC_DIR, file)).mtimeMs).toISOString().slice(0, 10);
    return [enPath(file), msPath(file)].map((p) =>
      `<url><loc>${ORIGIN + p}</loc><lastmod>${mod}</lastmod>${alt}<changefreq>weekly</changefreq><priority>${p === "/" ? "1.0" : p === "/ms/" ? "0.9" : "0.7"}</priority></url>`).join("\n");
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

const ROBOTS = `User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /api/
Disallow: /farm
Disallow: /records

Sitemap: ${ORIGIN}/sitemap.xml
`;

/* Mount on an Express app, before express.static. */
function mount(app) {
  /* One address per page: Railway's default domain and /index.html, /events (no .html) redirect. */
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (/\.up\.railway\.app$/i.test(req.hostname) && !req.path.startsWith("/api/") && req.path !== "/healthz")
      return res.redirect(301, ORIGIN + req.originalUrl);
    next();
  });
  /* Express treats /ms and /ms/ as the same route, so redirect the bare one first */
  app.use((req, res, next) => (req.method === "GET" || req.method === "HEAD") && req.path === "/ms" ? res.redirect(301, "/ms/" + qs(req)) : next());
  app.get(["/robots.txt"], (req, res) => res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(ROBOTS));
  app.get(["/sitemap.xml"], (req, res) => res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(sitemap()));

  const send = (file, lang) => (req, res) =>
    res.type("html").set("Cache-Control", "public, max-age=300").set("Content-Language", lang).send(page(file, lang));
  for (const [file, p] of PAGES) {
    app.get(p, send(file, "en"));
    app.get(msPath(file), send(file, "ms"));
    if (p !== "/") {
      const bare = p.replace(/\.html$/, "");
      app.get(bare, (req, res) => res.redirect(301, p + qs(req)));
      app.get("/ms" + bare, (req, res) => res.redirect(301, "/ms" + p + qs(req)));
    }
  }
  app.get("/index.html", (req, res) => res.redirect(301, "/" + qs(req)));
  app.get(["/ms", "/ms/index.html"], (req, res) => res.redirect(301, "/ms/" + qs(req)));
}
const qs = (req) => { const i = req.originalUrl.indexOf("?"); return i < 0 ? "" : req.originalUrl.slice(i); };

module.exports = { mount, render, sitemap, PAGES, PUBLIC_DIR: path.join(__dirname, "public") };
