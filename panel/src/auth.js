'use strict';
// Password login with scrypt hashes and in-memory sessions. Sessions end when the panel restarts.
const crypto = require('crypto');

const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 8;
const LOCK_MS = 5 * 60 * 1000;
const COOKIE = 'dwk_session';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verify(user, password) {
  const a = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class Auth {
  constructor(users) {
    this.users = users;
    this.sessions = new Map();
    this.fails = new Map();
  }

  login(name, password, ip) {
    const f = this.fails.get(ip);
    if (f && f.count >= MAX_FAILS && Date.now() - f.at < LOCK_MS) return { error: 'login_locked' };
    const user = this.users.find((u) => u.name === name);
    if (!user || !verify(user, String(password))) {
      this.fails.set(ip, { count: (f && Date.now() - f.at < LOCK_MS ? f.count : 0) + 1, at: Date.now() });
      return { error: 'bad_login' };
    }
    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { user: user.name, expires: Date.now() + SESSION_MS });
    return { token, user: user.name };
  }

  session(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`).exec(req.headers.cookie || '');
    if (!m) return null;
    const s = this.sessions.get(m[1]);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.sessions.delete(m[1]);
      return null;
    }
    return { ...s, token: m[1] };
  }

  logout(req) {
    const s = this.session(req);
    if (s) this.sessions.delete(s.token);
  }

  cookie(token) {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
  }

  clearCookie() {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}

module.exports = { Auth, hashPassword };
