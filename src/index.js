import { DurableObject } from "cloudflare:workers";

/*
  Durable Object: single global store.
  One place to read/write incidents so state stays consistent.
*/
export class IncidentStore extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // GET /incidents
    if (request.method === "GET" && url.pathname === "/incidents") {
      const incidents = (await this.state.storage.get("incidents")) || [];
      return Response.json(incidents);
    }

    // POST /incident
    // - Create new incident
    // - OR legacy update: additionalContext only
    if (request.method === "POST" && url.pathname === "/incident") {
      const body = await request.json();
      const incidents = (await this.state.storage.get("incidents")) || [];

      // Legacy: update additionalContext only (kept for older clients / prompts)
      if (
        body?.id &&
        typeof body.additionalContext === "string" &&
        !body.title &&
        !body.description &&
        !body.severity
      ) {
        const existing = incidents.find(i => i.id === body.id);
        if (!existing) return new Response("Not found", { status: 404 });

        existing.additionalContext = body.additionalContext;
        existing.updatedAt = new Date().toISOString();

        // Guardrails so UI + AI don't explode on older records
        if (!Array.isArray(existing.contextNotes)) {
          existing.contextNotes = [];
        }

        if (!Array.isArray(existing.timeline)) {
          existing.timeline = [];
        }

        await this.state.storage.put("incidents", incidents);
        return Response.json({ ok: true });
      }

      // Create new incident
      const id = String(body?.id || "").trim();
      const title = String(body?.title || "").trim();
      const description = String(body?.description || "").trim();
      const severity = String(body?.severity || "").trim();

      if (!id || !title || !description || !severity) {
        return new Response("Missing fields (id/title/description/severity)", { status: 400 });
      }

      if (incidents.some(i => i.id === id)) {
        return new Response("Incident ID already exists", { status: 409 });
      }

      const now = new Date().toISOString();

      incidents.push({
        id,
        title,
        description,
        severity: cap(severity),
        status: "Open",
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,

        // Legacy field kept (backwards compat)
        additionalContext: "",

        // Notes-only context (NOT a chat log)
        contextNotes: [],

        aiOutput: [],

        // Timeline entries: keeps the case history readable
        timeline: [
          {
            icon: "🆕",
            title: "Incident Created",
            body: title,
            createdAt: now
          }
        ]
      });

      await this.state.storage.put("incidents", incidents);
      return Response.json({ ok: true });
    }

    // DELETE /incident?id=...
    if (request.method === "DELETE" && url.pathname === "/incident") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing id", { status: 400 });

      const incidents = (await this.state.storage.get("incidents")) || [];
      const next = incidents.filter(i => i.id !== id);

      await this.state.storage.put("incidents", next);
      return Response.json({ ok: true });
    }

    // POST /status
    if (request.method === "POST" && url.pathname === "/status") {
      const body = await request.json();
      const incidents = (await this.state.storage.get("incidents")) || [];
      const incident = incidents.find(i => i.id === body?.id);

      if (!incident) return new Response("Not found", { status: 404 });

      const allowed = new Set(["Open", "Investigating", "Resolved"]);
      const nextStatus = allowed.has(body?.status) ? body.status : "Open";

      incident.status = nextStatus;
      incident.updatedAt = new Date().toISOString();

      // Timeline entry for status changes
      if (!Array.isArray(incident.timeline)) incident.timeline = [];
      incident.timeline.push({
        icon:
          nextStatus === "Resolved"
            ? "✅"
            : nextStatus === "Investigating"
            ? "🔄"
            : "♻️",
        title: "Status Changed",
        body: "→ " + nextStatus,
        createdAt: incident.updatedAt
      });

      if (nextStatus === "Resolved") {
        if (!incident.resolvedAt) incident.resolvedAt = new Date().toISOString();
      } else {
        // Reopening: clear resolvedAt so open-case metrics + lists stay correct
        incident.resolvedAt = null;
      }

      await this.state.storage.put("incidents", incidents);
      return Response.json({ ok: true });
    }

    // POST /context-note
    // Stores a single user note with timestamp (append-only)
    if (request.method === "POST" && url.pathname === "/context-note") {
      const body = await request.json();
      const incidents = (await this.state.storage.get("incidents")) || [];
      const incident = incidents.find(i => i.id === body?.id);

      if (!incident) return new Response("Not found", { status: 404 });

      const text = String(body?.text || "").trim();
      if (!text) return new Response("Missing text", { status: 400 });

      if (!Array.isArray(incident.contextNotes)) {
        incident.contextNotes = [];
      }

      if (!Array.isArray(incident.timeline)) incident.timeline = [];

      const stamp = new Date().toISOString();

      incident.contextNotes.push({
        text,
        createdAt: stamp
      });

      incident.timeline.push({
        icon: "📝",
        title: "Context Note Added",
        body: text,
        createdAt: stamp
      });

      // Keep legacy additionalContext updated (AI prompt + backwards compatibility)
      incident.additionalContext = incident.contextNotes
        .slice(-16)
        .map(n => "(" + n.createdAt + ") " + n.text)
        .join("\n");

      incident.updatedAt = stamp;

      await this.state.storage.put("incidents", incidents);
      return Response.json({ ok: true });
    }

    // POST /ai
    if (request.method === "POST" && url.pathname === "/ai") {
      const body = await request.json();
      const incidents = (await this.state.storage.get("incidents")) || [];
      const incident = incidents.find(i => i.id === body?.id);

      if (!incident) return new Response("Not found", { status: 404 });

      const mode = body?.mode;

      // Severity-aware guidance (kept exactly as-is, just re-commented)
      const sev = String(incident.severity || "").toLowerCase();
      const severityGuidance =
        sev === "high"
          ? [
              "Severity guidance (HIGH): treat as service-impacting / urgent.",
              "Prioritise immediate containment and stabilisation over deep root-cause.",
              "Include escalation/communications where appropriate (on-call, incident commander, stakeholder comms).",
              "Prefer safe, reversible changes. Suggest temporary mitigations first.",
              "Ask for the single most critical missing signal if needed (exact error, logs, time window)."
            ].join("\n")
          : sev === "medium"
          ? [
              "Severity guidance (MEDIUM): impact likely limited, but still time-sensitive.",
              "Balance mitigation with diagnosis. Suggest quick checks first, then deeper analysis.",
              "Ask 1–2 clarifying questions that unlock the next action."
            ].join("\n")
          : [
              "Severity guidance (LOW): limited impact / lower urgency.",
              "Focus on diagnosis, reproducibility, and preventative fixes.",
              "Ask clarifying questions and propose low-risk experiments."
            ].join("\n");

      const instructionMap = {
        summary:
          "Write a clear technical summary in plain text. Acknowledge relevant actions already attempted if mentioned in the notes. Avoid 'we'. Keep it factual and concise.",
        next_steps:
          "Give the user clear next steps. Use numbered steps (1, 2, 3...). Address the user as 'you'. Do not say 'we'. Add one short reason after each step.\n\n" +
          "IMPORTANT:\n" +
          "- Explicitly acknowledge what the user has already tried based on the notes.\n" +
          "- Do NOT repeat steps the user has already attempted.\n" +
          "- Build on previous attempts.\n" +
          "- After the steps, ask 1–3 short clarifying questions to refine the next actions.\n" +
          "- Keep explanations brief (one short sentence per step).",
        stakeholder_update:
          "Write a calm update for non-technical stakeholders in plain text. Acknowledge mitigation attempts already made if relevant. Avoid 'we'. Keep it short and reassuring. Ensure everything, including 'Next Steps' in the response, are kept between 'Dear Stakeholder' and 'Yours Sincerely,'."
      };

      const instruction = instructionMap[mode];
      if (!instruction) return new Response("Unknown mode", { status: 400 });

      const notes = Array.isArray(incident.contextNotes) ? incident.contextNotes : [];
      const notesSnippet = notes
        .slice(-18)
        .map(n => "- (" + n.createdAt + ") " + n.text)
        .join("\n");

      const prompt = `
Incident: ${incident.title}
Description: ${incident.description}
Severity: ${incident.severity}
Status: ${incident.status}

Additional context notes (most recent last):
${notesSnippet || "None provided."}

You must base your response on the additional context notes provided. Assume the user expects you to remember and build on them.
${severityGuidance}

${instruction}
Do not use markdown.
Do not use bullet symbols like * or -.
Use short paragraphs with blank lines between them (except numbered steps for next steps).
Do not invent facts.
`.trim();

      const result = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        prompt,
        max_tokens: 360
      });

      const clean = cleanAIText(result?.response || "");
      const stamp = new Date().toISOString();

      // Stored as ISO; UI formats it nicely
      const stampedText = "Update time: " + stamp + "\n\n" + clean;

      incident.aiOutput = Array.isArray(incident.aiOutput) ? incident.aiOutput : [];
      incident.aiOutput.push({
        type: mode,
        title:
          mode === "summary"
            ? "Summary"
            : mode === "next_steps"
            ? "Next Steps"
            : "Stakeholder Update",
        text: stampedText,
        createdAt: stamp
      });

      // Timeline entry for AI outputs
      if (!Array.isArray(incident.timeline)) incident.timeline = [];
      incident.timeline.push({
        icon: "🤖",
        title:
          mode === "summary"
            ? "AI: Summary Generated"
            : mode === "next_steps"
            ? "AI: Next Steps Generated"
            : "AI: Stakeholder Update Generated",
        body: "Action: " + String(mode || ""),
        createdAt: stamp
      });

      incident.updatedAt = stamp;

      await this.state.storage.put("incidents", incidents);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
}

