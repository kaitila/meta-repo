// The board's single page. Everything inline, nonce'd by the server's CSP; no external
// assets. Task text only ever reaches the DOM through textContent, and the initial state
// is embedded as JSON with every "<" escaped, so a title can't close the script.

/** JSON safe to put inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--lane:#eceef2;--fg:#1b1f24;--muted:#5d6672;--line:#d8dce2;--accent:#2457d6;
--pass:#1a7f37;--fail:#c62828;--warn:#9a6700;--chip:#e3e7ee;--shadow:0 1px 2px rgba(0,0,0,.06),0 2px 8px rgba(0,0,0,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#171b21;--lane:#13171c;--fg:#e6e9ee;--muted:#98a2ae;
--line:#2a313a;--accent:#7aa2ff;--pass:#4ac26b;--fail:#ff7b72;--warn:#d29922;--chip:#232a33;--shadow:none}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
header h1{font-size:15px;margin:0;font-weight:600}
header .meta{color:var(--muted);font-size:12px;margin-left:auto;display:flex;gap:12px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:var(--pass);display:inline-block}
.dot.off{background:var(--fail)}
main{display:flex;gap:10px;padding:12px 16px;overflow-x:auto;align-items:flex-start;min-height:calc(100vh - 50px)}
.lane{flex:0 0 240px;background:var(--lane);border:1px solid var(--line);border-radius:10px;padding:8px;max-height:calc(100vh - 80px);overflow-y:auto}
.lane.empty{flex-basis:120px;opacity:.7}
.lane h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:2px 4px 8px;display:flex;justify-content:space-between}
.lane.attn h2{color:var(--warn)}
.card{display:block;width:100%;text-align:left;background:var(--panel);color:inherit;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0 0 6px;box-shadow:var(--shadow);cursor:pointer;font:inherit}
.card:hover,.card:focus-visible{border-color:var(--accent);outline:none}
.card .id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.card .title{margin:2px 0 6px;overflow-wrap:anywhere}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--chip);color:var(--muted)}
.chip.review{color:var(--warn)}.chip.human{color:var(--fail)}
.none{color:var(--muted);font-size:12px;margin:4px}
#detail{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);background:var(--panel);border-left:1px solid var(--line);
box-shadow:-8px 0 24px rgba(0,0,0,.12);overflow-y:auto;padding:16px 20px 32px;z-index:3}
#detail[hidden]{display:none}
#detail h2{font-size:17px;margin:4px 0 8px;overflow-wrap:anywhere}
#detail h3{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:20px 0 6px}
.close{float:right;background:none;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:2px 10px;cursor:pointer;font:inherit}
.spec{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
ul.checks,ul.hist{list-style:none;padding:0;margin:0}
ul.checks li{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px}
.v{font-weight:600;font-size:12px}.v.pass{color:var(--pass)}.v.fail{color:var(--fail)}.v.pending{color:var(--muted)}
.ev{color:var(--muted);font-size:12px;margin-top:4px;overflow-wrap:anywhere;white-space:pre-wrap}
ul.hist li{padding:6px 0;border-bottom:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}
ul.hist time{color:var(--muted);font-size:12px;margin-right:6px}
a{color:var(--accent)}
.approve{margin-top:16px;padding:12px;border:1px solid var(--warn);border-radius:8px}
.approve label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.approve input{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:13px ui-monospace,monospace}
.approve button{margin-top:8px;padding:7px 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.msg{font-size:12px;margin-top:6px}.msg.err{color:var(--fail)}.msg.ok{color:var(--pass)}
@media (max-width:640px){main{flex-direction:column;overflow-x:visible}.lane,.lane.empty{flex:none;width:100%;max-height:none}
header .meta .hint{display:none}#detail{padding:14px 16px 28px}}
`;

const JS = `
"use strict";
const S = JSON.parse(document.getElementById("initial").textContent);
let lastEvent = S.lastEvent, openId = null, token = "", live = true;
const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
const when = (ms) => new Date(ms).toLocaleString();
const label = (s) => s.replace(/_/g, " ");
async function get(path) {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || r.statusText);
  return r.json();
}
function renderBoard(tasks) {
  const main = $("main");
  main.replaceChildren();
  for (const lane of S.lanes) {
    const ts = tasks.filter((t) => t.status === lane);
    const sec = el("section", "lane" + (ts.length ? "" : " empty") + (lane === "needs_approval" && ts.length ? " attn" : ""));
    sec.setAttribute("aria-label", label(lane));
    const h = el("h2");
    h.append(el("span", "", label(lane)), el("span", "", ts.length));
    sec.append(h);
    if (!ts.length) sec.append(el("div", "none", "none"));
    for (const t of ts) {
      const b = el("button", "card");
      b.type = "button";
      b.append(el("div", "id", t.id), el("div", "title", t.title));
      const row = el("div", "row");
      row.append(el("span", "chip " + t.risk, t.risk));
      if (t.assignee) row.append(el("span", "chip", "@" + t.assignee));
      b.append(row);
      b.addEventListener("click", () => openTask(t.id));
      sec.append(b);
    }
    main.append(sec);
  }
  $("#count").textContent = tasks.length + " tasks";
}
function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}
function summary(e) {
  const d = e.data || {};
  const parts = [];
  for (const k of ["note", "reason", "pr", "summary", "branch"]) if (d[k]) parts.push(k + ": " + d[k]);
  if (Array.isArray(d.results)) parts.push(d.results.map((r) => r.check + (r.pass ? " pass" : " fail")).join(", "));
  return parts.join("\\n");
}
async function openTask(id) {
  openId = id;
  if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
  let d;
  try { d = await get("/api/tasks/" + encodeURIComponent(id)); } catch (e) { return; }
  if (openId !== id) return;
  const t = d.task, p = $("#detail");
  const typing = document.activeElement && document.activeElement.id === "token";
  p.replaceChildren();
  const close = el("button", "close", "Close");
  close.type = "button";
  close.addEventListener("click", closeTask);
  p.append(close, el("div", "id", t.id), el("h2", "", t.title));
  const row = el("div", "row");
  row.append(el("span", "chip", label(t.status)), el("span", "chip " + t.risk, t.risk));
  if (t.assignee) row.append(el("span", "chip", "@" + t.assignee));
  if (t.branch) row.append(el("span", "chip", t.branch));
  p.append(row);
  if (t.pr) {
    const h = el("h3", "", "Pull request"), u = safeUrl(t.pr);
    p.append(h);
    if (u) { const a = el("a", "", t.pr); a.href = u; a.rel = "noopener noreferrer"; a.target = "_blank"; p.append(a); }
    else p.append(el("div", "", t.pr));
  }
  if (t.status === "needs_approval" && S.canApprove) p.append(approveBox(t.id));
  p.append(el("h3", "", "Spec"), el("pre", "spec", t.spec || "(none)"));
  p.append(el("h3", "", "Acceptance checks"));
  const ul = el("ul", "checks");
  for (const c of d.checks) {
    const li = el("li");
    const head = el("div", "row");
    const v = c.verdict;
    head.append(el("span", "chip", c.id + " · " + c.kind), el("span", "v " + (v ? (v.pass ? "pass" : "fail") : "pending"), v ? (v.pass ? "pass" : "fail") : "no verdict yet"));
    li.append(head, el("div", "", c.text));
    if (v) li.append(el("div", "ev", v.evidence + "\\n— " + v.by + ", " + when(v.at)));
    ul.append(li);
  }
  p.append(ul, el("h3", "", "History"));
  const hl = el("ul", "hist");
  for (const e of d.events.slice().reverse()) {
    const li = el("li");
    li.append(el("time", "", when(e.at)), el("strong", "", e.type), document.createTextNode(" by " + e.actor + " (" + e.actorKind + ")"));
    const s = summary(e);
    if (s) li.append(el("div", "ev", s));
    hl.append(li);
  }
  p.append(hl);
  p.hidden = false;
  const inp = $("#token");
  if (typing && inp) inp.focus();
}
function approveBox(id) {
  const box = el("div", "approve");
  const lab = el("label", "", "Token from the terminal running fm serve");
  const inp = el("input");
  inp.type = "password"; inp.autocomplete = "off"; inp.value = token; inp.id = "token";
  lab.htmlFor = "token";
  const btn = el("button", "", "Approve " + id);
  btn.type = "button";
  const msg = el("div", "msg");
  // Kept as typed, so a live refresh that rebuilds the panel doesn't lose it.
  inp.addEventListener("input", () => { token = inp.value; });
  btn.addEventListener("click", async () => {
    msg.className = "msg"; msg.textContent = "Approving…";
    try {
      const r = await fetch("/api/tasks/" + encodeURIComponent(id) + "/approve", { method: "POST", headers: { "x-foreman-token": inp.value.trim() } });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { msg.className = "msg ok"; msg.textContent = "Approved."; await refresh(); }
      else { msg.className = "msg err"; msg.textContent = body.message || "refused"; }
    } catch (e) { msg.className = "msg err"; msg.textContent = "couldn't reach the board: " + (e && e.message ? e.message : e); }
  });
  box.append(lab, inp, btn, msg);
  return box;
}
function closeTask() {
  openId = null; $("#detail").hidden = true;
  history.replaceState(null, "", location.pathname);
}
async function refresh() {
  const s = await get("/api/tasks");
  lastEvent = Math.max(lastEvent, s.lastEvent);
  renderBoard(s.tasks);
  if (openId) await openTask(openId);
}
async function poll() {
  try {
    const r = await get("/api/events?since=" + lastEvent);
    setLive(true);
    if (r.events.length) { lastEvent = r.lastEvent; await refresh(); }
  } catch { setLive(false); }
  setTimeout(poll, 2000);
}
function setLive(on) {
  if (on === live) return;
  live = on;
  $("#live").className = "dot" + (on ? "" : " off");
  $("#livetext").textContent = on ? "live" : "offline";
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openId) closeTask(); });
renderBoard(S.tasks);
setTimeout(poll, 2000);
if (location.hash.length > 1) { try { openTask(decodeURIComponent(location.hash.slice(1))); } catch {} }
`;

export function pageHtml(nonce: string, initial: unknown): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>foreman board</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header><h1>foreman board</h1><div class="meta"><span id="count"></span><span><span id="live" class="dot"></span> <span id="livetext">live</span></span><span class="hint">read-only · 127.0.0.1</span></div></header>
<main></main>
<aside id="detail" hidden aria-label="Task detail"></aside>
<script type="application/json" id="initial">${scriptJson(initial)}</script>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}
