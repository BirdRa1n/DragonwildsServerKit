#!/usr/bin/env node
'use strict';
// Development client for the module's socket: node dwk.js <socket> <command> [args...]
const net = require('net');

const [sock, ...cmd] = process.argv.slice(2);
if (!sock || !cmd.length) {
  console.error('usage: dwk.js <socket> <command> [args...]');
  process.exit(2);
}
const c = net.connect(sock, () => c.write(['1', ...cmd].join('\t') + '\n'));
let buf = '';
c.on('data', (d) => {
  buf += d;
  const nl = buf.indexOf('\n');
  if (nl < 0) return;
  const r = JSON.parse(buf.slice(0, nl));
  console.log(JSON.stringify(r.ok ? r.result : { error: r.error }, null, 1));
  c.end();
  process.exit(r.ok ? 0 : 1);
});
c.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 15000);