/*
  Worker entry:
  - serves the dashboard HTML
  - proxies everything else to the Durable Object store
*/
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/dashboard") {
      return new Response(renderDashboard(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    const id = env.INCIDENT_STORE.idFromName("global");
    const stub = env.INCIDENT_STORE.get(id);
    return stub.fetch(request);
  }
};
/* ======================================================
   Dashboard UI (layout locked)
   ====================================================== */
function renderDashboard() {
  // Anything using `document` needs to stay inside this HTML string (Cloudflare Workers env).
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Incident Dashboard</title>
<style>
:root{
  --bg:#0f1216;
  --panel:#151a21;
  --field:#1f2530;
  --border:#333;
  --text:#e6e6e6;
  --muted:#9aa4b2;
  --focus:#4ea1ff;

  --sidebar-w:340px;
  --control-h:42px;
  --control-r:8px;
  --control-px:12px;
  --stack-gap:12px;
}

*{ box-sizing:border-box; }

body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font-family:system-ui;
}

.container{
  display:grid;
  grid-template-columns:var(--sidebar-w) 1fr;
  height:100vh;
}

.sidebar{
  background:var(--panel);
  padding:24px;
  border-right:1px solid #222;
  overflow-y:auto;
}

.sidebar h2{ margin:0 0 16px 0; }

