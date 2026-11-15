"""Sector-agnostic case machinery.

A case is plain data:
  parties  - everyone who performs a step: suppliers and the company's own sites
  items    - the bill of materials as a tree; each item has a route (ordered steps)
  stages   - free-text step names; a case may use any vocabulary it likes

Nothing here knows about a particular industry. The SYNTHETIC parts generate
example history, because no real company data is available; with real records
you would write history.csv yourself and skip them.
"""
import csv
import json
from pathlib import Path

import numpy as np

from .ontology import document_stage, order_for
from .standards import applicable, lot_for

ROOT = Path(__file__).resolve().parent.parent
CASES_DIR = ROOT / "data" / "cases"
HISTORY_FIELDS = ["order", "seq", "day", "stage", "party", "category", "mode", "distance_km",
                  "qty", "international", "planned_days", "actual_days"]
HISTORY_DAYS = 1460           # four years of history; the project starts the day after
BUY_STAGES = ["order release", "production", "outgoing inspection", "transit", "receiving"]


def transit_days(mode, km):
    """Planning allowance for moving goods."""
    return {"road": km / 500 + 1, "air": 4.0, "sea": km / 650 + 8}[mode]


# ---------------------------------------------------------------- case builders

def party(id, name, region, km, mode="road", **hidden):
    """A supplier or site. region is relative to whoever receives the goods."""
    return {"id": id, "name": name, "region": region, "distance_km": km, "mode": mode, **hidden}


def buy(id, name, parent, category, party, lead, qty=1, new=False, alts=()):
    return {"id": id, "name": name, "parent": parent, "kind": "buy", "category": category,
            "party": party, "lead": lead, "qty": qty, "new": new, "alts": list(alts)}


def make(id, name, parent, party, steps, category="process", qty=1):
    """steps: (stage, planned_days) or (stage, planned_days, {"party":..., "mode":..., "km":...})."""
    return {"id": id, "name": name, "parent": parent, "kind": "make", "category": category,
            "party": party, "steps": steps, "qty": qty, "alts": []}


def route(case, item, party_id=None, new=None):
    """Expand an item into its ordered steps, optionally at an alternative party."""
    parties = {p["id"]: p for p in case["parties"]}
    out = []

    def step(stage, pid, planned, mode="none", km=0, intl=None):
        p = parties[pid]
        out.append({"id": f"{item['id']}:{stage}", "stage": stage, "party": pid,
                    "doc": document_stage(item["kind"], stage),
                    "category": item["category"], "mode": mode, "distance_km": km,
                    "qty": item["qty"],
                    "international": int(p["region"] != "domestic") if intl is None else intl,
                    "planned_days": round(float(planned), 1)})

    if item["kind"] == "buy":
        pid = party_id or item["party"]
        p = parties[pid]
        if item["new"] if new is None else new:
            step("supplier qualification", pid, case.get("qualification_days", 30))
        step("order release", pid, 3)
        step("production", pid, item["lead"] * p.get("lead_factor", 1.0))
        step("outgoing inspection", pid, 3)
        step("transit", pid, transit_days(p["mode"], p["distance_km"]), p["mode"], p["distance_km"])
        step("receiving", pid, 2)
    else:
        for s in item["steps"]:
            stage, days, extra = (*s, {})[:3]
            pid = extra.get("party", item["party"])
            step(stage, pid, days, extra.get("mode", "none"), extra.get("km", 0), extra.get("intl"))
    return out


# ------------------------------------------------------- SYNTHETIC ground truth

MODE_TRUTH = {"road": (0.05, 0.20, 0.0, 1.0), "air": (0.0, 0.20, 0.0, 1.0), "sea": (0.10, 0.25, 0.06, 1.6)}


