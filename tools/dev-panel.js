#!/usr/bin/env node
'use strict';
// Starts the panel against the mock module, with disposable data in the OS temp folder.
// The dev login is admin / dev-only-password, valid only for this local run.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-dev-'));
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('dev-only-password', salt, 64).toString('hex');
const config = path.join(dir, 'config.json');
fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 8090, socket: '127.0.0.1:7790', users: [{ name: 'admin', salt, hash }] }));

const root = path.join(__dirname, '..');
const mock = spawn(process.execPath, [path.join(__dirname, 'mock-kit.js'), '7790'], { stdio: ['pipe', 'inherit', 'inherit'] });
const panel = spawn(process.execPath, [path.join(root, 'panel/server.js')], {
  stdio: 'inherit',
  env: { ...process.env, DWK_CONFIG: config, DWK_DATA: dir },
});
process.stdin.on('data', (d) => mock.stdin.write(d));
const stop = () => {
  mock.kill();
  panel.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
panel.on('exit', stop);