input, select, button{
  width:100%;
  height:var(--control-h);
  padding:0 var(--control-px);
  margin-bottom:var(--stack-gap);
  border-radius:var(--control-r);
  border:1px solid var(--border);
  background:var(--field);
  color:#fff;
  font-size:14px;
  outline:none;
  appearance:none;
}

input::placeholder{ color:var(--muted); }

input:focus, select:focus{
  border-color:var(--focus);
  box-shadow:0 0 0 3px rgba(78,161,255,.15);
}

button{
  cursor:pointer;
  font-weight:600;
}
button:hover{ border-color:var(--focus); }

hr{
  border:none;
  border-top:1px solid #222;
  margin:16px 0;
}

label.small{
  display:block;
  margin:-4px 0 6px 0;
  font-size:12px;
  color:var(--muted);
}

.main{
  display:grid;
  grid-template-columns: minmax(0, 1fr) 140px 420px;
  gap:28px;
  padding:20px 28px;
  overflow-y:auto;
}

.incident{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  background:#121720;
  padding:10px 12px;
  border-radius:10px;
  margin-bottom:8px;

  border-left:3px solid var(--focus);
}

.incident .name{
  cursor:pointer;
  flex:1;
  min-width:0;
}

/* status dot + bin group */
.incident .tools{
  display:flex;
  align-items:center;
  gap:10px;
}

.status-dot{
  width:10px;
  height:10px;
  border-radius:50%;
  border:1px solid rgba(255,255,255,.15);
  box-shadow:0 0 0 3px rgba(0,0,0,.12);
}
.dot-open{ background:#ff4d4d; }
.dot-investigating{ background:#4ea1ff; }
.dot-resolved{ background:#3a9b5a; }

.incident .bin{
  font-size:20px;
  cursor:pointer;
  opacity:.75;
  padding:2px 4px;
}
.incident .bin:hover{
  opacity:1;
  color:#ff6b6b;
}

.card{
  background:#151a21;
  padding:18px;
  border-radius:12px;
  border:1px solid #222;
  max-width:920px;
}

.card h3{ margin:0 0 6px 0; }
.card p{ margin:8px 0; color:#d7dde6; }

.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  margin:14px 0 8px;
}
.actions button{
  width:auto;
  padding:0 14px;
}

/* Note input + note list */
.note-wrap{
  margin-top:12px;
  border:1px solid #222;
  border-radius:12px;
  background:#121720;
  padding:12px;
}

.note-list{
  display:flex;
  flex-direction:column;
  gap:10px;
  max-height:240px;
  overflow:auto;
  padding-right:6px;
  margin-bottom:12px;
}

.note{
  background:#151a21;
  border:1px solid rgba(255,255,255,.08);
  border-radius:12px;
  padding:10px 12px;
  font-size:13px;
  line-height:1.45;
  white-space:pre-wrap;
  word-break:break-word;
}

.note-meta{
  display:block;
  margin-top:6px;
  font-size:11px;
  color:#9aa4b2;
}

textarea{
  width:100%;
  border-radius:10px;
  border:1px solid #333;
  background:#1f2530;
  color:#fff;
  font-size:14px;
  padding:12px;
  outline:none;
  resize:vertical;
  min-height:120px;
}
textarea:focus{
  border-color:var(--focus);
  box-shadow:0 0 0 3px rgba(78,161,255,.15);
}

.ai-block{
  margin-top:14px;
  background:#151a21;
  border:1px solid #222;
  border-left:3px solid var(--focus);
  border-radius:12px;
  padding:12px 14px;
  max-width:920px;
}
.ai-block strong{
  display:block;
  margin-bottom:8px;
  letter-spacing:.2px;
}
.ai-block pre{
  margin:0;
  white-space:pre-wrap;
  word-break:break-word;
  line-height:1.6;
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:13px;
  color:#e9eef7;
}

/* Metrics */
.metrics{
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 320px;
  align-self: start;
}

.metric{
  background:#151a21;
  border:1px solid #222;
  border-radius:12px;
  padding:16px;
  text-align:center;
}
.metric .label{
  font-size:13px;
  color:#cbd5e1;
  margin-bottom:6px;
}
.metric .value{
  font-size:26px;
  font-weight:700;
  letter-spacing:.2px;
}
  .metric{
  cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}
.metric:hover{
  border-color: var(--focus);
  background-color: #18202b;
}
  .metric.active{
  border-color: var(--focus);
  box-shadow: 0 0 0 2px rgba(78,161,255,.15);
}
  .metric:focus-visible{
  outline: none;
  border-color: var(--focus);
  box-shadow: 0 0 0 3px rgba(78,161,255,.25);
}
  .metric[data-filter=""]{
  cursor: default;
}

#activeFilterHint{
  align-self: start;
  margin-top: 26px; 
  font-size: 12px;
  color: var(--muted);
  opacity: .85;
  white-space: nowrap;
  pointer-events: none;
}

@media (max-width: 1200px){
  .main{
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
    align-content: start;
  }

  /* Metrics always first */
  .metrics{
    position: static;
    order: 0;
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 8px;
  }

  /* Active filter always second */
  #activeFilterHint{
    order: 1;
    display: block;
    margin: 4px 0 8px;
    text-align: center;
  }

  /* Main panel / empty state always last */
  #details{
    order: 2;
    margin-top: 0;
  }
}

