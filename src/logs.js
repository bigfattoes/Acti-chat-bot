// Anonymous question log, visitor ratings, "Teach Acti" answers, and the private /logs page.
//
// Each answered question is saved to Cloudflare D1 (binding "DB"): time, site, page, the question,
// Acti's answer, the outcome, and the visitor's 👍/👎 if they rate it. Emails and phone numbers are
// blanked before saving, nothing identifies the visitor, and rows older than 90 days are deleted.
//
// Answers the team adds on /logs ("Teach Acti") are stored in the `taught` table and added to the
// AI's knowledge on every request (cached for a minute).
//
// GET  /logs        private page (password = the LOGS_PASSWORD secret, any username)
// GET  /logs.csv    same data as a spreadsheet download
// POST /logs/teach  add / edit / delete a taught answer (form on /logs)
// POST /feedback    { rid, rating: 1 | -1 } from the widget
//
// If the DB binding or the password isn't set, logging is skipped and /logs is disabled.

const RETENTION_DAYS = 90;
const DUBAI = "'+4 hours'"; // shown times are Dubai time (UTC+4, no daylight saving)
let tableReady = false;

async function ensureTables(db) {
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
  // Columns added after the first release; ALTER fails harmlessly if they already exist.
  for (const col of ["rid TEXT", "rating INTEGER"]) {
    try {
      await db.prepare(`ALTER TABLE questions ADD COLUMN ${col}`).run();
    } catch {}
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS questions_ts ON questions (ts)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS questions_rid ON questions (rid)").run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS taught (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        question TEXT NOT NULL, answer TEXT NOT NULL
      )`
    )
    .run();
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
    await ensureTables(env.DB);
    await env.DB.prepare(
      "INSERT INTO questions (site, page, question, answer, handoff, topic, refused, rid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        String(site || "").slice(0, 100),
        String(page || "").slice(0, 200),
        scrub(question, 500),
        scrub(result.reply, 2000),
        result.handoff ? 1 : 0,
        result.topic || null,
        result.refused ? 1 : 0,
        result.rid || null
      )
      .run();
    if (Math.random() < 0.02) {
      await env.DB.prepare(`DELETE FROM questions WHERE ts < datetime('now', '-${RETENTION_DAYS} days')`).run();
    }
  } catch (err) {
    console.error("Log write failed:", err?.message || err);
  }
}

// ---------- visitor ratings ----------

export async function saveFeedback(env, body) {
  if (!env.DB) return false;
  const rid = typeof body?.rid === "string" && /^[0-9a-f-]{36}$/i.test(body.rid) ? body.rid : null;
  const rating = body?.rating === 1 || body?.rating === -1 ? body.rating : null;
  if (!rid || !rating) return false;
  try {
    await ensureTables(env.DB);
    // Only recent answers can be rated, and a rating can be changed but not spammed elsewhere.
    await env.DB.prepare("UPDATE questions SET rating = ? WHERE rid = ? AND ts >= datetime('now', '-1 day')")
      .bind(rating, rid)
      .run();
    return true;
  } catch (err) {
    console.error("Feedback write failed:", err?.message || err);
    return false;
  }
}

// ---------- taught answers, added to the AI's knowledge ----------

const MAX_TAUGHT_CHARS = 6000;
let taughtCache = { at: 0, text: "" };

export async function taughtKnowledge(env) {
  if (!env.DB) return "";
  if (Date.now() - taughtCache.at < 60_000) return taughtCache.text;
  try {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare("SELECT question, answer FROM taught ORDER BY id DESC LIMIT 100").all();
    let text = "";
    for (const r of results) {
      const entry = `Q: ${r.question}\nA: ${r.answer}\n\n`;
      if (text.length + entry.length > MAX_TAUGHT_CHARS) break;
      text += entry;
    }
    taughtCache = { at: Date.now(), text: text.trim() };
  } catch (err) {
    console.error("Taught answers read failed:", err?.message || err);
    taughtCache = { at: Date.now(), text: "" };
  }
  return taughtCache.text;
}

// ---------- /logs page ----------

async function guard(request, env) {
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
  return null;
}

// POST /logs/teach — add, edit or delete a taught answer, then go back to the page.
export async function teach(request, env, url) {
  const denied = await guard(request, env);
  if (denied) return denied;
  // Browsers resend saved passwords to any site's form, so only accept forms posted from /logs itself.
  const origin = request.headers.get("Origin");
  if (request.method !== "POST" || (origin && origin !== url.origin)) {
    return new Response("Forbidden", { status: 403 });
  }
  const form = await request.formData();
  const action = form.get("action");
  const id = Number(form.get("id")) || 0;
  const question = String(form.get("question") || "").trim().slice(0, 300);
  const answer = String(form.get("answer") || "").trim().slice(0, 1500);
  await ensureTables(env.DB);
  if (action === "delete" && id) {
    await env.DB.prepare("DELETE FROM taught WHERE id = ?").bind(id).run();
  } else if (question && answer) {
    if (id) await env.DB.prepare("UPDATE taught SET question = ?, answer = ? WHERE id = ?").bind(question, answer, id).run();
    else await env.DB.prepare("INSERT INTO taught (question, answer) VALUES (?, ?)").bind(question, answer).run();
  }
  taughtCache.at = 0; // this isolate picks it up immediately; others within a minute
  const back = String(form.get("back") || "/logs");
  return new Response(null, { status: 303, headers: { Location: back.startsWith("/logs") ? back + "#taught" : "/logs" } });
}

export async function logsPage(request, env, url) {
  const denied = await guard(request, env);
  if (denied) return denied;

  await ensureTables(env.DB);
  const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const view = ["all", "unanswered", "bad", "leads", "offtopic"].includes(url.searchParams.get("view"))
    ? url.searchParams.get("view")
    : "all";
  const since = `datetime('now', '-${days} days')`;
  const viewWhere = {
    all: "",
    unanswered: "AND handoff = 1 AND topic IS NULL AND refused = 0",
    bad: "AND rating = -1",
    leads: "AND topic IS NOT NULL",
    offtopic: "AND refused = 1",
  }[view];
  const csv = url.pathname.endsWith(".csv");

  const db = env.DB;
  const [totals, top, rows, taught] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN handoff = 1 AND topic IS NULL AND refused = 0 THEN 1 ELSE 0 END) AS unanswered,
          SUM(CASE WHEN topic IS NOT NULL THEN 1 ELSE 0 END) AS leads,
          SUM(refused) AS offtopic,
          SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS good,
          SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) AS bad
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
        `SELECT datetime(ts, ${DUBAI}) AS ts, site, page, question, answer, handoff, topic, refused, rating FROM questions
        WHERE ts >= ${since} ${viewWhere} ORDER BY id DESC LIMIT ${csv ? 5000 : 200}`
      )
      .all(),
    db.prepare(`SELECT id, datetime(ts, ${DUBAI}) AS ts, question, answer FROM taught ORDER BY id DESC`).all(),
  ]);

  if (csv) {
    const head = ["time (Dubai)", "site", "page", "question", "answer", "status", "topic", "rating"];
    const lines = [
      head,
      ...rows.results.map((r) => [r.ts, r.site, r.page, r.question, r.answer, status(r), r.topic || "", ratingText(r.rating)]),
    ];
    const body = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="acti-questions-${days}d.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  const html = renderPage({
    days,
    view,
    totals: totals || {},
    top: top.results,
    rows: rows.results,
    taught: taught.results,
    back: url.pathname + url.search,
  });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

async function authorised(request, password) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let given = "";
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
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

function ratingText(v) {
  return v === 1 ? "👍" : v === -1 ? "👎" : "";
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderPage({ days, view, totals, top, rows, taught, back }) {
  const link = (d, v) => `?days=${d}&view=${v}`;
  const tab = (v, label) => `<a class="tab${v === view ? " on" : ""}" href="${link(days, v)}">${label}</a>`;
  const range = (d) => `<a class="tab${d === days ? " on" : ""}" href="${link(d, view)}">${d} days</a>`;
  const taughtSet = new Set(taught.map((t) => t.question.trim().toLowerCase()));
  const badge = (r) => {
    const cls = r.refused ? "off" : r.topic ? "lead" : r.handoff ? "miss" : "ok";
    return `<span class="badge ${cls}">${esc(status(r))}</span>`;
  };
  const stat = (n, label, cls = "") => `<div class="stat ${cls}"><b>${Number(n) || 0}</b><span>${label}</span></div>`;
  const teachForm = (q, a = "", id = "") => `<form class="teach" method="post" action="/logs/teach">
      <input type="hidden" name="back" value="${esc(back)}">${id ? `<input type="hidden" name="id" value="${id}">` : ""}
      <label>Question<input name="question" required maxlength="300" value="${esc(q)}"></label>
      <label>Acti's answer<textarea name="answer" required maxlength="1500" rows="3" placeholder="Write the correct answer, e.g. Yes, there's a food court with healthy options for kids and adults.">${esc(a)}</textarea></label>
      <div class="btns"><button class="save" name="action" value="save">${id ? "Save changes" : "Teach Acti"}</button>${
        id ? `<button class="del" name="action" value="delete" onclick="return confirm('Remove this answer from Acti?')">Remove</button>` : ""
      }</div></form>`;
  const rowHtml = (r) => {
    const canTeach = !r.refused && !r.topic;
    const known = taughtSet.has(String(r.question).trim().toLowerCase());
    return `<div class="row"><div class="meta">${badge(r)}${r.rating ? `<span class="rate">${ratingText(r.rating)}</span>` : ""}${
      known ? `<span class="badge ok">Answer added</span>` : ""
    }<span>${esc(r.ts)}</span><span>${esc(r.site)}${esc(r.page)}</span></div>
      <p class="q">${esc(r.question)}</p>
      <details><summary>Acti's answer</summary><p class="a">${esc(r.answer)}</p></details>
      ${canTeach && !known ? `<details class="add"><summary>${r.handoff || r.rating === -1 ? "＋ Add the right answer" : "＋ Add or correct the answer"}</summary>${teachForm(r.question)}</details>` : ""}
    </div>`;
  };

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
  .stat.miss b,.stat.bad b{color:#B9480A}.stat.lead b,.stat.good b{color:#0B7A3B}
  h2{font-size:16px;margin:24px 0 10px}h2 small{font-weight:400;color:var(--muted)}
  .top{background:#fff;border:1px solid var(--line);border-radius:14px;padding:6px 16px 6px 40px;margin:0}
  .top li{padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}.top li:last-child{border:0}
  .top em{color:var(--muted);font-style:normal;margin-left:6px}
  .row{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin-bottom:10px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:6px}
  .rate{font-size:15px}
  .q{font-weight:700;margin:0 0 4px;overflow-wrap:anywhere}.a{margin:0;color:#3d3947;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
  details summary{cursor:pointer;color:var(--purple);font-size:13px;font-weight:600;margin-top:4px}
  details.add summary{color:#B9480A}
  .badge{padding:2px 8px;border-radius:999px;font-weight:700;font-size:11.5px}
  .ok{background:#EEF7F1;color:#0B7A3B}.miss{background:#FFF1E6;color:#B9480A}.lead{background:#E9F9EF;color:#0B7A3B;border:1px solid #9BE0B4}.off{background:#F1EFF4;color:#6b6577}
  .teach{display:grid;gap:8px;margin-top:10px;padding:12px;border:1px dashed #E3D6EF;border-radius:12px;background:#FCFAFE}
  .teach label{display:grid;gap:4px;font-size:12.5px;font-weight:600;color:var(--muted)}
  .teach input,.teach textarea{font:inherit;font-size:14px;color:var(--ink);padding:8px 10px;border:1.5px solid #DCD7E3;border-radius:10px;background:#fff}
  .teach input:focus,.teach textarea:focus{outline:none;border-color:var(--purple)}
  .btns{display:flex;gap:8px}
  .save{background:var(--purple);color:#fff;border:0;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer}
  .del{background:#fff;color:#B42318;border:1.5px solid #F3C7C3;border-radius:10px;padding:8px 14px;font-weight:700;cursor:pointer}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin-bottom:10px}
  .empty{color:var(--muted);padding:12px 0}
  footer{color:var(--muted);font-size:12px;padding:16px 0 32px}
</style></head><body>
<header><h1>Acti question log</h1><p>Anonymous questions visitors asked Acti. Emails and phone numbers are removed; entries are deleted after 90 days. Times are Dubai time.</p></header>
<main>
  <div class="bar">${range(7)}${range(30)}${range(90)}<span class="spacer"></span><a class="csv" href="logs.csv${link(days, view)}">Download as spreadsheet (CSV)</a></div>
  <div class="stats">
    ${stat(totals.total, "questions")}
    ${stat(totals.unanswered, "couldn't answer", "miss")}
    ${stat(totals.leads, "leads (partner, ambassador, register, team)", "lead")}
    ${stat(totals.good, "👍 helpful", "good")}
    ${stat(totals.bad, "👎 not helpful", "bad")}
    ${stat(totals.offtopic, "off-topic")}
  </div>
  <h2>Most asked</h2>
  ${top.length ? `<ol class="top">${top.map((t) => `<li>${esc(t.q)}<em>× ${t.n}</em></li>`).join("")}</ol>` : `<p class="empty">No questions yet.</p>`}
  <h2>Questions</h2>
  <div class="bar">${tab("all", "All")}${tab("unanswered", "Couldn't answer")}${tab("bad", "👎 Not helpful")}${tab("leads", "Leads")}${tab("offtopic", "Off-topic")}</div>
  ${rows.length ? rows.map(rowHtml).join("") : `<p class="empty">Nothing here for this period.</p>`}
  <h2 id="taught">Answers you've taught Acti <small>(${taught.length}) — Acti uses these within a minute</small></h2>
  <details class="add card"><summary>＋ Teach Acti a new answer</summary>${teachForm("")}</details>
  ${
    taught.length
      ? taught.map((t) => `<div class="card"><div class="meta"><span>Added ${esc(t.ts)}</span></div>${teachForm(t.question, t.answer, t.id)}</div>`).join("")
      : `<p class="empty">None yet. Use "Add the right answer" on any question above.</p>`
  }
  <footer>Showing up to 200 most recent questions.</footer>
</main></body></html>`;
}
