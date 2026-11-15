/* The twin's engine, running in the browser (and in Node for tests).
 *
 * Given a case and a scenario it:
 *   1. applies the scenario (delays, supplier switches, reported actuals),
 *   2. re-forecasts steps downstream of any reported actual with the JEPA,
 *   3. plays the project forward thousands of times,
 *   4. reports dates, per-item timing and which items decide delivery.
 *
 * Scenario shape (all parts optional):
 *   { delays: {stepId: extraDays},
 *     done:   {stepId: actualDays},
 *     switch: {itemId: {party: partyId, from_day: day}} }
 */
(function (root) {
  'use strict';

  // ---- small neural network pieces (the JEPA's forward pass) ----
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  }
  const gelu = x => 0.5 * x * (1 + erf(x / Math.SQRT2));
  function dense(w, b, x, act) {
    const out = new Array(w.length);
    for (let i = 0; i < w.length; i++) {
      let s = b[i]; const wi = w[i];
      for (let j = 0; j < x.length; j++) s += wi[j] * x[j];
      out[i] = act ? gelu(s) : s;
    }
    return out;
  }
  const net = (L, x) => dense(L.w2, L.b2, dense(L.w1, L.b1, x, true), false);

  /* Predicted duration in days at each of the model's quantiles, for a step, given the steps of
   * the same item that have already finished. `done` = [{step, actual}]. */
  function forecast(model, party, step, done) {
    const zero = new Array(model.dim).fill(0);
    let ctx = zero, has = 0;
    if (done.length) {
      ctx = zero.slice(); has = 1;
      const recent = done.slice(-model.n_order);
      for (const d of recent) {
        const o = Math.log(d.actual / d.step.planned);
        const tok = net(model.token, d.step.x.concat(net(model.outcome, [o])));
        for (let k = 0; k < ctx.length; k++) ctx[k] += tok[k] / recent.length;
      }
    }
    const z = net(model.predictor, ctx.concat(party.ctx, [has, party.has], step.x));
    const q = net(model.head, z.concat(step.x)).sort((a, b) => a - b);
    return q.map(v => step.planned * Math.exp(v));
  }

  // ---- repeatable random numbers: the same "luck" in every scenario ----
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function normals(seedText, n) {
    let a = hash(seedText) || 1;
    const rand = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 2) {
      const u = Math.max(rand(), 1e-12), v = rand(), r = Math.sqrt(-2 * Math.log(u));
      out[i] = r * Math.cos(2 * Math.PI * v);
      if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
    }
    return out;
  }
  function percentile(sorted, p) {
    const i = (sorted.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  const median = arr => percentile(Float64Array.from(arr).sort(), 50);

  /* Lay the BOM out as an ordered list of steps: children before parents. */
  function plan(c, scenario) {
    const sw = scenario.switch || {}, kids = {};
    c.items.forEach(it => (kids[it.parent] = kids[it.parent] || []).push(it));
    const steps = [], rows = [], lastOf = {};
    (function visit(item, depth) {
      const row = { id: item.id, name: item.name, depth, first: -1, last: -1, party: item.party };
      rows.push(row);
      const waits = (kids[item.id] || []).map(k => (visit(k, depth + 1), lastOf[k.id]));
      const change = sw[item.id];
      const route = change && item.variants[change.party] ? item.variants[change.party] : item.route;
      if (change && item.variants[change.party]) row.party = change.party;
      route.forEach((s, k) => {
        steps.push({ ...s, item: item.id, itemName: item.name,
          preds: k === 0 ? waits : [steps.length - 1],
          notBefore: k === 0 && change ? (change.from_day || 0) : 0 });
        if (k === 0) row.first = steps.length - 1;
      });
      row.last = lastOf[item.id] = steps.length - 1;
    })(kids[null][0], 0);
    return { steps, rows: rows };
  }

  function run(c, model, scenario, opts) {
    scenario = scenario || {};
    const n = (opts && opts.n) || 3000;
    const delays = scenario.delays || {}, doneMap = scenario.done || {};
    const parties = {}; c.parties.forEach(p => parties[p.id] = p);
    const { steps, rows } = plan(c, scenario);
    const Z = model.z_knots, MID = model.mid, HIGH = model.high;
    const S = steps.length;

    // Re-forecast: once a step of an item is reported, later steps of that item update.
    const doneByItem = {};
    steps.forEach(s => {
      const seen = doneByItem[s.item] = doneByItem[s.item] || [];
      if (doneMap[s.id] !== undefined) { s.actual = +doneMap[s.id]; s.q = s.q.map(() => s.actual); seen.push({ step: s, actual: s.actual }); }
      else if (seen.length) { s.q = forecast(model, parties[s.party], s, seen); s.updated = true; }
      s.delay = +delays[s.id] || 0;
    });

    // Sample durations. Steps of one item share some luck (rho), as real orders do.
    const rho = c.rho || 0, a = Math.sqrt(rho), b = Math.sqrt(1 - rho);
    const dur = steps.map(s => {
      const d = new Float64Array(n);
      if (s.actual !== undefined) return d.fill(s.actual + s.delay);
      const own = normals(c.id + '|' + s.id, n), shared = normals(c.id + '|item|' + s.item, n);
      // Draw from the forecast's full shape: straight lines between its quantiles
      // (on a log scale), continued outwards at both ends.
      const L = s.q.map(Math.log), m = Z.length - 1;
      for (let k = 0; k < n; k++) {
        const z = Math.max(-3, Math.min(3, a * shared[k] + b * own[k]));
        let j = 0;
        while (j < m - 1 && z > Z[j + 1]) j++;
        const v = Math.exp(L[j] + (L[j + 1] - L[j]) * (z - Z[j]) / (Z[j + 1] - Z[j]));
        d[k] = s.delay < 0 ? Math.max(0.3 * v, v + s.delay) : v + s.delay;   // expediting has a floor
      }
      return d;
    });

    // Forward pass: a step starts when everything it waits for has finished.
    const start = [], finish = [];
    let planFinish = new Float64Array(S);
    for (let i = 0; i < S; i++) {
      const s = steps[i], st = new Float64Array(n).fill(s.notBefore), fi = new Float64Array(n);
      let p0 = 0;
      for (const p of s.preds) {
        const f = finish[p];
        for (let k = 0; k < n; k++) if (f[k] > st[k]) st[k] = f[k];
        p0 = Math.max(p0, planFinish[p]);
      }
      const d = dur[i];
      for (let k = 0; k < n; k++) fi[k] = st[k] + d[k];
      start.push(st); finish.push(fi);
      planFinish[i] = p0 + s.planned;
    }

    // Which steps decide delivery: walk back from the end along the latest-finishing predecessor.
    const crit = steps.map(() => new Uint8Array(n));
    crit[S - 1].fill(1);
    for (let i = S - 1; i >= 0; i--) {
      const preds = steps[i].preds;
      if (!preds.length) continue;
      for (let k = 0; k < n; k++) {
        if (!crit[i][k]) continue;
        let best = preds[0];
        for (const p of preds) if (finish[p][k] > finish[best][k]) best = p;
        crit[best][k] = 1;
      }
    }
    const share = u8 => { let s = 0; for (let k = 0; k < n; k++) s += u8[k]; return s / n; };

    const end = Float64Array.from(finish[S - 1]).sort();
    steps.forEach((s, i) => { s.s = median(start[i]); s.f = median(finish[i]); s.crit = share(crit[i]);
      // What the step is now expected to take, including any delay or expediting applied to it.
      const adj = v => s.actual !== undefined ? s.actual + s.delay : s.delay < 0 ? Math.max(0.3 * v, v + s.delay) : v + s.delay;
      s.typical = adj(s.q[MID]); s.pessimistic = adj(s.q[HIGH]); });
    rows.forEach(r => {
      r.steps = steps.slice(r.first, r.last + 1);
      r.s = r.steps[0].s; r.f = r.steps[r.steps.length - 1].f;
      r.crit = Math.max(...r.steps.map(s => s.crit));
      r.partyName = (parties[r.party] || {}).name || '';
    });
    return { plan: planFinish[S - 1], p50: percentile(end, 50), p80: percentile(end, 80), p95: percentile(end, 95),
             onPlan: end.filter(v => v <= planFinish[S - 1]).length / n, rows, steps };
  }

  /* The steps that most often decide delivery, longest first among equals. */
  function drivers(result, count) {
    return result.steps.filter(s => s.crit >= 0.05 && s.actual === undefined)
      .sort((x, y) => y.crit * y.typical - x.crit * x.typical).slice(0, count || 5);
  }

  function dateOf(c, day) {
    return new Date(Date.parse(c.start_date + 'T00:00:00Z') + Math.round(day) * 864e5);
  }
  function fmtDate(c, day, withYear) {
    return dateOf(c, day).toLocaleDateString('en-GB',
      { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
  }

  const api = { run, forecast, drivers, fmtDate, dateOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Twin = api;
})(typeof window !== 'undefined' ? window : globalThis);
