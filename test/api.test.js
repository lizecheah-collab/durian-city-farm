"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcf-test-"));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PASSWORD = "test-password";
process.env.RESEND_API_KEY = "re_test";
process.env.NOTIFY_EMAIL = "farm@example.com";
/* Capture Resend calls instead of sending real email. */
const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opt) => {
  if (String(url).startsWith("https://api.resend.com/")) { sentEmails.push({ url: String(url), opt }); return Promise.resolve(new Response(JSON.stringify({ id: "x" }), { status: 200 })); }
  return realFetch(url, opt);
};
const { app } = require("../server.js");

let server, base, cookie = "";
before(() => new Promise((r) => { server = app.listen(0, () => { base = "http://127.0.0.1:" + server.address().port; r(); }); }));
after(() => { server.closeAllConnections(); server.close(); });

/* An open date: in a season month, at least a few days ahead of openFrom. */
function openDate(avail) {
  const d = new Date(Math.max(Date.now() + 3 * 864e5, Date.parse(avail.openFrom + "T00:00:00Z")));
  while (!avail.seasonMonths.includes(d.getUTCMonth()) || d.toISOString().slice(0, 10) < avail.openFrom) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function form(fields, withReceipt = true) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (withReceipt) fd.append("receipt", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }), "r.jpg");
  return fd;
}
const admin = (p, opt = {}) => fetch(base + p, { ...opt, headers: { "Content-Type": "application/json", cookie, ...(opt.headers || {}) } });

let avail, ref;

test("serves pages", async () => {
  for (const p of ["/", "/book.html", "/events", "/admin.html"]) assert.equal((await fetch(base + p)).status, 200, p);
});

test("public availability has defaults", async () => {
  avail = await (await fetch(base + "/api/availability")).json();
  assert.equal(avail.openFrom, "2026-12-25");
  assert.deepEqual(avail.productsOff, ["buffet", "learning"]);
});

test("rejects booking without receipt", async () => {
  const r = await fetch(base + "/api/bookings", { method: "POST", body: form({ experience: "tour" }, false) });
  assert.equal((await r.json()).error, "bad_file");
});

test("rejects closed product and off-season date", async () => {
  const date = openDate(avail);
  let j = await (await fetch(base + "/api/bookings", { method: "POST", body: form({ experience: "buffet", date, slot: 0, name: "A", phone: "0123456789", people: 2, ack: 1 }) })).json();
  assert.equal(j.error, "product_unavailable");
  const off = date.slice(0, 5) + "02-10"; // Feb is not a season month
  j = await (await fetch(base + "/api/bookings", { method: "POST", body: form({ experience: "tour", date: off, slot: 0, name: "A", phone: "0123456789", people: 2, ack: 1 }) })).json();
  assert.equal(j.error, "date_unavailable");
});

test("accepts a valid booking", async () => {
  const date = openDate(avail);
  const r = await fetch(base + "/api/bookings", { method: "POST", body: form({ experience: "dinein", date, slot: 1, name: "Ali", phone: "012-345 6789", people: 3, variety: "Black Thorn", kg: "2", notes: "=SUM(1)", ack: 1 }) });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.match(j.ref, /^DCF-[A-Z0-9]{6}$/);
  ref = j.ref;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sentEmails.length, 1, "one alert email");
  const mail = JSON.parse(sentEmails[0].opt.body);
  assert.equal(sentEmails[0].opt.headers.Authorization, "Bearer re_test");
  assert.deepEqual(mail.to, ["farm@example.com"]);
  assert.ok(mail.subject.includes(ref));
  assert.ok(mail.html.includes("Ali") && mail.html.includes("RM30"));
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].filename, "receipt-" + ref + ".jpg");
});

test("admin requires login", async () => {
  assert.equal((await fetch(base + "/api/admin/me")).status, 401);
  assert.equal((await fetch(base + "/api/admin/bookings")).status, 401);
  const bad = await admin("/api/admin/login", { method: "POST", body: JSON.stringify({ password: "nope" }) });
  assert.equal(bad.status, 401);
});

test("admin login, list, update, receipt, csv", async () => {
  const r = await admin("/api/admin/login", { method: "POST", body: JSON.stringify({ password: "test-password" }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal((await admin("/api/admin/me")).status, 200);

  let list = await (await admin("/api/admin/bookings?status=pending&upcoming=1&q=ali")).json();
  assert.equal(list.bookings.length, 1);
  assert.equal(list.bookings[0].deposit, 30);
  assert.equal(list.slots.length, 5);

  await admin("/api/admin/bookings/" + ref, { method: "POST", body: JSON.stringify({ status: "confirmed" }) });
  await admin("/api/admin/bookings/" + ref, { method: "POST", body: JSON.stringify({ admin_note: "paid" }) });
  list = await (await admin("/api/admin/bookings?status=confirmed&upcoming=0&q=")).json();
  assert.equal(list.bookings[0].admin_note, "paid");

  const rc = await admin("/api/admin/bookings/" + ref + "/receipt");
  assert.equal(rc.headers.get("content-type"), "image/jpeg");

  const csv = await (await admin("/api/admin/export.csv")).text();
  assert.ok(csv.includes(ref));
  assert.ok(csv.includes("\"'=SUM(1)\""), "formula cells are escaped");
});

test("admin availability round trip blocks bookings", async () => {
  const j = await (await admin("/api/admin/availability")).json();
  const date = openDate(j.availability);
  j.availability.closed.push(date, "not-a-date");
  const saved = await (await admin("/api/admin/availability", { method: "POST", body: JSON.stringify(j.availability) })).json();
  assert.deepEqual(saved.availability.closed, [date]);
  const pub = await (await fetch(base + "/api/availability")).json();
  assert.deepEqual(pub.closed, [date]);
  const b = await (await fetch(base + "/api/bookings", { method: "POST", body: form({ experience: "tour", date, slot: 0, name: "B", phone: "0123456789", people: 1, ack: 1 }) })).json();
  assert.equal(b.error, "date_unavailable");
});

test("logout ends session", async () => {
  await admin("/api/admin/logout", { method: "POST" });
  assert.equal((await admin("/api/admin/me")).status, 401);
});