/* Dropdown arrows (keeps exact same sizing/layout) */
select{
  padding-right:34px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%239aa4b2' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat:no-repeat;
  background-position:right 12px center;
  background-size:18px 18px;
}
</style>
</head>

<body>
<div class="container">

  <div class="sidebar">
    <h2>Incident Dashboard</h2>

    <input id="cid" placeholder="Incident ID">
    <input id="ctitle" placeholder="Title">
    <input id="cdesc" placeholder="Description">

    <select id="csev">
      <option>High</option>
      <option selected>Medium</option>
      <option>Low</option>
    </select>

    <button onclick="create()">Create Incident</button>

    <hr>

    <input id="search" placeholder="Search by title" oninput="renderSidebar(incidents)">

    <label class="small">From date</label>
    <input id="from" type="date" onchange="renderSidebar(incidents)">

    <label class="small">Until date</label>
    <input id="until" type="date" onchange="renderSidebar(incidents)">

    <hr>

    <div id="list"></div>
  </div>

<div class="main">
  <div id="details"></div>
  <div id="activeFilterHint"></div>
  <div class="metrics" id="metrics"></div>
</div>

<script>
let incidents = [];
let currentId = null;
let metricFilter = "all"; // all | open | resolved
let timelineOpen = false;
let notesOpen = true;
const aiOpenState = {};

/*
  Metrics
  These numbers drive the quick “Total/Open/Resolved/Avg Resolution” cards.
*/
function renderMetrics(list){
  const total = list.length;
  const open = list.filter(i => (i.status || "").toLowerCase() === "open").length;
  const resolved = list.filter(i => (i.status || "").toLowerCase() === "resolved").length;

  const resolvedWithDates = list.filter(i => i.resolvedAt && i.createdAt);
  let avg = "—";
  if (resolvedWithDates.length) {
    const ms = resolvedWithDates
      .map(i => new Date(i.resolvedAt).getTime() - new Date(i.createdAt).getTime())
      .filter(n => Number.isFinite(n) && n >= 0);

    if (ms.length) {
      const avgMs = ms.reduce((a,b) => a + b, 0) / ms.length;
      avg = humanDuration(avgMs);
    }
  }

metrics.innerHTML =
  '<div class="metric" tabindex="0" data-filter="all">' +
    '<div class="label">Total</div>' +
    '<div class="value">' + total + '</div>' +
  '</div>' +

  '<div class="metric" tabindex="0" data-filter="open">' +
    '<div class="label">Open</div>' +
    '<div class="value">' + open + '</div>' +
  '</div>' +

  '<div class="metric" tabindex="0" data-filter="resolved">' +
    '<div class="label">Resolved</div>' +
    '<div class="value">' + resolved + '</div>' +
  '</div>' +

  '<div class="metric" tabindex="0" data-filter="">' +
    '<div class="label">Avg Resolution</div>' +
    '<div class="value">' + avg + '</div>' +
  '</div>';
}

