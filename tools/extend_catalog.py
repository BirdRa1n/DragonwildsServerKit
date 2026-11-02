"""Adds the items and creatures missing from catalog.json by reading the game client, without the server.

    python -I tools/extend_catalog.py <client Paks folder>/RSDragonwilds-Windows <catalog.json>

tools/gen-catalog.js is more exact, but it loads every asset into the server, which causes hitches. Use this
one to complete a catalog while people are playing. Entries already in the catalog are kept as they are.
Run extract_assets.py and extract_names.py afterwards.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from iostore import IoStore  # noqa: E402
from locres import Pak, read_locres  # noqa: E402

LOCRES_EN = "../../../RSDragonwilds/Content/Localization/Game/en/Game.locres"
ITEM_TABLES = ("ST_ItemNames", "ST_Localization")
AI_TABLES = ("ST_AI_Names",)
# Assets kept by the developers but not meant to be used.
UNUSED = re.compile(r"/Deprecated/|/Deleted/|_OLD$|_Test$|^ITEM_Test|TEST_", re.I)
FSTRING = re.compile(rb"[\x02-\x7f]\x00\x00\x00[\x20-\x7e]{1,120}\x00")
ICON = re.compile(rb"T_[A-Za-z0-9_+]*", re.I)
NOT_ITEM_ICON = re.compile(r"Buff|Journal|NavIcons|Map_|Notification|Tag_|HUD|Reticle", re.I)
# How much of an asset's start holds its name table, where texture references are.
HEADER_BYTES = 8000


def strings_in(data):
    """Short strings stored in an asset: 4-byte length with terminator, text, terminator."""
    out = []
    for match in FSTRING.finditer(data):
        raw = match.group()
        if raw[0] == len(raw) - 4:
            out.append(raw[4:-1].decode())
    return out


def game_path(file_path, name):
    """Maps a container path to the path the game loads it by. Expansions mount under their own name."""
    path = file_path[:-len(".uasset")]
    plugin = re.search(r"/Plugins/GameFeatures/([^/]+)/Content/(.+)$", path)
    if plugin:
        return f"/{plugin.group(1)}/{plugin.group(2)}.{name}"
    content = re.search(r"/RSDragonwilds/Content/(.+)$", path)
    return f"/Game/{content.group(1)}.{name}" if content else None


def humanize(name, prefix):
    name = re.sub(prefix, "", name)
    name = re.sub(r"_Character$", "", name).replace("_", " ")
    return re.sub(r"([a-z])([A-Z])", r"\1 \2", name).strip()


def find_icon(data, textures):
    """Names in an asset's name table run together, so match the longest name of a real texture."""
    best = None
    for match in ICON.finditer(data[:HEADER_BYTES]):
        text = match.group().decode()
        for end in range(len(text), 3, -1):
            candidate = text[:end]
            if candidate.lower() in textures:
                if not NOT_ITEM_ICON.search(candidate) and (best is None or len(candidate) > len(best)):
                    best = candidate
                break
    return best


def item_kind(path, name):
    """The catalog's item kinds, inferred from where the asset lives. The panel's categories use them."""
    if "/Equipment/" in path:
        if "/Ammo/" in path:
            return "RangedAmmoData"
        if "/Jewellery/" in path:
            return "TrinketItemData"
        return "HeldEquipmentData" if "/Held/" in path else "WearableEquipmentData"
    if "/Tomes/" in path or "Tome" in name:
        return "BP_Consumables_SkillTome_C"
    if "/Potion" in path or "Potion" in name:
        return "BP_Consumables_Potion_C"
    if "Seed" in name:
        return "SeedHeldEquipmentData"
    if "/Consumables/" in path or "Consumable" in name:
        return "BP_Consumables_Drink_C" if "Drink" in path else "BP_Consumables_Food_C"
    return "ItemData"


def main():
    base, catalog_path = sys.argv[1:3]
    with open(catalog_path, encoding="utf8") as f:
        catalog = json.load(f)
    store = IoStore(base)
    en = read_locres(Pak(base + ".pak").read(LOCRES_EN))
    files = {p.rsplit("/", 1)[1][:-len(".uasset")]: p for p in store.files if p.endswith(".uasset")}
    textures = {name.lower() for name in files if name.lower().startswith("t_")}

    def lookup(tables):
        keys = {}
        for (namespace, key), text in en.items():
            if namespace.startswith(tables):
                keys.setdefault(key, text)
                if namespace.startswith(tables[0]):
                    keys[key] = text
        return keys

    item_keys = lookup(ITEM_TABLES)
    known = {i["id"] for i in catalog["items"]}
    added_items = named_items = with_icon = 0
    for name, path in sorted(files.items()):
        if not name.startswith("ITEM_") or "MeshData" in name or name in known or UNUSED.search(path) or UNUSED.search(name):
            continue
        target = game_path(path, name)
        if not target:
            continue
        data = store.read_file(path)
        names = [item_keys[s] for s in strings_in(data) if s in item_keys]
        icon = find_icon(data, textures)
        named_items += bool(names)
        with_icon += bool(icon)
        added_items += 1
        catalog["items"].append({
            "path": target,
            "id": name,
            "name": max(names, key=len) if names else humanize(name, r"^ITEM_"),
            "kind": item_kind(path, name),
            "stack": 1,
            "iconPath": icon,
            "group": path.split("/")[-2],
        })

    ai_keys = lookup(AI_TABLES)
    known = {e["id"] for e in catalog["enemies"]}
    added_enemies = named_enemies = 0
    for name, path in sorted(files.items()):
        if not (name.startswith("BP_AI_") and name.endswith("_Character")) or name in known or UNUSED.search(path):
            continue
        target = game_path(path, name)
        if not target:
            continue
        stem = name[len("BP_AI_"):-len("_Character")]
        display = ai_keys.get(stem)
        data_path = files.get(name.replace("_Character", "_Data"))
        if not display and data_path:
            found = [s for s in strings_in(store.read_file(data_path)) if s in ai_keys]
            display = ai_keys[max(found, key=len)] if found else None
        named_enemies += bool(display)
        added_enemies += 1
        catalog["enemies"].append({"path": f"{target}_C", "id": name, "name": display or humanize(name, r"^BP_AI_"), "group": path.split("/")[-2]})

    catalog["items"].sort(key=lambda i: i["name"])
    catalog["enemies"].sort(key=lambda e: e["name"])
    with open(catalog_path, "w", encoding="utf8") as f:
        json.dump(catalog, f, ensure_ascii=False, separators=(",", ":"))
    print(f"items: {added_items} added ({named_items} with the game's name, {with_icon} with an icon), {len(catalog['items'])} total")
    print(f"creatures: {added_enemies} added ({named_enemies} with the game's name), {len(catalog['enemies'])} total")


if __name__ == "__main__":
    main()
