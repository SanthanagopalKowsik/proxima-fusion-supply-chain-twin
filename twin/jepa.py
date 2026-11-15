"""A JEPA (joint embedding predictive architecture) for supply chain steps.

Run:  python -m twin.jepa

Idea. A step's outcome (how late it ran) is turned into a vector, an
"embedding", by an encoder. The model is trained to PREDICT that embedding
for a step it has not seen finish, from context:
  - what already happened earlier in the same order, and
  - the recent track record of the party performing the step.
The prediction is made in embedding space, never on raw numbers, and the
target comes from a slowly updated copy of the encoder. That is the JEPA
recipe. No labels are needed for this stage: the history supervises itself.

Three things come out of it:
  1. A forecast head: the predicted embedding is decoded into an optimistic,
     typical and pessimistic duration, plus a far-tail estimate.
  2. Live re-forecasting: report an actual and every later step updates.
  3. A surprise score: how far a real outcome landed from its prediction.
     Rising surprise at a party means its behaviour is changing.

Parties, stages and categories are learned embeddings, so the model is not tied to a sector:
adding a case adds rows of history, not code.
"""
import bisect
import copy
import csv
import math
from statistics import NormalDist
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from .casegen import CASES_DIR, ROOT

CKPT = ROOT / "outputs" / "jepa.pt"
QUANTILES = (0.05, 0.25, 0.5, 0.75, 0.9, 0.97)   # six points describe the whole shape, tail included
MID, HIGH = 2, 4    # positions of the typical (P50) and pessimistic (P90) estimates
Z_KNOTS = [NormalDist().inv_cdf(q) for q in QUANTILES]
DIM = 32            # embedding size
N_ORDER = 8         # earlier steps of the same order used as context
N_PARTY = 12        # most recent completed steps of the same party used as context
N_NUM = 4


def load_rows():
    rows = []
    for d in sorted(p for p in CASES_DIR.iterdir() if (p / "history.csv").exists()):
        with open(d / "history.csv", newline="") as f:
            for r in csv.DictReader(f):
                r["case"] = d.name
                for k in ("seq", "distance_km", "qty", "international"):
                    r[k] = int(r[k])
                for k in ("day", "planned_days", "actual_days"):
                    r[k] = float(r[k])
                rows.append(r)
    # Censoring guard. Recent history holds only steps that already finished, which
    # favours the fast ones. Keep a step only if it started long enough ago that it
    # would be visible even had it run very late (2.5x plan); selection then depends
    # on start date and plan alone, never on the outcome.
    asof = {}
    for r in rows:
        asof[r["case"]] = max(asof.get(r["case"], 0.0), r["day"] + r["actual_days"])
    return [r for r in rows if r["day"] <= asof[r["case"]] - 2.5 * r["planned_days"]]


def numeric(r):
    return [math.log(r["planned_days"]), math.log1p(r["distance_km"] / 1000),
            math.log(max(r["qty"], 1)) / 5, float(r["international"])]


class Vocab:
    """Maps names to integer ids. Id 0 is reserved for anything unseen."""

    def __init__(self, rows=None, state=None):
        self.keys = ("stage", "party", "category", "mode")
        self.maps = state or {k: {v: i + 1 for i, v in enumerate(sorted({r[k] for r in rows}))}
                              for k in self.keys}

    def ids(self, r):
        return [self.maps[k].get(r[k], 0) for k in self.keys]

    def sizes(self):
        return [len(self.maps[k]) + 1 for k in self.keys]


def mlp(n_in, n_hidden, n_out):
    return nn.Sequential(nn.Linear(n_in, n_hidden), nn.GELU(), nn.Linear(n_hidden, n_out))


