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

    /* ─── Knowledge Graph Panel (M8.1 Phase 2) ─────────────────────────── */
    .graph-panel {
      margin: 0 24px 24px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .graph-header {
      display: flex; align-items: center; gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .graph-header h2 {
      margin: 0;
      font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
      color: var(--muted);
    }
    .graph-controls {
      display: flex; align-items: center; gap: 10px;
      flex-wrap: wrap; flex: 1;
    }
    .graph-controls label {
      color: var(--muted); font-size: 11px;
      display: flex; align-items: center; gap: 4px;
    }
    .graph-controls input[type="number"],
    .graph-controls input[type="text"] {
      width: 80px;
      background: var(--bg); border: 1px solid var(--border);
      color: var(--text); padding: 4px 6px; border-radius: 4px;
      font-family: inherit; font-size: 12px;
    }
    .graph-controls input[type="text"] { width: 110px; }
    .graph-controls button {
      background: var(--panel-2); border: 1px solid var(--border);
      color: var(--text); padding: 4px 10px; border-radius: 4px;
      cursor: pointer; font-family: inherit; font-size: 11px;
    }
    .graph-controls button:hover { border-color: var(--accent); }
    .muted { color: var(--muted); font-size: 11px; }
    .graph-canvas-wrap {
      position: relative;
      min-height: 620px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    #graph-svg {
      width: 100%;
      height: 620px;
      display: block;
    }
    .edge-line {
      stroke: var(--muted);
      stroke-width: 1;
      opacity: 0.6;
    }
    .edge-line[data-relation="REFERENCES"] {
      stroke-dasharray: 4 3;
    }
    .node { cursor: pointer; }
    .node-circle {
      stroke: var(--bg);
      stroke-width: 1.5;
      fill: var(--muted);
    }
    .node-circle:hover { stroke-width: 3; }
    .node-circle[data-type="DECISION"] { fill: var(--accent); }
    .node-circle[data-type="PATTERN"]  { fill: var(--ok); }
    .node-circle[data-type="ERROR"]    { fill: var(--err); }
    .node-circle[data-type="FILE"]     { fill: var(--warn); }
    .node-circle[data-type="NOTE"]     { fill: var(--muted); }
    .node-label {
      fill: var(--text);
      font-size: 10px;
      pointer-events: none;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .graph-detail {
      position: absolute;
      top: 12px; right: 12px;
      width: 280px;
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      font-size: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .graph-detail[hidden] { display: none; }
    .graph-detail h3 {
      margin: 0 0 8px;
      font-size: 13px; color: var(--accent);
      word-break: break-word;
    }
    .graph-detail p { margin: 4px 0; }
    .graph-detail code {
      background: var(--bg); padding: 1px 4px; border-radius: 3px;
      font-size: 11px;
    }
    .graph-detail pre.props {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px;
      margin: 6px 0;
      max-height: 200px;
      overflow: auto;
      font-size: 10px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .graph-detail button {
      background: var(--panel); border: 1px solid var(--border);
      color: var(--text); padding: 3px 10px; border-radius: 4px;
      cursor: pointer; font-family: inherit; font-size: 11px;
      margin-top: 4px;
    }
    .graph-detail button:hover { border-color: var(--err); color: var(--err); }
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

  <section class="graph-panel" id="graph-panel">
    <header class="graph-header">
      <h2>Knowledge Graph</h2>
      <div class="graph-controls">
        <label>Nodes <input type="number" id="g-node-limit" value="60" min="1" max="200" /></label>
        <label>Edges <input type="number" id="g-edge-limit" value="120" min="1" max="500" /></label>
        <label>Type <input type="text" id="g-type-filter" placeholder="(any)" /></label>
        <button id="g-reload" type="button">Reload</button>
        <span id="g-stats" class="muted"></span>
      </div>
    </header>
    <div class="graph-canvas-wrap">
      <svg id="graph-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Knowledge Graph"></svg>
      <aside id="graph-detail" class="graph-detail" hidden>
        <h3 id="gd-label">—</h3>
        <p><span class="muted">type:</span> <code id="gd-type">—</code></p>
        <p><span class="muted">source chunk:</span> <code id="gd-src">—</code></p>
        <pre id="gd-props" class="props"></pre>
        <button id="gd-close" type="button">Close</button>
      </aside>
    </div>
  </section>

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

    // ─── Knowledge Graph Panel (M8.1 Phase 2) ────────────────────────────
    (function initGraphPanel() {
      const svg = document.getElementById('graph-svg');
      const stats = document.getElementById('g-stats');
      const detail = document.getElementById('graph-detail');
      const closeBtn = document.getElementById('gd-close');
      const reload = document.getElementById('g-reload');
      const nodeInput = document.getElementById('g-node-limit');
      const edgeInput = document.getElementById('g-edge-limit');
      const typeInput = document.getElementById('g-type-filter');
      if (!svg || !stats || !detail || !closeBtn || !reload || !nodeInput || !edgeInput || !typeInput) {
        return;
      }

      const SVG_NS = 'http://www.w3.org/2000/svg';
      const W = 1000, H = 600;
      const PAD = 30;
      const K_REP = 1500;
      const K_ATTR = 0.02;
      const IDEAL = 100;
      const MAX_ITER = 120;

      function makeSvg(name, attrs) {
        const el = document.createElementNS(SVG_NS, name);
        if (attrs) {
          for (const k of Object.keys(attrs)) {
            el.setAttribute(k, String(attrs[k]));
          }
        }
        return el;
      }

      function truncate(s, n) {
        const str = String(s == null ? '' : s);
        if (str.length <= n) return str;
        return str.slice(0, n - 1) + '…';
      }

      function radiusForType(type) {
        if (type === 'DECISION') return 9;
        if (type === 'PATTERN') return 8;
        if (type === 'ERROR') return 8;
        if (type === 'FILE') return 7;
        return 6;
      }

      // Deterministic seeded pseudo-random in [0,1) from a node id.
      // Lets the graph render stably across reloads with the same data.
      function seededRand(seed) {
        let x = (seed * 9301 + 49297) % 233280;
        return function next() {
          x = (x * 9301 + 49297) % 233280;
          return x / 233280;
        };
      }

      function layout(nodes, edges) {
        const n = nodes.length;
        if (n === 0) return;
        // Seed initial positions deterministically by node.id.
        for (const node of nodes) {
          const rng = seededRand(Number(node.id) || 1);
          node.x = PAD + rng() * (W - 2 * PAD);
          node.y = PAD + rng() * (H - 2 * PAD);
          node.vx = 0; node.vy = 0;
        }
        if (n === 1) return;

        let temp = 1.0;
        for (let iter = 0; iter < MAX_ITER; iter++) {
          // Repulsion: O(n²) — fine for ≤200 nodes.
          for (let i = 0; i < n; i++) {
            const a = nodes[i];
            let fx = 0, fy = 0;
            for (let j = 0; j < n; j++) {
              if (i === j) continue;
              const b = nodes[j];
              let dx = a.x - b.x;
              let dy = a.y - b.y;
              let dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 5) dist = 5;
              const f = K_REP / (dist * dist);
              fx += (dx / dist) * f;
              fy += (dy / dist) * f;
            }
            a.vx = fx;
            a.vy = fy;
          }
          // Attraction along edges.
          for (const e of edges) {
            const s = nodes.find(function(nn) { return nn.id === e.source_id; });
            const t = nodes.find(function(nn) { return nn.id === e.target_id; });
            if (!s || !t) continue;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = K_ATTR * dist / IDEAL;
            const ax = (dx / dist) * f * dist;
            const ay = (dy / dist) * f * dist;
            s.vx += ax; s.vy += ay;
            t.vx -= ax; t.vy -= ay;
          }
          // Apply with cooling.
          for (const node of nodes) {
            node.x += node.vx * temp;
            node.y += node.vy * temp;
            if (node.x < PAD) node.x = PAD;
            if (node.x > W - PAD) node.x = W - PAD;
            if (node.y < PAD) node.y = PAD;
            if (node.y > H - PAD) node.y = H - PAD;
          }
          temp *= 0.985;
        }
      }

      function showDetail(node) {
        const lblEl = document.getElementById('gd-label');
        const typeEl = document.getElementById('gd-type');
        const srcEl = document.getElementById('gd-src');
        const propsEl = document.getElementById('gd-props');
        if (lblEl) lblEl.textContent = String(node.label == null ? '' : node.label);
        if (typeEl) typeEl.textContent = String(node.type == null ? '' : node.type);
        if (srcEl) srcEl.textContent = node.source_chunk_id == null ? '—' : String(node.source_chunk_id);
        if (propsEl) {
          try {
            propsEl.textContent = JSON.stringify(node.properties || {}, null, 2);
          } catch (e) {
            propsEl.textContent = '{}';
          }
        }
        detail.hidden = false;
      }

      function render(graph) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const nodes = Array.isArray(graph.nodes) ? graph.nodes.slice() : [];
        const edges = Array.isArray(graph.edges) ? graph.edges.slice() : [];
        const nodeById = new Map();
        for (const nn of nodes) nodeById.set(nn.id, nn);
        layout(nodes, edges);

        // Edges first (behind nodes).
        for (const e of edges) {
          const s = nodeById.get(e.source_id);
          const t = nodeById.get(e.target_id);
          if (!s || !t) continue;
          const line = makeSvg('line', {
            x1: s.x, y1: s.y, x2: t.x, y2: t.y,
            'class': 'edge-line',
            'data-relation': e.relation == null ? '' : String(e.relation),
          });
          svg.appendChild(line);
        }

        // Nodes.
        for (const n of nodes) {
          const g = makeSvg('g', {
            'class': 'node',
            'data-type': n.type == null ? '' : String(n.type),
            transform: 'translate(' + n.x + ',' + n.y + ')',
          });
          const c = makeSvg('circle', {
            'class': 'node-circle',
            r: radiusForType(n.type),
            'data-type': n.type == null ? '' : String(n.type),
          });
          const lbl = makeSvg('text', {
            'class': 'node-label',
            dy: -12,
            'text-anchor': 'middle',
          });
          lbl.textContent = truncate(n.label, 24);
          g.appendChild(c);
          g.appendChild(lbl);
          g.addEventListener('click', function () { showDetail(n); });
          svg.appendChild(g);
        }
      }

      closeBtn.addEventListener('click', function () { detail.hidden = true; });

      async function loadGraph() {
        const params = new URLSearchParams();
        params.set('node_limit', String(nodeInput.value));
        params.set('edge_limit', String(edgeInput.value));
        const t = String(typeInput.value || '').trim();
        if (t) params.set('type', t);
        stats.textContent = 'Loading…';
        try {
          const r = await jsonFetch('/api/graph?' + params.toString());
          const body = r.body || {};
          if (!r.ok || body.ok === false) {
            stats.textContent = 'Error: ' + (body.reason || r.status);
            return;
          }
          const s = body.stats || { node_count: 0, edge_count: 0 };
          stats.textContent = s.node_count + ' nodes · ' + s.edge_count + ' edges';
          render(body);
        } catch (err) {
          stats.textContent = 'Error: ' + String(err);
        }
      }

      reload.addEventListener('click', loadGraph);
      loadGraph();
    })();
  </script>
</body>
</html>`;
