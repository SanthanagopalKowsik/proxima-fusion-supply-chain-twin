/* Tests for the twin's browser code. Run from the project folder:  node tests/test_twin.js */
const fs = require('fs'), path = require('path');
const docs = path.join(__dirname, '..', 'docs');
global.window = {};
for (const f of fs.readdirSync(path.join(docs, 'data'))) eval(fs.readFileSync(path.join(docs, 'data', f), 'utf8'));
const Twin = require(path.join(docs, 'engine.js'));
global.Twin = Twin;
const Plan = global.TwinPlan = require(path.join(docs, 'plan.js'));
const S = global.TwinSupport = require(path.join(docs, 'support.js'));
const Chat = require(path.join(docs, 'chat.js'));
const model = window.TWIN_MODEL, c = window.TWIN_CASES.proxima;
let failed = 0;
const check = (name, ok, detail) => { console.log((ok ? '  ok    ' : '  FAIL  ') + name + (detail ? '   ' + detail : '')); if (!ok) failed++; };

console.log('Forecast model and simulator');
{
  // The JEPA forward pass in JavaScript must match the one computed in Python.
  const ref = model.check, item = c.items.find(i => i.id === ref.item), parties = Object.fromEntries(c.parties.map(p => [p.id, p]));
  const done = item.route.filter(s => ref.done[s.id] !== undefined).map(s => ({ step: s, actual: ref.done[s.id] }));
  const target = item.route.find(s => s.id === ref.step);
  const q = Twin.forecast(model, parties[target.party], target, done);
  const worst = Math.max(...q.map((v, i) => Math.abs(v - ref.q[i]) / ref.q[i]));
  check('JEPA forward pass matches Python', worst < 0.002, `largest relative difference ${(worst * 100).toFixed(3)}%`);

  const base = Twin.run(c, model, {});
  console.log(`  planned day ${base.plan.toFixed(0)} | twin p50/p80/p95 ${base.p50.toFixed(0)}/${base.p80.toFixed(0)}/${base.p95.toFixed(0)} | truth ${c.truth.p50}/${c.truth.p80}/${c.truth.p95}`);
  // Tolerance, not a target: suppliers whose behaviour changed in the last months of
  // history cannot be fully known, so some error against the hidden truth is expected.
  const off = k => Math.abs(base[k] - c.truth[k]) / c.truth[k];
  check('likely date within 10% of the hidden truth', off('p50') < 0.10, `${(off('p50') * 100).toFixed(1)}%`);
  check('promise date within 10% of the hidden truth', off('p80') < 0.10, `${(off('p80') * 100).toFixed(1)}%`);
  check('repeatable', Twin.run(c, model, {}).p80 === base.p80);
  for (const sc of c.scenarios) {
    const r = Twin.run(c, model, sc), delayOnly = sc.delays && !sc.done && !sc.switch;
    const total = delayOnly ? Object.values(sc.delays).reduce((a, b) => a + b, 0) : null, shift = r.p80 - base.p80;
    check(`scenario: ${sc.name}`, isFinite(r.p80) && (!delayOnly || (shift >= -0.01 && shift <= total + 0.01)), `shift ${shift >= 0 ? '+' : ''}${shift.toFixed(1)} days`);
  }
  const d = Twin.drivers(base, 1)[0];
  check('delaying the top gating step moves delivery', Twin.run(c, model, { delays: { [d.id]: 30 } }).p80 > base.p80 + 5, d.id);
}

