/**
 * Read-only status page served at GET /ui (plan B27). One static file: it asks for the operator
 * token once (kept in sessionStorage for this tab only) and polls the API. No external assets.
 */
export function statusPageHtml(projectId: string, projectName: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Friday status</title>
<style>
  :root { --bg:#ffffff; --fg:#1b1d21; --muted:#5f6670; --line:#e3e6ea; --card:#f6f7f9; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --accent:#0969da; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e6e8eb; --muted:#9aa3ad; --line:#2a2f37; --card:#161a20; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#58a6ff; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding:16px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; }
  header .muted { color:var(--muted); }
  main { padding:16px; display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; }
  section.wide { grid-column: 1 / -1; }
  h2 { font-size:14px; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  code { font-family: ui-monospace, Consolas, monospace; font-size:12px; }
  .s-COMPLETED, .s-READY, .s-AVAILABLE, .s-PASSED { color:var(--ok); }
  .s-RUNNING, .s-BUSY, .s-VERIFYING, .s-READY_FOR_VERIFICATION { color:var(--accent); }
  .s-WAITING, .s-DEGRADED, .s-pending, .s-HARNESS_LOST { color:var(--warn); }
  .s-FAILED, .s-CANCELLED, .s-DISCONNECTED, .s-denied { color:var(--bad); }
  #login { padding:16px; max-width:520px; }
  input { width:100%; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  button { margin-top:8px; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
  .err { color:var(--bad); }
</style>
</head>
<body>
<header><h1>Friday</h1><span class="muted">${esc(projectName)} · <code>${esc(projectId)}</code></span><span id="meta" class="muted"></span></header>
<div id="login" hidden>
  <p>Paste the operator token (run <code>friday ui --token</code> to print it). It stays in this tab only.</p>
  <input id="tok" type="password" autocomplete="off" aria-label="Operator token">
  <button id="go">Show status</button> <span id="loginErr" class="err"></span>
</div>
<main id="app" hidden>
  <section class="wide"><h2>Tasks</h2><table id="tasks"></table></section>
  <section><h2>Harnesses</h2><table id="harnesses"></table></section>
  <section><h2>Agents</h2><table id="agents"></table></section>
  <section><h2>Pending approvals</h2><table id="approvals"></table></section>
  <section class="wide"><h2>Recent events</h2><table id="events"></table></section>
</main>
<script>
const PID = ${JSON.stringify(projectId)};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const cls = (s) => 's-' + String(s).replace(/[^A-Za-z_]/g, '');
let token = sessionStorage.getItem('friday-operator-token') || '';
async function api(path) {
  const r = await fetch('/api/v1/projects/' + PID + path, { headers: { authorization: 'Bearer ' + token } });
  if (r.status === 401 || r.status === 403) { throw new Error('auth'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function table(el, head, rows) {
  el.innerHTML = '<tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    (rows.length ? rows.join('') : '<tr><td colspan="' + head.length + '" class="muted">none</td></tr>');
}
async function refresh() {
  try {
    const s = await api('/status');
    document.getElementById('meta').textContent = '· event #' + s.head + ' · updated ' + new Date().toLocaleTimeString();
    table(document.getElementById('tasks'), ['Task', 'Status', 'Summary', 'Agent', 'Updated'], s.tasks.map((t) =>
      '<tr><td><code>' + esc(t.task_id) + '</code></td><td class="' + cls(t.status) + '">' + esc(t.status) + (t.waiting_reason ? ' (' + esc(t.waiting_reason) + ')' : '') +
      '</td><td>' + esc(t.summary) + '</td><td>' + esc(t.agent_key || t.reserved_for_agent_key || '') + '</td><td>' + esc(t.updated_at) + '</td></tr>'));
    table(document.getElementById('harnesses'), ['Harness', 'Vendor', 'Status', 'Level'], s.harnesses.map((h) =>
      '<tr><td><code>' + esc(h.harness_id) + '</code></td><td>' + esc(h.vendor) + '</td><td class="' + cls(h.status) + '">' + esc(h.status) + '</td><td>' + esc(h.enforcement_level || '') + '</td></tr>'));
    table(document.getElementById('agents'), ['Agent', 'Status', 'Task'], s.agents.map((a) =>
      '<tr><td>' + esc(a.agent_key) + (a.shadow ? ' (shadow)' : '') + '</td><td class="' + cls(a.status) + '">' + esc(a.status) + '</td><td><code>' + esc(a.current_task_id || '') + '</code></td></tr>'));
    table(document.getElementById('approvals'), ['Approval', 'Capability', 'Target'], s.approvals.map((a) =>
      '<tr><td><code>' + esc(a.approval_id) + '</code></td><td>' + esc(a.capability) + '</td><td>' + esc(a.target) + '</td></tr>'));
    table(document.getElementById('events'), ['#', 'Type', 'Actor', 'When'], s.events.map((e) =>
      '<tr><td>' + esc(e.sequence) + '</td><td><code>' + esc(e.type) + '</code></td><td>' + esc(e.actor.kind + ':' + e.actor.id) + '</td><td>' + esc(e.occurred_at) + '</td></tr>'));
  } catch (e) {
    if (e.message === 'auth') { showLogin('That token was not accepted.'); return; }
    document.getElementById('meta').textContent = '· ' + e.message;
  }
}
function showLogin(msg) {
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
  document.getElementById('loginErr').textContent = msg || '';
}
document.getElementById('go').onclick = () => {
  token = document.getElementById('tok').value.trim();
  sessionStorage.setItem('friday-operator-token', token);
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  refresh();
};
if (token) { document.getElementById('app').hidden = false; refresh(); } else { showLogin(''); }
setInterval(() => { if (token && !document.getElementById('app').hidden) refresh(); }, 2000);
</script>
</body>
</html>`;
}
