'use strict';
// Settings kept as JSON next to the panel. Writes are atomic, so a crash cannot truncate the file.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  solo: {
    enabled: false,
    limitMinutes: 60,
    warnMinutes: [10, 5, 1],
    kickReason: 'Time limit for playing alone reached. Wait for another player to join.',
    warnText: 'You are alone: {minutes} min left before being disconnected.',
  },
  messages: {
    kick: 'Kicked by an administrator.',
    ban: 'You have been banned from this server.',
  },
  exempt: [], // { id, name }
  bans: [], // { id, name, reason, at }
  perks: {}, // id -> { health, stamina, hunger, thirst, endurance, cooldown: bool }
  soloUsed: {}, // id -> seconds spent alone since the last time someone else was online
  known: {}, // id -> { name, lastSeen }
};

class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`invalid settings in ${file}: ${e.message}`);
    }
    this.data = { ...DEFAULTS, ...saved, solo: { ...DEFAULTS.solo, ...(saved.solo || {}) }, messages: { ...DEFAULTS.messages, ...(saved.messages || {}) } };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
