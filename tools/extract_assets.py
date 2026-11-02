"""Extracts panel images from the game client's container into panel/public/data.

    python -I tools/extract_assets.py <client Paks folder>/RSDragonwilds-Windows <catalog.json> <output dir>

Reads the map, the icons named in catalog.json, the creature emblems and the UI art listed below. These images belong to
Jagex: they are built locally from the user's own copy of the game, and must not be committed or shared.
"""
import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", ".tools", "py"))

import texture2ddecoder  # noqa: E402
from PIL import Image  # noqa: E402

from iostore import IoStore  # noqa: E402

CONTENT = "../../../RSDragonwilds/Content/"
BLOCK_BYTES = {"PF_DXT1": 8, "PF_DXT5": 16, "PF_BC4": 8, "PF_BC5": 16, "PF_BC7": 16}
DECODERS = {
    "PF_DXT1": texture2ddecoder.decode_bc1,
    "PF_DXT5": texture2ddecoder.decode_bc3,
    "PF_BC4": texture2ddecoder.decode_bc4,
    "PF_BC5": texture2ddecoder.decode_bc5,
    "PF_BC7": texture2ddecoder.decode_bc7,
}
FORMAT = re.compile(rb"PF_[A-Za-z0-9_]+\x00")
# After the format string: 12 bytes of bulk data header, then the largest mip.
MIP_HEADER = 12


# The game has no portraits of its creatures, so each one is shown with a related icon from the game.
# First match wins, tested against the enemy's asset name.
EMBLEMS = [
    (r"Velgar", "T_Icon_Velgar_Head"),
    (r"Spectral", "T_Icon_Spectral_Noggin"),
    (r"Imaru|Rotsworn", "T_Icon_Imaru_Head_Resized"),
    (r"Goblin", "T_Icon_Resources_Goblin_Pack"),
    (r"Dragon", "T_Icon_RedDragonhide"),
    (r"Wolf", "T_Icon_Dire_Wolf_Skin"),
    (r"Chicken", "T_Icon_ZombieChicken"),
    (r"Cow", "T_Icon_Dire_Wolf_Leather_NEW"),
    (r"Ram", "T_Icon_Resources_Large_Animal_Horn"),
    (r"Deer", "T_Icons_Resource_Antlers"),
    (r"Sheep", "T_Icon_Resource_Ball_Of_Wool"),
    (r"Rat", "T_Icon_Rat_roast"),
    (r"Kebbit", "T_NavIcons_Kebbit_Tunnel"),
    (r"Chinchompa", "T_Icon_Spectral_Chinchompa_Skull"),
    (r"Falcon|Magpie|Raven", "T_Icon_Resource_Feathers"),
    (r"Witherbeast", "T_Icon_WitherBeast_Heart"),
    (r"Terrorbird", "T_Icon_SM_Terro_bird_02_05"),
    (r"Vine", "T_Icon_Resources_Vine"),
    (r"Ent_", "T_Icon_Resources_Vine"),
    (r"Abyssal", "T_Icon_Resource_Abyssal_Spine"),
    (r"Miniboss", "T_Icon_Resource_Vault_Shard"),
    (r"Guardian", "T_Icon_Resource_Vault_Core"),
    (r"Beast", "T_Icon_WitherHeart"),
    (r"Dummy", "T_Icon_Crrate"),
]

UI_ART = {
    "logo": ("Art/UI/Logo_Dragonwilds/Game_Logo_Dragonwilds", 720),
    "keyart": ("Art/UI/MainMenu/SplashScreen/T_KeyArt_PressStart", 2048),
    "slot": ("Art/UI/Common/T_Common_ItemSlotsBackground", 128),
    "slot-highlight": ("Art/UI/Common/T_Common_ItemSlotsHighlight", 144),
    "banner": ("Art/UI/Craft/T_DeathShop_Banner", 1152),
    "title-graphic": ("Art/UI/Craft/RuneCrafting/T_Title_Graphic", 1000),
    "title-bg": ("Art/UI/Craft/T_Craft_TitleBackground", 824),
    "flourish-top": ("Art/UI/Notifications/FinalBoss/T_SW_Top_Flourish_Checkpoint", 328),
    "flourish-low": ("Art/UI/Notifications/FinalBoss/T_SW_Lower_Flourish_Kuldra", 188),
    "sigil": ("Art/UI/AI/T_Boss_Bg", 472),
    "rune-circle": ("Art/UI/Map/T_Map_Radial_Background", 524),
    "reticle": ("Art/UI/Map/T_Map_Reticle", 160),
    "arrow": ("Art/UI/NavIcons/T_Map_Icon_FriendArrow_1", 80),
    "dot": ("Art/UI/NavIcons/T_Map_Icon_FriendDot", 80),
    "skill-frame": ("Art/UI/Common/T_ToolTip_Bg", 484),
}


