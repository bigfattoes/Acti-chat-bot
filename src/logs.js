// Anonymous question log + private /logs page.
//
// Each answered question is saved to Cloudflare D1 (binding "DB"): time, site, page, the question,
// Acti's answer, and whether it handed off to WhatsApp. Emails and phone numbers are blanked
// before saving, nothing identifies the visitor, and rows older than 90 days are deleted.
//
// GET /logs      private page (password = the LOGS_PASSWORD secret, any username)
// GET /logs.csv  same data as a spreadsheet download
//
// If the DB binding or the password isn't set, logging is skipped and /logs is disabled.

const RETENTION_DAYS = 90;
let tableReady = false;

async function ensureTable(db) {
  if (tableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        site TEXT, page TEXT, question TEXT NOT NULL, answer TEXT,
        handoff INTEGER NOT NULL DEFAULT 0, topic TEXT, refused INTEGER NOT NULL DEFAULT 0
      )`
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS questions_ts ON questions (ts)").run();
  tableReady = true;
}

// Same idea as the widget's WhatsApp scrubbing: no emails or phone numbers in the log.
export function scrub(text, max) {
  return String(text ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .slice(0, max);
}

export async function logQuestion(env, { site, page, question, result }) {
  if (!env.DB) return;
  try {
    await ensureTable(env.DB);
    await env.DB.prepare(
      "INSERT INTO questions (site, page, question, answer, handoff, topic, refused) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        String(site || "").slice(0, 100),
        String(page || "").slice(0, 200),
        scrub(question, 500),
        scrub(result.reply, 2000),
        result.handoff ? 1 : 0,
        result.topic || null,
        result.refused ? 1 : 0
      )
      .run();
    if (Math.random() < 0.02) {
      await env.DB.prepare(`DELETE FROM questions WHERE ts < datetime('now', '-${RETENTION_DAYS} days')`).run();
    }
  } catch (err) {
    console.error("Log write failed:", err?.message || err);
  }
}

// ---------- /logs page ----------

export async function logsPage(request, env, url) {
  if (!env.DB || !env.LOGS_PASSWORD) {
    return new Response("Logs aren't set up yet. Add the LOGS_PASSWORD secret in Cloudflare.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (env.CHAT_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.CHAT_LIMITER.limit({ key: "logs:" + ip });
    if (!success) return new Response("Too many requests. Wait a minute.", { status: 429 });
  }
  if (!(await authorised(request, env.LOGS_PASSWORD))) {
    return new Response("Password required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Acti logs", charset="UTF-8"', "cache-control": "no-store" },
    });
  }

  await ensureTable(env.DB);
  const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const view = ["all", "unanswered", "leads", "offtopic"].includes(url.searchParams.get("view"))
    ? url.searchParams.get("view")
    : "all";
  const since = `datetime('now', '-${days} days')`;
  const viewWhere = {
    all: "",
    unanswered: "AND handoff = 1 AND topic IS NULL AND refused = 0",
    leads: "AND topic IS NOT NULL",
    offtopic: "AND refused = 1",
  }[view];

  const db = env.DB;
  const [totals, top, rows] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN handoff = 1 AND topic IS NULL AND refused = 0 THEN 1 ELSE 0 END) AS unanswered,
          SUM(CASE WHEN topic IS NOT NULL THEN 1 ELSE 0 END) AS leads,
          SUM(refused) AS offtopic
        FROM questions WHERE ts >= ${since}`
      )
      .first(),
    db
      .prepare(
        `SELECT lower(trim(question)) AS q, COUNT(*) AS n FROM questions
        WHERE ts >= ${since} AND refused = 0 GROUP BY q ORDER BY n DESC, q LIMIT 15`
      )
      .all(),
    db
      .prepare(
        `SELECT ts, site, page, question, answer, handoff, topic, refused FROM questions
        WHERE ts >= ${since} ${viewWhere} ORDER BY id DESC LIMIT ${url.pathname.endsWith(".csv") ? 5000 : 200}`
      )
      .all(),
  ]);

  if (url.pathname.endsWith(".csv")) {
    const head = ["time (UTC)", "site", "page", "question", "answer", "status", "topic"];
    const lines = [head, ...rows.results.map((r) => [r.ts, r.site, r.page, r.question, r.answer, status(r), r.topic || ""])];
    const csv = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="acti-questions-${days}d.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  return new Response(renderPage({ days, view, totals: totals || {}, top: top.results, rows: rows.results }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

async function authorised(request, password) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let given = "";
  try {
    const decoded = atob(header.slice(6));
    given = decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return false;
  }
  // Compare hashes so the check takes the same time whatever was typed.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(password)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function status(r) {
  if (r.refused) return "Off-topic";
  if (r.topic) return "Lead: " + r.topic;
  if (r.handoff) return "Couldn't answer";
  return "Answered";
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderPage({ days, view, totals, top, rows }) {
  const link = (d, v) => `?days=${d}&view=${v}`;
  const tab = (v, label) =>
    `<a class="tab${v === view ? " on" : ""}" href="${link(days, v)}">${label}</a>`;
  const range = (d) => `<a class="tab${d === days ? " on" : ""}" href="${link(d, view)}">${d} days</a>`;
  const badge = (r) => {
    const s = status(r);
    const cls = r.refused ? "off" : r.topic ? "lead" : r.handoff ? "miss" : "ok";
    return `<span class="badge ${cls}">${esc(s)}</span>`;
  };
  const stat = (n, label, cls = "") => `<div class="stat ${cls}"><b>${Number(n) || 0}</b><span>${label}</span></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Acti question log</title>
<style>
  :root{--purple:#6F23B0;--orange:#EE6A1A;--ink:#1d1d24;--muted:#6b6577;--line:#ECEAF0;--bg:#faf8fd}
  *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg)}
  header{background:linear-gradient(120deg,var(--purple),#8A33C9 60%,var(--orange) 140%);color:#fff;padding:24px 16px}
  header h1{margin:0;font-size:22px}header p{margin:4px 0 0;opacity:.9;font-size:14px}
  main{max-width:1100px;margin:0 auto;padding:16px}
  .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 16px}
  .tab{padding:7px 12px;border-radius:999px;border:1.5px solid var(--line);background:#fff;color:var(--ink);text-decoration:none;font-size:14px;font-weight:600}
  .tab.on{background:var(--purple);border-color:var(--purple);color:#fff}
  .spacer{flex:1}.csv{color:var(--purple);font-weight:600;font-size:14px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .stat b{display:block;font-size:28px}.stat span{color:var(--muted);font-size:13px}
  .stat.miss b{color:#B9480A}.stat.lead b{color:#0B7A3B}
  h2{font-size:16px;margin:24px 0 10px}
  .top{background:#fff;border:1px solid var(--line);border-radius:14px;padding:6px 16px 6px 40px;margin:0}
  .top li{padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}.top li:last-child{border:0}
  .top em{color:var(--muted);font-style:normal;margin-left:6px}
  .row{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin-bottom:10px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:6px}
  .q{font-weight:700;margin:0 0 4px;overflow-wrap:anywhere}.a{margin:0;color:#3d3947;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
  details summary{cursor:pointer;color:var(--purple);font-size:13px;font-weight:600;margin-top:4px}
  .badge{padding:2px 8px;border-radius:999px;font-weight:700;font-size:11.5px}
  .ok{background:#EEF7F1;color:#0B7A3B}.miss{background:#FFF1E6;color:#B9480A}.lead{background:#E9F9EF;color:#0B7A3B;border:1px solid #9BE0B4}.off{background:#F1EFF4;color:#6b6577}
  .empty{color:var(--muted);padding:24px 0}
  footer{color:var(--muted);font-size:12px;padding:16px 0 32px}
</style></head><body>
<header><h1>Acti question log</h1><p>Anonymous questions visitors asked Acti. Emails and phone numbers are removed; entries are deleted after 90 days.</p></header>
<main>
  <div class="bar">${range(7)}${range(30)}${range(90)}<span class="spacer"></span><a class="csv" href="logs.csv${link(days, view)}">Download as spreadsheet (CSV)</a></div>
  <div class="stats">
    ${stat(totals.total, "questions")}
    ${stat(totals.unanswered, "couldn't answer", "miss")}
    ${stat(totals.leads, "partner / ambassador / register / team", "lead")}
    ${stat(totals.offtopic, "off-topic")}
  </div>
  <h2>Most asked</h2>
  ${top.length ? `<ol class="top">${top.map((t) => `<li>${esc(t.q)}<em>× ${t.n}</em></li>`).join("")}</ol>` : `<p class="empty">No questions yet.</p>`}
  <h2>Questions</h2>
  <div class="bar">${tab("all", "All")}${tab("unanswered", "Couldn't answer")}${tab("leads", "Leads")}${tab("offtopic", "Off-topic")}</div>
  ${
    rows.length
      ? rows
          .map(
            (r) => `<div class="row"><div class="meta">${badge(r)}<span>${esc(r.ts)} UTC</span><span>${esc(r.site)}${esc(r.page)}</span></div>
      <p class="q">${esc(r.question)}</p><details><summary>Acti's answer</summary><p class="a">${esc(r.answer)}</p></details></div>`
          )
          .join("")
      : `<p class="empty">Nothing here for this period.</p>`
  }
  <footer>Showing up to 200 most recent. Times are UTC (Dubai is UTC+4).</footer>
</main></body></html>`;
}