function humanDuration(ms){
  const mins = Math.round(ms / 60000);
  if (mins < 60) return mins + "m";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.round(hrs / 24);
  return days + "d";
}

/*
  Sidebar rendering
  Keeps existing search + date filters, then splits into Open / Closed.
*/
function renderSidebar(list){
  listEl.innerHTML = "";

  const q = (search.value || "").toLowerCase().trim();
  const fromD = fromDate();
  const untilD = untilDate();

  const filtered = list.filter(i => {
    const t = (i.title || "").toLowerCase();
    const created = i.createdAt ? new Date(i.createdAt) : null;

    const okTitle = !q || t.includes(q);
    const okFrom = !fromD || (created && created >= fromD);
    const okUntil = !untilD || (created && created <= untilD);

    return okTitle && okFrom && okUntil;
  });

  const openCases = filtered.filter(i => i.status !== "Resolved");
  const closedCases = filtered.filter(i => i.status === "Resolved");

  if (openCases.length) {
    listEl.appendChild(sectionHeader("Open Cases"));
    openCases.forEach(i => listEl.appendChild(renderRow(i)));
  }

  if (closedCases.length) {
    listEl.appendChild(sectionHeader("Closed Cases"));
    closedCases.forEach(i => listEl.appendChild(renderRow(i)));
  }

  if (!openCases.length && !closedCases.length) {
    const empty = document.createElement("div");
    empty.style.color = "#9aa4b2";
    empty.style.fontSize = "13px";
    empty.textContent = "No incidents found.";
    listEl.appendChild(empty);
  }
}

function renderRow(i){
  const row = document.createElement("div");
  row.className = "incident";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = i.id + " (" + cap(i.severity) + ")";
  name.addEventListener("click", () => show(i.id));

  const dot = document.createElement("div");
  dot.className = "status-dot " + statusDotClass(i.status);

  const bin = document.createElement("div");
  bin.className = "bin";
  bin.textContent = "🗑";
  bin.addEventListener("click", (e) => {
    e.stopPropagation();
    removeIncident(i.id);
  });

  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(dot, bin);

  row.append(name, tools);
  return row;
}

function sectionHeader(text){
  const h = document.createElement("div");
  h.textContent = text;
  h.style.margin = "14px 0 6px";
  h.style.fontSize = "12px";
  h.style.fontWeight = "600";
  h.style.letterSpacing = ".04em";
  h.style.color = "#9aa4b2";
  return h;
}

function statusDotClass(status){
  const s = String(status || "Open").toLowerCase();
  if (s === "resolved") return "dot-resolved";
  if (s === "investigating") return "dot-investigating";
  return "dot-open";
}

