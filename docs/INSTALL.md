# Installation guide

This guide installs the Dragonwilds Server Kit on a Linux dedicated server, from nothing to a working panel.
Allow about 30 minutes.

**Contents**

1. [Check the requirements](#1-check-the-requirements)
2. [Build the module](#2-build-the-module)
3. [Back up your world](#3-back-up-your-world)
4. [Install the module](#4-install-the-module)
5. [Generate the item catalog](#5-generate-the-item-catalog)
6. [Extract the map and icons](#6-extract-the-map-and-icons)
7. [Install the panel](#7-install-the-panel)
8. [Reach the panel safely](#8-reach-the-panel-safely)
9. [First steps in the panel](#9-first-steps-in-the-panel)

Then: [Advertising a different address](#advertising-a-different-address) ·
[Troubleshooting](#troubleshooting) · [Updating the kit](#updating-the-kit) ·
[Updating after a game patch](#updating-after-a-game-patch) · [Uninstall](#uninstall)

## What you need

| Where | What |
|---|---|
| **Server** | The Dragonwilds Linux dedicated server, run by systemd, with root access. Node.js 18 or later. |
| **Your computer** | Windows or Linux, with Git, Python 3 and SSH. A copy of the game client, for the map and icons. |

The examples assume this layout. If yours is different, change the paths as you go:

| What | Path or name |
|---|---|
| Server installation | `/opt/dragonwilds-server` |
| Server service | `dragonwilds` |
| Service user | `dragonwilds` |
| Kit folder (you will create it) | `/opt/dragonwilds-kit` |

Commands marked **on the server** run there as root. The others run on your computer, from the repository folder.

> The steps that restart the game disconnect everyone. Check that nobody is playing, or warn them first.

## 1. Check the requirements

**On the server**, read the build ID of your server:

```bash
readelf -n /opt/dragonwilds-server/RSDragonwilds/Binaries/Linux/RSDragonwildsServer-Linux-Shipping | grep "Build ID"
```

It must be `c695030ea461f775`. If it is different, the module cannot run on it: see
[Updating after a game patch](#updating-after-a-game-patch).

Check Node.js, **on the server**:

```bash
node --version
```

On Debian or Ubuntu, you can install it with `apt install nodejs` if it is missing.

Your client and server must also be on the same game version, as always. Do not update the server while you
use this kit, unless you are ready to redo the addresses.

## 2. Build the module

The repository does not include a compiled module, so you build your own.

Get the code:

```bash
git clone https://github.com/BirdRa1n/DragonwildsServerKit.git
```

```bash
cd DragonwildsServerKit
```

Install the Zig compiler into the repository's `.tools` folder. This needs no administrator rights, and it
is what lets Windows build a Linux library:

```bash
python -m pip install --target .tools/zig ziglang
```

Build it. On Windows, use Git Bash:

```bash
sh mod/scripts/build.sh
```

You should now have `mod/build/libdwkit.so`.

## 3. Back up your world

The kit does not edit your save file directly, but its actions change your world. Take a backup you can
return to.

**On the server**:

```bash
systemctl stop dragonwilds
```

```bash
mkdir -p /opt/dragonwilds-backups
```

```bash
tar --exclude=Logs -czf /opt/dragonwilds-backups/saved-before-kit.tar.gz -C /opt/dragonwilds-server/RSDragonwilds Saved
```

Leave the server stopped for the next step. The archive contains `DedicatedServer.ini`, which holds your
server's passwords, so keep it private.

## 4. Install the module

Copy the module to the server. Replace `your-server` with its address:

```bash
ssh root@your-server "mkdir -p /opt/dragonwilds-kit/panel/data"
```

```bash
scp mod/build/libdwkit.so tools/dwk.js tools/gen-catalog.js root@your-server:/opt/dragonwilds-kit/
```

**On the server**, give it to the service user:

```bash
chown -R dragonwilds:dragonwilds /opt/dragonwilds-kit
```

**On the server**, create the file `/etc/systemd/system/dragonwilds.service.d/dwkit.conf`:

```bash
mkdir -p /etc/systemd/system/dragonwilds.service.d
```

```bash
cat > /etc/systemd/system/dragonwilds.service.d/dwkit.conf <<'EOF'
[Service]
Environment=LD_PRELOAD=/opt/dragonwilds-kit/libdwkit.so
Environment=DWKIT_DIR=/opt/dragonwilds-kit
EOF
```

Start the server, **on the server**:

```bash
systemctl daemon-reload
```

```bash
systemctl start dragonwilds
```

The server takes about 15 seconds to be ready. Check the module's log:

```bash
cat /opt/dragonwilds-kit/kit.log
```

A good log ends like this:

```
tick hook installed in 2 slot(s)
first tick: engine=DomGameEngine objects=...
listening on /opt/dragonwilds-kit/kit.sock
```

Confirm that the module answers:

```bash
runuser -u dragonwilds -- node /opt/dragonwilds-kit/dwk.js /opt/dragonwilds-kit/kit.sock snapshot
```

You should see something like `{"world": "L_World", "fps": 29.9, "players": []}`.

If the log says `unexpected server build`, your server is on another build. The module turned itself off and
your server is running normally.

## 5. Generate the item catalog

The panel's lists of items, creatures and skills are read from your running server. This loads about 1,000
assets, which uses some memory and can cause small hitches, so do it when nobody is playing. It takes
around 3 minutes.

**On the server**:

```bash
runuser -u dragonwilds -- node /opt/dragonwilds-kit/gen-catalog.js /opt/dragonwilds-kit/kit.sock /opt/dragonwilds-server/Manifest_UFSFiles_Linux.txt /opt/dragonwilds-kit/catalog.json
```

It finishes with a line like `items=724/1008 enemies=58 skills=15`.

Download the catalog to your computer, where the next step needs it:

```bash
mkdir -p panel/public/data
```

```bash
scp root@your-server:/opt/dragonwilds-kit/catalog.json panel/public/data/catalog.json
```

## 6. Extract the map and icons

The dedicated server has no textures, so the map and icons come from your game client.

Install the two image libraries the extractor uses:

```bash
python -m pip install --target .tools/py pillow texture2ddecoder
```

Run it. Point it at the client's `Content/Paks` folder, ending with the container name and no extension:

```bash
python -I tools/extract_assets.py "C:/Games/RuneScape Dragonwilds/RSDragonwilds/Content/Paks/RSDragonwilds-Windows" panel/public/data/catalog.json panel/public/data
```

Steam usually installs the game under `steamapps/common`. It takes about a minute, and ends with:

```
icons: 736 written, 2 failed
emblems: 58
ui art: 15
map written
```

A few failed icons are normal: those items just show an empty slot.

The extractor reads uncompressed, unencrypted containers. If it says `container is compressed or encrypted`,
your client's files are packaged differently, and the panel will work without images until the reader is
extended. Everything else still works.

These images belong to Jagex. They stay in `panel/public/data`, which Git ignores. Do not publish them.

The game has no portraits of its creatures, so each one is shown with a related icon from the game, chosen in
`EMBLEMS` in `tools/extract_assets.py`.

## 7. Install the panel

Copy the panel to the server:

```bash
tar -czf panel.tgz -C panel server.js src public
```

```bash
scp panel.tgz root@your-server:/tmp/
```

**On the server**, unpack it:

```bash
tar -xzf /tmp/panel.tgz -C /opt/dragonwilds-kit/panel && rm /tmp/panel.tgz
```

```bash
chown -R dragonwilds:dragonwilds /opt/dragonwilds-kit
```

**On the server**, create the panel's configuration. Replace `100.64.0.1` with the address the panel should
listen on: your server's VPN address, for example. `host` can be one address or a list:

```bash
cat > /opt/dragonwilds-kit/panel/config.json <<'EOF'
{
  "host": ["100.64.0.1"],
  "port": 8090,
  "socket": "/opt/dragonwilds-kit/kit.sock",
  "users": []
}
EOF
```

Create your login **on the server**. Only a hash of the password is stored, but it shows on screen as you type:

```bash
cd /opt/dragonwilds-kit/panel && node -e "
const fs = require('fs');
const { hashPassword } = require('./src/auth');
const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
rl.question('New admin password: ', (pw) => {
  const c = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  c.users = [{ name: 'admin', ...hashPassword(pw) }];
  fs.writeFileSync('config.json', JSON.stringify(c, null, 2), { mode: 0o600 });
  rl.close();
});"
```


```bash
chown dragonwilds:dragonwilds /opt/dragonwilds-kit/panel/config.json
```

**On the server**, create the service:

```bash
cat > /etc/systemd/system/dwkit-panel.service <<'EOF'
[Unit]
Description=Dragonwilds Server Kit panel
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=dragonwilds
Group=dragonwilds
WorkingDirectory=/opt/dragonwilds-kit/panel
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
```

```bash
systemctl daemon-reload
```

```bash
systemctl enable --now dwkit-panel
```

Check it, **on the server**:

```bash
journalctl -u dwkit-panel -n 5 --no-pager
```

You should see `Panel at http://100.64.0.1:8090`. Now open that address in your browser.

## 8. Reach the panel safely

The panel can change your world and kick your players, and it serves plain HTTP with no encryption. **Never
forward its port to the internet.** Choose one of these:

**A VPN (recommended).** With [Tailscale](https://tailscale.com) or WireGuard, put the server's VPN address in
`host`. Only devices on your VPN can reach the panel.

**A tunnel with access control.** With Cloudflare Tunnel or similar:

1. Add the server's local address to `host`, for example `["100.64.0.1", "192.168.1.50"]`.
2. Point the tunnel at `http://192.168.1.50:8090`, with the type set to HTTP. The tunnel adds the HTTPS.
3. Protect the hostname with an access policy, such as Cloudflare Access limited to your email address.
4. Add the address the tunnel connects from to `config.json`, then restart the panel:

```json
"trustedProxies": ["192.168.1.2"]
```

Without step 4, every visitor seems to come from the same address, and 8 wrong passwords lock everyone out for 5 minutes.

After changing `config.json`, **on the server**:

```bash
systemctl restart dwkit-panel
```

Restarting the panel does not disconnect players. It only logs out whoever is using the panel.

## 9. First steps in the panel

1. **Pick your language** at the top right. The panel remembers it.
2. **Join the game** with a character. It appears under **Map**, on the world map and in the list.
3. **Open the Rules tab** and set the limit for playing alone, if you want one. It starts off.
4. **Set the messages players see**, also in the Rules tab. They start in English, and players see them
   whatever language the panel is in. Change them to your group's language.
5. **Add exceptions.** Players appear in the list after they join once.

Per-player options work while the panel is running. If it stops, players return to normal play, and the
options apply again when it returns. Bans also depend on the panel running.

## Advertising a different address

By default, the session advertises your server's public IP, and players need your router to forward the game's
ports. If they reach you some other way, such as a relay or a VPN, tell the session which address to advertise.

Add this line to `dwkit.conf`:

```
Environment=DWKIT_HOST_ADDRESS=203.0.113.10:7777
```

**On the server**:

```bash
systemctl daemon-reload
```

```bash
systemctl restart dragonwilds
```

Check that it was accepted:

```bash
journalctl -u dragonwilds --since "-3min" --no-pager | grep "session host address"
```

You should see `result 0`. Players join with the code or the server list as usual.

The address must forward UDP to your server. The game port (`7777`) is required. Forward the world settings
port (`8888`) too: the game client may use it.

## Troubleshooting

**`kit.log` does not exist.** The module did not load. Check that `dwkit.conf` is in place, run
`systemctl daemon-reload` and restart the server. Confirm the service user can read `/opt/dragonwilds-kit`.

**`unexpected server build` in `kit.log`.** Your server was updated. See
[Updating after a game patch](#updating-after-a-game-patch).

**The panel says the server is offline.** Check `kit.sock` exists in `/opt/dragonwilds-kit` and `socket` in
`config.json` points to it. The socket is created on the first tick after the server starts.

**The panel does not open.**
- Check `host` in `config.json` includes the address you are opening.
- Use `http://`, not `https://`.
- Run `ss -tln | grep 8090` on the server to see where it is listening.

**A tunnel returns 502.** The tunnel cannot reach the panel. Check the type is HTTP, and try `curl` from
the machine running the tunnel.

**Items or the map are missing.** Repeat steps [5](#5-generate-the-item-catalog) and
[6](#6-extract-the-map-and-icons), then step 7 to copy them. Reload with Ctrl+F5.

**An option has no effect on a player.** Reload the panel and log in again: restarting the panel ends sessions.

**Players time out when joining.** The advertised address does not reach your server. See
[Advertising a different address](#advertising-a-different-address).

**The server crashes.** Unreal writes a stack trace to the log. Look for `Unhandled Exception` in
`RSDragonwilds/Saved/Logs/RSDragonwilds.log`. If `libdwkit.so` is in the trace, remove the module with the
steps under [Uninstall](#uninstall), and open an issue with the trace.

**Find a value without the panel.** `tools/dwk.js` sends commands to the module:

```bash
runuser -u dragonwilds -- node /opt/dragonwilds-kit/dwk.js /opt/dragonwilds-kit/kit.sock find SkillData
```

Calling functions by hand can crash the server. An object of the wrong kind, such as a class template, is enough.

## Updating the kit

```bash
git pull
```

**If only the panel changed**, players stay connected:

```bash
DWK_SSH=root@your-server sh tools/deploy-panel.sh
```

**If the module changed**, this restarts the game and disconnects players. Warn them first:

```bash
DWK_SSH=root@your-server sh tools/deploy.sh
```

Set `DWK_SSH_KEY` to the path of your SSH key if you need a specific one. Your settings, in `panel/data`, are kept.

## Updating after a game patch

The module has the addresses of one build written into `mod/src/ue.h`. A patch changes them, so the module turns
itself off until they are redone. Your server keeps running, without the kit. The panel shows it as offline.

**To stay on a working version,** do not update the server. Client and server must match, so this also means
keeping the client on that version.

**To support a new build,** you need some experience with native code. The server ships a symbol file,
`RSDragonwildsServer-Linux-Shipping.sym`, a table of records followed by newline-separated names:

```
u32 count
count × { u64 address, u32 line, u32 file, u32 symbol_offset }
strings
```

Add `0x200000` to each address to get the address in memory. `symbol_offset` counts from the start of the strings.

Then, in `mod/src/ue.h`:

1. Update `kBuildId` and the read-only segment bounds, from `readelf -n` and `readelf -l`.
2. Update each `kAddr...` function address, from the symbols.
3. Update `kAddrGUObjectArray`. It is not a symbol: read it from the `mov $address,%edi` before calls to
   `FUObjectArray::AllocateUObjectIndex`.
4. Check the layout constants against the disassembly of functions such as `UObject::ProcessEvent` and
   `UStruct::FindPropertyByName`.
5. Test on a separate server, because a wrong address crashes the game.

The panel uses names from the game's reflection data. Those can change too, so test each feature afterwards.

## Uninstall

**On the server**:

```bash
systemctl disable --now dwkit-panel
```

```bash
rm /etc/systemd/system/dwkit-panel.service /etc/systemd/system/dragonwilds.service.d/dwkit.conf
```

```bash
systemctl daemon-reload
```

```bash
systemctl restart dragonwilds
```

```bash
rm -rf /opt/dragonwilds-kit
```

Your server is now back to normal. No game files were changed. Items and levels you gave players stay in the
world, so restore your backup from step 3 if you want them gone.
