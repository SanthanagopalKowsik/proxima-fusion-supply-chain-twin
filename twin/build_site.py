"""Package the trained model and the cases for the static website.

Run:  python -m twin.build_site

Writes docs/data/proxima.js and docs/data/model.js. They are plain script
files (not JSON fetched over the network) so the site also works when opened
straight from disk.
"""
import json
import math

import numpy as np
import torch

from .casegen import CASES_DIR, HISTORY_DAYS, ROOT
from .ontology import schema
from .standards import registry
from .jepa import HIGH, MID, N_ORDER, N_PARTY, Z_KNOTS, build_tensors, context, load_model, load_rows, numeric

SITE = ROOT / "docs" / "data"
RECENT_DAYS = 180


def r(x, nd=4):
    return [round(float(v), nd) for v in x]


def layers(seq):
    """Weights of a two-layer network, as plain lists."""
    return {"w1": [r(row) for row in seq[0].weight.tolist()], "b1": r(seq[0].bias.tolist()),
            "w2": [r(row) for row in seq[2].weight.tolist()], "b2": r(seq[2].bias.tolist())}


@torch.no_grad()
def describe(model, vocab, case_id, step):
    row = dict(step, case=case_id)
    return model.describe(torch.tensor([vocab.ids(row)]), torch.tensor([numeric(row)]))[0]


@torch.no_grad()
def export_case(case, rows, model, vocab, metrics):
    cid = case["id"]
    rows = sorted([x for x in rows if x["case"] == cid], key=lambda x: x["day"])
    T = build_tensors(rows, vocab)
    cat, num, y = T[0], T[1], T[2]
    ids = torch.arange(1, len(rows) + 1)

    # Surprise per finished step: distance between predicted and actual outcome embedding.
    desc, c_o, has_o, c_p, has_p = context(model, T, ids)
    surprise = (model.predict(desc, c_o, has_o, c_p, has_p) - model.target(y[ids, None])).pow(2).mean(dim=1).numpy()
    logy = y[1:].numpy()            # log(actual / planned) per step
    end = np.array([x["day"] + x["actual_days"] for x in rows])
    own = np.array([x["stage"] != "transit" for x in rows])          # transit is the carrier's doing

    parties = []
    for p in case["parties"]:
        mine = np.array([x["party"] == p["id"] for x in rows]) & own
        recent = mine & (end > HISTORY_DAYS - RECENT_DAYS)
        older = mine & ~recent
        # The party's latest finished steps, pooled: the context the browser starts from.
        last = [i + 1 for i in np.argsort(end) if rows[i]["party"] == p["id"]][-N_PARTY:]
        if last:
            idx = torch.tensor([last])
            ctx, has = model.pool(model.describe(cat[idx], num[idx]), y[idx], torch.ones(1, len(last)))
        else:
            ctx, has = torch.zeros(1, 32), torch.zeros(1, 1)
        stats = {"steps": int(mine.sum())}
        if recent.sum() >= 8 and older.sum() >= 20:
            # Typical (median) overrun, which a few disrupted orders cannot distort.
            a, b = logy[older], logy[recent]
            change = float(np.median(b) - np.median(a))
            noise = 1.25 * math.sqrt(a.var() / len(a) + b.var() / len(b))   # standard error of that change
            stats.update(slip_before=float(np.exp(np.median(a)) - 1), slip_recent=float(np.exp(np.median(b)) - 1),
                         surprise=float(surprise[recent].mean() / surprise[older].mean()))
            real = abs(change) > 0.12 and abs(change) > 3 * noise            # large and not explained by chance
            stats["status"] = "Stable" if not real else "Worsening" if change > 0 else "Improving"
        parties.append({"id": p["id"], "name": p["name"], "region": p["region"],
                        "ctx": r(ctx[0]), "has": float(has[0, 0]), **stats})
    party_ctx = {p["id"]: (torch.tensor([p["ctx"]]), torch.tensor([[p["has"]]])) for p in parties}

    def export_route(steps):
        out = []
        for s in steps:
            d = describe(model, vocab, cid, s)[None]
            c_p, has_p = party_ctx[s["party"]]
            z = model.predict(d, torch.zeros(1, 32), torch.zeros(1, 1), c_p, has_p)
            q = s["planned_days"] * torch.exp(model.quantiles(z, d))[0]
            out.append({"id": s["id"], "stage": s["stage"], "party": s["party"], "doc": s["doc"],
                        "planned": s["planned_days"], "x": r(d[0]), "q": r(q, 2)})
        return out

    items = [{"id": i["id"], "name": i["name"], "parent": i["parent"], "kind": i["kind"],
              "party": i["party"], "category": i["category"], "qty": i["qty"], "order": i["order"], "support": i.get("support"),
              "lot": i["lot"], "standards": i["standards"], "route": export_route(i["route"]),
              "variants": {a: export_route(v) for a, v in i["variants"].items()}} for i in case["items"]]

    # The recent steps that lost the most days against plan, for the dashboard.
    names = {p["id"]: p["name"] for p in case["parties"]}
    lost = np.array([x["actual_days"] - x["planned_days"] for x in rows])
    recent_ids = [i for i in np.argsort(-lost) if end[i] > HISTORY_DAYS - RECENT_DAYS][:5]
    alerts = [{"stage": rows[i]["stage"], "party": names[rows[i]["party"]],
               "planned": rows[i]["planned_days"], "actual": rows[i]["actual_days"],
               "days_ago": int(HISTORY_DAYS - end[i])} for i in recent_ids]

    return {**{k: case[k] for k in ("id", "company", "sector", "title", "blurb", "start_date",
                                    "disclaimer", "scenarios", "truth", "service", "feedback")},
            "parties": parties, "items": items, "alerts": alerts, "rho": metrics["rho"],
            "history": {"steps": len(rows), "orders": len({x["order"] for x in rows})}}