/*
  Main panel
  Shows details, notes, timeline, and AI outputs.
  Resolved cases intentionally collapse controls.
*/
function show(id){
  currentId = id;
  const i = incidents.find(x => x.id === id);
  if (!i) {
    details.innerHTML = "";
    return;
  }

  const status = i.status || "Open";
  const isResolved = status === "Resolved";
  const notes = Array.isArray(i.contextNotes) ? i.contextNotes : [];

  let html = "";

  html += "<div class='card'>";

  // Title row: title left, created time right
  html += "<div style='display:flex;justify-content:space-between;align-items:baseline;gap:12px'>";
  html += "<h3 style='margin:0'>" + escapeHtml(i.title) + "</h3>";
  html += "<div style='font-size:12px;font-weight:600;color:#9aa4b2'>";
  html += "Created: " + (i.createdAt ? niceDate(i.createdAt) : "-");
  html += "</div>";
  html += "</div>";

  html += "<p style='font-size:13px;color:#d7dde6'>" + escapeHtml(i.description) + "</p>";
if (isResolved) {
  html += "<div style='height:1px;background:#222;margin:14px 0'></div>";

  html += "<div style='font-weight:700;font-size:20px;margin:8px 0'>";
  html += "Post Incident Review";
  html += "</div>";

  html += "<div style='height:1px;background:#222;margin:14px 0'></div>";
}

  // Status controls only make sense for active cases
  if (!isResolved) {
    html += "<div style='font-weight:700;font-size:15px;margin:12px 0 6px 0'>Status</div>";
    html += "<select id='statusSelect'>";
    html += optionHtml("Open", status);
    html += optionHtml("Investigating", status);
    html += optionHtml("Resolved", status);
    html += "</select>";

    html += "<button id='changeStatusBtn' style='width:auto;padding:0 14px'>Change Status</button>";
  }

if (i.resolvedAt) {
  html += "<div style='margin-top:10px;text-align:right;font-size:12px'>";
  html += "<strong style='color:#fff;font-weight:700'>Resolved:</strong> ";
  html += "<span style='color:#9aa4b2;font-weight:600'>" + niceDate(i.resolvedAt) + "</span>";
  html += "</div>";
}

  // Notes (collapsible)
html += "<div style='margin-top:14px'>";

const lastNoteIso = notes.length ? notes[notes.length - 1].createdAt : "";
const lastNoteNice = lastNoteIso ? niceDate(lastNoteIso) : "—";

html += "<div class='note-wrap' style='padding:6px 12px;border-left:3px solid var(--focus)'>";

html += "<div style='display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px'>";

html += "<strong" +
        (isResolved && !notesOpen ? " style='position:relative;top:30px'" : "") +
        ">Additional Context (Notes)</strong>";

html += "<span style='font-size:12px;color:#9aa4b2;font-weight:600'>";
html += "Last updated: " + escapeHtml(lastNoteNice);
html += "</span>";

html += "</div>";

html += "<div id='notesInner' style='display:" + (notesOpen ? "block" : "none") + "'>";
html += "<div class='note-list'>" + renderNotes(notes) + "</div>";

if (!isResolved) {
  html += "<textarea id='noteInput' placeholder='Add what you tried, logs, symptoms, mitigations, errors…'></textarea>";
  html += "<div style='height:10px'></div>";
}

html += "</div>";

html += "<div style='display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px'>";

if (!isResolved) {
  html += "<button id='addNoteBtn' style='width:auto;padding:0 14px'>Add Note</button>";
} else {
  html += "<div></div>";
}

html += "<button id='toggleNotesBtn' style='width:auto;padding:0 12px;font-size:12px'>";
html += notesOpen ? "Hide" : "Show";
html += "</button>";

html += "</div>";

html += "</div>";
html += "</div>";

  // Timeline (collapsible)
const timeline = Array.isArray(i.timeline) ? i.timeline : [];
const lastTimelineIso = timeline.length
  ? timeline[timeline.length - 1].createdAt
  : "";
const lastTimelineNice = lastTimelineIso ? niceDate(lastTimelineIso) : "—";

html += "<div style='margin-top:14px'>";
html += "<div class='" + (timelineOpen ? "note-wrap" : "ai-block") + "'>";

html += "<div style='display:flex;align-items:center;justify-content:space-between'>";

html += "<strong style='position:relative;top:3px'>Timeline</strong>";

html += "<div style='display:flex;align-items:center;gap:12px'>";

html += "<span style='font-size:12px;color:#9aa4b2;font-weight:600'>";
html += "Last updated: " + escapeHtml(lastTimelineNice);
html += "</span>";

html += "<button id='toggleTimelineBtn' style='width:auto;padding:0 12px;font-size:12px;position:relative;top:6px'>";
html += timelineOpen ? "Hide" : "Show";
html += "</button>";

html += "</div>";
html += "</div>";

html += "<div id='timelineWrap' style='display:" + (timelineOpen ? "block" : "none") + "'>";
html += "<div class='note-list'>" + renderTimeline(timeline) + "</div>";
html += "</div>";

html += "</div>";
html += "</div>";

  // AI buttons removed on resolved; replaced by reopen
  html += "<div class='actions'>";
  if (!isResolved) {
    html += "<button data-ai='summary'>AI: Summary</button>";
    html += "<button data-ai='next_steps'>AI: Next Steps</button>";
    html += "<button data-ai='stakeholder_update'>AI: Stakeholder Update</button>";
  } else {
    html += "<button id='reopenBtn'>Reopen Case</button>";
  }
  html += "</div>";

  html += "</div>";

  // AI output blocks (latest first)
const outputs = (i.aiOutput || []).slice().reverse();

for (const o of outputs) {
  const key = o.createdAt + ":" + o.type;
  const isOpen = aiOpenState[key] !== false;

  html += "<div class='ai-block'>";

  html += "<div style='display:flex;justify-content:space-between;align-items:center'>";

  html += "<strong style='position:relative;top:3px'>" +
        escapeHtml(o.title || "AI Output") +
        "</strong>";

  html += "<div style='display:flex;align-items:center;gap:12px'>";

  if (!isOpen) {
    html += "<span style='font-size:12px;color:#9aa4b2;font-weight:600'>";
    html += "Last updated: " + escapeHtml(o.createdAt ? niceDate(o.createdAt) : "");
    html += "</span>";
  }

html += "<button data-ai-toggle='" + escapeHtml(key) + "' " +
        "style='width:auto;padding:0 10px;font-size:12px;position:relative;top:6px'>" +
        (isOpen ? "Hide" : "Show") +
        "</button>";

  html += "</div>";
  html += "</div>";

  if (isOpen) {
    html += "<pre>" + escapeHtml(formatAI(o)) + "</pre>";
  }

  html += "</div>";
}

details.innerHTML = html;

document.querySelectorAll("[data-ai-toggle]").forEach(btn => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-ai-toggle");
    aiOpenState[key] = !(aiOpenState[key] !== false);
    show(currentId);
  });
});

  // Event binding kept defensive (elements may not exist on resolved view)
  const statusBtn = document.getElementById("changeStatusBtn");
  if (statusBtn) statusBtn.addEventListener("click", changeStatus);

  const noteBtn = document.getElementById("addNoteBtn");
  if (noteBtn) {
  noteBtn.addEventListener("click", () => {
    if (!notesOpen) {
      notesOpen = true;
      show(currentId);
      setTimeout(() => {
        const box = document.getElementById("noteInput");
        if (box) box.focus();
      }, 0);
      return;
    }
    addNote();
  });
}

  const toggleNotesBtn = document.getElementById("toggleNotesBtn");
