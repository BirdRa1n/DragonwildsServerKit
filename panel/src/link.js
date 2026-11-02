'use strict';
// Connection to the native module (Unix socket on the server, TCP "host:port" for tools/mock-kit.js).
const net = require('net');
const { EventEmitter } = require('events');
const { AppError } = require('./errors');

const RECONNECT_MS = 2000;
const TIMEOUT_MS = 10000;

class Link extends EventEmitter {
  constructor(target) {
    super();
    this.target = target;
    this.connected = false;
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.connect();
  }

  connect() {
    const m = /^(.+):(\d+)$/.exec(this.target);
    const s = m ? net.connect(Number(m[2]), m[1]) : net.connect(this.target);
    this.sock = s;
    s.on('connect', () => {
      this.connected = true;
      this.emit('up');
    });
    s.on('data', (d) => this.onData(d));
    s.on('error', () => {});
    s.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.buf = '';
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AppError('link_lost'));
      }
      this.pending.clear();
      if (was) this.emit('down');
      setTimeout(() => this.connect(), RECONNECT_MS);
    });
  }

  onData(d) {
    this.buf += d.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(r.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else p.reject(new Error(r.error));
    }
  }

  /** Runs one module command. Arguments must not contain tabs or line breaks. */
  rpc(...args) {
    if (!this.connected) return Promise.reject(new AppError('server_offline'));
    const clean = args.map((a) => String(a).replace(/[\t\r\n]+/g, ' '));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('no_reply'));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write([id, ...clean].join('\t') + '\n');
    });
  }
}

module.exports = { Link };
