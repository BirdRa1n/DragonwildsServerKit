#!/usr/bin/env node
'use strict';
// Simulates the native module over TCP so the panel can be tested without the game:
//   node tools/mock-kit.js [port]     then run the panel with DWK_SOCKET=127.0.0.1:<port>
const net = require('net');

const PORT = Number(process.argv[2] || 7790);
const obj = (ptr, name, cls) => ({ ptr, name, class: cls });
const players = [
  { id: '0002aaa1', name: 'Alice', idx: 1, x: 198000, y: 91450, z: 1200, yaw: 30, health: 100, maxHealth: 100, stamina: 80, maxStamina: 100, dead: false },
  { id: '0002bbb2', name: 'Bob', idx: 2, x: 120000, y: 40000, z: 900, yaw: 200, health: 45, maxHealth: 120, stamina: 100, maxStamina: 100, dead: false },
];
let online = players.slice();

function snapshot() {
  for (const p of online) {
    p.yaw = (p.yaw + 4) % 360;
    p.x += Math.cos((p.yaw * Math.PI) / 180) * 400;
    p.y += Math.sin((p.yaw * Math.PI) / 180) * 400;
    p.stamina = Math.max(0, p.stamina - 1);
  }
  return {
    world: 'L_World',
    fps: 29.9,
    players: online.map((p) => ({
      ps: `0x${p.idx}00`, name: p.name, id: p.id, ping: 12, address: '', pc: `0x${p.idx}01`, pawn: `0x${p.idx}02`,
      location: { ReturnValue: { X: p.x, Y: p.y, Z: p.z } },
      rotation: { ReturnValue: { Pitch: 0, Yaw: p.yaw, Roll: 0 } },
      healthComp: `0x${p.idx}03`, staminaComp: `0x${p.idx}04`,
      health: { ReturnValue: p.health }, maxHealth: { ReturnValue: p.maxHealth }, dead: { ReturnValue: p.dead },
      stamina: { ReturnValue: p.stamina }, maxStamina: { ReturnValue: p.maxStamina },
    })),
  };
}

const byPtr = (ptr) => online.find((p) => ptr.startsWith(`0x${p.idx}`));

function handle(a) {
  const [cmd, ...args] = a;
  switch (cmd) {
    case 'snapshot': return snapshot();
    case 'load': return obj('0x900', args[0].split('.').pop(), 'ItemData');
    case 'named': return obj('0x901', args[0], 'SkillData');
    case 'cdo': return obj('0x902', 'Default__X', 'X');
    case 'find': return [obj('0x903', args[0], args[0])];
    case 'get':
      if (args[1] === 'Skills') return [{ CurrentXP: 500, SkillData: obj('0x901', 'SKILL_Mining', 'SkillData') }];
      return obj(`0x${byPtr(args[0])?.idx ?? 9}05`, args[1], args[1]);
    case 'xp': return true;
    case 'clearcooldowns': return 0;
    case 'kick': {
      const p = byPtr(args[0]);
      online = online.filter((x) => x !== p);
      return true;
    }
    case 'call': {
      const [ptr, fn, ...rest] = args;
      const p = byPtr(ptr);
      if (fn === 'IncreaseHealth') p.health = Math.min(p.maxHealth, p.health + Number(rest[0]));
      if (fn === 'IncreaseStamina') p.stamina = Math.min(p.maxStamina, p.stamina + Number(rest[0]));
      if (fn === 'Revive') { p.dead = false; p.health = p.maxHealth; }
      if (fn === 'TeleportWithParams') {
        const m = /TargetLocation=([^,]+),([^,]+),([^;]+)/.exec(rest[1]);
        const t = byPtr(rest[0]);
        [t.x, t.y, t.z] = [Number(m[1]), Number(m[2]), Number(m[3])];
      }
      if (/^GetCurrent(Sustenance|Hydration|Endurance)$/.test(fn)) return { ReturnValue: 50 };
      if (/^GetMax(Sustenance|Hydration|Endurance)$/.test(fn)) return { ReturnValue: 100 };
      if (fn === 'K2_GetActorLocation') return { ReturnValue: { X: p.x, Y: p.y, Z: p.z } };
      if (fn === 'LineTraceSingle') return { ReturnValue: true, OutHit: { ImpactPoint: { X: 0, Y: 0, Z: 1000 } } };
      if (fn === 'AsyncDomSpawnAI') return { ReturnValue: obj('0x910', 'AsyncAction', 'AsyncAction_DomSpawnAI') };
      return { ReturnValue: true };
    }
    default: return true;
  }
}

net.createServer((s) => {
  let buf = '';
  s.on('error', () => {});
  s.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const [id, ...a] = buf.slice(0, nl).split('\t');
      buf = buf.slice(nl + 1);
      s.write(`${JSON.stringify({ id, ok: true, result: handle(a) })}\n`);
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock kit on 127.0.0.1:${PORT}`));

// Second player leaves and returns on stdin commands for manual tests of the solo rule.
process.stdin.on('data', (d) => {
  const c = d.toString().trim();
  if (c === 'leave') online = players.slice(0, 1);
  if (c === 'join') online = players.slice();
  console.log('players online:', online.length);
});
