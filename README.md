# Dragonwilds Server Kit

A web admin panel and server mod for **RuneScape: Dragonwilds** Linux dedicated servers.

Watch your players on the world map, give items and XP, teleport, summon creatures, and set rules for
your server, all from a browser. The panel speaks English, Portuguese (Brazil) and Spanish.

> **Unofficial.** This project is not affiliated with or endorsed by Jagex. It ships no game files. Read
> [Before you install](#before-you-install).

## Features

**Live map**
- The game's own world map, with every player's position and heading
- Click to teleport a player. Their landing height is found automatically, so they do not fall

**Players**
- Health and stamina at a glance, with ping
- Revive, even after the game has already respawned them
- Restore health and stamina
- Per-player options that stay on across reconnects: unlimited health, stamina, hunger, thirst and
  endurance, and no spell cooldowns
- Grant XP for any skill

**Items and creatures**
- Over 700 items with their in-game icons, with search and categories
- Over 50 creatures to summon near a player, at any level

**Rules**
- Limit how long someone can play alone, so friends do not get ahead of the group. Time alone is a budget:
  reconnecting does not refill it, and it only resets when someone else is online
- Exceptions: players who may stay alone with no limit
- Bans, enforced as players join
- Kicks, and configurable messages shown to players

**Everything else**
- Password login, with attempts limited
- A chronicle of joins, leaves and administrator actions
- Spell animations that respect your system's reduced motion setting

## Before you install

- **This only works on one exact server build.** The module uses fixed memory addresses from
  build `c695030ea461f775` (version 1.0.0.5, Unreal Engine 5.6.1). On any other build it turns itself off
  and the server runs normally, without the kit. After a game update, the addresses must be redone. See
  [Updating after a game patch](docs/INSTALL.md#updating-after-a-game-patch).
- **Jagex's rules may apply to you.** The
  [Community Modding Guidelines](https://legal.jagex.com/docs/policies/runescape-dragonwilds-community-modding-guidelines)
  prohibit cheating in multiplayer and giving unfair advantages in shared spaces. Items, XP and unlimited
  stats may fall under that. Use them only with the agreement of everyone on your server, at your own risk.
- **Tell your players the server is modded.** The kit lives outside the folders the game scans, so the
  game still reports the server as unmodified (`ModDetection` stays `0`).
- **The panel controls your server, and it serves plain HTTP.** Do not expose its port to the internet. Use
  a VPN such as Tailscale, or a tunnel with HTTPS and access control.
- **Game art is not included.** The panel's map and icons are built from your own copy of the game. They
  belong to Jagex, so do not publish them.

## Install

Follow the **[installation guide](docs/INSTALL.md)**. In short, you will:

1. Build the module.
2. Load it into your server with a systemd drop-in.
3. Generate the item catalog from the running server.
4. Extract the map and icons from your game client.
5. Install the panel as a service, and open it through your VPN.

## How it works

```
Browser ──HTTP/SSE──► Node.js panel ◄──Unix socket──► libdwkit.so, inside the game server
                      rules, login, API               loaded with LD_PRELOAD, game thread only
```

| Folder | What it is |
|---|---|
| `mod/` | The native module, in C++. It offers generic reflection over a local socket: find objects, read and write properties, call functions. |
| `panel/` | The web panel, with no npm dependencies. Rules live here, so a bug in them cannot crash the game. |
| `tools/` | Asset extraction, catalog generation, the module simulator, tests and deployment scripts. |
| `docs/` | The installation guide. |

The module hooks the engine tick and handles at most 32 commands per frame, never blocking the game thread.
Anything specific to Dragonwilds, such as giving an item, is written in the panel using the names in the game's
reflection data. That keeps the native code small.

The per-player spell cooldown option watches for spells entering cooldown and calls the game's own
`StartCooldown` to end it. It needs the world setting `Difficulty.Player.SpellCooldownScale` at 1x.

## Development

You need Node.js 18 or later. To build the module you also need Python and Zig: see the
[installation guide](docs/INSTALL.md#2-build-the-module).

Run the rule tests:

```bash
node tools/test-rules.js
```

Run the panel against a simulated module at `http://127.0.0.1:8090`. The login is `admin` /
`dev-only-password`, valid only for that local run:

```bash
node tools/dev-panel.js
```

The simulator has no game art unless you have extracted it to `panel/public/data`.

| Script | What it does |
|---|---|
| `tools/deploy-panel.sh` | Publishes only the panel. Players stay connected. With `--static`, updates only web files and game data, and the panel does not even restart. |
| `tools/deploy.sh` | Builds and publishes everything. Restarts the game and disconnects players. |
| `tools/dwk.js` | Sends one command to the module, for debugging. |
| `tools/live-test.js` | Exercises teleport and revive on the first player online. It changes that character, so use it on a test server only. |

To add a language, add its strings to `panel/public/i18n.js`, and its code to `LANGUAGES` in `tools/extract_names.py`. Names of items, creatures and skills are the game's own translations.

## License

[MIT](LICENSE). This covers this project's code only. RuneScape, Dragonwilds and all game assets belong to Jagex.
