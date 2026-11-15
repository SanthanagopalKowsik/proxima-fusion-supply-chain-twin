"""The twin's ontology: what exists, how things relate, and what can be done.

Two halves, following the structure Palantir describes for Foundry:
  semantic - object types, their properties, and link types between them;
  kinetic  - action types (changes a person can make) and functions (logic).

The order documents follow SAP's procurement flow: a requirement becomes a
purchase order, production is monitored, goods are received. Every step of an
order carries the document stage it belongs to.

This file is the single definition. The website reads it to label objects,
build the action forms and tell the assistant what it may do.
"""

OBJECT_TYPES = {
    "Project": {"label": "Project", "plural": "Projects",
                "about": "One deliverable with a start date and a delivery forecast.",
                "properties": ["company", "title", "sector", "start date"]},
    "Material": {"label": "Material", "plural": "Materials",
                 "about": "An item in the bill of materials: bought from a supplier or made at a site.",
                 "properties": ["name", "kind (buy or make)", "category", "quantity"]},
    "Party": {"label": "Supplier or site", "plural": "Suppliers and sites",
              "about": "Whoever performs steps: an external supplier or one of the company's own sites.",
              "properties": ["name", "region", "distance", "typical overrun", "trend"]},
    "Order": {"label": "Order", "plural": "Orders",
              "about": "The document that procures or produces one material: a purchase order or a production order.",
              "properties": ["number", "document type", "status"]},
    "Step": {"label": "Step", "plural": "Steps",
             "about": "One stage of an order, with a planned duration and a forecast range.",
             "properties": ["stage", "document stage", "planned days", "typical days", "pessimistic days",
                            "start", "finish", "share of runs deciding delivery"]},
    "Alert": {"label": "Alert", "plural": "Alerts",
              "about": "A rule that fired on the current plan, ranked by days of delivery at risk.",
              "properties": ["rule", "severity", "days at risk", "cause"]},
    "Scenario": {"label": "Scenario", "plural": "Scenarios",
                 "about": "A sandbox copy of the plan with actions applied, compared before anything is committed.",
                 "properties": ["name", "actions", "promise date", "change against plan"]},
}

LINK_TYPES = [
    ("Material", "is a component of", "Material"),
    ("Material", "is supplied by", "Party"),
    ("Material", "can alternatively be supplied by", "Party"),
    ("Order", "procures or produces", "Material"),
    ("Step", "belongs to", "Order"),
    ("Step", "is performed by", "Party"),
    ("Alert", "concerns", "Material or Party"),
    ("Scenario", "applies", "Action"),
]

# kind: a "fact" records something that happened; a "decision" is a choice still open to review.
ACTION_TYPES = {
    "ReportActual": {
        "label": "Report an actual", "kind": "fact",
        "about": "Record that a step finished and how long it took. Later steps of the same order are re-forecast.",
        "params": [{"name": "step", "type": "Step"}, {"name": "days", "type": "number", "label": "Actual duration (days)"}]},
    "DelayStep": {
        "label": "Delay a step", "kind": "decision",
        "about": "Add days to a step, for a known or feared slip.",
        "params": [{"name": "step", "type": "Step"}, {"name": "days", "type": "number", "label": "Extra days"}]},
    "ExpediteStep": {
        "label": "Expedite a step", "kind": "decision",
        "about": "Take days out of a step, for example by overtime or faster freight. A step cannot fall below 30% of its forecast.",
        "params": [{"name": "step", "type": "Step"}, {"name": "days", "type": "number", "label": "Days saved"}]},
    "SwitchSupplier": {
        "label": "Switch supplier", "kind": "decision",
        "about": "Move a bought material to an alternative supplier. The new supplier must be qualified first.",
        "params": [{"name": "material", "type": "Material"}, {"name": "party", "type": "Party", "label": "New supplier"},
                   {"name": "from_day", "type": "number", "label": "From project day"}]},
}

FUNCTIONS = [
    ("Forecast a step", "JEPA model: optimistic to far-tail duration from the party's record and progress so far."),
    ("Simulate the plan", "3,000 runs of the whole project under a set of actions."),
    ("Find gating factors", "The steps that decide delivery, and how often."),
    ("Raise alerts", "Rules over the current plan, ranked by days of delivery at risk."),
    ("Evaluate a playbook option", "The change in promise date if a suggested action were taken."),
    ("Select LSA candidates", "Which elements of the product are analysed for support, and the repair policy for each (S3000L)."),
    ("Size initial spares", "Spares that cover demand during resupply or repair, using the plan's own lead times (S2000M)."),
    ("Update reliability from the field", "Observed failures correct the predicted MTBF, when there are enough to judge (S5000F)."),
    ("Compute availability", "Time lost to repair, to waiting for spares and to scheduled maintenance (SX000i)."),
    ("Trace lot genealogy", "The lots and suppliers behind a material, down the bill of materials."),
]

# Stage of the SAP-style document flow that each kind of step belongs to.
BUY_FLOW = {"supplier qualification": "Source determination", "order release": "Purchase order",
            "production": "Order confirmation", "outgoing inspection": "Order confirmation",
            "transit": "Inbound delivery", "receiving": "Goods receipt"}
MAKE_FLOW = {"transit": "Stock transfer", "receiving": "Goods receipt", "delivery": "Outbound delivery"}


def document_stage(kind, stage):
    if kind == "buy":
        return BUY_FLOW.get(stage, "Order confirmation")
    return MAKE_FLOW.get(stage, "Production order")


def order_for(index, item):
    """A synthetic order document for one material, numbered in SAP's customary ranges."""
    if item["kind"] == "buy":
        return {"number": str(4500000100 + index), "doc_type": "Purchase order"}
    return {"number": str(1000100 + index), "doc_type": "Production order"}


def schema():
    return {"object_types": OBJECT_TYPES,
            "link_types": [{"from": a, "label": b, "to": c} for a, b, c in LINK_TYPES],
            "action_types": ACTION_TYPES,
            "functions": [{"name": a, "about": b} for a, b in FUNCTIONS]}
