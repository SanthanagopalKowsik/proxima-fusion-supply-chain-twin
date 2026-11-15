/* The kinetic layer: actions, scenarios, alerts and the plan they change.
 *
 * - An ACTION is a typed change (report an actual, delay, expedite, switch supplier).
 * - The PLAN is the list of actions that have been applied. An empty plan is
 *   the baseline: supplier quotes plus the model's forecast.
 * - A SCENARIO is a sandbox: the plan plus further actions, evaluated and
 *   compared without changing the plan. Applying it is a separate, explicit step.
 * - ALERTS are rules evaluated on the current plan, ranked by days at risk,
 *   each with a playbook of options that can be tried as scenarios.
 */
(function (root) {
  'use strict';
  const Twin = root.Twin || require('./engine.js');

  const itemOf = (c, id) => c.items.find(i => i.id === id);
  const partyOf = (c, id) => c.parties.find(p => p.id === id);
  function stepOf(c, id) {
    const item = itemOf(c, id.split(':')[0]);
    if (!item) return null;
    return [...item.route, ...Object.values(item.variants).flat()].find(s => s.id === id) || null;
  }

  /* ------------------------------------------------------------------ actions */
  function validate(c, a) {
    const num = (v, what) => { if (!(typeof v === 'number' && isFinite(v) && v >= 0)) throw new Error(what + ' must be a number, zero or more'); };
    if (a.type === 'SwitchSupplier') {
      const item = itemOf(c, a.material);
      if (!item) throw new Error('Unknown material ' + a.material);
      if (!item.variants[a.party]) throw new Error(`${item.name} has no alternative supplier ${a.party}`);
      num(a.from_day || 0, 'From day');
    } else if (['ReportActual', 'DelayStep', 'ExpediteStep'].includes(a.type)) {
      if (!stepOf(c, a.step)) throw new Error('Unknown step ' + a.step);
      num(a.days, 'Days');
      if (a.type === 'ReportActual' && a.days <= 0) throw new Error('An actual duration must be above zero');
    } else throw new Error('Unknown action type ' + a.type);
    return a;
  }
  function describe(c, a) {
    if (a.type === 'SwitchSupplier') {
      return `Switch ${itemOf(c, a.material).name} to ${partyOf(c, a.party).name}` + (a.from_day ? ` from day ${a.from_day}` : '');
    }
    const s = stepOf(c, a.step), name = `${itemOf(c, a.step.split(':')[0]).name}, ${s.stage}`;
    if (a.type === 'ReportActual') return `${name} finished in ${a.days} days (planned ${Math.round(s.planned)})`;
    if (a.type === 'DelayStep') return `${name} delayed by ${a.days} days`;
    return `${name} expedited by ${a.days} days`;
  }
  /* The engine's input: one merged picture of every action. Later actions on the same thing win or add up. */
  function toScenario(actions) {
    const sc = { delays: {}, done: {}, switch: {} };
    for (const a of actions) {
      if (a.type === 'DelayStep') sc.delays[a.step] = (sc.delays[a.step] || 0) + a.days;
      else if (a.type === 'ExpediteStep') sc.delays[a.step] = (sc.delays[a.step] || 0) - a.days;
      else if (a.type === 'ReportActual') sc.done[a.step] = a.days;
      else if (a.type === 'SwitchSupplier') sc.switch[a.material] = { party: a.party, from_day: a.from_day || 0 };
    }
    return sc;
  }
  function fromScenario(sc) {      // the stored example setbacks, as actions
    const out = [];
    for (const [step, days] of Object.entries(sc.delays || {})) out.push({ type: 'DelayStep', step, days });
    for (const [step, days] of Object.entries(sc.done || {})) out.push({ type: 'ReportActual', step, days });
    for (const [material, s] of Object.entries(sc.switch || {})) out.push({ type: 'SwitchSupplier', material, party: s.party, from_day: s.from_day || 0 });
    return out;
  }

  /* ------------------------------------------------------------- evaluation */
  const memo = new Map();
  function evaluate(c, model, actions) {
    const key = c.id + '|' + JSON.stringify(actions);
    if (!memo.has(key)) {
      if (memo.size > 80) memo.clear();
      memo.set(key, Twin.run(c, model, toScenario(actions)));
    }
    return memo.get(key);
  }

  /* ------------------------------------------------------------------ store */
  const mem = {};
  const keyOf = c => 'twin.plan.' + c.id;
  function state(c) {
    if (mem[c.id]) return mem[c.id];
    let saved = null;
    try { saved = JSON.parse(root.localStorage.getItem(keyOf(c)) || 'null'); } catch (e) { /* no storage: start fresh */ }
    const st = { plan: [], draft: [], saved: [], log: [], ...(saved || {}) };
    try { st.plan.concat(st.draft).forEach(a => validate(c, a)); st.saved.forEach(s => s.actions.forEach(a => validate(c, a))); }
    catch (e) { st.plan = []; st.draft = []; st.saved = []; st.log = []; }   // stored data no longer fits this case
    return (mem[c.id] = st);
  }
  function persist(c) {
    const st = state(c);
    try { root.localStorage.setItem(keyOf(c), JSON.stringify({ plan: st.plan, draft: st.draft, saved: st.saved, log: st.log })); } catch (e) { /* not available */ }
  }
  /* Commit actions to the plan and record the decision. */
  function apply(c, model, actions, note) {
    const st = state(c);
    actions.forEach(a => validate(c, a));
    const before = evaluate(c, model, st.plan).p80;
    st.plan = st.plan.concat(actions);
    const after = evaluate(c, model, st.plan).p80;
    st.log.unshift({ when: new Date().toISOString().slice(0, 10), what: actions.map(a => describe(c, a)), note: note || '', effect: after - before });
    persist(c);
    return after - before;
  }
  function reset(c) { mem[c.id] = { plan: [], draft: [], saved: [], log: [] }; persist(c); }
  /* Every scenario worth comparing: the working draft, saved ones, and the case's examples. */
  function scenarios(c) {
    const st = state(c), out = [];
    if (st.draft.length) out.push({ id: 'draft', name: 'Working scenario', actions: st.draft, kind: 'draft' });
    st.saved.forEach((s, i) => out.push({ id: 'saved' + i, name: s.name, actions: s.actions, kind: 'saved', index: i }));
    c.scenarios.forEach((s, i) => out.push({ id: 'ex' + i, name: s.name, actions: fromScenario(s), kind: 'example' }));
    return out;
  }

  /* ------------------------------------------------------------------ alerts */
  const severity = days => days >= 14 ? 'High' : days >= 5 ? 'Medium' : 'Low';
  function alerts(c, model) {
    const st = state(c), r = evaluate(c, model, st.plan), out = [];
    const pct = x => Math.round(x * 100) + '%';
    // Rule 1: a step that decides delivery and has a long bad case.
    r.steps.filter(s => s.actual === undefined && s.crit >= 0.3)
      .map(s => ({ s, days: s.crit * (s.pessimistic - s.typical) }))
      .filter(x => x.days >= 4).sort((a, b) => b.days - a.days).slice(0, 3)
      .forEach(({ s, days }) => {
        const item = itemOf(c, s.item), single = item.kind === 'buy' && !Object.keys(item.variants).length;
        out.push({ id: 'gate:' + s.id, rule: 'Gating step at risk', days, material: s.item, step: s.id,
          title: `${s.itemName}: ${s.stage} could overrun`,
          cause: `This step decides delivery in ${pct(s.crit)} of runs. It typically takes ${Math.round(s.typical)} days but ${Math.round(s.pessimistic)} in a bad case, against ${Math.round(s.planned)} planned.` +
                 (single ? ' No alternative supplier is defined for this material.' : '') });
      });
    // Rule 2: a supplier or site in this plan whose behaviour has got worse.
    c.parties.filter(p => p.status === 'Worsening').forEach(p => {
      const mine = r.steps.filter(s => s.party === p.id && s.actual === undefined && s.stage !== 'transit');
      if (!mine.length) return;
      const crit = Math.max(...mine.map(s => s.crit)), top = mine.slice().sort((a, b) => b.typical - a.typical)[0];
      out.push({ id: 'trend:' + p.id, rule: 'Supplier trend worsening', days: crit * mine.reduce((a, s) => a + s.pessimistic - s.typical, 0),
        party: p.id, material: top.item, step: top.id, title: `${p.name} is getting slower`,
        cause: `Its typical overrun rose from ${pct(p.slip_before)} to ${pct(p.slip_recent)} in the last six months. ` +
               (crit < 0.05 ? 'Its material has slack today, so delivery is not yet affected.' : `Its material decides delivery in ${pct(crit)} of runs.`) });
    });
    // Rule 3: a reported actual that ran well over plan.
    r.steps.filter(s => s.actual !== undefined && s.actual > s.planned * 1.2).forEach(s => {
      const later = r.steps.filter(x => x.item === s.item && x.updated);
      out.push({ id: 'over:' + s.id, rule: 'Reported overrun', days: s.actual - s.planned, material: s.item, step: (later[0] || s).id,
        title: `${s.itemName}: ${s.stage} ran ${Math.round(s.actual - s.planned)} days over`,
        cause: `Reported at ${s.actual} days against ${Math.round(s.planned)} planned.` +
               (later.length ? ` The ${later.length} later step${later.length > 1 ? 's' : ''} of this order have been re-forecast in light of it.` : '') });
    });
    out.forEach(a => { a.severity = severity(a.days); });
    return out.sort((a, b) => b.days - a.days).slice(0, 6);
  }
  /* A new supplier cannot simply be swapped in. */
  const requalification = () => 'The new supplier has to be qualified first; that time is included.';
  /* Playbook: the options worth trying for an alert, each with its effect on the promise date. */
  function playbook(c, model, alert) {
    const st = state(c), r = evaluate(c, model, st.plan), item = itemOf(c, alert.material), options = [];
    const switched = toScenario(st.plan).switch[item.id];
    if (item.kind === 'buy') {
      Object.keys(item.variants).filter(a => !switched || switched.party !== a).forEach(a =>
        options.push({ label: `Switch to ${partyOf(c, a).name}`, actions: [{ type: 'SwitchSupplier', material: item.id, party: a, from_day: 0 }],
          note: requalification(item) }));
    }
    const s = r.steps.find(x => x.id === alert.step && x.actual === undefined)
           || r.steps.filter(x => x.item === item.id && x.actual === undefined).sort((a, b) => b.typical - a.typical)[0];
    if (s) {
      const n = Math.max(3, Math.min(21, Math.round(s.typical * 0.15)));
      options.push({ label: `Expedite ${s.stage} by ${n} days`, actions: [{ type: 'ExpediteStep', step: s.id, days: n }] });
    }
    options.forEach(o => { o.effect = evaluate(c, model, st.plan.concat(o.actions)).p80 - r.p80; });
    return options.sort((a, b) => a.effect - b.effect);
  }

  const api = { validate, describe, toScenario, fromScenario, evaluate, state, persist, apply, reset, scenarios, alerts, playbook, itemOf, partyOf, stepOf, severity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TwinPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);