if (toggleNotesBtn) {
  toggleNotesBtn.addEventListener("click", () => {
    notesOpen = !notesOpen;
    show(currentId);
  });
}

  const reopenBtn = document.getElementById("reopenBtn");
  if (reopenBtn) reopenBtn.addEventListener("click", reopenCase);

  document.querySelectorAll("[data-ai]").forEach(btn => {
    btn.addEventListener("click", () => {
      runAI(btn.getAttribute("data-ai"));
    });
  });

  // Timeline toggle
  const toggleBtn = document.getElementById("toggleTimelineBtn");
  const timelineWrap = document.getElementById("timelineWrap");
  if (toggleBtn && timelineWrap) {
    toggleBtn.addEventListener("click", () => {
  timelineOpen = !timelineOpen;
  timelineWrap.style.display = timelineOpen ? "block" : "none";
  toggleBtn.textContent = timelineOpen ? "Hide" : "Show";
});
  }
}

/*
  Actions: CRUD + AI calls
*/
async function create(){
  const payload = {
    id: cid.value.trim(),
    title: ctitle.value.trim(),
    description: cdesc.value.trim(),
    severity: csev.value
  };

  const res = await safeFetch("/incident", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    alert(await res.text());
    return;
  }

  cid.value = "";
  ctitle.value = "";
  cdesc.value = "";
  await load();
}

async function changeStatus(){
  const sel = document.getElementById("statusSelect");
  if (!sel || !currentId) return;

  const res = await safeFetch("/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: currentId, status: sel.value })
  });

  if (!res.ok) {
    alert(await res.text());
    return;
  }

  await load();
  show(currentId);
}

async function addNote(){
  const box = document.getElementById("noteInput");
  if (!box || !currentId) return;

  const text = box.value.trim();
  if (!text) return;

  const res = await safeFetch("/context-note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: currentId, text })
  });

  if (!res.ok) {
    alert(await res.text());
    return;
  }

  box.value = "";
  await load();
  show(currentId);
}

async function runAI(mode){
  const res = await safeFetch("/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: currentId, mode })
  });

  if (!res.ok) {
    alert(await res.text());
    return;
  }

  await load();
  show(currentId);
}

async function removeIncident(id){
  const res = await safeFetch("/incident?id=" + encodeURIComponent(id), { method: "DELETE" });
  if (!res.ok) {
    alert(await res.text());
    return;
  }

  if (currentId === id) {
    currentId = null;
    details.innerHTML = "";
  }

  await load();
}

async function reopenCase(){
  if (!currentId) return;

  const res = await safeFetch("/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: currentId, status: "Investigating" })
  });

  if (!res.ok) {
    alert(await res.text());
    return;
  }

  await load();
  show(currentId);
}

/*
  Helpers: mostly string/HTML rendering and safety guards.
*/
function optionHtml(value, current){
  return "<option " + (value === current ? "selected" : "") + ">" + value + "</option>";
}

function renderNotes(notes){
  if (!notes || !notes.length) {
    return "<div class='note'>"
      + "No notes yet. Add what you tried, then run AI: Next Steps."
      + "<span class='note-meta'></span>"
      + "</div>";
  }

  return notes
    .slice(-40)
    .map(n => {
      const meta = n.createdAt ? niceDate(n.createdAt) : "";
      return "<div class='note'>"
        + escapeHtml(n.text || "")
        + "<span class='note-meta'>" + escapeHtml(meta) + "</span>"
        + "</div>";
    })
    .join("");
}
    function updateActiveFilterHint(){
  const el = document.getElementById("activeFilterHint");
  if (!el) return;

  if (metricFilter === "open") {
    el.textContent = "Active filter: Open cases";
  } else if (metricFilter === "resolved") {
    el.textContent = "Active filter: Resolved cases";
  } else {
    el.textContent = "Active filter: Total cases";
  }
}

/*
  Empty state for the main panel.
*/
function renderEmptyMainState(hasIncidents){
  return "<div class='card' style='opacity:.85'>"
    + "<h3>" + (hasIncidents ? "No Incident Selected" : "No Incidents Yet") + "</h3>"
    + "<p>"
    + (hasIncidents
        ? "Select an incident from the left to view details, investigate, add context notes, or generate AI-assisted guidance."
        : "Create a new incident using the form on the left to begin tracking and investigation.")
    + "</p>"
    + "<p style='color:#9aa4b2;font-size:13px'>"
    + "This panel will populate automatically once an incident is selected."
    + "</p>"
    + "</div>";
}

