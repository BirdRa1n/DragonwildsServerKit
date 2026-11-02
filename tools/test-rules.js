#!/usr/bin/env node
'use strict';
// Tests the panel rules with a fake game and a fake clock: node tools/test-rules.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../panel/src/store');
const { Rules } = require('../panel/src/rules');

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-rules-')), 'settings.json');
let now = 1000000;
Date.now = () => now;

const A = { id: 'a', name: 'Alice', health: 100, maxHealth: 100, stamina: 100, maxStamina: 100, dead: false };
const B = { id: 'b', name: 'Bob', health: 100, maxHealth: 100, stamina: 100, maxStamina: 100, dead: false };

function setup() {
  const store = new Store(file);
  store.data = { ...store.data, exempt: [], bans: [], perks: {}, soloUsed: {}, known: {} };
  store.data.solo = { ...store.data.solo, enabled: true, limitMinutes: 2, warnMinutes: [1] };
  const kicked = [];
  const calls = [];
  const game = {
    kick: async (p, reason) => { kicked.push([p.id, reason]); },
    say: async () => {},
    revive: async (p) => calls.push(['revive', p.id]),
    restoreHealth: async (p) => calls.push(['health', p.id]),
    restoreStamina: async (p) => calls.push(['stamina', p.id]),
    clearSpellCooldowns: async (p) => calls.push(['cooldown', p.id]),
    refillSurvival: async (p, s) => calls.push([s, p.id]),
  };
  const logs = [];
  const rules = new Rules(store, game, (e) => logs.push(e));
  rules.kicking = { has: () => false, add() {}, delete() {} };
  return { store, rules, kicked, calls, logs };
}

/** Advances the clock one second per tick and evaluates the rules. */
async function run(rules, players, seconds) {
  for (let i = 0; i < seconds; i++) {
    now += 1000;
    await rules.tick(players);
  }
}

const tests = {
  async 'kicks a player alone once the limit is reached'() {
    const { rules, kicked } = setup();
    await run(rules, [A], 119);
    assert.equal(kicked.length, 0);
    await run(rules, [A], 3);
    assert.equal(kicked[0][0], 'a');
  },
  async 'reconnecting does not refill the budget'() {
    const { rules, kicked } = setup();
    await run(rules, [A], 90);
    await run(rules, [], 600);
    assert.equal(kicked.length, 0);
    await run(rules, [A], 25);
    assert.equal(kicked.length, 0);
    await run(rules, [A], 8);
    assert.ok(kicked.length >= 1);
  },
  async 'time on an empty server is not counted'() {
    const { rules, store } = setup();
    await run(rules, [A], 10);
    await run(rules, [], 300);
    assert.ok(store.data.soloUsed.a <= 11, `used ${store.data.soloUsed.a}`);
  },
  async 'playing with someone else resets the budget'() {
    const { rules, kicked, store } = setup();
    await run(rules, [A], 100);
    await run(rules, [A, B], 5);
    assert.equal(store.data.soloUsed.a, undefined);
    await run(rules, [A], 100);
    assert.equal(kicked.length, 0);
  },
  async 'exempt players are never kicked'() {
    const { rules, kicked, store } = setup();
    store.data.exempt.push({ id: 'a', name: 'Alice' });
    await run(rules, [A], 1000);
    assert.equal(kicked.length, 0);
  },
  async 'disabled rule kicks nobody'() {
    const { rules, kicked, store } = setup();
    store.data.solo.enabled = false;
    await run(rules, [A], 1000);
    assert.equal(kicked.length, 0);
  },
  async 'banned players are kicked on sight, even with others online'() {
    const { rules, kicked, store } = setup();
    store.data.bans.push({ id: 'b', name: 'Bob', reason: 'x', at: 1 });
    await run(rules, [A, B], 1);
    assert.deepEqual(kicked.map((k) => k[0]), ['b']);
  },
  async 'warns once at each threshold'() {
    const { rules, logs } = setup();
    await run(rules, [A], 70);
    assert.equal(logs.filter((l) => l.key === 'solo_warn').length, 1);
  },
  async 'spell cooldowns clear only for marked players, and not while dead'() {
    const { rules, calls, store } = setup();
    store.data.solo.enabled = false;
    store.data.perks.a = { cooldown: true };
    await run(rules, [A, B], 1);
    assert.deepEqual(calls, [['cooldown', 'a']]);
    calls.length = 0;
    await run(rules, [{ ...A, dead: true }], 1);
    assert.deepEqual(calls, []);
  },
  async 'hunger, thirst and endurance refill only when marked, every two seconds, and not while dead'() {
    const { rules, calls, store } = setup();
    store.data.solo.enabled = false;
    store.data.perks.a = { hunger: true, endurance: true };
    await run(rules, [A, B], 5);
    assert.ok(calls.every(([s, id]) => id === 'a' && s !== 'thirst'), JSON.stringify(calls));
    assert.ok(calls.length >= 4 && calls.length <= 6, `refilled ${calls.length} times in 5 s`);
    calls.length = 0;
    await run(rules, [{ ...A, dead: true }], 5);
    assert.deepEqual(calls, []);
  },
  async 'unlimited health revives and refills, stamina refills'() {
    const { rules, calls, store } = setup();
    store.data.solo.enabled = false;
    store.data.perks.a = { health: true, stamina: true };
    await run(rules, [{ ...A, health: 10, stamina: 5 }], 1);
    assert.deepEqual(calls, [['health', 'a'], ['stamina', 'a']]);
    calls.length = 0;
    await run(rules, [{ ...A, dead: true, health: 0, stamina: 5 }], 1);
    assert.deepEqual(calls, [['revive', 'a']]);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
