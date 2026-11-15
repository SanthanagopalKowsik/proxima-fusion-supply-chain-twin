# Supply chain twin: an HTS stellarator model coil

A digital twin of the supply chain for a first-of-a-kind superconducting
magnet. It answers two questions:

1. **When will it be delivered?** It forecasts how long every step really
   takes, simulates the whole project, and re-forecasts when something slips.
2. **Once delivered, can it be kept working?** It sizes spares, estimates
   availability and learns from failures in service.

> **This is an illustrative portfolio project.** It is modelled on the kind of
> programme Proxima Fusion has described publicly: a high-temperature
> superconducting (HTS) demonstration coil for a stellarator. I have no
> company data. Every supplier is anonymised, and every lead time, delay,
> price, reliability figure and field failure is synthetic. The project is not
> affiliated with or endorsed by Proxima Fusion.

## See it

The site is in `docs/` and needs no server: open `docs/index.html`, or enable
GitHub Pages on the `docs` folder.

| Page | What it is for |
|---|---|
| Control tower | The date that is safe to promise, and alerts ranked by days of delivery at risk. Each alert opens to its cause and a playbook of options with their effect on the date. |
| Explorer | One page per material, supplier or site: its order, document flow, lot genealogy, linked objects, and the actions you can take on it. |
| Scenarios | Try actions on a copy of the plan, compare scenarios side by side, then apply one. Nothing changes the plan until you apply it. |
| Support | Which parts of the product are analysed for support, repair policy, spares to hold, availability, people, equipment and procedures. |
| Assistant | Ask in words. It reads objects, runs the simulator and proposes actions; you approve them. |
| Model | The ontology, the standards followed, and how far to trust the numbers. |

The assistant is a built-in engine that runs in the browser. Under Settings
you can add your own Anthropic API key; Claude then answers in free
conversation with three tools: query objects, simulate, and propose actions.
That path is written to the current API but has not been run, because no key
was available.

## The case

A model coil test campaign with 15 materials and 72 steps, starting
11 January 2027: HTS tape, coil casing, copper and insulation into the coil;
a cryostat with cryocoolers, thermal shield and vacuum pumps; a magnet power
supply, current leads, quench detection and instrumentation.

| | Day | |
|---|---|---|
| Schedule as quoted by suppliers | 391 | |
| Likely delivery (50%) | 546 | |
| Safe to promise (80%) | 668 | 277 days later than the quotes |
| Bad case (95%) | 825 | |

What decides the date is the HTS tape: a new supplier to qualify, then about
260 days of production against 200 quoted.

| Setback | Effect on the promise date |
|---|---|
| HTS tape production slips 8 weeks | +53 days |
| HTS supplier fails qualification on day 45, switch to the alternative | +62 days |
| Coil winding takes twice as long as planned | +24 days |
| Cryocooler production slips 6 weeks | +2 days: it has slack |

In service, the test stand reaches 97.7% availability with three spares.
Current leads need a spare because a replacement takes about 220 days to
obtain; cryocoolers need one because repair takes about 10 weeks; vacuum pumps
need one because three are installed and they fail most often.

## How it works

### What the machine learning model is for

The model has one narrow job: **predict how long a single step will really
take.** A step is something like "HTS tape production at supplier A", quoted
at 200 days.

- **Input:** who performs the step, what kind of step it is, the quoted
  duration, that party's recent track record, and what has already happened
  earlier in the same order.
- **Output:** a range of durations, from optimistic through typical to a
  far-tail bad case. For the HTS tape it says about 263 days typical and 445
  in a bad case.

Everything else is built on those ranges. The model does not produce the
delivery date, the alerts or the spares. Ordinary calculation does that, with
the model's predictions as its raw material.

The model is a JEPA (joint embedding predictive architecture). An encoder
turns a step's outcome (how late it ran) into a vector. The model learns to
predict that vector for a step that has not finished, from its context.
Prediction happens in vector space, against a slowly updated copy of the
encoder. A small head decodes the result into six points of the duration
distribution. In practice this buys one thing a simpler model cannot do: when
you report that a step ran late, the later steps of that order are
re-forecast.

It is written from scratch in PyTorch and has about 20,000 parameters. It is
in the repository in three forms:

| What | Where |
|---|---|
| Training code | `twin/jepa.py` |
| Trained PyTorch checkpoint | `outputs/jepa.pt` |
| The same weights, exported for the browser | `docs/data/model.js` |

The synthetic history it was trained on is in
`data/cases/proxima/history.csv`. Rebuilding from the checkpoint reproduces
the browser weights exactly.

### The layers, bottom to top