class JEPA(nn.Module):
    def __init__(self, sizes):
        super().__init__()
        dims = (8, 8, 4, 3)
        self.embeds = nn.ModuleList([nn.Embedding(n, d) for n, d in zip(sizes, dims)])
        self.n_desc = sum(dims) + N_NUM
        self.outcome = mlp(1, 32, DIM)                    # online encoder of an outcome
        self.target = copy.deepcopy(self.outcome)         # slow-moving copy: provides targets
        for p in self.target.parameters():
            p.requires_grad_(False)
        self.token = mlp(self.n_desc + DIM, 64, DIM)      # a finished step, as context
        self.predictor = mlp(2 * DIM + 2 + self.n_desc, 64, DIM)
        self.head = mlp(DIM + self.n_desc, 64, len(QUANTILES))

    def describe(self, cat, num):
        """What is known about a step before it runs: who, what, how far, how long planned."""
        return torch.cat([e(cat[..., i]) for i, e in enumerate(self.embeds)] + [num], dim=-1)

    def pool(self, desc, outcome, mask):
        """Average the context tokens that exist (mask = 1). Returns the mean and a has-any flag."""
        tok = self.token(torch.cat([desc, self.outcome(outcome[..., None])], dim=-1))
        n = mask.sum(dim=1, keepdim=True)
        return (tok * mask[..., None]).sum(dim=1) / n.clamp(min=1), (n > 0).float()

    def predict(self, desc, c_order, has_order, c_party, has_party):
        """Predicted embedding of a step's outcome, given its description and context."""
        return self.predictor(torch.cat([c_order, c_party, has_order, has_party, desc], dim=-1))

    def quantiles(self, z, desc):
        """Decode a predicted embedding into log(actual / planned) at each of QUANTILES."""
        return self.head(torch.cat([z, desc], dim=-1)).sort(dim=-1).values

    @torch.no_grad()
    def update_target(self, momentum=0.99):
        for t, o in zip(self.target.parameters(), self.outcome.parameters()):
            t.mul_(momentum).add_(o.detach(), alpha=1 - momentum)


def build_tensors(rows, vocab):
    """Encode rows and, for every row, find its context rows (index 0 = padding)."""
    n = len(rows)
    cat = torch.tensor([[0, 0, 0, 0]] + [vocab.ids(r) for r in rows])
    num = torch.tensor([[0.0] * N_NUM] + [numeric(r) for r in rows])
    y = torch.tensor([0.0] + [math.log(r["actual_days"] / r["planned_days"]) for r in rows])
    order_ctx = torch.zeros(n + 1, N_ORDER, dtype=torch.long)
    party_ctx = torch.zeros(n + 1, N_PARTY, dtype=torch.long)

    by_order, by_party = {}, {}
    for i, r in enumerate(rows, start=1):
        by_order.setdefault(r["order"], []).append(i)
        by_party.setdefault((r["case"], r["party"]), []).append((r["day"] + r["actual_days"], i))
    for ids in by_order.values():                       # earlier steps of the same order
        ids.sort(key=lambda i: rows[i - 1]["seq"])
        for k, i in enumerate(ids):
            prev = ids[max(0, k - N_ORDER):k]
            order_ctx[i, :len(prev)] = torch.tensor(prev)
    for done in by_party.values():                      # the party's latest finished steps
        done.sort()
    for i, r in enumerate(rows, start=1):
        done = by_party[(r["case"], r["party"])]
        k = bisect.bisect_right(done, (r["day"], n + 1))    # finished before this step started
        prev = [j for _, j in done[max(0, k - N_PARTY):k] if rows[j - 1]["order"] != r["order"]]
        party_ctx[i, :len(prev)] = torch.tensor(prev, dtype=torch.long)
    return cat, num, y, order_ctx, party_ctx


def context(model, T, idx, drop_order=None):
    """Description and pooled context for the rows in idx."""
    cat, num, y, order_ctx, party_ctx = T
    desc = model.describe(cat[idx], num[idx])
    o, p = order_ctx[idx], party_ctx[idx]
    o_mask = (o > 0).float()
    if drop_order is not None:
        o_mask = o_mask * drop_order[:, None]
    c_o, has_o = model.pool(model.describe(cat[o], num[o]), y[o], o_mask)
    c_p, has_p = model.pool(model.describe(cat[p], num[p]), y[p], (p > 0).float())
    return desc, c_o, has_o, c_p, has_p


