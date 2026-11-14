"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dcf-seo-"));
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-password";
const { app } = require("../server.js");

let server, base, port;
before(() => new Promise((r) => { server = app.listen(0, () => { port = server.address().port; base = "http://127.0.0.1:" + port; r(); }); }));
after(() => { server.closeAllConnections(); server.close(); });

const get = (p) => fetch(base + p, { redirect: "manual" });
const html = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return r.text(); };

test("robots.txt and sitemap.xml", async () => {
  const robots = await (await get("/robots.txt")).text();
  assert.match(robots, /Sitemap: https:\/\/www\.duriancityfarm\.com\/sitemap\.xml/);
  assert.match(robots, /Disallow: \/admin\.html/);
  const sm = await (await get("/sitemap.xml")).text();
  assert.equal((sm.match(/<loc>/g) || []).length, 12);
  assert.ok(sm.includes("<loc>https://www.duriancityfarm.com/ms/faq.html</loc>"));
});

test("llms.txt is served", async () => {
  const r = await get("/llms.txt");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /^# Durian City Farm/);
});

test("English pages have canonical, hreflang, Open Graph and a single H1", async () => {
  for (const p of ["/", "/book.html", "/events.html", "/retreat.html", "/partner.html", "/faq.html"]) {
    const h = await html(p);
    assert.ok(h.includes(`<link rel="canonical" href="https://www.duriancityfarm.com${p}">`), p + " canonical");
    assert.ok(h.includes('hreflang="ms"'), p + " hreflang");
    assert.ok(h.includes('property="og:image"'), p + " og");
    assert.ok(h.includes('window.DCF_PAGE_LANG="en"'), p + " lang flag");
    const visible = h.replace(/<script\b[\s\S]*?<\/script>/g, "");
    assert.equal((visible.match(/<h1[\s>]/g) || []).length, 1, p + " one h1");
    assert.ok(!/data:image\/(jpeg|png|webp);base64/.test(h), p + " no embedded photos");
  }
});

test("Malay pages are translated in the HTML", async () => {
  const h = await html("/ms/");
  assert.match(h, /<html lang="ms"/);
  assert.match(h, /<title>Durian City Farm \| Kebun Durian/);
  assert.ok(h.includes("Pengalaman"), "nav translated");
  assert.ok(h.includes('<link rel="canonical" href="https://www.duriancityfarm.com/ms/">'));
  const faq = await html("/ms/faq.html");
  const ld = JSON.parse(faq.match(/<script type="application\/ld\+json">(\{[^<]*"FAQPage"[^<]*)<\/script>/)[1]);
  assert.ok(ld.mainEntity.length >= 14, "all visible questions in schema");
  assert.ok(!/^Where can I/.test(ld.mainEntity[0].name), "FAQ schema in Malay");
});

test("Booking page has readable text for crawlers in the right language", async () => {
  const en = await html("/book.html");
  assert.ok(en.includes("<h1>Book your visit</h1>") && !en.includes("Tempah lawatan anda</h1>"));
  const ms = await html("/ms/book.html");
  assert.ok(ms.includes("<h1>Tempah lawatan anda</h1>") && !ms.includes("<h1>Book your visit</h1>"));
  assert.ok(ms.includes('window.DCF_PAGE_LANG="ms"'));
});

test("Home page structured data is complete and has no self-rated stars", async () => {
  const h = await html("/");
  const ld = JSON.parse(h.match(/<script type="application\/ld\+json">\s*(\{[\s\S]*?"LocalBusiness"[\s\S]*?\})\s*<\/script>/)[1]);
  assert.equal(ld.url, "https://www.duriancityfarm.com/");
  assert.equal(ld.telephone, "+60149095633");
  assert.equal(ld.aggregateRating, undefined);
  assert.ok(ld.makesOffer.length >= 5);
});

test("Duplicate addresses redirect to one URL", async () => {
  for (const [from, to] of [["/index.html", "/"], ["/events", "/events.html"], ["/ms", "/ms/"], ["/ms/index.html", "/ms/"], ["/ms/faq", "/ms/faq.html"]]) {
    const r = await get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get("location"), to, from);
  }
  const res = await new Promise((r) => http.get({ host: "127.0.0.1", port, path: "/faq.html", headers: { Host: "web-production-c0ecc.up.railway.app" } }, r));
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, "https://www.duriancityfarm.com/faq.html");
  res.resume();
  const api = await new Promise((r) => http.get({ host: "127.0.0.1", port, path: "/api/availability", headers: { Host: "web-production-c0ecc.up.railway.app" } }, r));
  assert.equal(api.statusCode, 200, "API still works on the Railway address");
  api.resume();
});

test("Photos are served as cacheable files", async () => {
  const h = await html("/");
  const src = h.match(/src="(\/img\/[0-9a-f]{12}\.webp)"/)[1];
  const r = await get(src);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.match(r.headers.get("cache-control"), /max-age=31536000/);
  assert.equal((await get("/img/og-durian-city-farm.jpg")).status, 200);
});