function safeText(v){
  return typeof v === "string" && v.trim() ? v : "";
}

function renderTimeline(timeline){
  if (!timeline || !timeline.length) {
    return "<div class='note'>No timeline yet.<span class='note-meta'></span></div>";
  }

  return timeline
    .slice(-60)
    .map(e => {
      const icon = safeText(e.icon);
      const title = safeText(e.title);
      let body = safeText(e.body);
      const meta = e.createdAt ? niceDate(e.createdAt) : "";

      // Normalise "Action: ..." into a friendlier title case
      if (body.toLowerCase().startsWith("action:")) {
        const raw = body.slice(7).trim(); // after "Action:"
        const cleaned = raw
  .replaceAll("_", " ")
  .split(" ")
  .map(w => w ? w[0].toUpperCase() + w.slice(1) : "")
  .join(" ");
        body = "Action: " + cleaned;
      }

      return "<div class='note'>" +
             escapeHtml((icon ? icon + " " : "") + title) +
             (body ? "<br>" + escapeHtml(body) : "") +
             "<span class='note-meta'>" + escapeHtml(meta) + "</span>" +
             "</div>";
    })
    .join("");
}

async function safeFetch(url, options){
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const msg = await res.text();
      alert(msg || "Request failed");
    }
    return res;
  } catch (e) {
    alert("Network error");
    return new Response("Network error", { status: 599 });
  }
}

// Renders timestamps nicely and strips duplicate "Update time:" lines from stored body
function formatAI(o){
  if (!o) return "";
  const stamp = o.createdAt ? niceDate(o.createdAt) : "";
  const raw = String(o.text || "");
  const cleaned = raw.replace(/^Update time:.*\\n*/i, "");
  return (stamp ? "Update time: " + stamp + "\\n\\n" : "") + cleaned;
}

function niceDate(iso){
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleDateString() + ", " + d.toLocaleTimeString();
}

function cap(s){
  if (!s) return "";
  const v = String(s).trim();
  return v ? v[0].toUpperCase() + v.slice(1).toLowerCase() : "";
}

function fromDate(){
  return from.value ? new Date(from.value) : null;
}

function untilDate(){
  return until.value ? new Date(until.value + "T23:59:59") : null;
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/*
  DOM refs
*/
const listEl = document.getElementById("list");
const details = document.getElementById("details");
const metrics = document.getElementById("metrics");

const cid = document.getElementById("cid");
const ctitle = document.getElementById("ctitle");
const cdesc = document.getElementById("cdesc");
const csev = document.getElementById("csev");

const search = document.getElementById("search");
const from = document.getElementById("from");
const until = document.getElementById("until");

/*
  Load:
  - fetch incidents
  - render metrics + bind filter behaviour
  - update sidebar + main panel
*/
async function load(){
  const res = await safeFetch("/incidents");
  incidents = await res.json();

  renderMetrics(incidents);

  document.querySelectorAll(".metric").forEach(m => {
  const filter = m.dataset.filter;
  const isActive = filter && filter === metricFilter;
  m.classList.toggle("active", isActive);

  m.onclick = () => {
    if (!filter) return;
    metricFilter = filter;
    load();
  };

  m.onkeydown = (e) => {
    if (e.key === "Enter") {
      m.click();
    }
  };
});

  const filteredForSidebar =
    metricFilter === "open"
      ? incidents.filter(i => i.status !== "Resolved")
      : metricFilter === "resolved"
      ? incidents.filter(i => i.status === "Resolved")
      : incidents;

  renderSidebar(filteredForSidebar);

const hint = document.getElementById("activeFilterHint");
if (hint) {
  hint.textContent =
    metricFilter === "open"
      ? "Active filter: Open cases"
      : metricFilter === "resolved"
      ? "Active filter: Resolved cases"
      : "Active filter: Total cases";
}

  if (currentId && incidents.some(i => i.id === currentId)) {
    show(currentId);
  } else {
    details.innerHTML = renderEmptyMainState(incidents.length > 0);
  }
}

load();
</script>
</body>
</html>`;
}
/* ======================================================
   Worker-side helpers
   ====================================================== */

/*
  Cleans up AI output so it renders nicely in the UI.
  - strips markdown artefacts
  - normalises spacing
  - keeps paragraphs readable
*/
function cleanAIText(text) {
  return String(text || "")
    .replace(/\*+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n{1,}/g, "\n\n")
    .trim();
}

/*
  Capitalise a string in a predictable way.
  Used for severity + small UI labels.
*/
function cap(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  return v[0].toUpperCase() + v.slice(1).toLowerCase();
}
