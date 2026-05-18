// Sovereign Command Center — embedded static HTML dashboard.
//
// Self-contained vanilla HTML/CSS/JS (zero build step, zero front-end deps).
// Served verbatim from a single TS export so the dashboard ships in dist/
// with no separate asset copy step in package.json.files.
//
// The dashboard talks to the same-origin JSON API at /api/graduations and
// renders four lifecycle lanes (proposed → composed → approved → rejected).
// Mutation actions (confirm, reject, compose) post JSON bodies and re-fetch.
//
// XSS posture: NO innerHTML anywhere on the dynamic render path. Every cell
// is built with createElement + textContent. Server-side already coerces
// numeric fields through Number() and the API never echoes raw user HTML.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Sovereign Command Center — M7 Graduations</title>
  <style>
    :root {
      --bg: #0b0e14;
      --panel: #11151c;
      --panel-2: #161b25;
      --border: #1e2531;
      --text: #d6e0ee;
      --muted: #6b7587;
      --accent: #6ab7ff;
      --accent-2: #a370ff;
      --ok: #4ddca3;
      --warn: #ffb454;
      --err: #ff6f6f;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    header {
      display: flex; align-items: center; gap: 16px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, var(--panel) 0%, var(--bg) 100%);
    }
    header .badge {
      background: var(--accent); color: var(--bg);
      padding: 2px 8px; border-radius: 4px;
      font-weight: 700; letter-spacing: 0.5px;
    }
    header h1 { margin: 0; font-size: 14px; letter-spacing: 1px; }
    header .spacer { flex: 1; }
    header button {
      background: var(--panel-2); border: 1px solid var(--border);
      color: var(--text); padding: 6px 12px; border-radius: 6px;
      cursor: pointer; font-family: inherit; font-size: 12px;
    }
    header button:hover { border-color: var(--accent); }
    main {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 16px; padding: 24px;
    }
    .lane {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px; min-height: 480px;
    }
    .lane h2 {
      margin: 0 0 12px;
      font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
      color: var(--muted);
      display: flex; align-items: center; gap: 8px;
    }
    .lane h2 .count {
      background: var(--panel-2); border: 1px solid var(--border);
      padding: 1px 8px; border-radius: 10px;
      font-size: 11px; color: var(--text);
    }
    .card {
      background: var(--panel-2); border: 1px solid var(--border);
      border-radius: 6px; padding: 10px; margin-bottom: 10px;
      font-size: 12px;
    }
    .card .id { color: var(--accent); font-weight: 700; }
    .card .meta { color: var(--muted); font-size: 11px; margin-top: 4px; }
    .card .rationale {
      margin-top: 6px; padding: 6px; background: var(--bg);
      border-left: 2px solid var(--accent-2);
      white-space: pre-wrap; word-break: break-word;
    }
    .card .actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
    .card button {
      background: var(--panel); border: 1px solid var(--border);
      color: var(--text); padding: 4px 8px; border-radius: 4px;
      cursor: pointer; font-family: inherit; font-size: 11px;
    }
    .card button.confirm { border-color: var(--ok); color: var(--ok); }
    .card button.reject { border-color: var(--err); color: var(--err); }
    .card button.compose { border-color: var(--warn); color: var(--warn); }
    .card button:hover { background: var(--bg); }
    #toast {
      position: fixed; bottom: 16px; right: 16px;
      background: var(--panel-2); border: 1px solid var(--border);
      padding: 10px 14px; border-radius: 6px;
      font-size: 12px; max-width: 360px;
      opacity: 0; transition: opacity 0.25s;
    }
    #toast.show { opacity: 1; }
    #toast.ok { border-color: var(--ok); }
    #toast.err { border-color: var(--err); }
    .empty { color: var(--muted); text-align: center; padding: 16px 0; font-style: italic; }
    dialog {
      background: var(--panel); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 24px; min-width: 480px;
    }
    dialog::backdrop { background: rgba(0,0,0,0.6); }
    dialog h3 { margin: 0 0 16px; font-size: 14px; }
    dialog label { display: block; margin: 12px 0 4px; font-size: 11px; color: var(--muted); }
    dialog input, dialog textarea, dialog select {
      width: 100%; padding: 6px 8px;
      background: var(--bg); border: 1px solid var(--border);
      color: var(--text); border-radius: 4px;
      font-family: inherit; font-size: 12px;
    }
    dialog textarea { resize: vertical; min-height: 80px; }
    dialog .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    dialog button {
      background: var(--panel-2); border: 1px solid var(--border);
      color: var(--text); padding: 6px 12px; border-radius: 4px;
      cursor: pointer; font-family: inherit;
    }
    dialog button.primary { border-color: var(--accent); color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <span class="badge">SCM</span>
    <h1>SOVEREIGN COMMAND CENTER · M7 GRADUATIONS</h1>
    <span class="spacer"></span>
    <span id="health" style="color: var(--muted); font-size: 11px;">·</span>
    <button id="refresh">refresh</button>
  </header>
  <main>
    <section class="lane" data-state="proposed">
      <h2>proposed <span class="count" data-count="proposed">0</span></h2>
      <div class="cards" data-cards="proposed"></div>
    </section>
    <section class="lane" data-state="composed">
      <h2>composed <span class="count" data-count="composed">0</span></h2>
      <div class="cards" data-cards="composed"></div>
    </section>
    <section class="lane" data-state="approved">
      <h2>approved <span class="count" data-count="approved">0</span></h2>
      <div class="cards" data-cards="approved"></div>
    </section>
    <section class="lane" data-state="rejected">
      <h2>rejected <span class="count" data-count="rejected">0</span></h2>
      <div class="cards" data-cards="rejected"></div>
    </section>
  </main>
  <div id="toast"></div>

  <dialog id="composeDialog">
    <h3>Compose Global Rationale</h3>
    <form id="composeForm">
      <input type="hidden" name="graduation_id" />
      <label>Verdict</label>
      <select name="verdict">
        <option value="pass">pass</option>
        <option value="fail">fail</option>
      </select>
      <label>Evidence (≤120 words)</label>
      <textarea name="evidence" required></textarea>
      <label>Global Rationale (≥10 chars, required if pass)</label>
      <textarea name="global_rationale"></textarea>
      <label>Model</label>
      <input name="model" value="orchestrator:claude-opus-4-7" required />
      <div class="row">
        <button type="button" data-close>cancel</button>
        <button type="submit" class="primary">save compose</button>
      </div>
    </form>
  </dialog>

  <dialog id="rejectDialog">
    <h3>Reject Graduation</h3>
    <form id="rejectForm">
      <input type="hidden" name="graduation_id" />
      <label>Rejection Reason</label>
      <textarea name="reason" required></textarea>
      <div class="row">
        <button type="button" data-close>cancel</button>
        <button type="submit" class="primary">confirm reject</button>
      </div>
    </form>
  </dialog>

  <script>
    const STATES = ['proposed', 'composed', 'approved', 'rejected'];
    const $ = (s, p = document) => p.querySelector(s);
    const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

    function toast(msg, kind) {
      const t = $('#toast');
      t.textContent = msg;
      t.className = 'show ' + (kind || '');
      setTimeout(() => { t.className = ''; }, 3200);
    }

    async function jsonFetch(url, opts) {
      const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, body };
    }

    async function loadHealth() {
      const r = await jsonFetch('/api/health');
      $('#health').textContent = r.ok ? 'connected · v' + (r.body.version || '?') : 'disconnected';
    }

    function makeEl(tag, opts) {
      const el = document.createElement(tag);
      if (opts && opts.cls) el.className = opts.cls;
      if (opts && opts.text != null) el.textContent = String(opts.text);
      return el;
    }

    function renderCard(row) {
      const card = makeEl('div', { cls: 'card' });

      const head = makeEl('div');
      const idSpan = makeEl('span', { cls: 'id', text: '#' + row.id });
      head.appendChild(idSpan);
      head.appendChild(document.createTextNode(' · ' + (row.project_id ?? '') + ' · skill ' + row.source_skill_id));
      card.appendChild(head);

      const ratio = (Number(row.success_rate_at_propose) * 100).toFixed(0);
      let metaText = 'freq ' + row.frequency_at_propose +
        ' · sr ' + ratio + '%' +
        ' · age ' + row.age_days_at_propose + 'd';
      if (row.cross_project_verdict) metaText += ' · verdict ' + row.cross_project_verdict;
      card.appendChild(makeEl('div', { cls: 'meta', text: metaText }));

      if (row.proposed_global_rationale) {
        card.appendChild(makeEl('div', { cls: 'rationale', text: row.proposed_global_rationale }));
      }

      const actionDefs = [];
      if (row.state === 'proposed') {
        actionDefs.push({ label: 'compose', cls: 'compose', action: 'compose' });
        actionDefs.push({ label: 'reject', cls: 'reject', action: 'reject' });
      } else if (row.state === 'composed') {
        actionDefs.push({ label: 'confirm promote', cls: 'confirm', action: 'confirm' });
        actionDefs.push({ label: 'reject', cls: 'reject', action: 'reject' });
      }
      if (actionDefs.length) {
        const actions = makeEl('div', { cls: 'actions' });
        for (const def of actionDefs) {
          const btn = makeEl('button', { cls: def.cls, text: def.label });
          btn.dataset.action = def.action;
          btn.addEventListener('click', () => handleAction(row, def.action));
          actions.appendChild(btn);
        }
        card.appendChild(actions);
      }
      return card;
    }

    async function loadGraduations() {
      const r = await jsonFetch('/api/graduations?k=50');
      if (!r.ok) { toast('failed to load: ' + (r.body.reason || r.status), 'err'); return; }
      const byState = { proposed: [], composed: [], approved: [], rejected: [] };
      for (const row of (r.body.results || [])) {
        if (byState[row.state]) byState[row.state].push(row);
      }
      for (const s of STATES) {
        const lane = $('[data-cards="' + s + '"]');
        while (lane.firstChild) lane.removeChild(lane.firstChild);
        $('[data-count="' + s + '"]').textContent = String(byState[s].length);
        if (!byState[s].length) {
          lane.appendChild(makeEl('div', { cls: 'empty', text: 'no candidates' }));
          continue;
        }
        for (const row of byState[s]) lane.appendChild(renderCard(row));
      }
    }

    async function handleAction(row, action) {
      if (action === 'confirm') {
        if (!confirm('Promote #' + row.id + ' to GLOBAL? This mints an is_global=true row.')) return;
        const r = await jsonFetch('/api/graduations/' + row.id + '/confirm', { method: 'POST' });
        toast(r.ok ? 'promoted #' + row.id : 'failed: ' + (r.body.reason || r.status), r.ok ? 'ok' : 'err');
        loadGraduations();
      } else if (action === 'reject') {
        const dlg = $('#rejectDialog');
        dlg.querySelector('[name=graduation_id]').value = String(row.id);
        dlg.showModal();
      } else if (action === 'compose') {
        const dlg = $('#composeDialog');
        dlg.querySelector('[name=graduation_id]').value = String(row.id);
        dlg.showModal();
      }
    }

    $$('button[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

    $('#composeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = fd.get('graduation_id');
      const body = {
        verdict: fd.get('verdict'),
        evidence: fd.get('evidence'),
        global_rationale: fd.get('global_rationale') || null,
        model: fd.get('model'),
      };
      const r = await jsonFetch('/api/graduations/' + id + '/compose', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast(r.ok ? 'composed #' + id : 'failed: ' + (r.body.reason || r.status), r.ok ? 'ok' : 'err');
      $('#composeDialog').close();
      loadGraduations();
    });

    $('#rejectForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = fd.get('graduation_id');
      const body = { reason: fd.get('reason') };
      const r = await jsonFetch('/api/graduations/' + id + '/reject', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast(r.ok ? 'rejected #' + id : 'failed: ' + (r.body.reason || r.status), r.ok ? 'ok' : 'err');
      $('#rejectDialog').close();
      loadGraduations();
    });

    $('#refresh').addEventListener('click', () => { loadHealth(); loadGraduations(); });

    loadHealth();
    loadGraduations();
    setInterval(loadHealth, 30000);
  </script>
</body>
</html>`;