| Layer | What it does | Where |
|---|---|---|
| 1. Data | The case: suppliers, bill of materials, each order's steps, and four years of synthetic step history | `twin/cases.py`, `twin/casegen.py`, `data/` |
| 2. Ontology | The definitions everything shares: object types, links, the four action types, the list of functions | `twin/ontology.py` |
| 3. ML model | Learns step durations from the history | `twin/jepa.py`, `outputs/jepa.pt` |
| 4. Standards | The S-Series registry and which specification applies to each material | `twin/standards.py` |
| 5. Export | Packs the trained weights and the case into files a browser can load | `twin/build_site.py`, `docs/data/` |
| 6. Simulator | Plays the project forward 3,000 times using the model's ranges; finds the dates and which steps decide them | `docs/engine.js` |
| 7. Decisions | Actions (delay, expedite, switch supplier, report an actual), scenarios, alerts and their playbooks | `docs/plan.js` |
| 8. Support | Spares, availability, field feedback and lot tracing | `docs/support.js` |
| 9. Assistant | Turns a typed question into queries, simulations and proposed actions | `docs/chat.js` |
| 10. Pages | The six screens | `docs/index.html`, `docs/app.js`, `docs/style.css` |

Nothing in layers 1 to 3 or 5 to 7 is specific to fusion. A case is data, and
stage names are free text, so another sector means another case file.

### Back end and front end

**The back end is Python, and it only runs at build time.** Four commands
generate the case, train the model, export and test (see Rebuild). The result
is a set of static files. Python is never running while someone uses the site.

**The front end is plain HTML, CSS and JavaScript,** with no framework and no
build step.

**There is no server.** That has consequences:

- The model's forward pass is rewritten in JavaScript, so the browser itself
  re-forecasts and simulates. A test checks that the JavaScript and Python
  versions agree.
- The site can be hosted for free on GitHub Pages and also works opened
  straight from disk.
- The plan and the decision log are saved in the visitor's own browser, not in
  a database. Nothing is shared between visitors.
- The model cannot retrain from the site. New data means rerunning the Python
  build.

### How a request flows

Take the question "what if HTS tape production slips 8 weeks?":

1. The assistant recognises the material, the step and the 56 days, and builds
   a delay action.
2. The action goes into a working scenario, not the plan.
3. The simulator reruns the 3,000 project runs with that delay.
4. The page shows the promise date moving by 53 days.
5. Nothing is committed until you press Apply. Then it enters the plan and the
   decision log.

### Where the structure comes from

The arrangement follows concepts that Palantir, SAP and the S-Series publish.
No software from any of them is used, and no conformance is claimed.

| Idea | Documented by | Here |
|---|---|---|
| Objects, links, actions and functions as one model | Palantir Foundry Ontology | `twin/ontology.py` |
| One page per object with its links | Palantir Object Views | Explorer |
| A sandbox of actions, compared and then applied | Palantir Ontology scenarios | Scenarios |
| An agent that proposes and a person who approves | Palantir AIP | Assistant |
| Requirement to purchase order to goods receipt | SAP procurement process | Document flow on each material |
| Alerts ranked by impact, with cause and playbook | SAP Supply Chain Control Tower | Control tower |
| Logistic support analysis | S3000L | Product breakdown, repair policy, maintenance tasks |
| Provisioning | S2000M | Recommended spares |
| In-service feedback | S5000F | Field failures correct predicted reliability |
| Support system effectiveness | SX000i | Availability |

## Measured results, and their limits

Step forecasts, on the most recent 15% of history (average error in days):

| Method | Error |
|---|---|
| Schedule as quoted | 4.15 |
| Quote times typical slip per stage | 3.68 |
| Plain network, no context | 3.52 |
| JEPA with party record and order progress | 3.48 |

86% of real durations fell at or below the pessimistic estimate (ideal 90%).
Against the example world's hidden truth, the likely delivery date is 4.5%
early and the promise date 3.6% early.

Read these honestly:

- **The JEPA's accuracy gain over a plain network is small.** Its value here
  is re-forecasting from reported progress, which the plain network cannot do.
- **Everything is measured on synthetic data that I generated.** It shows the
  method works and is roughly calibrated. It says nothing about real
  performance at any company.
- **Planted problems are only partly found.** I hid a deteriorating cryocooler
  supplier in the history and the twin flags it. I also hid vacuum pumps that
  fail twice as often as predicted; with four failures on record the twin
  declines to conclude anything, which is the right call but means the problem
  goes unreported.
- **Supply is modelled on time only.** Expediting and switching suppliers look
  free; cost, capacity and whether a supplier can actually expedite are absent.
- **Support is simplified.** Spares are sized item by item at one stock point,
  and repair policy is a cost threshold, not a full level of repair analysis.

## Rebuild

Needs Python with NumPy and PyTorch. Node is only needed for the tests. About
a minute in total.

```bash
python -m twin.cases
```

```bash
python -m twin.jepa
```

```bash
python -m twin.build_site
```

```bash
node tests/test_twin.js
```

## Using real data

Write `data/cases/<id>/history.csv` with one row per completed step (`order,
seq, day, stage, party, category, mode, distance_km, qty, international,
planned_days, actual_days`), describe the project in `twin/cases.py`, and
rebuild. Purchase order and goods receipt dates from an ERP system usually
provide the history.
