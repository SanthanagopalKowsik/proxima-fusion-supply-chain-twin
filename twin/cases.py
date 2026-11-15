"""The Proxima Fusion case, defined as data for the sector-agnostic engine.

Run:  python -m twin.cases

IMPORTANT: the case is illustrative. The site footprint follows public
information; every supplier is anonymised; all lead times, delays and
performance figures are synthetic. Nothing here is company data.

A value starting with '_' is a hidden truth of the example world (for
instance a supplier that has recently started slipping). The model never
sees it and has to discover it from history.
"""
from .casegen import HISTORY_DAYS, buy, make, party, transit_days, write_case

DISCLAIMER = ("Illustrative case. Site footprint follows public information; suppliers are "
              "anonymised and all durations and performance data are synthetic. Not affiliated "
              "with or endorsed by the company.")
RECENT = HISTORY_DAYS - 210     # day from which a planted supplier problem begins


PROXIMA = {
    "id": "proxima", "company": "Proxima Fusion", "sector": "Fusion energy",
    "title": "HTS stellarator model coil",
    "blurb": "A first-of-a-kind high-temperature superconducting demonstration magnet: long-lead "
             "superconductor tape, precision coil casing, cryostat, power and protection systems, "
             "ending in a cold test campaign.",
    "start_date": "2027-01-11", "disclaimer": DISCLAIMER,
    "qualification_days": 45, "order_sigma": 0.20,
    "parties": [
        party("PRX-SITE", "Proxima Fusion integration hall (Germany)", "domestic", 0, _bias=0.10),
        party("PRX-HTS-A", "HTS tape supplier A (East Asia)", "overseas", 9000, "air", _bias=0.22),
        party("PRX-HTS-B", "HTS tape supplier B (Europe)", "regional", 800, lead_factor=1.15),
        party("PRX-CASE-A", "Coil casing machining supplier A (Germany)", "domestic", 400),
        party("PRX-CASE-B", "Coil casing machining supplier B (Italy)", "regional", 900, lead_factor=1.1),
        party("PRX-CU", "Copper stabiliser and solder supplier (Germany)", "domestic", 300),
        party("PRX-INS", "Insulation materials supplier (Switzerland)", "regional", 500),
        party("PRX-CRYV", "Cryostat vessel fabricator (Central Europe)", "regional", 700),
        party("PRX-CRYC", "Cryocooler supplier (Japan)", "overseas", 9300, "air", _drift=(RECENT, 0.30)),
        party("PRX-SHLD", "Thermal shield supplier (France)", "regional", 800),
        party("PRX-VAC", "Vacuum pump supplier (Germany)", "domestic", 350),
        party("PRX-PSU-A", "Magnet power supply supplier A (Switzerland)", "regional", 450),
        party("PRX-PSU-B", "Magnet power supply supplier B (Germany)", "domestic", 500, lead_factor=1.2),
        party("PRX-CL", "Current lead supplier (United Kingdom)", "regional", 1100),
        party("PRX-QD", "Quench detection electronics supplier (Germany)", "domestic", 200),
        party("PRX-DAQ", "Instrumentation supplier (Germany)", "domestic", 250),
    ],
    "items": [
        make("TEST", "Model coil test campaign", None, "PRX-SITE", [
            ("final integration", 20), ("cooldown", 14), ("cold test", 21), ("acceptance review", 7)]),
        make("COIL", "HTS coil", "TEST", "PRX-SITE", [
            ("coil winding", 40), ("soldering and impregnation", 15), ("instrumentation", 10), ("warm test", 7)]),
        buy("HTS", "HTS tape (REBCO)", "COIL", "superconductor", "PRX-HTS-A", 200, 40, new=True, alts=["PRX-HTS-B"]),
        buy("CASE", "Coil casing and winding former", "COIL", "precision machining", "PRX-CASE-A", 110,
            alts=["PRX-CASE-B"]),
        buy("CU", "Copper stabiliser and solder", "COIL", "metals", "PRX-CU", 30),
        buy("INS", "Insulation materials", "COIL", "materials", "PRX-INS", 25),
        make("CRYO", "Cryostat assembly", "TEST", "PRX-SITE", [("cryostat integration", 15), ("leak test", 6)]),
        buy("CRYV", "Cryostat vessel", "CRYO", "vessels", "PRX-CRYV", 120),
        buy("CRYC", "Cryocoolers", "CRYO", "cryogenics", "PRX-CRYC", 150, 4),
        buy("SHLD", "Thermal shield and insulation", "CRYO", "cryogenics", "PRX-SHLD", 45),
        buy("VAC", "Vacuum pumps", "CRYO", "vacuum", "PRX-VAC", 60, 3),
        buy("PSU", "Magnet power supply", "TEST", "power electronics", "PRX-PSU-A", 130, alts=["PRX-PSU-B"]),
        buy("CL", "Current leads", "TEST", "cryogenics", "PRX-CL", 90, 2, new=True),
        buy("QD", "Quench detection electronics", "TEST", "electronics", "PRX-QD", 75),
        buy("DAQ", "Instrumentation and data acquisition", "TEST", "electronics", "PRX-DAQ", 40),
    ],
    "stages": {
        "coil winding": {"mu": 0.20, "sigma": 0.35, "disrupt_p": 0.12, "disrupt_x": 2.0},
        "soldering and impregnation": {"mu": 0.15, "sigma": 0.30, "disrupt_p": 0.08, "disrupt_x": 2.0},
        "cold test": {"mu": 0.15, "sigma": 0.30, "disrupt_p": 0.15, "disrupt_x": 2.2},
        "cooldown": {"mu": 0.05, "sigma": 0.15},
        "leak test": {"mu": 0.10, "sigma": 0.30, "disrupt_p": 0.15, "disrupt_x": 2.5},
        "production": {"mu": 0.12, "sigma": 0.30, "disrupt_p": 0.06, "disrupt_x": 2.2},
        "supplier qualification": {"mu": 0.25, "sigma": 0.45},
        "order release": {"mu": 0.20, "sigma": 0.50},
    },
    "scenarios": [
        {"name": "HTS tape production slips 8 weeks", "delays": {"HTS:production": 56}},
        {"name": "HTS supplier A fails qualification on day 45; switch to supplier B",
         "switch": {"HTS": {"party": "PRX-HTS-B", "from_day": 45}}},
        {"name": "Cryocooler production slips 6 weeks", "delays": {"CRYC:production": 42}},
        {"name": "Coil winding reported at double the planned time", "done": {"COIL:coil winding": 80}},
    ],
}