def pinball(pred, target):
    q = torch.tensor(QUANTILES)
    err = target[:, None] - pred
    return torch.maximum(q * err, (q - 1) * err).mean()


def spread_penalty(z):
    """Keep every embedding dimension informative (prevents the encoder collapsing to a constant)."""
    z = z - z.mean(dim=0)
    std = torch.sqrt(z.var(dim=0) + 1e-4)
    cov = (z.T @ z) / (len(z) - 1)
    off_diag = cov - torch.diag(torch.diag(cov))
    return torch.relu(1 - std).mean() + 0.04 * off_diag.pow(2).sum() / DIM


def load_model(path=CKPT):
    ckpt = torch.load(path)
    vocab = Vocab(state=ckpt["vocab"])
    model = JEPA(vocab.sizes())
    model.load_state_dict(ckpt["state"])
    return model.eval(), vocab, ckpt


def main():
    torch.manual_seed(0)
    rows = load_rows()
    rows.sort(key=lambda r: r["day"])
    vocab = Vocab(rows)
    T = build_tensors(rows, vocab)
    y = T[2]
    n = len(rows)
    # Chronological split by step start: learn from the past, judge on the most recent 15%.
    ids = torch.arange(1, n + 1)
    train, val, test = ids[:int(0.7 * n)], ids[int(0.7 * n):int(0.85 * n)], ids[int(0.85 * n):]
    model = JEPA(vocab.sizes())
    print(f"{n:,} steps from {len({r['case'] for r in rows})} cases | "
          f"{sum(p.numel() for p in model.parameters() if p.requires_grad):,} parameters")

    # ---- Stage 1: self-supervised JEPA pretraining (no forecasting loss at all) ----
    pre = [p for name, p in model.named_parameters() if p.requires_grad and not name.startswith("head")]
    opt = torch.optim.AdamW(pre, lr=2e-3, weight_decay=1e-4)
    epochs = 30
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    for epoch in range(1, epochs + 1):
        model.train()
        total = 0.0
        for idx in train[torch.randperm(len(train))].split(256):
            # Often hide the order's own history, so the model also learns the "not started yet" case.
            keep = (torch.rand(len(idx)) > 0.35).float()
            desc, c_o, has_o, c_p, has_p = context(model, T, idx, keep)
            z_pred = model.predict(desc, c_o, has_o, c_p, has_p)
            with torch.no_grad():
                z_true = model.target(y[idx, None])
            loss = (z_pred - z_true).pow(2).mean() + spread_penalty(model.outcome(y[idx, None]))
            opt.zero_grad(); loss.backward(); opt.step()
            model.update_target()
            total += loss.item() * len(idx)
        sched.step()
        if epoch % 10 == 0:
            with torch.no_grad():
                spread = model.target(y[val, None]).std(dim=0).mean().item()
            print(f"pretrain epoch {epoch:2d}  loss {total / len(train):.4f}  embedding spread {spread:.2f}")

    # ---- Stage 2: forecast head, with gentle fine-tuning of the pretrained JEPA ----
    opt = torch.optim.AdamW([{"params": model.head.parameters(), "lr": 2e-3},
                             {"params": pre, "lr": 3e-4}], weight_decay=1e-4)
    best, best_state = float("inf"), None

    def forecast(idx, with_order=True):
        keep = None if with_order else torch.zeros(len(idx))
        desc, c_o, has_o, c_p, has_p = context(model, T, idx, keep)
        return model.quantiles(model.predict(desc, c_o, has_o, c_p, has_p), desc)

    for epoch in range(1, 21):
        model.train()
        for idx in train[torch.randperm(len(train))].split(256):
            keep = (torch.rand(len(idx)) > 0.35).float()
            desc, c_o, has_o, c_p, has_p = context(model, T, idx, keep)
            loss = pinball(model.quantiles(model.predict(desc, c_o, has_o, c_p, has_p), desc), y[idx])
            opt.zero_grad(); loss.backward(); opt.step()
        model.eval()
        with torch.no_grad():
            v = pinball(forecast(val), y[val]).item()
        if v < best:
            best, best_state = v, copy.deepcopy(model.state_dict())
    model.load_state_dict(best_state)
    model.eval()

    # ---- Reference model: same inputs but no context and no JEPA ----
    plain_embeds = nn.ModuleList([nn.Embedding(s, d) for s, d in zip(vocab.sizes(), (8, 8, 4, 3))])
    plain_net = mlp(model.n_desc, 64, len(QUANTILES))
    plain = lambda idx: plain_net(torch.cat(
        [e(T[0][idx][:, i]) for i, e in enumerate(plain_embeds)] + [T[1][idx]], dim=1)).sort(dim=1).values
    opt = torch.optim.AdamW(list(plain_embeds.parameters()) + list(plain_net.parameters()), lr=2e-3)
    for epoch in range(30):
        for idx in train[torch.randperm(len(train))].split(256):
            loss = pinball(plain(idx), y[idx])
            opt.zero_grad(); loss.backward(); opt.step()

    # ---- Honest test on the most recent steps ----
    with torch.no_grad():
        planned = torch.tensor([r["planned_days"] for r in rows])[test - 1]
        actual = torch.tensor([r["actual_days"] for r in rows])[test - 1]
        to_days = lambda logq: planned[:, None] * torch.exp(logq)
        q_ctx, q_prior, q_plain = to_days(forecast(test)), to_days(forecast(test, False)), to_days(plain(test))
        stage_med = {}
        for i in train.tolist():
            stage_med.setdefault(rows[i - 1]["stage"], []).append(y[i].item())
        by_stage = planned * torch.exp(torch.tensor(
            [float(np.median(stage_med.get(rows[i - 1]["stage"], [0.0]))) for i in test.tolist()]))
        mae = lambda p: (p - actual).abs().mean().item()
        below = lambda q, k: (actual <= q[:, k]).float().mean().item()
        metrics = {
            "mae_planned": mae(planned), "mae_stage_median": mae(by_stage), "mae_plain": mae(q_plain[:, MID]),
            "mae_jepa_prior": mae(q_prior[:, MID]), "mae_jepa": mae(q_ctx[:, MID]),
            "below_p50": below(q_ctx, MID), "below_p90": below(q_ctx, HIGH), "below_p97": below(q_ctx, 5),
            "n_test": len(test),
        }
        # Leftover correlation between steps of one order when nothing is known yet:
        # the simulator needs it so that bad orders are bad throughout.
        q = forecast(val, False).numpy()
        z = [float(np.interp(yi, qi, Z_KNOTS)) for yi, qi in zip(y[val].tolist(), q)]   # where each outcome fell
        groups = {}
        for i, zi in zip(val.tolist(), z):
            groups.setdefault(rows[i - 1]["order"], []).append(zi)
        pairs = [(a[i], a[j]) for a in groups.values() for i in range(len(a)) for j in range(i + 1, len(a))]
        rho = float(np.corrcoef(np.array(pairs).T)[0, 1])
        metrics["rho"] = max(0.0, rho)

    print("\nTEST on the most recent 15% of steps: average error in days per step")
    print(f"  schedule as planned                       {metrics['mae_planned']:.2f}")
    print(f"  planned x typical slip per stage          {metrics['mae_stage_median']:.2f}")
    print(f"  plain network, no context                 {metrics['mae_plain']:.2f}")
    print(f"  JEPA, party track record only             {metrics['mae_jepa_prior']:.2f}")
    print(f"  JEPA, plus progress within the order      {metrics['mae_jepa']:.2f}")
    print(f"  actuals at or below the typical estimate  {metrics['below_p50']:.1%}  (ideal 50%)")
    print(f"  actuals at or below the pessimistic one   {metrics['below_p90']:.1%}  (ideal 90%)")
    print(f"  actuals at or below the far-tail one      {metrics['below_p97']:.1%}  (ideal 97%)")
    print(f"  within-order correlation left over        {metrics['rho']:.2f}")
    CKPT.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state": model.state_dict(), "vocab": vocab.maps, "metrics": metrics}, CKPT)
    print(f"Saved {CKPT}")


if __name__ == "__main__":
    main()
