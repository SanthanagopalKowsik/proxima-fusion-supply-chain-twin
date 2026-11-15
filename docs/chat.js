/* The assistant. It reads the ontology, runs functions, and PROPOSES actions.
 *
 * It never changes the plan itself: what-if questions go into the working
 * scenario, and a person applies that scenario (a button, or typing "apply").
 *
 * Two engines share the same three kinds of tool (query objects, run a
 * function, propose actions):
 *   - local:  pattern-based, no network, always available;
 *   - Claude: free conversation through the Anthropic API, used only when the
 *             visitor has stored their own API key in this browser.
 */
(function (root) {
  'use strict';
  const Twin = root.Twin || require('./engine.js');
  const Plan = root.TwinPlan || require('./plan.js');
  const Support = root.TwinSupport || require('./support.js');

  const STOP = new Set('the a an of and to in on at by for is it its if we our with from what when how does do did will would could be are was were this that then than set lot kit'.split(' '));
  const words = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
  const stem = w => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const signed = n => (n >= 0 ? '+' : '') + Math.round(n);

  function days(text) {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(day|week|wk|month)s?/i);
    return m ? Math.round(parseFloat(m[1]) * ({ day: 1, week: 7, wk: 7, month: 30 }[m[2].toLowerCase()])) : null;
  }
  /* Best-matching material, stage and party mentioned in the text. */
  function entities(c, text) {
    const t = new Set(words(text).map(stem)), raw = ' ' + text.toLowerCase() + ' ';
    const score = name => { const w = words(name).map(stem); return w.filter(x => t.has(x)).length / Math.sqrt(w.length || 1); };
    let item = null, best = 0;
    for (const it of c.items) {
      const s = score(it.name) + (raw.includes(' ' + it.id.toLowerCase() + ' ') ? 3 : 0);
      if (s > best) { best = s; item = it; }
    }
    if (best < 0.55) item = null;
    let stage = null;
    const stages = [...new Set(c.items.flatMap(i => i.route.map(s => s.stage)))].sort((a, b) => b.length - a.length);
    for (const st of stages) if (words(st).map(stem).every(w => t.has(w))) { stage = st; break; }
    if (!stage && /\b(shipping|shipment|customs|freight|in transit)\b/.test(raw)) stage = 'transit';
    if (!stage && /\b(qualif|audit|onboard)/.test(raw)) stage = 'supplier qualification';
    if (stage && !item) {
      const owners = c.items.filter(i => i.route.some(s => s.stage === stage));
      if (owners.length === 1) item = owners[0];
    }
    let party = null; best = 0.9;
    for (const p of c.parties) { const s = score(p.name); if (s > best) { best = s; party = p; } }
    return { item, stage, party };
  }
  function pickStep(item, stage, fallback) {
    if (!item) return null;
    if (stage) { const s = item.route.find(x => x.stage === stage); if (s) return s; }
    if (!fallback) return null;
    return item.route.find(s => s.stage === 'production') || item.route.slice().sort((a, b) => b.planned - a.planned)[0];
  }

  /* What the result card shows: the working scenario against the current plan. */
  function card(c, model) {
    const st = Plan.state(c), plan = Plan.evaluate(c, model, st.plan), work = Plan.evaluate(c, model, st.plan.concat(st.draft));
    return { p50: work.p50, p80: work.p80, shift: st.draft.length ? work.p80 - plan.p80 : null, proposed: st.draft.length };
  }
  function verdict(c, model) {
    const st = Plan.state(c), plan = Plan.evaluate(c, model, st.plan), r = Plan.evaluate(c, model, st.plan.concat(st.draft));
    const shift = r.p80 - plan.p80, f = d => Twin.fmtDate(c, d, true);
    let t = Math.abs(shift) < 0.5
      ? `That changes nothing. The date I would promise stays **${f(r.p80)}**, because other items finish later anyway and absorb it.`
      : `The date I would promise moves from ${f(plan.p80)} to **${f(r.p80)}** (${signed(shift)} days). The most likely delivery is ${f(r.p50)}.`;
    const base = Object.fromEntries(plan.steps.map(s => [s.id, s.typical]));
    const moved = r.steps.filter(s => s.updated && base[s.id] && Math.abs(s.typical - base[s.id]) >= 0.5)
      .map(s => `${s.stage} ${Math.round(base[s.id])} → ${Math.round(s.typical)} days`);
    if (moved.length) t += `\n\nGiven that reported result, I have also re-forecast the later steps of the same order: ${moved.join(', ')}.`;
    const top = Twin.drivers(r, 1)[0];
    if (top) t += `\n\nWhat decides the date now: **${top.itemName}** (${top.stage}).`;
    if (st.draft.length > 1) t += `\n\nThe working scenario now holds ${st.draft.length} changes: ${st.draft.map(a => Plan.describe(c, a)).join('; ')}.`;
    return t + '\n\nNothing is applied yet. Apply it to the plan when you have decided, or say "clear" to drop it.';
  }
  const helpText = c => 'I can answer questions like these:\n\n' +
    '- When will it deliver?\n- What needs attention?\n- What drives the delivery date?\n- Which suppliers are getting worse?\n' +
    `- ${c.scenarios[0].name}\n- ${c.scenarios[1].name}\n` +
    '- "Expedite <step> by N days"\n- "<step> finished in N days" to report real progress\n- "apply" to commit the working scenario, "clear" to drop it';

  /* ------------------------------------------------------------------ local engine */
  function local(c, model, text) {
    const q = ' ' + text.toLowerCase() + ' ', n = days(text), e = entities(c, text), st = Plan.state(c);
    const f = d => Twin.fmtDate(c, d, true), has = re => re.test(q);
    const reply = (msg, withCard) => ({ text: msg, card: withCard ? card(c, model) : null });
    const propose = (action, lead) => {
      try { Plan.validate(c, action); } catch (err) { return reply(String(err.message)); }
      st.draft.push(action); Plan.persist(c);
      return reply(lead + '\n\n' + verdict(c, model), true);
    };

    if (has(/\b(clear|reset|start over|drop it|discard|undo)\b/)) {
      st.draft = []; Plan.persist(c);
      return reply(`Working scenario cleared. The plan is unchanged: safe to promise **${f(Plan.evaluate(c, model, st.plan).p80)}**.`, true);
    }
    if (has(/^\s*(apply|commit|go ahead|confirm|do it|yes,? apply)\b/)) {
      if (!st.draft.length) return reply('There is no working scenario to apply. Ask a what-if question first.');
      const what = st.draft.map(a => Plan.describe(c, a)), effect = Plan.apply(c, model, st.draft, 'Applied from the assistant');
      st.draft = []; Plan.persist(c);
      return reply(`Applied to the plan: ${what.join('; ')}.\n\nThe promise date is now **${f(Plan.evaluate(c, model, st.plan).p80)}** (${signed(effect)} days).`, true);
    }
    if (has(/\b(help|what can you|what do you|how do i)\b/)) return reply(helpText(c));

    // --- propose: switch supplier
    if (has(/\b(switch|alternat|replace|second source|dual sourc|change supplier|move to|fails?|failed)\b/) && e.item) {
      const alts = Object.keys(e.item.variants);
      if (!alts.length) return reply(`**${e.item.name}** has no alternative supplier defined, so there is nothing to switch to. Materials with an alternative: ${c.items.filter(i => Object.keys(i.variants).length).map(i => i.name).join(', ')}.`);
      const to = e.party && alts.includes(e.party.id) ? e.party.id : alts[0], m = q.match(/day\s+(\d+)/);
      return propose({ type: 'SwitchSupplier', material: e.item.id, party: to, from_day: m ? +m[1] : 0 },
        `Proposed: switch **${e.item.name}** to ${Plan.partyOf(c, to).name}${m ? ' on day ' + m[1] : ''}, including a fresh supplier qualification.`);
    }
    // --- propose: report an actual
    if ((n !== null && has(/\b(finish|complet|took|taken|done in|reported|actual|came in)\w*/)) || has(/\b(double|twice)\b/)) {
      const step = pickStep(e.item, e.stage, true);
      if (!step) return reply('Which step finished? Name the material and the step, for example "wafer fab finished in 85 days".');
      const actual = n !== null ? n : Math.round(step.planned * 2);
      return propose({ type: 'ReportActual', step: step.id, days: actual },
        `Proposed record: **${e.item.name}**, ${step.stage} took ${plural(actual, 'day')} against ${Math.round(step.planned)} planned.`);
    }
    // --- propose: expedite
    if (n !== null && has(/\b(expedit|speed up|accelerat|pull in|save|faster|shorten|cut)\w*/)) {
      const step = pickStep(e.item, e.stage, true);
      if (!step) return reply('Which step should be expedited? For example "expedite wafer fab by 10 days".');
      return propose({ type: 'ExpediteStep', step: step.id, days: n }, `Proposed: take ${plural(n, 'day')} out of **${e.item.name}**, ${step.stage}.`);
    }
    // --- propose: delay
    if (n !== null && has(/\b(slip|delay|late|held|stuck|slow|add|push|behind|longer|extra|lose|lost|overrun)\w*/)) {
      const step = pickStep(e.item, e.stage, true);
      if (!step) return reply(`Which material is delayed? For example: "${c.scenarios[0].name}".`);
      return propose({ type: 'DelayStep', step: step.id, days: n }, `Proposed what-if: ${plural(n, 'day')} added to **${e.item.name}**, ${step.stage}.`);
    }

    const r = Plan.evaluate(c, model, st.plan.concat(st.draft));
    // --- traceability: which lots went into a material
    if (has(/\b(trace|traceab\w*|genealogy|lots?|batch\w*)\b/)) {
      const item = e.item || c.items.find(i => !i.parent);
      return reply(`Lot genealogy of **${item.name}**:\n\n` + Support.genealogy(c, item.id).map(g => `- ${'· '.repeat(g.depth)}${g.name}: lot ${g.lot}, ${g.party}`).join('\n'));
    }
    // --- standards
    if (has(/\b(standards?|s3000l|s2000m|s5000f|s-series|ils|ips|conform\w*|complian\w*)\b/)) {
      if (e.item) {
        return reply(e.item.standards.length
          ? `Standards recorded for **${e.item.name}**:\n\n` + e.item.standards.map(x => `- ${x.code} ${x.name}: ${x.why}`).join('\n') +
            '\n\nThese say which documents apply. They are not a claim of conformance.'
          : `No standards are recorded for **${e.item.name}**.`);
      }
      return reply('The support side of the twin follows the S-Series IPS specifications (formerly ILS):\n\n' +
        '- **S3000L** for the product breakdown, repair policy and maintenance tasks\n- **S2000M** for spares\n- **S5000F** for feedback from the field\n- **SX000i** for availability\n\n' +
        'Name a material to see which apply to it, or open the Model page for the full list. These record which documents apply; they are not a claim of conformance.');
    }
    // --- product support: availability, spares, maintenance, reliability
    if (has(/\b(availab\w*|spares?|provision\w*|maintenance|maintain\w*|lsa|support\w*|reliab\w*|mtbf|failures?|failing|in service|repair\w*)\b/)) {
      const a = Support.analyse(c, model, st.plan.concat(st.draft)), svc = a.service;
      let t = `In service (${svc.what.toLowerCase()}): availability **${(a.ao * 100).toFixed(svc.fleet === 1 ? 1 : 2)}%**, with **${a.spares} spares** worth €${Math.round(a.value).toLocaleString('en-GB')} recommended.\n\n` +
        a.candidates.map(x => `- ${x.name}: ${x.policy.toLowerCase()}; ${x.spares} ${x.spares === 1 ? 'spare' : 'spares'}; ${Math.round(x.turnaround)} days without the part (${x.basis})`).join('\n');
      if (a.findings.length) t += '\n\nFindings:\n\n' + a.findings.map(x => `- ${x.text}`).join('\n');
      return reply(t + '\n\nResupply and repair times come from the plan, so a supplier delay changes these figures.');
    }
    // --- alerts
    if (has(/\b(alert|attention|worry|concern|problem|issue|priorit|look at|urgent)\w*/)) {
      const list = Plan.alerts(c, model);
      if (!list.length) return reply('Nothing needs attention on the current plan.');
      return reply('In order of days at risk:\n\n' + list.map(a => `- **${a.title}** (${a.severity.toLowerCase()}, up to ${Math.round(a.days)} days): ${a.cause}`).join('\n') +
        '\n\nOpen the Control tower to try the options for each.');
    }
    // --- gating factors
    if (has(/\b(drives?|driving|driven|critical|bottlenecks?|decides?|deciding|gating|biggest risk|risks?|why|longest)\b/)) {
      return reply('These steps most often decide when the project delivers:\n\n' +
        Twin.drivers(r, 4).map(s => `- **${s.itemName}**, ${s.stage}: decides delivery in ${Math.round(s.crit * 100)}% of runs, typically ${Math.round(s.typical)} days (planned ${Math.round(s.planned)})`).join('\n') +
        '\n\nA day lost on any of them is very likely a day lost on delivery. Materials not listed have slack.', true);
    }
    // --- supplier health
    if (has(/\b(supplier|vendor|watch|worsen|reliab|perform|trust|site)\w*/) && !e.item) {
      const flagged = c.parties.filter(p => p.status === 'Worsening');
      const worst = c.parties.filter(p => p.slip_recent !== undefined).sort((a, b) => b.slip_recent - a.slip_recent).slice(0, 3);
      return reply((flagged.length
        ? `${flagged.length === 1 ? 'One supplier or site has' : flagged.length + ' suppliers or sites have'} got measurably slower in the last six months:\n\n` +
          flagged.map(p => `- **${p.name}**: typical overrun was ${Math.round(p.slip_before * 100)}%, now ${Math.round(p.slip_recent * 100)}%`).join('\n')
        : 'No supplier or site shows a clear recent change in behaviour.') +
        '\n\nLargest typical overruns right now:\n\n' + worst.map(p => `- ${p.name}: ${Math.round(p.slip_recent * 100)}% over plan`).join('\n'));
    }
    // --- one material
    if (e.item && !has(/\b(when|deliver|promise)\b/)) {
      const row = r.rows.find(x => x.id === e.item.id);
      return reply(`**${e.item.name}**${row.partyName ? ' (' + row.partyName + ')' : ''}, ${e.item.order.doc_type.toLowerCase()} ${e.item.order.number}, runs from ${Twin.fmtDate(c, row.s)} to ${Twin.fmtDate(c, row.f, true)} and decides delivery in ${Math.round(row.crit * 100)}% of runs.\n\n` +
        row.steps.map(s => `- ${s.stage}: typically ${Math.round(s.typical)} days, up to ${Math.round(s.pessimistic)} in a bad case (planned ${Math.round(s.planned)})`).join('\n'));
    }
    if (has(/\b(scenario|example|what if|try|suggest)\w*/)) return reply('Here are setbacks you can try:\n\n' + c.scenarios.map(s => `- ${s.name}`).join('\n'));
    // --- when will it deliver
    if (has(/\b(when|deliver|date|promise|status|timeline|forecast|finish|ready|on time|how long|overview|summary)\w*/)) {
      return reply(`For this project I would promise **${f(r.p80)}**. The most likely delivery is ${f(r.p50)}, and in a bad case it runs to ${f(r.p95)}.\n\nSupplier quotes alone add up to ${f(r.plan)}, so the realistic promise is ${Math.round(r.p80 - r.plan)} days later than the plan. The chance of meeting the planned date is ${Math.round(r.onPlan * 100)}%.`, true);
    }
    return reply(`I did not understand that as a supply chain question I can compute.\n\n${helpText(c)}`);
  }

  /* ----------------------------------------------------------------- Claude engine */
  const API = 'https://api.anthropic.com/v1/messages';
  const ACTION_ITEM = {
    type: 'object', additionalProperties: false, required: ['type', 'step_id', 'material_id', 'party_id', 'days', 'from_day'],
    properties: {
      type: { type: 'string', enum: ['ReportActual', 'DelayStep', 'ExpediteStep', 'SwitchSupplier'] },
      step_id: { type: ['string', 'null'], description: 'For ReportActual, DelayStep, ExpediteStep.' },
      material_id: { type: ['string', 'null'], description: 'For SwitchSupplier.' },
      party_id: { type: ['string', 'null'], description: 'For SwitchSupplier: the alternative supplier.' },
      days: { type: ['number', 'null'], description: 'Actual duration, extra days, or days saved.' },
      from_day: { type: ['number', 'null'], description: 'For SwitchSupplier: project day the switch happens.' },
    },
  };
  const TOOLS = [
    { name: 'query_objects', strict: true,
      description: 'Read objects from the ontology as they stand under the current plan: materials with their order and steps, suppliers and sites with their trend, open alerts, or the plan itself (applied actions and decision log).',
      input_schema: { type: 'object', additionalProperties: false, required: ['object_type'],
        properties: { object_type: { type: 'string', enum: ['materials', 'parties', 'alerts', 'plan', 'support'] } } } },
    { name: 'simulate', strict: true,
      description: 'Function: simulate the project with the given actions added on top of the current plan. Changes nothing. Pass an empty list for the current plan. Each call is independent.',
      input_schema: { type: 'object', additionalProperties: false, required: ['actions'], properties: { actions: { type: 'array', items: ACTION_ITEM } } } },
    { name: 'propose_actions', strict: true,
      description: 'Put actions in front of the user as the working scenario for their approval. This does NOT apply them; only the user can apply. Replaces any earlier proposal.',
      input_schema: { type: 'object', additionalProperties: false, required: ['actions'], properties: { actions: { type: 'array', items: ACTION_ITEM } } } },
  ];
  const toAction = a => a.type === 'SwitchSupplier'
    ? { type: a.type, material: a.material_id, party: a.party_id, from_day: a.from_day || 0 }
    : { type: a.type, step: a.step_id, days: a.days };

  function systemPrompt(c) {
    return `You are the assistant of a supply chain digital twin. Project: ${c.company}, ${c.title} (${c.sector}), start date ${c.start_date}.

The case is illustrative: suppliers are anonymised and all durations are synthetic. Say so if asked where data comes from; never present figures as real company data.

How to work:
- Product support (availability, spares, maintenance tasks, field reliability, lots, applicable standards) is under query_objects "support". It follows the roles of the S-Series IPS specifications (S3000L, S2000M, S5000F); these record which documents apply and are never a claim of conformance.
- Read with query_objects. Compute with simulate; never estimate dates yourself. Dates in tool results are already formatted. The date to promise is the 80% date.
- You cannot change the plan. To recommend a change, call propose_actions and tell the user it is waiting for their approval. Never say something has been applied.
- Before proposing, simulate the options you are weighing and say what each does to the promise date, including options that make it worse.
- Answer for a supply chain manager: lead with the answer, give dates, then what decides the date. Keep it short.

Action types: ReportActual (a step finished; needs step_id, days), DelayStep and ExpediteStep (step_id, days), SwitchSupplier (material_id, party_id, from_day). Step ids look like MATERIAL:stage; get exact ids from query_objects.`;
  }
  function runTool(c, model, name, input) {
    const st = Plan.state(c), f = d => Twin.fmtDate(c, d, true), pct = x => Math.round(x * 100) + '%';
    const outcome = (r, base) => ({ planned_date: f(r.plan), likely_date: f(r.p50), promise_date_80pct: f(r.p80), bad_case_date_95pct: f(r.p95),
      change_vs_current_plan_days: Math.round(r.p80 - base.p80),
      gating_steps: Twin.drivers(r, 5).map(s => ({ step_id: s.id, share_of_runs: pct(s.crit), typical_days: Math.round(s.typical), planned_days: s.planned })) });
    const plan = Plan.evaluate(c, model, st.plan);
    if (name === 'query_objects') {
      if (input.object_type === 'materials') return plan.rows.map(r => { const it = Plan.itemOf(c, r.id); return {
        material_id: it.id, name: it.name, kind: it.kind, component_of: it.parent, supplier: r.partyName, order: it.order.doc_type + ' ' + it.order.number,
        alternative_suppliers: Object.keys(it.variants).map(a => ({ party_id: a, name: Plan.partyOf(c, a).name })),
        finish: f(r.f), decides_delivery: pct(r.crit),
        steps: r.steps.map(s => ({ step_id: s.id, document_stage: s.doc, planned_days: s.planned, typical_days: Math.round(s.typical), pessimistic_days: Math.round(s.pessimistic), reported_actual: s.actual })) }; });
      if (input.object_type === 'parties') return c.parties.map(p => ({ party_id: p.id, name: p.name, region: p.region, trend: p.status || 'not rated',
        typical_overrun_before: p.slip_before === undefined ? null : pct(p.slip_before), typical_overrun_recent: p.slip_recent === undefined ? null : pct(p.slip_recent) }));
      if (input.object_type === 'support') {
        const a = Support.analyse(c, model, st.plan);
        return { in_service: a.service.what, fleet: a.service.fleet, availability: (a.ao * 100).toFixed(2) + '%', spares_recommended: a.spares, spares_value_eur: Math.round(a.value),
          findings: a.findings.map(x => x.text), support_equipment: a.equipment, skills: a.skills.map(k => ({ skill: k.skill, hours_per_year: Math.round(k.hours) })),
          elements: a.rows.map(x => x.status !== 'candidate' ? { material_id: x.id, name: x.name, lsa_candidate: false, reason: x.reason, lot: x.lot } : {
            material_id: x.id, name: x.name, lsa_candidate: true, lot: x.lot, repair_policy: x.policy, mtbf_predicted_h: x.mtbfPred, mtbf_in_service_h: Math.round(x.mtbfUsed),
            field_feedback: x.fb.verdict, failures_per_year: +x.demand.toFixed(2), days_without_part: Math.round(x.turnaround), basis: x.basis, spares: x.spares,
            standards: Plan.itemOf(c, x.id).standards.map(z => z.family + ' ' + z.code) }) };
      }
      if (input.object_type === 'alerts') return Plan.alerts(c, model).map(a => ({ title: a.title, rule: a.rule, severity: a.severity, days_at_risk: Math.round(a.days), cause: a.cause, material_id: a.material }));
      return { applied_actions: st.plan.map(a => Plan.describe(c, a)), awaiting_approval: st.draft.map(a => Plan.describe(c, a)), decision_log: st.log, ...outcome(plan, plan) };
    }
    const actions = (input.actions || []).map(toAction);
    actions.forEach(a => Plan.validate(c, a));
    const r = Plan.evaluate(c, model, st.plan.concat(actions));
    if (name === 'simulate') return outcome(r, plan);
    st.draft = actions; Plan.persist(c);
    return { status: 'Shown to the user as the working scenario. Not applied; waiting for their approval.', ...outcome(r, plan) };
  }

  async function claude(c, model, convo, text, apiKey) {
    convo.push({ role: 'user', content: text });
    let touched = false;
    for (let turn = 0; turn < 8; turn++) {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
          'anthropic-dangerous-direct-browser-access': 'true',   // the visitor's own key, used from their own browser
        },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: 'medium' },
          fallbacks: 'default', system: systemPrompt(c), tools: TOOLS, messages: convo }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})), why = (body.error && body.error.message) || res.statusText;
        while (convo.length && !(convo[convo.length - 1].role === 'user' && convo[convo.length - 1].content === text)) convo.pop();
        convo.pop();                                             // leave the conversation as it was before this question
        if (res.status === 401) throw new Error('The API key was rejected. Check it in Settings.');
        if (res.status === 429) throw new Error('Rate limited by the API. Wait a moment and try again.');
        throw new Error(`Claude request failed (${res.status}): ${why}`);
      }
      const msg = await res.json();
      convo.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'refusal') return { text: 'Claude declined to answer that request.', card: null };
      if (msg.stop_reason !== 'tool_use') {
        const answer = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        return { text: answer || '(no answer)', card: touched ? card(c, model) : null };
      }
      const results = msg.content.filter(b => b.type === 'tool_use').map(block => {
        try {
          if (block.name !== 'query_objects') touched = true;
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(runTool(c, model, block.name, block.input || {})) };
        } catch (err) {
          return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: String(err.message || err) };
        }
      });
      convo.push({ role: 'user', content: results });            // every result in one message
    }
    return { text: 'I could not finish that in a reasonable number of steps. Try a simpler question.', card: card(c, model) };
  }

  const api = { local, claude, card, runTool };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TwinChat = api;
})(typeof window !== 'undefined' ? window : globalThis);