# ---------------------------------------------------------------------------
# Product support data (S3000L logistic support analysis and related S-Series).
#
# For each material that is part of the DELIVERED product:
#   integral=True   - built into its parent, not replaceable in service
#   otherwise       - replaceable in service: predicted MTBF (operating hours),
#                     unit price, quantity per product, whether it can be
#                     repaired (and at what cost), and its maintenance tasks.
# Materials not listed are consumed in manufacturing and are outside the
# support breakdown. Every figure is synthetic. "_true" is the hidden ratio of
# real to predicted MTBF, used only to generate in-service feedback.

def task(name, kind, hours, skill, equipment=(), interval_h=None):
    return {"name": name, "kind": kind, "hours": hours, "skill": skill,
            "equipment": list(equipment), "interval_h": interval_h}


PROXIMA["service"] = {
    "what": "One model coil test stand in operation",
    "fleet": 1, "hours_per_year": 3000, "observed_years": 3.0, "fill_target": 0.95, "labour_rate": 110}
PROXIMA["support"] = {
    "TEST": {"integral": True}, "CRYO": {"integral": True},
    "COIL": {"mtbf_h": 80000, "price": 2400000, "per_unit": 1, "repairable": True, "repair_cost": 600000, "tasks": [
        task("Coil electrical and joint resistance check", "preventive", 8, "Magnet engineer", ["Precision ohmmeter", "Data acquisition rack"], 1500),
        task("Replace coil", "corrective", 320, "Magnet engineer", ["Overhead crane", "Coil handling frame"])]},
    "HTS": {"integral": True}, "CASE": {"integral": True}, "CU": {"integral": True}, "INS": {"integral": True},
    "CRYV": {"mtbf_h": 120000, "price": 380000, "per_unit": 1, "repairable": True, "repair_cost": 60000, "tasks": [
        task("Vacuum leak check", "preventive", 6, "Vacuum technician", ["Helium leak detector"], 3000),
        task("Repair vessel seal", "corrective", 24, "Vacuum technician", ["Helium leak detector", "Overhead crane"])]},
    "CRYC": {"mtbf_h": 20000, "price": 95000, "per_unit": 4, "repairable": True, "repair_cost": 22000, "_true": 0.9, "tasks": [
        task("Cold head maintenance", "preventive", 6, "Cryogenics technician", ["Helium charging rig"], 10000),
        task("Replace cryocooler", "corrective", 10, "Cryogenics technician", ["Helium charging rig", "Overhead crane"])]},
    "SHLD": {"integral": True},
    "VAC": {"mtbf_h": 15000, "price": 28000, "per_unit": 3, "repairable": True, "repair_cost": 7000, "_true": 0.5, "tasks": [
        task("Pump bearing and oil service", "preventive", 3, "Vacuum technician", ["Pump service kit"], 8000),
        task("Replace vacuum pump", "corrective", 4, "Vacuum technician", ["Helium leak detector"])]},
    "PSU": {"mtbf_h": 30000, "price": 260000, "per_unit": 1, "repairable": True, "repair_cost": 35000, "tasks": [
        task("Power supply calibration", "preventive", 4, "Power electronics engineer", ["Current calibrator"], 6000),
        task("Replace power module of supply", "corrective", 6, "Power electronics engineer", ["Current calibrator"])]},
    "CL": {"mtbf_h": 60000, "price": 48000, "per_unit": 2, "repairable": False, "tasks": [
        task("Replace current lead", "corrective", 16, "Cryogenics technician", ["Overhead crane", "Helium leak detector"])]},
    "QD": {"mtbf_h": 40000, "price": 32000, "per_unit": 1, "repairable": True, "repair_cost": 6000, "tasks": [
        task("Quench detection functional test", "preventive", 2, "Power electronics engineer", ["Signal simulator"], 1500),
        task("Replace detection board", "corrective", 2, "Power electronics engineer", ["Signal simulator"])]},
    "DAQ": {"mtbf_h": 25000, "price": 54000, "per_unit": 1, "repairable": False, "tasks": [
        task("Replace acquisition module", "corrective", 1.5, "Instrumentation engineer", ["Signal simulator"])]},
}

CASES = [PROXIMA]
SEED = 23      # fixes the example world, so every rebuild gives the same history

if __name__ == "__main__":
    n, truth = write_case(PROXIMA, SEED)
    steps = sum(len(i.get("steps", [])) or 5 + i.get("new", False) for i in PROXIMA["items"])
    print(f"{PROXIMA['company']}: {len(PROXIMA['items'])} items, {steps} steps, {n:,} history rows. "
          f"True delivery day p50/p80/p95: {truth['p50']:.0f} / {truth['p80']:.0f} / {truth['p95']:.0f}")
