import json
from pathlib import Path


def normalized(value):
    return "".join(character for character in value.casefold() if character.isalnum())


CATALOG = json.loads(Path(__file__).with_name("catalog.json").read_text(encoding="utf-8"))
PROFILES = {(normalized(row["make"]), normalized(row["model"])): row for row in CATALOG}
DEFAULT_PROFILE = {"cc": 125, "oil_interval_km": 3000, "service_interval_days": 90, "expected_cost_cop": 60000}


def profile_for(vehicle):
    matched = PROFILES.get((normalized(vehicle.get("make", "")), normalized(vehicle.get("model", ""))))
    if matched:
        return matched, matched["make"] + " " + matched["model"]
    return DEFAULT_PROFILE, None
