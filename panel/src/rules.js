'use strict';
// Server rules, evaluated every snapshot: bans, the time limit for playing alone, and unlimited stats.
//
// Time alone is a budget, not a countdown per session. Reconnecting does not refill it; it only
// resets when someone else is online. Otherwise a kicked player could just rejoin and keep going.

const { describe } = require('./errors');

const SAVE_EVERY_MS = 30000;
const SURVIVAL_EVERY_MS = 2000;
const SURVIVAL_PERKS = ['hunger', 'thirst', 'endurance'];

class Rules {
  constructor(store, game, log) {
    this.store = store;
    this.game = game;
    this.log = log;
    this.lastTick = 0;
    this.lastSave = Date.now();
    this.warned = new Map();
    this.kicking = new Set();
    this.lastSurvival = new Map();
  }

  isExempt(id) {
    return this.store.data.exempt.some((e) => e.id === id);
  }

  isBanned(id) {
    return this.store.data.bans.some((b) => b.id === id);
  }

  soloStatus(players) {
    const { solo, soloUsed } = this.store.data;
    if (players.length !== 1) return { alone: false, enabled: solo.enabled };
    const p = players[0];
    const exempt = this.isExempt(p.id);
    const used = soloUsed[p.id] || 0;
    return {
      alone: true,
      enabled: solo.enabled,
      exempt,
      playerId: p.id,
      usedSeconds: used,
      remainingSeconds: Math.max(0, solo.limitMinutes * 60 - used),
    };
  }

  async kick(p, reason, event) {
    if (this.kicking.has(p.id)) return;
    this.kicking.add(p.id);
    try {
      await this.game.kick(p, reason);
      this.log(event);
    } catch (e) {
      this.log({ kind: 'error', key: 'kick_failed', params: { name: p.name }, err: describe(e) });
    } finally {
      setTimeout(() => this.kicking.delete(p.id), 5000);
    }
  }

  async tickBans(players) {
    for (const p of players) {
      if (!this.isBanned(p.id)) continue;
      const ban = this.store.data.bans.find((b) => b.id === p.id);
      await this.kick(p, ban.reason || this.store.data.messages.ban, { kind: 'rule', key: 'banned_kick', params: { name: p.name } });
    }
  }

  async tickSolo(players, dt) {
    const data = this.store.data;
    const { solo } = data;
    if (players.length >= 2) {
      for (const p of players) {
        if (data.soloUsed[p.id]) delete data.soloUsed[p.id];
        this.warned.delete(p.id);
      }
      return;
    }
    if (players.length !== 1 || !solo.enabled) return;
    const p = players[0];
    if (this.isExempt(p.id)) return;

    data.soloUsed[p.id] = (data.soloUsed[p.id] || 0) + dt;
    const remaining = solo.limitMinutes * 60 - data.soloUsed[p.id];
    if (remaining <= 0) {
      await this.kick(p, solo.kickReason, { kind: 'rule', key: 'solo_kick', params: { name: p.name, minutes: solo.limitMinutes } });
      return;
    }
    const passed = this.warned.get(p.id) ?? Infinity;
    for (const m of solo.warnMinutes) {
      if (remaining <= m * 60 && m < passed) {
        this.warned.set(p.id, m);
        this.log({ kind: 'rule', key: 'solo_warn', params: { name: p.name, minutes: m } });
        await this.game.say(p, solo.warnText.replace('{minutes}', m)).catch((e) => this.log({ kind: 'error', key: 'warn_failed', params: { name: p.name }, err: describe(e) }));
        break;
      }
    }
  }

  /** These stats fall slowly, so they are checked less often than health and stamina. */
  async tickSurvival(p, perks) {
    if (p.dead || !SURVIVAL_PERKS.some((s) => perks[s])) return;
    const now = Date.now();
    if (now - (this.lastSurvival.get(p.id) || 0) < SURVIVAL_EVERY_MS) return;
    this.lastSurvival.set(p.id, now);
    for (const s of SURVIVAL_PERKS) if (perks[s]) await this.game.refillSurvival(p, s);
  }

  async tickPerks(players) {
    for (const p of players) {
      const perks = this.store.data.perks[p.id];
      if (!perks) continue;
      try {
        if (perks.health && p.dead) await this.game.revive(p);
        else if (perks.health && p.health < p.maxHealth) await this.game.restoreHealth(p);
        if (perks.stamina && !p.dead && p.stamina < p.maxStamina) await this.game.restoreStamina(p);
        if (perks.cooldown && !p.dead) await this.game.clearSpellCooldowns(p);
        await this.tickSurvival(p, perks);
      } catch (e) {
        this.log({ kind: 'error', key: 'perk_failed', params: { name: p.name }, err: describe(e) });
      }
    }
  }

  async tick(players) {
    const now = Date.now();
    const dt = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;

    const known = this.store.data.known;
    for (const p of players) known[p.id] = { name: p.name, lastSeen: now };

    await this.tickBans(players);
    await this.tickSolo(players, dt);
    await this.tickPerks(players);

    if (now - this.lastSave > SAVE_EVERY_MS) {
      this.lastSave = now;
      this.store.save();
    }
  }

  /** The server went away: an empty server is not time alone, so the clock must not jump. */
  reset() {
    this.lastTick = 0;
  }
}

module.exports = { Rules };
