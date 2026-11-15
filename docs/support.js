/* Product support: keeping the delivered product working.
 *
 * Follows the roles the S-Series IPS specifications describe (formerly ILS):
 *   S3000L  product breakdown, LSA candidate selection, repair policy, maintenance tasks
 *   S2000M  initial provisioning: how many spares to hold
 *   S5000F  in-service feedback: observed failures correct the predicted reliability
 *   SX000i  support system effectiveness: operational availability
 * plus a lot genealogy, so a failure can be traced to component lots and suppliers.
 *
 * The link to the rest of the twin: spares are sized by how long resupply or
 * repair really takes, and those times come from the same plan and forecasts
 * as the delivery date. A slower supplier means more spares or less uptime.
 */
(function (root) {
  'use strict';
  const Twin = root.Twin || require('./engine.js');
  const Plan = root.TwinPlan || require('./plan.js');

  /* Smallest stock s such that demand during the turnaround is covered with the target probability. */
  function poissonStock(lambda, target) {
    let p = Math.exp(-lambda), cdf = p, s = 0;
    if (lambda > 700) {                      // too large for exp(-lambda): normal approximation
      const z = 1.645 + (target - 0.95) * 8;
      return { s: Math.ceil(lambda + z * Math.sqrt(lambda)), short: 1 - target };
    }
    while (cdf < target && s < 100000) { s++; p *= lambda / s; cdf += p; }
    return { s, short: Math.max(0, 1 - cdf) };
  }

  /* Time to obtain one more of a material from scratch: its own order plus everything beneath it. */
  const memo = new Map();
  function resupply(c, model, itemId, actions) {
    const key = c.id + '|' + itemId + '|' + JSON.stringify(actions);
    if (memo.has(key)) return memo.get(key);
    const keep = new Set([itemId]);
    for (let grew = true; grew;) { grew = false; c.items.forEach(i => { if (keep.has(i.parent) && !keep.has(i.id)) { keep.add(i.id); grew = true; } }); }
    const sub = { ...c, items: c.items.filter(i => keep.has(i.id)).map(i => i.id === itemId ? { ...i, parent: null } : i) };
    const r = Twin.run(sub, model, Plan.toScenario(actions), { n: 1200 });
    if (memo.size > 200) memo.clear();
    memo.set(key, { p50: r.p50, p80: r.p80 });
    return memo.get(key);
  }

  /* S5000F: combine the prediction with what the field has shown. */
  function feedback(pred, fb) {
    if (!fb) return { used: pred, verdict: 'No field data', expected: 0, failures: 0 };
    const PRIOR = 2;                                   // the prediction counts as two failures' worth of evidence
    const used = (PRIOR * pred + fb.hours) / (PRIOR + fb.failures), expected = fb.hours / pred;
    let verdict = 'As predicted';
    if (expected + fb.failures < 10) verdict = 'Too few events to judge';
    else if (fb.failures > expected + 2 * Math.sqrt(expected) && used < 0.85 * pred) verdict = 'Worse than predicted';
    else if (fb.failures < expected - 2 * Math.sqrt(expected) && used > 1.15 * pred) verdict = 'Better than predicted';
    return { used: verdict === 'Too few events to judge' ? pred : used, verdict, expected, failures: fb.failures, hours: fb.hours };
  }

  function analyse(c, model, actions) {
    actions = actions || Plan.state(c).plan;
    const svc = c.service, plan = Plan.evaluate(c, model, actions);
    const depth = Object.fromEntries(plan.rows.map(r => [r.id, r.depth]));
    const rows = plan.rows.map(pr => {
      const item = Plan.itemOf(c, pr.id), sup = item.support, row = { id: item.id, name: item.name, depth: depth[item.id], party: pr.partyName, lot: item.lot };
      // S3000L candidate selection: is this element analysed for support at all?
      if (!sup) return { ...row, status: 'outside', reason: 'Consumed in manufacturing; not part of the delivered product.' };
      if (sup.integral) return { ...row, status: 'integral', reason: 'Built into its parent; not replaceable in service.' };
      const prev = sup.tasks.filter(t => t.kind === 'preventive'), corr = sup.tasks.filter(t => t.kind === 'corrective');
      const fb = feedback(sup.mtbf_h, c.feedback[item.id]);
      // Repair policy (level of repair): repair only where it is possible and clearly cheaper than a new unit.
      const economic = sup.repairable && sup.repair_cost <= 0.5 * sup.price;
      const policy = !sup.repairable ? 'Discard and replace' : economic ? 'Repair and return to stock' : 'Discard and replace (repair uneconomic)';
      // Turnaround: how long a spare is missing after a failure.
      const own = pr.steps, moves = own.filter(s => s.stage === 'transit' || s.stage === 'delivery'), work = own.filter(s => !moves.includes(s));
      const repairDays = 0.3 * work.reduce((a, s) => a + s.typical, 0) + 2 * moves.reduce((a, s) => a + s.typical, 0);
      const fresh = resupply(c, model, item.id, actions);
      const turnaround = economic ? repairDays : fresh.p80;
      const demand = svc.fleet * svc.hours_per_year * sup.per_unit / fb.used;      // failures per year
      const stock = poissonStock(demand * turnaround / 365, svc.fill_target);
      const atPrediction = poissonStock(svc.fleet * svc.hours_per_year * sup.per_unit / sup.mtbf_h * turnaround / 365, svc.fill_target).s;
      // Availability of one position: time lost to repair, to waiting for a spare, and to scheduled work.
      const mttr = corr.reduce((a, t) => a + t.hours, 0);
      const waiting = stock.short * turnaround * 24 / 2;
      const lostPerHour = (mttr + waiting) / fb.used + prev.reduce((a, t) => a + t.hours / t.interval_h, 0);
      return { ...row, status: 'candidate', policy, economic, tasks: sup.tasks, perUnit: sup.per_unit, price: sup.price,
        reason: 'Replaceable in service' + (sup.repairable ? ', repairable' : '') + (prev.length ? ', has scheduled maintenance' : '') + '.',
        mtbfPred: sup.mtbf_h, mtbfUsed: fb.used, fb, demand, turnaround, basis: economic ? 'repair' : 'new supply', freshP80: fresh.p80,
        spares: stock.s, sparesAtPrediction: atPrediction, value: stock.s * sup.price, mttr,
        ao: Math.pow(1 / (1 + lostPerHour), sup.per_unit) };
    });
    const cand = rows.filter(r => r.status === 'candidate');

    // Maintenance task analysis rolled up into the support elements it implies.
    const skills = {}, equipment = new Set();
    cand.forEach(r => r.tasks.forEach(t => {
      const perYear = t.kind === 'preventive' ? svc.fleet * svc.hours_per_year * r.perUnit / t.interval_h : r.demand;
      const k = skills[t.skill] = skills[t.skill] || { skill: t.skill, hours: 0, tasks: [] };
      k.hours += perYear * t.hours; k.tasks.push(t.name);
      t.equipment.forEach(e => equipment.add(e));
    }));
    const labour = Object.values(skills).reduce((a, k) => a + k.hours, 0) * svc.labour_rate;

    // Findings: what a support manager should act on.
    const findings = [];
    cand.filter(r => r.fb.verdict === 'Worse than predicted').forEach(r => findings.push({ item: r.id, level: 'High',
      text: `${r.name} is failing more often than predicted: ${r.fb.failures} failures in the field against ${Math.round(r.fb.expected)} expected. ` +
            `Spares rise from ${r.sparesAtPrediction} to ${r.spares}. Lot ${r.lot}${r.party ? ' from ' + r.party : ''}.` }));
    cand.filter(r => r.basis === 'new supply' && r.turnaround >= 150 && r.spares > 0).sort((a, b) => b.value - a.value).slice(0, 2)
      .forEach(r => findings.push({ item: r.id, level: 'Medium',
        text: `${r.name}: a replacement takes about ${Math.round(r.turnaround)} days to obtain, so ${r.spares} ${r.spares === 1 ? 'spare has' : 'spares have'} to be held. Shorter supply would reduce this.` }));
    cand.filter(r => r.fb.verdict === 'Too few events to judge' && r.fb.failures > 0).slice(0, 1).forEach(r => findings.push({ item: r.id, level: 'Low',
      text: `${r.name}: ${r.fb.failures} ${r.fb.failures === 1 ? 'failure' : 'failures'} so far against ${r.fb.expected.toFixed(1)} expected, but too few events to conclude anything. The prediction is kept.` }));

    return { service: svc, rows, candidates: cand, ao: cand.reduce((a, r) => a * r.ao, 1),
      spares: cand.reduce((a, r) => a + r.spares, 0), value: cand.reduce((a, r) => a + r.value, 0),
      skills: Object.values(skills).sort((a, b) => b.hours - a.hours), equipment: [...equipment].sort(),
      procedures: cand.reduce((a, r) => a + r.tasks.length, 0), scheduled: cand.reduce((a, r) => a + r.tasks.filter(t => t.kind === 'preventive').length, 0),
      labour, findings };
  }

  /* Traceability: the lots that went into a material, down the bill of materials. */
  function genealogy(c, itemId) {
    const out = [];
    (function walk(id, depth) {
      const item = Plan.itemOf(c, id);
      out.push({ id, name: item.name, lot: item.lot, depth, order: item.order.number, party: Plan.partyOf(c, item.party).name });
      c.items.filter(i => i.parent === id).forEach(k => walk(k.id, depth + 1));
    })(itemId, 0);
    return out;
  }

  const api = { analyse, genealogy, resupply, feedback, poissonStock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TwinSupport = api;
})(typeof window !== 'undefined' ? window : globalThis);