class Truth:
    """How long steps really take in the example world. Hidden from the model:
    each party's habitual lateness, its slowly drifting health, the trouble
    shared by all steps of one order, and rare disruptions."""

    def __init__(self, case, seed):
        self.case = case
        self.rng = np.random.default_rng(seed)
        months = HISTORY_DAYS // 30 + 2
        self.latent = {}
        for p in case["parties"]:
            health = np.zeros(months)
            for m in range(1, months):
                health[m] = 0.9 * health[m - 1] + self.rng.normal(0, 0.025)
            self.latent[p["id"]] = {
                "bias": p.get("_bias", float(np.clip(self.rng.normal(0.08, 0.10), -0.05, 0.35))),
                "noise": p.get("_noise", float(self.rng.uniform(0.7, 1.3))),
                "health": health, "drift": p.get("_drift"),   # (from_day, extra log-slip)
            }

    def order_trouble(self):
        return float(self.rng.normal(0, self.case.get("order_sigma", 0.15)))

    def actual(self, s, day, trouble):
        rng, lat = self.rng, self.latent[s["party"]]
        if s["stage"] in ("transit", "delivery"):
            mu, sigma, p, x = MODE_TRUTH[s["mode"]]
            d = s["planned_days"] * np.exp(mu + 0.3 * trouble + rng.normal(0, sigma))
            if rng.random() < p:
                d *= x                                   # port congestion
            if s["international"]:
                d += rng.uniform(1, 6)                   # customs
            return max(float(d), 0.5)
        prof = {"mu": 0.08, "sigma": 0.25, "disrupt_p": 0.0, "disrupt_x": 2.0,
                **self.case["stages"].get(s["stage"], {})}
        log = prof["mu"] + lat["bias"] + lat["health"][min(int(day // 30), len(lat["health"]) - 1)]
        if lat["drift"] and day >= lat["drift"][0]:
            log += lat["drift"][1]
        log += trouble + rng.normal(0, prof["sigma"] * lat["noise"])
        if rng.random() < prof["disrupt_p"]:
            log += np.log(rng.uniform(1.4, prof["disrupt_x"]))
        return max(float(s["planned_days"] * np.exp(log)), 0.5)


def make_history(case, truth, n_orders=2500):
    """Past executions of the case's item routes: one 'order' per execution."""
    rng, rows = truth.rng, []
    for order in range(n_orders):
        item = dict(case["items"][rng.integers(len(case["items"]))])
        item["qty"] = max(1, int(item["qty"] * rng.lognormal(0, 0.5)))
        pid = None
        if item["kind"] == "buy":
            pid = str(rng.choice([item["party"]] + item["alts"]))
        steps = route(case, item, pid, new=bool(rng.random() < 0.15))
        day, trouble = float(rng.uniform(0, HISTORY_DAYS - 60)), truth.order_trouble()
        for seq, s in enumerate(steps):
            actual = truth.actual(s, day, trouble)
            if day + actual > HISTORY_DAYS:      # still running today: its outcome is not known yet
                break
            rows.append([f"{case['id']}-{order}", seq, round(day, 1), s["stage"], s["party"], s["category"],
                         s["mode"], s["distance_km"], s["qty"], s["international"],
                         s["planned_days"], round(actual, 1)])
            day += actual
    return rows


def true_project_end(case, truth, n=3000):
    """Play the real project forward under the hidden truth: the benchmark the twin is judged on."""
    children = {}
    for item in case["items"]:
        children.setdefault(item["parent"], []).append(item)
    routes = {item["id"]: route(case, item) for item in case["items"]}
    ends = np.empty(n)
    for k in range(n):
        def finish(item):
            t = max([finish(c) for c in children.get(item["id"], [])], default=0.0)
            trouble = truth.order_trouble()
            for s in routes[item["id"]]:
                t += truth.actual(s, HISTORY_DAYS, trouble)
            return t
        ends[k] = finish(children[None][0])
    return ends


def write_case(case, seed):
    """Write case.json (public facts only) and history.csv; return the truth benchmark."""
    truth = Truth(case, seed)
    out = CASES_DIR / case["id"]
    out.mkdir(parents=True, exist_ok=True)
    rows = make_history(case, truth)
    with open(out / "history.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(HISTORY_FIELDS)
        w.writerows(rows)
    ends = true_project_end(case, truth)
    public = {k: v for k, v in case.items() if k not in ("stages", "support")}
    # In-service feedback (S5000F): failures observed in the field so far. A separate
    # random stream, so adding support data never changes the supply history above.
    fb_rng, service = np.random.default_rng(seed + 1000), case.get("service", {})
    feedback = {}
    for item_id, sup in case.get("support", {}).items():
        if "mtbf_h" in sup:
            hours = service["fleet"] * service["hours_per_year"] * service["observed_years"] * sup["per_unit"]
            feedback[item_id] = {"hours": hours,
                                 "failures": int(fb_rng.poisson(hours / (sup["mtbf_h"] * sup.get("_true", 1.0))))}
    public["feedback"] = feedback
    public["parties"] = [{k: v for k, v in p.items() if not k.startswith("_")} for p in case["parties"]]
    public["truth"] = {f"p{q}": round(float(np.percentile(ends, q)), 1) for q in (50, 80, 95)}
    for index, item in enumerate(public["items"]):
        item["order"] = order_for(index, item)
        item["lot"] = lot_for(item)
        item["standards"] = applicable(case, item)
        support = case.get("support", {}).get(item["id"])
        item["support"] = None if support is None else {k: v for k, v in support.items() if not k.startswith("_")}
        item["route"] = route(case, item)
        item["variants"] = {a: route(case, item, a, new=True) for a in item["alts"]}
    (out / "case.json").write_text(json.dumps(public, indent=1))
    return len(rows), public["truth"]