@torch.no_grad()
def reference_check(model, exported):
    """A worked re-forecast computed here in Python, so the browser engine can be tested against it."""
    case = exported[0]
    item = next(i for i in case["items"] if len(i["route"]) >= 4 and i["kind"] == "make")
    party_ctx = {p["id"]: p for p in case["parties"]}
    done = {item["route"][0]["id"]: item["route"][0]["planned"] * 1.6,
            item["route"][1]["id"]: item["route"][1]["planned"] * 1.4}
    toks = []
    for s in item["route"][:2]:
        o = torch.tensor([[math.log(done[s["id"]] / s["planned"])]])
        toks.append(model.token(torch.cat([torch.tensor([s["x"]]), model.outcome(o)], dim=1)))
    c_o = torch.stack(toks).mean(dim=0)
    target = item["route"][2]
    p = party_ctx[target["party"]]
    d = torch.tensor([target["x"]])
    z = model.predict(d, c_o, torch.ones(1, 1), torch.tensor([p["ctx"]]), torch.tensor([[p["has"]]]))
    q = target["planned"] * torch.exp(model.quantiles(z, d))[0]
    return {"case": case["id"], "item": item["id"], "done": done, "step": target["id"], "q": r(q, 3)}


def main():
    model, vocab, ckpt = load_model()
    rows = load_rows()
    SITE.mkdir(parents=True, exist_ok=True)
    exported = []
    for d in sorted(p for p in CASES_DIR.iterdir() if (p / "case.json").exists()):
        case = json.loads((d / "case.json").read_text())
        data = export_case(case, rows, model, vocab, ckpt["metrics"])
        exported.append(data)
        (SITE / f"{case['id']}.js").write_text(
            "window.TWIN_CASES = window.TWIN_CASES || {};\n"
            f"window.TWIN_CASES[{json.dumps(case['id'])}] = {json.dumps(data, separators=(',', ':'))};\n",
            encoding="utf-8")
        flagged = [p["name"] for p in data["parties"] if p.get("status") == "Worsening"]
        print(f"{case['company']:15s} {len(data['items'])} items  flagged as worsening: {flagged or 'none'}")
    payload = {"dim": 32, "n_order": N_ORDER, "z_knots": r(Z_KNOTS), "mid": MID, "high": HIGH, "outcome": layers(model.outcome), "token": layers(model.token),
               "predictor": layers(model.predictor), "head": layers(model.head),
               "metrics": ckpt["metrics"], "schema": schema(), "standards": registry(), "check": reference_check(model, exported)}
    (SITE / "model.js").write_text(f"window.TWIN_MODEL = {json.dumps(payload, separators=(',', ':'))};\n",
                                   encoding="utf-8")
    size = sum(f.stat().st_size for f in SITE.glob("*.js")) / 1024
    print(f"Wrote {SITE}  ({size:.0f} KB in total)")


if __name__ == "__main__":
    main()
