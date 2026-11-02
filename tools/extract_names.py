"""Builds panel/public/data/names.json: item, creature and skill names in each panel language.

    python -I tools/extract_names.py <client Paks folder>/RSDragonwilds-Windows <catalog.json> <output dir>

The names are the game's own translations, read from the client. Like the other extracted data, the
result belongs to Jagex: it is built locally and must not be committed or shared.
"""
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from iostore import IoStore  # noqa: E402
from locres import Pak, read_locres  # noqa: E402

LANGUAGES = ("en", "pt-BR", "es")
LOCRES = "../../../RSDragonwilds/Content/Localization/Game/{}/Game.locres"
ITEM_TABLES = ("ST_ItemNames", "ST_ItemNames_SW", "ST_Localization")
SKILL_TABLES = ("ST_Skills", "ST_Localization")

# Creatures whose data asset points to no name of its own, or to the name of a related creature.
ENEMY_KEYS = {
    "BP_AI_DragonLesserGreen_Blightscale_Character": ("ST_AI_Names_Fellhollow", "DragonGreen_Blightscale"),
    "BP_AI_RotswornMarauderImaru_Character": ("ST_AI_Names_Fellhollow", "SkeletonMelee2hWither"),
    "BP_AI_RotswornNecromancerImaru_Character": ("ST_AI_Names_Fellhollow", "SkeletonWitherMage"),
    "BP_AI_RotswornWarriorImaru_Character": ("ST_AI_Names_Fellhollow", "SkeletonMeleeWithered"),
    "BP_AI_Terrorbird_Witherbeast_Character": ("ST_AI_Names_Fellhollow", "WitherBeast"),
}


def fstring(text):
    """How a short ASCII string is stored in an asset: length with terminator, bytes, terminator."""
    raw = text.encode("ascii", "ignore")
    return struct.pack("<i", len(raw) + 1) + raw + b"\0"


def enemy_key(store, pkg_files, enemy, keys):
    """Finds which name key a creature's data asset refers to, by looking for each key in its bytes."""
    if enemy["id"] in ENEMY_KEYS:
        return ENEMY_KEYS[enemy["id"]]
    package = enemy["path"].split(".")[0].rsplit("/", 1)
    # Some creatures have a key with exactly their own name, which is safer than searching their data.
    stem = package[1].replace("BP_AI_", "").replace("_Character", "")
    exact = [k for k in keys if k[1] == stem]
    if exact:
        return exact[0]
    data_name = package[1].replace("_Character", "_Data")
    # Plugin content is mounted outside /Game/, so look the asset up by file name.
    path = pkg_files.get(data_name.lower())
    if not path:
        return None
    data = store.read_file(path)
    found = [k for k in keys if fstring(k[1]) in data]
    return max(found, key=lambda k: len(k[1])) if found else None


def preferred(candidates, tables, translations):
    """Picks a key for an English text, which can appear in many places.

    Prefers the most specific table, and an entry the game really translated: some copies stay in English.
    """
    def rank(key):
        table = next((i for i, t in enumerate(tables) if key[0].startswith(t)), len(tables))
        return (translations.get(key) == translations_english[key], table)

    translations_english = {key: english for key, english in candidates}
    ordered = sorted(translations_english, key=rank)
    return ordered[0] if ordered else None


def main():
    base, catalog_path, out = sys.argv[1:4]
    with open(catalog_path, encoding="utf8") as f:
        catalog = json.load(f)
    pak = Pak(base + ".pak")
    tables = {lang: read_locres(pak.read(LOCRES.format(lang))) for lang in LANGUAGES}

    by_english = {}
    for key, text in tables["en"].items():
        by_english.setdefault(text, []).append((key, text))

    keys = {}
    for entry in catalog["items"]:
        key = preferred(by_english.get(entry["name"], []), ITEM_TABLES, tables["pt-BR"])
        if key:
            keys[entry["id"]] = key
    for entry in catalog["skills"]:
        key = preferred(by_english.get(entry["name"], []), SKILL_TABLES, tables["pt-BR"])
        if key:
            keys[entry["id"]] = key

    store = IoStore(base)
    pkg_files = {p.rsplit("/", 1)[1][:-len(".uasset")].lower(): p for p in store.files if p.endswith(".uasset")}
    ai_keys = [k for k in tables["en"] if k[0].startswith("ST_AI_Names")]
    missing = []
    for entry in catalog["enemies"]:
        key = enemy_key(store, pkg_files, entry, ai_keys)
        if key:
            keys[entry["id"]] = key
        else:
            missing.append(entry["id"])

    names = {lang: {} for lang in LANGUAGES}
    for entry_id, key in keys.items():
        for lang in LANGUAGES:
            text = tables[lang].get(key)
            if text:
                names[lang][entry_id] = text

    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "names.json"), "w", encoding="utf8") as f:
        json.dump(names, f, ensure_ascii=False, separators=(",", ":"))

    total = len(catalog["items"]) + len(catalog["skills"]) + len(catalog["enemies"])
    print(f"names: {len(keys)} of {total} have translations")
    if missing:
        print(f"creatures without a game name: {', '.join(missing)}")


if __name__ == "__main__":
    main()
