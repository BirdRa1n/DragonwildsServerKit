#!/usr/bin/env node
'use strict';
// Builds the panel catalog from the server's file manifest and the running module:
//   node gen-catalog.js <socket> <Manifest_UFSFiles_Linux.txt> <output.json>
// Items are loaded once to read their display name. Run it against the test instance, because
// loading every item costs memory and hitches on a live server.
const fs = require('fs');
const net = require('net');

const [sock, manifest, output] = process.argv.slice(2);
const paths = fs.readFileSync(manifest, 'utf8').split('\n').map((l) => l.split('\t')[0]);

function toAsset(p) {
  const m = p.match(/RSDragonwilds\/Content\/(.+)\.uasset$/);
  if (!m) return null;
  const name = m[1].split('/').pop();
  return { pkg: `/Game/${m[1]}`, name };
}
const humanize = (s) => s.replace(/^BP_AI_/, '').replace(/_Character$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

const items = paths.filter((p) => /\/ITEM_[^/]*\.uasset$/.test(p)).map(toAsset).filter(Boolean);
const enemies = paths.filter((p) => /\/BP_AI_[^/]*_Character\.uasset$/.test(p)).map(toAsset).filter(Boolean);

const c = net.connect(sock);
let buf = '';
let seq = 0;
const pending = new Map();
c.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const r = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  }
});
const rpc = (...a) =>
  new Promise((resolve) => {
    const id = String(++seq);
    pending.set(id, resolve);
    c.write([id, ...a].join('\t') + '\n');
  });

(async () => {
  const outItems = [];
  for (const it of items) {
    const r = await rpc('load', `${it.pkg}.${it.name}`);
    const ptr = r.ok && r.result ? r.result.ptr : null;
    if (!ptr) continue;
    const get = async (p) => (await rpc('get', ptr, p)).result;
    if (/MeshData/.test(r.result.class) || (await get('bSoftDeleted'))) continue;
    const display = await get('Name');
    outItems.push({
      path: `${it.pkg}.${it.name}`,
      id: it.name,
      name: display || humanize(it.name.replace(/^ITEM_/, '')),
      kind: r.result.class,
      stack: (await get('MaxStackSize')) || 1,
      iconPath: await get('Icon'),
      group: it.pkg.split('/').slice(-2, -1)[0],
    });
  }
  outItems.sort((a, b) => a.name.localeCompare(b.name));

  const skillsRaw = (await rpc('find', 'SkillData', '64')).result || [];
  const skills = [];
  for (const s of skillsRaw) {
    skills.push({ id: s.name, name: (await rpc('get', s.ptr, 'Name')).result || s.name, max: (await rpc('get', s.ptr, 'MaxLevel')).result, iconPath: (await rpc('get', s.ptr, 'Icon')).result });
  }
  const outEnemies = [];
  for (const e of enemies) {
    // The display name lives in the matching BP_AI_*_Data asset, when there is one.
    const dataName = e.name.replace(/_Character$/, '_Data');
    const dataPkg = e.pkg.replace(/[^/]+$/, dataName);
    const data = paths.includes(`RSDragonwilds/Content/${dataPkg.slice('/Game/'.length)}.uasset`) ? await rpc('load', `${dataPkg}.${dataName}`) : null;
    const display = data && data.ok && data.result ? (await rpc('get', data.result.ptr, 'AIName')).result : null;
    outEnemies.push({ path: `${e.pkg}.${e.name}_C`, id: e.name, name: display || humanize(e.name), group: e.pkg.split('/').slice(-2, -1)[0] });
  }
  outEnemies.sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync(output, JSON.stringify({ items: outItems, enemies: outEnemies, skills }));
  console.log(`items=${outItems.length}/${items.length} enemies=${outEnemies.length} skills=${skills.length}`);
  process.exit(0);
})();