console.log('\nActions, scenarios and alerts');
{
  const base = Plan.evaluate(c, model, []).p80, step = 'HTS:production';
  const p80 = actions => Plan.evaluate(c, model, actions).p80;
  check('expediting a gating step brings delivery in', p80([{ type: 'ExpediteStep', step, days: 20 }]) < base - 5);
  check('delay and equal expedite cancel out', Math.abs(p80([{ type: 'DelayStep', step, days: 10 }, { type: 'ExpediteStep', step, days: 10 }]) - base) < 0.01);
  let threw = 0;
  for (const bad of [{ type: 'DelayStep', step: 'NOPE:x', days: 3 }, { type: 'DelayStep', step, days: -3 }, { type: 'SwitchSupplier', material: 'CU', party: 'PRX-HTS-B' }, { type: 'Nonsense' }]) {
    try { Plan.validate(c, bad); } catch (e) { threw++; }
  }
  check('invalid actions are rejected', threw === 4);
  const alerts = Plan.alerts(c, model);
  check('alerts are ranked by days at risk', alerts.length > 0 && alerts.every((a, i) => i === 0 || alerts[i - 1].days >= a.days), `${alerts.length} alerts`);
  const options = Plan.playbook(c, model, alerts[0]);
  check('playbook effect equals a fresh simulation', options.length > 0 && options.every(o => Math.abs(o.effect - (p80(o.actions) - base)) < 0.01), `${options.length} options`);
  // The assistant proposes; only an explicit apply changes the plan.
  Plan.reset(c);
  Chat.local(c, model, 'What if HTS tape production slips 8 weeks?');
  const st = Plan.state(c);
  check('a what-if goes to the working scenario, not the plan', st.plan.length === 0 && st.draft.length === 1 && st.draft[0].days === 56);
  Chat.local(c, model, 'apply');
  check('typing apply commits it and logs the decision', st.plan.length === 1 && st.draft.length === 0 && st.log.length === 1 && st.log[0].effect > 30, `effect ${st.log[0].effect.toFixed(1)} days`);
  const tool = Chat.runTool(c, model, 'propose_actions', { actions: [{ type: 'ExpediteStep', step_id: step, material_id: null, party_id: null, days: 5, from_day: null }] });
  check('the agent tool proposes without applying', st.plan.length === 1 && st.draft.length === 1 && /Not applied/.test(tool.status));
  Plan.reset(c);
  check('assistant describes a named material', /Cryocoolers/.test(Chat.local(c, model, 'tell me about the cryocoolers').text));
}

console.log('\nProduct support (S-Series)');
{
  check('spares stock meets its target', (() => { const { s, short } = S.poissonStock(3.2, 0.95); return short <= 0.05 && s >= 5 && s <= 7; })());
  check('no field data keeps the prediction', S.feedback(1000, null).used === 1000);
  check('a handful of failures is not treated as evidence', S.feedback(20000, { hours: 36000, failures: 4 }).verdict === 'Too few events to judge');
  check('many more failures than expected is flagged', S.feedback(4e6, { hours: 1.6e8, failures: 78 }).verdict === 'Worse than predicted');
  const a = S.analyse(c, model, []);
  check('support analysis is well formed', a.candidates.length > 0 && a.ao > 0.5 && a.ao <= 1 && a.candidates.every(r => r.spares >= 0 && r.turnaround > 0 && isFinite(r.value)),
    `${a.candidates.length} candidates, ${a.spares} spares, availability ${(a.ao * 100).toFixed(2)}%`);
  check('every material has a lot and the genealogy covers the product', c.items.every(i => i.lot) && S.genealogy(c, c.items.find(i => !i.parent).id).length === c.items.length);
  // The bridge between the two halves: a slower supplier must not make support look better.
  const pick = r => r.candidates.find(x => x.id === 'CL'), slow = S.analyse(c, model, [{ type: 'DelayStep', step: 'CL:production', days: 240 }]);
  check('a supplier delay lengthens resupply; spares and downtime do not improve',
    pick(slow).turnaround > pick(a).turnaround + 200 && pick(slow).spares >= pick(a).spares && slow.ao <= a.ao + 1e-9,
    `${Math.round(pick(a).turnaround)} -> ${Math.round(pick(slow).turnaround)} days, ${pick(a).spares} -> ${pick(slow).spares} spares`);
  check('assistant answers a spares question', /spares/.test(Chat.local(c, model, 'How many spares do we need?').text));
  check('assistant traces a lot', /lot LP/.test(Chat.local(c, model, 'trace the HTS coil').text));
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
