#!/usr/bin/env node
'use strict';
// Exercises the panel's game actions against the first player online. It changes that player's
// character, so use it only on the test instance: node live-test.js <panel dir> <socket>
const path = require('path');

const [panelDir, socket] = process.argv.slice(2);
const { Link } = require(path.join(panelDir, 'src/link'));
const { Game, normalizeSnapshot } = require(path.join(panelDir, 'src/game'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const link = new Link(socket);
const game = new Game(link);

const player = async () => normalizeSnapshot(await link.rpc('snapshot')).players[0];
const brief = (p) => `pos=${Math.round(p.pos?.x)},${Math.round(p.pos?.y)},${Math.round(p.pos?.z)} hp=${p.health} dead=${p.dead}`;

async function settle(label, seconds) {
  for (let i = 0; i < seconds; i += 3) {
    await sleep(3000);
    console.log(`  ${label} t+${i + 3}s ${brief(await player())}`);
  }
}

async function main() {
  await new Promise((resolve) => link.once('up', resolve));
  let p = await player();
  if (!p) throw new Error('nenhum jogador online');
  console.log(`player ${p.name} ${brief(p)}`);

  p = await player();
  console.log(`revive test from ${brief(p)}`);
  await link.rpc('call', p.healthComp, 'DecreaseHealth', p.maxHealth + 100, 'DWKit');
  await sleep(1000);
  p = await player();
  console.log(`after damage ${brief(p)}`);
  const fell = p.pos;
  await game.revive(p);
  await settle('revive', 15);
  p = await player();
  console.log(`final ${brief(p)}; moved ${Math.round(Math.hypot(p.pos.x - fell.x, p.pos.y - fell.y))} from where they fell`);
  process.exit(0);
}

main().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
