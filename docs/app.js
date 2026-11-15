/* Page logic. Five pages over one plan per case:
 *   Control tower - alerts ranked by days at risk, with playbooks
 *   Explorer      - one page per material, supplier or site
 *   Scenarios     - try actions on a copy of the plan, compare, apply
 *   Assistant     - asks the same objects, functions and actions in words
 *   Model         - how it is organised and how far to trust it
 */
(function () {
  'use strict';
  const CASES = window.TWIN_CASES, MODEL = window.TWIN_MODEL, Twin = window.Twin, Plan = window.TwinPlan, Chat = window.TwinChat;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const VIEWS = [['tower', 'Control tower'], ['explore', 'Explorer'], ['scenarios', 'Scenarios'], ['support', 'Support'], ['chat', 'Assistant'], ['model', 'Model']];
  const Support = window.TwinSupport;
  const DRIVER = 0.3;        // a material "decides the date" if it did so in at least 30% of runs
  const KEY = 'twin.anthropic_key';
  const keyStore = {
    get() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ } },
  };

  let caseId = Object.keys(CASES)[0], view = 'tower', objectId = '', busy = false, compareId = 'plan';
  const threads = {};        // assistant conversation per case, kept while the page is open
  const C = () => CASES[caseId];
  const st = () => Plan.state(C());
  const planResult = () => Plan.evaluate(C(), MODEL, st().plan);
  const f = (d, y) => Twin.fmtDate(C(), d, y);
  const pct = x => Math.round(x * 100) + '%';
  const days = (n, sign) => (sign && n > 0 ? '+' : '') + Math.round(n) + (Math.abs(Math.round(n)) === 1 ? ' day' : ' days');
  const effectText = e => Math.abs(e) < 0.5 ? 'no change' : days(e, true);

  /* ------------------------------------------------------------ navigation */
  function go(next) {
    next = next || {};
    if (next.caseId && next.caseId !== caseId) { caseId = next.caseId; objectId = ''; compareId = 'plan'; }
    if (next.view) view = next.view;
    if (next.objectId !== undefined) objectId = next.objectId;
    const hash = '#' + caseId + '/' + view + (view === 'explore' && objectId ? '/' + objectId : '');
    try { if (location.hash !== hash) history.pushState(null, '', hash); } catch (e) { /* file:// in some browsers */ }
    document.querySelectorAll('#views button').forEach(b => b.setAttribute('aria-current', b.dataset.view === view));
    document.querySelectorAll('.case').forEach(b => b.setAttribute('aria-current', b.dataset.id === caseId));
    $('case-select').value = caseId; $('view-select').value = view;
    VIEWS.forEach(([v]) => { $('view-' + v).hidden = v !== view; });
    document.title = C().company + ' · Supply Chain Twin';
    ({ tower: renderTower, explore: renderExplore, scenarios: renderScenarios, support: renderSupport, chat: renderThread, model: renderModel })[view]();
    if (view !== 'chat') document.querySelector('main').scrollTop = 0;
  }
  if (Object.keys(CASES).length === 1) document.querySelector('.app').classList.add('single');
  $('views').innerHTML = VIEWS.map(([v, label]) => `<button data-view="${v}">${label}</button>`).join('');
  VIEWS.forEach(([v, label]) => $('view-select').add(new Option(label, v)));
  $('cases').innerHTML = Object.values(CASES).map(c => `<button class="case" data-id="${c.id}">${esc(c.company)}<small>${esc(c.title)}</small></button>`).join('');
  Object.values(CASES).forEach(c => $('case-select').add(new Option(c.company, c.id)));
  document.querySelectorAll('#views button').forEach(b => b.onclick = () => go({ view: b.dataset.view }));
  document.querySelectorAll('.case').forEach(b => b.onclick = () => go({ caseId: b.dataset.id }));
  $('case-select').onchange = e => go({ caseId: e.target.value });
  $('view-select').onchange = e => go({ view: e.target.value });
  // Any element with data-go="view" or data-object="id" navigates.
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-object],[data-go]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.object !== undefined) go({ view: 'explore', objectId: t.dataset.object }); else go({ view: t.dataset.go });
  });
  const objLink = (id, label) => `<a href="#" data-object="${esc(id)}">${esc(label)}</a>`;

  /* --------------------------------------------------------------- timeline */
  function timeline(card, c, r, scaleTo) {
    const svg = card.querySelector('svg'), tip = card.querySelector('.tip');
    const W = card.clientWidth - 36, LAB = Math.min(230, Math.max(118, W * 0.3)), PAD = 6;
    const TOP = 40, ROW = 26, H = TOP + r.rows.length * ROW + 26;
    const maxDay = Math.max(scaleTo || 0, r.p80) * 1.04 + 4;
    const x = d => LAB + d / maxDay * (W - LAB - PAD);
    const chars = Math.floor(LAB / 7.2), T0 = Twin.dateOf(c, 0).getTime();
    let s = '', n = 0;
    const stepM = Math.max(1, Math.ceil(maxDay / 30.4 * 34 / (W - LAB)));
    for (let m = new Date(Date.UTC(new Date(T0).getUTCFullYear(), new Date(T0).getUTCMonth() + 1, 1)); (m - T0) / 864e5 < maxDay;
         m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1)), n++) {
      if (n % stepM) continue;
      const gx = x((m - T0) / 864e5);
      s += `<line x1="${gx}" x2="${gx}" y1="${TOP}" y2="${H - 22}" stroke="var(--line)"/>`;
      if (gx + 30 < W) s += `<text x="${gx + 3}" y="${H - 7}">${m.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}${m.getUTCMonth() === 0 ? ' ' + m.getUTCFullYear() : ''}</text>`;
    }
    r.rows.forEach((row, i) => {
      const y = TOP + i * ROW, mid = y + ROW / 2, a = x(row.s), b = x(row.f);
      const room = chars - row.depth * 2, label = row.name.length > room ? row.name.slice(0, room - 1) + '…' : row.name;
      s += `<g class="row"><rect class="rowbg" x="0" y="${y}" width="${W}" height="${ROW}" rx="4"/>` +
        `<text class="name" x="${row.depth * 10}" y="${mid + 4}" ${row.depth === 0 ? 'font-weight="600"' : ''}>${esc(label)}</text>` +
        `<rect x="${a}" y="${mid - 6}" width="${Math.max(3, b - a)}" height="12" rx="3" fill="var(--${row.crit >= DRIVER ? 'driver' : 'slack'})"/>` +
        `<rect class="hit" x="0" y="${y}" width="${W}" height="${ROW}" fill="transparent" data-r="${i}"/></g>`;
    });
    const px = x(r.plan), sx = x(r.p80), text = 'Promise ' + Twin.fmtDate(c, r.p80);
    s += `<line x1="${px}" x2="${px}" y1="16" y2="${H - 22}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 4"/>` +
      `<text x="${px - 5}" y="12" text-anchor="end">Planned ${Twin.fmtDate(c, r.plan)}</text>` +
      `<line x1="${sx}" x2="${sx}" y1="16" y2="${H - 22}" stroke="var(--ink)" stroke-width="1.5"/>`;
    s += sx + 5 + text.length * 7 < W ? `<text class="ref" x="${sx + 5}" y="12">${text}</text>` : `<text class="ref" x="${sx - 5}" y="30" text-anchor="end">${text}</text>`;
    svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', `Timeline: safe to promise ${Twin.fmtDate(c, r.p80, true)}, most likely ${Twin.fmtDate(c, r.p50, true)}`);
    svg.innerHTML = s; svg._r = r; svg._scale = scaleTo;
    if (svg._wired) return;
    svg._wired = true;
    svg.addEventListener('mousemove', e => {
      const i = e.target.dataset && e.target.dataset.r;
      if (i === undefined) { tip.style.display = 'none'; return; }
      const row = svg._r.rows[i], longest = row.steps.reduce((a, b) => (b.typical > a.typical ? b : a));
      tip.innerHTML = `<b>${esc(row.name)}</b>` + (row.partyName ? `<div>${esc(row.partyName)}</div>` : '') +
        `<div>${f(row.s)} to ${f(row.f, true)}</div><div>Longest step: ${esc(longest.stage)}, ${Math.round(longest.typical)} days</div>` +
        `<div>Decides delivery in ${pct(row.crit)} of runs</div><div class="hint">Click to open</div>`;
      tip.style.display = 'block';
      const box = card.getBoundingClientRect();
      let left = e.clientX - box.left + 14;
      if (left + tip.offsetWidth > box.width - 8) left = e.clientX - box.left - tip.offsetWidth - 14;
      tip.style.left = Math.max(8, left) + 'px'; tip.style.top = (e.clientY - box.top + 14) + 'px';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    svg.addEventListener('click', e => { const i = e.target.dataset && e.target.dataset.r; if (i !== undefined) go({ view: 'explore', objectId: svg._r.rows[i].id }); });
  }
  window.addEventListener('resize', () => document.querySelectorAll('main section:not([hidden]) .chart-card').forEach(card => {
    const svg = card.querySelector('svg'); if (svg._r) timeline(card, C(), svg._r, svg._scale);
  }));

  /* ---------------------------------------------------------- control tower */
  const SEV = { High: '▲', Medium: '◆', Low: '●' };
  function renderTower() {
    const c = C(), s = st(), r = planResult();
    $('t-eyebrow').textContent = `${c.company} · ${c.title} · ${c.sector}`;
    $('t-headline').textContent = 'Safe to promise: ' + f(r.p80, true);
    $('t-sub').textContent = `Most likely ${f(r.p50)}. ${Math.round(r.p80 - r.plan)} days later than supplier quotes suggest (${f(r.plan)}).` +
      (s.plan.length ? ` The plan includes ${s.plan.length} applied ${s.plan.length === 1 ? 'action' : 'actions'}.` : '');

    const list = Plan.alerts(c, MODEL);
    $('t-alerts').innerHTML = list.length ? list.map((a, i) =>
      `<details class="alert" data-i="${i}"><summary><span class="sev ${a.severity}"><i>${SEV[a.severity]}</i>${a.severity}</span>` +
      `<span class="a-title">${esc(a.title)}</span><span class="a-days">${a.days >= 0.5 ? 'up to ' + days(a.days) : 'no effect yet'}</span></summary>` +
      `<div class="a-body"><p>${esc(a.cause)}</p><div class="options"></div>` +
      `<p class="more">${objLink(a.party || a.material, 'Open ' + (a.party ? Plan.partyOf(c, a.party).name : Plan.itemOf(c, a.material).name))}</p></div></details>`).join('')
      : '<p class="quiet">Nothing needs attention on the current plan.</p>';
    $('t-alerts').querySelectorAll('details').forEach(d => d.addEventListener('toggle', () => {
      const box = d.querySelector('.options');
      if (!d.open || box.dataset.done) return;
      box.dataset.done = '1';
      const options = Plan.playbook(c, MODEL, list[+d.dataset.i]);
      box.innerHTML = '<div class="o-head">Options, with their effect on the promise date</div>' + (options.map((o, k) =>
        `<div class="option"><span>${esc(o.label)}${o.note ? `<div class="d">${esc(o.note)}</div>` : ''}</span><span class="eff ${o.effect < -0.5 ? 'gain' : o.effect > 0.5 ? 'loss' : ''}">${effectText(o.effect)}</span>` +
        `<button data-k="${k}" data-do="draft">Add to scenario</button><button data-k="${k}" data-do="apply">Apply</button></div>`).join('') || '<p class="quiet">No modelled option for this alert.</p>');
      box.querySelectorAll('button').forEach(b => b.onclick = () => {
        const o = options[+b.dataset.k];
        if (b.dataset.do === 'apply') { Plan.apply(c, MODEL, o.actions, 'From alert: ' + list[+d.dataset.i].title); renderTower(); }
        else { s.draft.push(...o.actions); Plan.persist(c); go({ view: 'scenarios' }); }
      });
    }));

    timeline(document.querySelector('#view-tower .chart-card'), c, r);
    const top = Twin.drivers(r, 5), max = Math.max(...top.map(d => d.crit), 0.01);
    $('t-drivers').innerHTML = top.map(d =>
      `<div class="driver"><div class="t"><span>${objLink(d.item, d.itemName)}, ${esc(d.stage)}</span><span>${pct(d.crit)} of runs</span></div>` +
      `<div class="bar"><i style="width:${d.crit / max * 100}%"></i></div>` +
      `<div class="d">Typically ${Math.round(d.typical)} days, up to ${Math.round(d.pessimistic)} in a bad case. Planned ${Math.round(d.planned)}.</div></div>`).join('');
    $('t-log').innerHTML = s.log.length
      ? s.log.map(l => `<div class="logrow"><div>${l.what.map(esc).join('<br>')}</div><div class="d">${l.when} · ${effectText(l.effect)}${l.note ? ' · ' + esc(l.note) : ''}</div></div>`).join('') +
        '<button class="ghost" id="t-reset">Reset plan to baseline</button>'
      : '<p class="quiet">None yet. The plan is the baseline: supplier quotes plus the model\'s forecast.</p>';
    if ($('t-reset')) $('t-reset').onclick = () => { Plan.reset(c); renderTower(); };
  }

  /* --------------------------------------------------------------- explorer */
  let exploreTab = 'materials';
  function actionForm(host, fixedItem, onAdd) {
    const c = C(), types = MODEL.schema.action_types;
    const items = fixedItem ? [fixedItem] : c.items;
    host.innerHTML = `<div class="form"><select class="a-type" aria-label="Action">${Object.entries(types).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select>` +
      (fixedItem ? '' : `<select class="a-item" aria-label="Material">${items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>`) +
      '<span class="a-params"></span><button class="a-add primary">Add to scenario</button></div><p class="a-about d"></p><p class="a-err"></p>';
    const q = sel => host.querySelector(sel);
    const item = () => fixedItem || Plan.itemOf(c, q('.a-item').value);
    function params() {
      const type = q('.a-type').value, it = item();
      q('.a-about').textContent = types[type].about;
      q('.a-err').textContent = '';
      if (type === 'SwitchSupplier') {
        const alts = Object.keys(it.variants);
        q('.a-params').innerHTML = alts.length
          ? `<select class="a-party" aria-label="New supplier">${alts.map(a => `<option value="${a}">${esc(Plan.partyOf(c, a).name)}</option>`).join('')}</select>` +
            '<label>from day <input class="a-day" type="number" min="0" value="0"></label>'
          : '<span class="d">No alternative supplier is defined for this material.</span>';
        q('.a-add').disabled = !alts.length;
      } else {
        q('.a-params').innerHTML = `<select class="a-step" aria-label="Step">${it.route.map(s => `<option value="${s.id}">${esc(s.stage)}</option>`).join('')}</select>` +
          `<label><input class="a-days" type="number" min="0" value="${type === 'ReportActual' ? Math.round(it.route[0].planned) : 10}"> days</label>`;
        q('.a-add').disabled = false;
      }
    }
    q('.a-type').onchange = params; if (q('.a-item')) q('.a-item').onchange = params;
    q('.a-add').onclick = () => {
      const type = q('.a-type').value;
      const a = type === 'SwitchSupplier'
        ? { type, material: item().id, party: q('.a-party').value, from_day: +q('.a-day').value || 0 }
        : { type, step: q('.a-step').value, days: +q('.a-days').value };
      try { Plan.validate(c, a); } catch (err) { q('.a-err').textContent = err.message; return; }
      st().draft.push(a); Plan.persist(c); onAdd(a);
    };
    params();
  }
  function renderExplore() {
    const c = C(), r = planResult(), host = $('explore');
    const item = Plan.itemOf(c, objectId), party = Plan.partyOf(c, objectId);
    const trend = p => p.status ? `<span class="sev ${p.status === 'Worsening' ? 'High' : 'Low'}"><i>${{ Worsening: '▲', Improving: '▼', Stable: '●' }[p.status]}</i>${p.status}</span>` : '<span class="d">Not rated</span>';

    if (item) {                                   // ---- Object view: a material
      const row = r.rows.find(x => x.id === item.id), parent = Plan.itemOf(c, item.parent);
      const kids = c.items.filter(i => i.parent === item.id), alts = Object.keys(item.variants);
      const supRow = Support.analyse(c, MODEL).rows.find(x => x.id === item.id);
      host.innerHTML = `<p class="back"><a href="#" data-object="">← All materials</a></p>
        <div class="eyebrow">Material · ${item.kind === 'buy' ? 'bought' : 'made'}</div>
        <p class="headline">${esc(item.name)}</p>
        <p class="sub">Ready ${f(row.f, true)}. Decides delivery in ${pct(row.crit)} of runs${row.crit < 0.05 ? ', so it has slack' : ''}.</p>
        <div class="card"><dl class="props">
          <div><dt>${esc(item.order.doc_type)}</dt><dd>${esc(item.order.number)}</dd></div>
          <div><dt>${item.kind === 'buy' ? 'Supplier' : 'Site'}</dt><dd>${objLink(row.party, row.partyName)}</dd></div>
          <div><dt>Category</dt><dd>${esc(item.category)}</dd></div>
          <div><dt>Quantity</dt><dd>${item.qty.toLocaleString('en-GB')}</dd></div>
          <div><dt>Runs</dt><dd>${f(row.s)} to ${f(row.f, true)}</dd></div>
        </dl></div>
        <div class="card"><h2>Document flow</h2><div class="scroll"><table>
          <tr><th>Document stage</th><th>Step</th><th class="num">Planned</th><th class="num">Typical</th><th class="num">Bad case</th><th>Dates</th><th>Status</th></tr>
          ${row.steps.map(s => `<tr><td>${esc(s.doc)}</td><td>${esc(s.stage)}</td><td class="num">${Math.round(s.planned)}</td><td class="num">${Math.round(s.typical)}</td>
            <td class="num">${s.actual === undefined ? Math.round(s.pessimistic) : ''}</td><td class="num">${f(s.s)} to ${f(s.f)}</td>
            <td>${s.actual !== undefined ? 'Reported' : s.delay > 0 ? 'Delayed' : s.delay < 0 ? 'Expedited' : s.updated ? 'Re-forecast' : 'Forecast'}</td></tr>`).join('')}
        </table></div><p class="d">Durations in days.</p></div>
        <div class="card"><h2>Standards and traceability</h2><dl class="links">
          <div><dt>Applicable standards</dt><dd>${item.standards.length ? item.standards.map(x => `${tag(x.code)} ${esc(x.name)}<div class="d">${esc(x.why)}</div>`).join('') : 'None recorded for this material.'}</dd></div>
          <div><dt>Lot genealogy</dt><dd>${Support.genealogy(c, item.id).map(g => `<div style="padding-left:${g.depth * 14}px">${g.depth ? objLink(g.id, g.name) : esc(g.name)} <span class="d">lot ${esc(g.lot)} · ${esc(g.party)}</span></div>`).join('')}</dd></div>
          ${supRow ? `<div><dt>In service</dt><dd>${supRow.status === 'candidate'
            ? `${esc(supRow.policy)}. MTBF ${mtbf(supRow.mtbfUsed)} (${esc(supRow.fb.verdict.toLowerCase())}). ${supRow.spares} ${supRow.spares === 1 ? 'spare' : 'spares'} recommended. <a href="#" data-go="support">Support page</a>`
            : esc(supRow.reason)}</dd></div>` : ''}
        </dl></div>
        <div class="grid">
          <div class="card"><h2>Linked objects</h2><dl class="links">
            ${parent ? `<div><dt>Component of</dt><dd>${objLink(parent.id, parent.name)}</dd></div>` : ''}
            ${kids.length ? `<div><dt>Components</dt><dd>${kids.map(k => objLink(k.id, k.name)).join('<br>')}</dd></div>` : ''}
            <div><dt>${item.kind === 'buy' ? 'Supplied by' : 'Made at'}</dt><dd>${objLink(row.party, row.partyName)}</dd></div>
            ${alts.length ? `<div><dt>Alternative suppliers</dt><dd>${alts.map(a => objLink(a, Plan.partyOf(c, a).name)).join('<br>')}</dd></div>` : ''}
          </dl></div>
          <div class="card"><h2>Actions</h2><div id="e-action"></div></div>
        </div>`;
      actionForm($('e-action'), item, () => go({ view: 'scenarios' }));
      return;
    }
    if (party) {                                  // ---- Object view: a supplier or site
      const supplies = r.rows.filter(x => x.party === party.id), altFor = c.items.filter(i => i.variants[party.id] && !supplies.some(x => x.id === i.id));
      host.innerHTML = `<p class="back"><a href="#" data-object="">← All suppliers and sites</a></p>
        <div class="eyebrow">Supplier or site · ${esc(party.region)}</div>
        <p class="headline">${esc(party.name)}</p>
        <p class="sub">${party.status ? `Typical overrun ${pct(party.slip_recent)} over plan in the last six months, ${pct(party.slip_before)} before.` : 'Too little recent history to rate.'}</p>
        <div class="card"><dl class="props">
          <div><dt>Trend</dt><dd>${trend(party)}</dd></div>
          <div><dt>Completed steps on record</dt><dd>${(party.steps || 0).toLocaleString('en-GB')}</dd></div>
          <div><dt>Region</dt><dd>${esc(party.region)}</dd></div>
        </dl></div>
        <div class="card"><h2>Linked objects</h2><dl class="links">
          <div><dt>Supplies in this plan</dt><dd>${supplies.map(x => objLink(x.id, x.name)).join('<br>') || 'Nothing'}</dd></div>
          ${altFor.length ? `<div><dt>Alternative for</dt><dd>${altFor.map(i => objLink(i.id, i.name)).join('<br>')}</dd></div>` : ''}
        </dl></div>`;
      exploreTab = 'parties';
      return;
    }
    // ---- Lists
    const depth = Object.fromEntries(r.rows.map(x => [x.id, x.depth]));
    const body = exploreTab === 'materials'
      ? `<tr><th>Material</th><th>Supplier or site</th><th>Order</th><th class="num">Ready</th><th class="num">Decides delivery</th></tr>` +
        r.rows.map(x => { const it = Plan.itemOf(c, x.id); return `<tr><td style="padding-left:${depth[x.id] * 14}px">${objLink(x.id, x.name)}</td><td>${esc(x.partyName)}</td>` +
          `<td class="num">${esc(it.order.number)}</td><td class="num">${f(x.f, true)}</td><td class="num">${x.crit >= 0.05 ? pct(x.crit) : 'slack'}</td></tr>`; }).join('')
      : `<tr><th>Supplier or site</th><th>Region</th><th class="num">Typical overrun, before → recent</th><th>Trend</th></tr>` +
        c.parties.map(p => `<tr><td>${objLink(p.id, p.name)}</td><td>${esc(p.region)}</td>` +
          `<td class="num">${p.status ? pct(p.slip_before) + ' → ' + pct(p.slip_recent) : ''}</td><td>${trend(p)}</td></tr>`).join('');
    host.innerHTML = `<div class="eyebrow">${esc(c.company)} · ${esc(c.title)}</div><p class="headline">Explorer</p>
      <p class="sub">Every object in the plan, with its links. Open one to see its document flow and act on it.</p>
      <div class="tabs"><button data-tab="materials">Materials (${c.items.length})</button><button data-tab="parties">Suppliers and sites (${c.parties.length})</button></div>
      <div class="card"><div class="scroll"><table>${body}</table></div></div>`;
    host.querySelectorAll('.tabs button').forEach(b => { b.setAttribute('aria-current', b.dataset.tab === exploreTab); b.onclick = () => { exploreTab = b.dataset.tab; renderExplore(); }; });
  }

  /* -------------------------------------------------------------- scenarios */
  function renderScenarios() {
    const c = C(), s = st(), plan = planResult();
    $('s-eyebrow').textContent = `${c.company} · ${c.title}`;
    const work = s.draft.length ? Plan.evaluate(c, MODEL, s.plan.concat(s.draft)) : null;
    $('s-draft').innerHTML = (s.draft.length
      ? `<ul class="acts">${s.draft.map((a, i) => `<li><span>${esc(Plan.describe(c, a))}</span><button class="x" data-i="${i}" aria-label="Remove">×</button></li>`).join('')}</ul>` +
        `<p class="verdict">Promise date ${f(work.p80, true)}: <strong>${effectText(work.p80 - plan.p80)}</strong> against the plan (${f(plan.p80, true)}).</p>` +
        '<div class="row-actions"><button class="primary" id="s-apply">Apply to plan</button><input id="s-name" placeholder="Name to save as" aria-label="Scenario name"><button id="s-save">Save</button><button id="s-clear">Clear</button></div>'
      : '<p class="quiet">Empty. Add an action below, pick an option on an alert, or ask the assistant a what-if question.</p>') +
      '<div class="adder"><div class="o-head">Add an action</div><div id="s-form"></div></div>';
    actionForm($('s-form'), null, () => { compareId = 'draft'; renderScenarios(); });
    $('s-draft').querySelectorAll('.x').forEach(b => b.onclick = () => { s.draft.splice(+b.dataset.i, 1); Plan.persist(c); renderScenarios(); });
    if ($('s-apply')) {
      $('s-apply').onclick = () => { Plan.apply(c, MODEL, s.draft, 'Applied from Scenarios'); s.draft = []; Plan.persist(c); compareId = 'plan'; renderScenarios(); };
      $('s-clear').onclick = () => { s.draft = []; Plan.persist(c); compareId = 'plan'; renderScenarios(); };
      $('s-save').onclick = () => { const name = $('s-name').value.trim(); if (!name) { $('s-name').focus(); return; }
        s.saved.push({ name, actions: s.draft.slice() }); s.draft = []; Plan.persist(c); renderScenarios(); };
    }

    const list = Plan.scenarios(c), rows = [{ id: 'plan', name: 'Current plan', actions: [], kind: 'plan' }].concat(list);
    if (!rows.some(x => x.id === compareId)) compareId = 'plan';
    const results = Object.fromEntries(rows.map(x => [x.id, Plan.evaluate(c, MODEL, s.plan.concat(x.actions))]));
    $('s-table').innerHTML = '<tr><th>Scenario</th><th class="num">Promise date</th><th class="num">Against plan</th><th>Decided by</th><th></th></tr>' + rows.map(x => {
      const r = results[x.id], e = r.p80 - plan.p80, top = Twin.drivers(r, 1)[0];
      return `<tr class="${x.id === compareId ? 'on' : ''}"><td><a href="#" class="pick" data-id="${x.id}">${esc(x.name)}</a>${x.kind === 'example' ? '<div class="d">Example</div>' : ''}</td>` +
        `<td class="num">${f(r.p80, true)}</td><td class="num eff ${e < -0.5 ? 'gain' : e > 0.5 ? 'loss' : ''}">${x.kind === 'plan' ? '' : effectText(e)}</td>` +
        `<td>${top ? esc(top.itemName) : ''}</td><td class="num">${x.kind === 'plan' || x.kind === 'draft' ? '' : `<button data-load="${x.id}">Load</button>`}` +
        `${x.kind === 'saved' ? `<button data-del="${x.index}" aria-label="Delete">×</button>` : ''}</td></tr>`;
    }).join('');
    $('s-table').querySelectorAll('.pick').forEach(a => a.onclick = e => { e.preventDefault(); e.stopPropagation(); compareId = a.dataset.id; renderScenarios(); });
    $('s-table').querySelectorAll('[data-load]').forEach(b => b.onclick = () => { s.draft = rows.find(x => x.id === b.dataset.load).actions.slice(); Plan.persist(c); compareId = 'draft'; renderScenarios(); });
    $('s-table').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { s.saved.splice(+b.dataset.del, 1); Plan.persist(c); renderScenarios(); });
    $('s-chart-title').textContent = 'Timeline: ' + rows.find(x => x.id === compareId).name;
    timeline(document.querySelector('#view-scenarios .chart-card'), c, results[compareId], Math.max(...Object.values(results).map(x => x.p80)));
  }

  /* ---------------------------------------------------------------- support */
  const num = n => Math.round(n).toLocaleString('en-GB');
  const money = n => '€' + (n >= 1e6 ? (n / 1e6).toFixed(2) + ' million' : num(n));
  const mtbf = h => h >= 1e6 ? (h / 1e6).toFixed(1) + 'M h' : num(h) + ' h';
  const tag = code => `<span class="std">${code}</span>`;
  function renderSupport() {
    const c = C(), a = Support.analyse(c, MODEL), svc = a.service, one = svc.fleet === 1;
    const sev = l => `<span class="sev ${l}"><i>${SEV[l]}</i>${l}</span>`;
    $('support').innerHTML = `<div class="eyebrow">${esc(c.company)} · ${esc(c.title)} · product support</div>
      <p class="headline">${one ? 'Availability in service: ' + (a.ao * 100).toFixed(1) + '%' : 'Spares to hold: ' + num(a.spares) + ' units'}</p>
      <p class="sub">${esc(svc.what)}: ${num(svc.fleet)} ${one ? 'system' : 'units'}, ${num(svc.hours_per_year)} operating hours a year each.
        ${one ? `${a.spares} spares worth ${money(a.value)} keep it there.` : `Worth ${money(a.value)}; availability ${(a.ao * 100).toFixed(2)}%.`}
        Resupply and repair times come from the current plan.</p>
      <div class="card"><h2>Findings</h2>${a.findings.length ? a.findings.map(x =>
        `<div class="finding">${sev(x.level)}<span>${esc(x.text)} ${objLink(x.item, 'Open')}</span></div>`).join('') : '<p class="quiet">Nothing stands out.</p>'}</div>
      <div class="card"><h2>Product breakdown and candidates ${tag('S3000L')}</h2><div class="scroll"><table>
        <tr><th>Element</th><th>Analysed for support?</th><th>Repair policy</th><th class="num">MTBF predicted → in service</th></tr>
        ${a.rows.filter(r => r.status !== 'outside').map(r => `<tr><td style="padding-left:${r.depth * 14}px">${objLink(r.id, r.name)}</td>
          <td>${r.status === 'candidate' ? 'Yes' : 'No'}<div class="d">${esc(r.reason)}</div></td><td>${r.policy || ''}</td>
          <td class="num">${r.status === 'candidate' ? mtbf(r.mtbfPred) + ' → ' + mtbf(r.mtbfUsed) + `<div class="d">${esc(r.fb.verdict)}</div>` : ''}</td></tr>`).join('')}
      </table></div><p class="d">${a.rows.filter(r => r.status === 'outside').length} materials are consumed in manufacturing and are outside the support breakdown.</p></div>
      <div class="card"><h2>Initial provisioning ${tag('S2000M')}</h2><div class="scroll"><table>
        <tr><th>Item</th><th class="num">Failures a year</th><th class="num">Time without the part</th><th class="num">Spares</th><th class="num">Value</th></tr>
        ${a.candidates.map(r => `<tr><td>${objLink(r.id, r.name)}</td><td class="num">${r.demand >= 10 ? num(r.demand) : r.demand.toFixed(2)}</td>
          <td class="num">${num(r.turnaround)} days<div class="d">${r.basis}</div></td><td class="num">${r.spares}</td><td class="num">${money(r.value)}</td></tr>`).join('')}
      </table></div><p class="d">Spares cover demand during the time without the part, ${Math.round(svc.fill_target * 100)}% of the time. Failures a year use the in-service MTBF.</p></div>
      <div class="grid">
        <div class="card"><h2>People and training ${tag('S6000T')}</h2>${a.skills.map(k =>
          `<div class="driver"><div class="t"><span>${esc(k.skill)}</span><span>${num(k.hours)} hours a year</span></div><div class="d">${k.tasks.map(esc).join(', ')}</div></div>`).join('')}
          <p class="d">About ${money(a.labour)} of labour a year at ${money(svc.labour_rate)} an hour.</p></div>
        <div class="card"><h2>Equipment and documentation ${tag('S1000D')}</h2>
          <dl class="links"><div><dt>Support equipment needed</dt><dd>${a.equipment.map(esc).join('<br>')}</dd></div>
          <div><dt>Maintenance procedures to write</dt><dd>${a.procedures}, of which ${a.scheduled} scheduled ${a.scheduled ? tag('S4000P') : ''}</dd></div></dl></div>
      </div>
      <p class="d" style="margin-top:14px">Feedback from the field ${tag('S5000F')} is the "in service" column above. All figures are synthetic. The method is simplified: single-item spares at one stock point, waiting time treated as time lost.</p>`;
  }

  /* -------------------------------------------------------------- assistant */
  function rich(text) {            // a very small markdown subset: paragraphs, bullets, bold
    const out = []; let list = null;
    const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    for (const line of text.split('\n')) {
      if (/^\s*[-*]\s+/.test(line)) { (list = list || []).push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue; }
      if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; }
      if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    }
    if (list) out.push('<ul>' + list.join('') + '</ul>');
    return out.join('');
  }
  function renderThread() {
    const c = C(), t = threads[caseId] || (threads[caseId] = { log: [], convo: [] }), el = $('thread');
    if (!t.log.length) {
      const chips = ['When will it deliver?', 'What needs attention?', c.scenarios[0].name, 'Which suppliers are getting worse?'];
      el.innerHTML = `<div class="hello"><h1>${esc(c.company)}: ${esc(c.title)}</h1><p>${esc(c.blurb)}</p>` +
        `<div class="chips">${chips.map(x => `<button class="chip">${esc(x)}</button>`).join('')}</div></div>`;
      el.querySelectorAll('.chip').forEach(b => b.onclick = () => ask(b.textContent));
    } else {
      const last = t.log.length - 1;
      el.innerHTML = t.log.map((m, i) => {
        if (m.role === 'user') return `<div class="msg user"><div>${esc(m.text)}</div></div>`;
        let card = '';
        if (m.card) {
          const k = m.card;
          card = `<div class="result"><div><div class="k">Safe to promise</div><div class="v">${f(k.p80, true)}</div></div>` +
            `<div><div class="k">Most likely</div><div class="v">${f(k.p50, true)}</div></div>` +
            (k.shift === null ? '' : `<div><div class="k">Against plan</div><div class="v">${effectText(k.shift)}</div></div>`) +
            // Only the newest proposal can still be acted on.
            (k.proposed && i === last && st().draft.length ? '<span class="btns"><button class="primary" id="c-apply">Apply to plan</button><button data-go="scenarios">Open in Scenarios</button></span>' : '') + '</div>';
        }
        return `<div class="msg bot${m.error ? ' err' : ''}">${rich(m.text)}${card}</div>`;
      }).join('') + (busy ? '<div class="msg bot"><p class="quiet">Working…</p></div>' : '');
      if ($('c-apply')) $('c-apply').onclick = () => ask('apply');
    }
    $('engine').textContent = (keyStore.get() ? 'Answered by Claude, using the twin\'s objects, functions and actions.' : 'Answered by the built-in engine, in your browser.') +
      ' It proposes; you apply. Illustrative case on synthetic data.';
    const main = document.querySelector('main');
    main.scrollTop = t.log.length ? main.scrollHeight : 0;
  }
  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    const id = caseId, t = threads[id] || (threads[id] = { log: [], convo: [] });
    t.log.push({ role: 'user', text });
    busy = true; $('q').value = ''; sizeBox(); renderThread();
    try {
      const key = keyStore.get();
      // Typed approval is handled locally in both modes: only a person applies changes.
      const r = key && !/^\s*(apply|clear)\s*$/i.test(text) ? await Chat.claude(CASES[id], MODEL, t.convo, text, key) : Chat.local(CASES[id], MODEL, text);
      t.log.push({ role: 'bot', text: r.text, card: r.card });
    } catch (err) {
      t.log.push({ role: 'bot', error: true, text: String(err.message || err) });
    }
    busy = false; if (view === 'chat') renderThread(); $('q').focus();
  }
  function sizeBox() {
    const q = $('q');
    q.style.height = 'auto';
    q.style.height = Math.min(q.scrollHeight, 160) + 'px';
    q.style.overflowY = q.scrollHeight > 160 ? 'auto' : 'hidden';
    $('send').disabled = !q.value.trim() || busy;
  }
  $('q').addEventListener('input', sizeBox);
  $('q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('q').value); } });
  $('ask').addEventListener('submit', e => { e.preventDefault(); ask($('q').value); });

  /* ------------------------------------------------------------------ model */
  function renderModel() {
    const c = C(), S = MODEL.schema, m = MODEL.metrics, b = Plan.evaluate(c, MODEL, []);
    const gap = b.p50 - c.truth.p50, gap80 = b.p80 - c.truth.p80, side = g => `${Math.abs(Math.round(g))} days ${g < 0 ? 'early' : 'late'}`;
    const defs = (rows) => `<dl class="defs">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
    $('model').innerHTML = `<div class="eyebrow">How the twin is organised</div><p class="headline">Model</p>
      <p class="sub">An ontology of objects and links, a small set of actions and functions on top, and one forecasting model underneath.</p>
      <div class="grid">
        <div class="card"><h2>Object types</h2>${defs(Object.values(S.object_types).map(o => [o.label, o.about]))}</div>
        <div class="card"><h2>Links</h2>${defs(S.link_types.map(l => [l.from, `${l.label} ${l.to}`]))}</div>
        <div class="card"><h2>Action types</h2>${defs(Object.values(S.action_types).map(a => [a.label, a.about]))}</div>
        <div class="card"><h2>Functions</h2>${defs(S.functions.map(x => [x.name, x.about]))}</div>
      </div>
      <div class="card" style="margin-top:16px"><h2>Where the structure comes from</h2><div class="scroll"><table>
        <tr><th>Idea</th><th>Documented by</th><th>Here</th></tr>
        <tr><td>Objects, links, actions and functions as one model of the business</td><td>Palantir Foundry Ontology</td><td>The four lists above; every page reads them</td></tr>
        <tr><td>One page per object, with its linked objects</td><td>Palantir Object Views</td><td>Explorer</td></tr>
        <tr><td>A sandbox of actions, compared and then applied</td><td>Palantir Ontology scenarios</td><td>Scenarios</td></tr>
        <tr><td>An agent that queries objects, runs functions and proposes actions for approval</td><td>Palantir AIP</td><td>Assistant</td></tr>
        <tr><td>Requirement to purchase order to goods receipt, traceable per order</td><td>SAP procurement process</td><td>Document flow on each material</td></tr>
        <tr><td>Alerts ranked by impact, with cause and a playbook of responses</td><td>SAP Supply Chain Control Tower</td><td>Control tower</td></tr>
      </table></div><p class="d">Modelled on publicly documented concepts. No SAP or Palantir software is used, and the project is not affiliated with either company.</p></div>
      <div class="card"><h2>Standards</h2><div class="scroll"><table>
        <tr><th>Specification</th><th>Covers</th><th>Here</th></tr>
        ${Object.entries(MODEL.standards.s_series).map(([code, x]) => `<tr><td>${tag(code)} ${esc(x.name)}</td><td>${esc(x.role)}</td><td>${esc(x.here)}</td></tr>`).join('')}
      </table></div><p class="d">${esc(MODEL.standards.note)}</p></div>
      <div class="card trust"><h2>How far to trust this</h2><ul>
        <li>${esc(c.disclaimer)}</li>
        <li>Learned from ${c.history.steps.toLocaleString('en-GB')} completed steps in ${c.history.orders.toLocaleString('en-GB')} past orders (synthetic). The model is sector-agnostic: it learns parties, stages and categories from the history it is given.</li>
        <li>Step forecasts, tested on the most recent 15% of history: average error ${m.mae_jepa.toFixed(2)} days per step, against ${m.mae_planned.toFixed(2)} for the schedule as quoted and ${m.mae_plain.toFixed(2)} for a plain network without the JEPA's context. ${Math.round(m.below_p90 * 100)}% of real durations fell at or below the pessimistic estimate (ideal 90%).</li>
        <li>Whole project, checked against this example world's hidden truth: the baseline's likely date is ${side(gap)} and its promise date ${side(gap80)}, out of about ${Math.round(c.truth.p50)} days.</li>
        <li>A supplier is flagged only when its typical overrun moved by more than 12 points and by more than chance explains. A problem that began very recently on long orders can stay invisible until those orders finish.</li>
        <li>Expediting and switching are modelled on time only. Cost, capacity and whether a supplier can actually expedite are not.</li>
      </ul></div>`;
  }

  /* --------------------------------------------------------------- settings */
  const dlg = $('settings');
  $('open-settings').onclick = () => { $('key').value = ''; $('key').placeholder = keyStore.get() ? 'A key is stored. Enter a new one to replace it.' : 'Anthropic API key'; dlg.showModal(); };
  $('key-cancel').onclick = () => dlg.close();
  $('key-remove').onclick = () => { keyStore.set(''); dlg.close(); if (view === 'chat') renderThread(); };
  $('key-save').onclick = () => { const v = $('key').value.trim(); if (v) keyStore.set(v); dlg.close(); if (view === 'chat') renderThread(); };

  function fromAddress() {
    const [hc, hv, ho] = decodeURIComponent(location.hash.slice(1)).split('/');
    go({ caseId: CASES[hc] ? hc : caseId, view: VIEWS.some(([v]) => v === hv) ? hv : 'tower', objectId: ho || '' });
  }
  window.addEventListener('popstate', fromAddress);
  window.addEventListener('hashchange', fromAddress);
  fromAddress();
})();