def texture_finder(store):
    """Finds a texture by file name: DLC content lives in plugin folders, outside /Game/."""
    index = {}
    for path in store.files:
        if path.endswith(".uasset"):
            index[path.rsplit("/", 1)[1][:-len(".uasset")].lower()] = path[:-len(".uasset")]

    def find(game_path_or_name):
        name = game_path_or_name.rsplit("/", 1)[-1].split(".")[0].lower()
        return index[name]

    return find


def mip_size(fmt, w, h):
    return ((w + 3) // 4) * ((h + 3) // 4) * BLOCK_BYTES[fmt]


def load_texture(store, path):
    """Returns the largest mip of a texture as an RGBA image."""
    data = store.read_file(path + ".uasset")
    header, = struct.unpack_from("<I", data, 4)
    match = FORMAT.search(data, header)
    if not match:
        raise ValueError("no pixel format")
    fmt = match.group()[:-1].decode()
    if fmt not in DECODERS:
        raise ValueError(f"unsupported format {fmt}")
    w, h = struct.unpack_from("<II", data, match.start() - 16)
    size = mip_size(fmt, w, h)
    start = match.end() + MIP_HEADER
    if start + size <= len(data):
        pixels = data[start:start + size]
    elif path + ".ubulk" in store.files:
        bulk = store.read_file(path + ".ubulk")
        pixels = bulk[:size]
        if len(pixels) != size:
            raise ValueError(f"short bulk data for {w}x{h} {fmt}")
    else:
        raise ValueError(f"no pixel data for {w}x{h} {fmt}")
    # The decoder returns BGRA.
    return Image.frombytes("RGBA", (w, h), DECODERS[fmt](pixels, w, h), "raw", "BGRA")


def save(image, path, max_size=None, quality=88):
    if max_size and max(image.size) > max_size:
        image = image.copy()
        image.thumbnail((max_size, max_size), Image.LANCZOS)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image.save(path, "WEBP", quality=quality, method=6)


def main():
    base, catalog_path, out = sys.argv[1:4]
    store = IoStore(base)
    find = texture_finder(store)
    with open(catalog_path, encoding="utf8") as f:
        catalog = json.load(f)

    done, failed = 0, []
    for group, folder, size in (("items", "icons/items", 128), ("skills", "icons/skills", 96)):
        for entry in catalog.get(group, []):
            icon = entry.get("iconPath")
            if not icon or "None" in icon:
                continue
            try:
                save(load_texture(store, find(icon)), os.path.join(out, folder, entry["id"] + ".webp"), size)
                done += 1
            except (KeyError, ValueError) as e:
                failed.append(f"{entry['id']}: {e}")
    print(f"icons: {done} written, {len(failed)} failed")
    for line in failed[:20]:
        print(" ", line)

    written = 0
    for enemy in catalog.get("enemies", []):
        for pattern, icon in EMBLEMS:
            if re.search(pattern, enemy["id"]):
                save(load_texture(store, find(icon)), os.path.join(out, "icons/enemies", enemy["id"] + ".webp"), 192)
                written += 1
                break
        else:
            print("  no emblem for", enemy["id"])
    print(f"emblems: {written}")

    for name, (path, size) in UI_ART.items():
        save(load_texture(store, CONTENT + path), os.path.join(out, "ui", name + ".webp"), size, 90)
    print(f"ui art: {len(UI_ART)}")

    save(load_texture(store, CONTENT + "Art/UI/Map/T_WorldMap_Landmass"), os.path.join(out, "map.webp"), 4096, 82)
    print("map written")


if __name__ == "__main__":
    main()
