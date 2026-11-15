"""Standards the support side of the twin is organised around.

The S-Series (ASD/AIA) specifications for Integrated Product Support, formerly
Integrated Logistics Support (ILS), describe how a delivered product is kept
working. The twin follows the roles they describe.

Honest limits. The roles below follow the publisher's public descriptions of
each specification. The twin does not implement their data models or exchange
formats, and nothing here claims conformance to any standard.
"""

S_SERIES = {
    "SX000i": {"name": "Guide for the use of the S-Series IPS specifications",
               "role": "The overall framework, including support system effectiveness.",
               "here": "Support page headline: operational availability of the supported product."},
    "S3000L": {"name": "Logistic support analysis (LSA)",
               "role": "Product breakdown, LSA candidate selection, analysis activities, maintenance task analysis.",
               "here": "Product breakdown with candidate selection, repair policy and maintenance tasks."},
    "S2000M": {"name": "Material management",
               "role": "Provisioning, spare parts lists, and supply from pricing and ordering to repair orders.",
               "here": "Initial provisioning: recommended spares, sized by the twin's own resupply lead times."},
    "S5000F": {"name": "In-service data feedback",
               "role": "Reliability, maintenance and safety data returned from operation.",
               "here": "Observed failures update predicted reliability and re-size spares."},
    "S4000P": {"name": "Preventive maintenance",
               "role": "Developing and improving scheduled maintenance.",
               "here": "Scheduled tasks and their intervals in the maintenance task analysis."},
    "S6000T": {"name": "Training analysis and design",
               "role": "Deriving training needs from the tasks people must perform.",
               "here": "Skills and annual hours derived from maintenance tasks."},
    "S1000D": {"name": "Technical publications",
               "role": "Producing and exchanging technical documentation.",
               "here": "Count of maintenance procedures that need to be written."},
}


def applicable(case, item):
    """Specifications relevant to one material: [{family, code, name, why}]."""
    support = case.get("support", {}).get(item["id"])
    if not support:
        return []
    if "mtbf_h" not in support:
        return [{"family": "S-Series", "code": "S3000L", "name": S_SERIES["S3000L"]["name"],
                 "why": "In the product breakdown, but not an LSA candidate: integral to its parent."}]
    codes = ["S3000L", "S2000M", "S5000F", "S6000T", "S1000D"]
    if any(t["kind"] == "preventive" for t in support["tasks"]):
        codes.insert(3, "S4000P")
    return [{"family": "S-Series", "code": c, "name": S_SERIES[c]["name"], "why": S_SERIES[c]["here"]} for c in codes]


def lot_for(item):
    """A synthetic lot identifier for the order that procures or produces a material."""
    return ("LP" if item["kind"] == "buy" else "LM") + item["order"]["number"][-5:]


def registry():
    return {"s_series": S_SERIES,
            "note": ("Roles follow the publisher's public descriptions of each specification. The twin does not "
                     "implement their data models or exchange formats, and nothing here claims conformance.")}
