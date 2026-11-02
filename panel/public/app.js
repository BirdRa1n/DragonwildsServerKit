'use strict';

// World bounds read from the game's BP_MapBackground actor: center 198000, 91450, extent 210000.
const WORLD = { cx: 198000, cy: 91450, ext: 210000 };
const MARKER_SMOOTHING = 0.14;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const { t } = I18N;
const fmt = (n) => Math.round(n).toLocaleString(I18N.locale);
const when = (ms) => new Date(ms).toLocaleString(I18N.locale);
/** A catalog entry's name in the panel's language: the game's own translation when it has one. */
const nameOf = (entry) => (names[I18N.lang] && names[I18N.lang][entry.id]) || (names.en && names.en[entry.id]) || entry.name;
/** Same, for an asset id that arrives in a log entry. */
const nameOfId = (id, fallback) => (names[I18N.lang] && names[I18N.lang][id]) || (names.en && names.en[id]) || fallback;
const minutes = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let state = { online: false, players: [], solo: {} };
let settings = { solo: {}, exempt: [], bans: [], known: [] };
let catalog = { items: [], enemies: [], skills: [] };
let names = {};
let selectedId = null;
let es = null;
const logEntries = [];
const MAX_LOG_SHOWN = 300;

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') {
    showLogin();
    throw new Error(t('err.session'));
  }
  if (!res.ok) throw new Error(data.error ? errorText({ code: data.error, params: data.params }) : t('err.unknown', { status: res.status }));
  return data;
}

/** Translates an error sent by the server, including the field name of validation errors. */
function errorText(err) {
  const params = { ...(err.params || {}) };
  if (params.field) params.field = t(`field.${params.field}`);
  return t(`err.${err.code}`, params);
}

let toastTimer;
function toast(text, bad) {
  const t = $('toast');
  t.hidden = true;
  void t.offsetWidth; // restarts the entrance animation
  t.textContent = text;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3000);
}

async function act(id, action, body, done) {
  try {
    await api(`player/${encodeURIComponent(id)}/${action}`, body || {});
    if (done) toast(done);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

/* ---------- session ---------- */

function showLogin() {
  if (es) es.close();
  es = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-pass').focus();
}

async function start() {
  $('login').hidden = true;
  $('app').hidden = false;
  const boot = await api('bootstrap');
  state = boot.state;
  settings = boot.settings;
  $('log').innerHTML = '';
  logEntries.length = 0;
  boot.log.forEach(addLog);
  renderSettings();
  renderState();
  fitMap();
  if (!catalog.items.length) {
    const res = await fetch('data/catalog.json');
    if (res.ok) catalog = await res.json();
    catalog.items = catalog.items.filter((i) => i.group !== 'Deprecated');
    const namesRes = await fetch('data/names.json');
    if (namesRes.ok) names = await namesRes.json();
    buildCatalogPages();
    renderDetail(true);
  }
  es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { state = JSON.parse(e.data); renderState(); });
  es.addEventListener('settings', (e) => { settings = JSON.parse(e.data); renderSettings(); });
  es.addEventListener('log', (e) => addLog(JSON.parse(e.data)));
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('login', { user: $('login-user').value, password: $('login-pass').value });
    $('login-pass').value = '';
    await start();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('logout', {});
  showLogin();
});

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === 'map') resizeMap();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- live state ---------- */

function renderState() {
  const server = $('chip-server');
  server.className = state.online ? 'chip' : 'chip bad';
  server.lastElementChild.textContent = t(state.online ? 'top.online' : 'top.offline');
  $('chip-players').textContent = state.online ? t(state.players.length === 1 ? 'top.players.one' : 'top.players.other', { n: state.players.length }) : '';
  $('chip-fps').textContent = state.online && state.fps ? `${Math.round(state.fps)} FPS` : '';

  $('player-count').textContent = `(${state.players.length})`;
  const list = $('players');
  if (!state.players.length) {
    list.innerHTML = `<li class="empty">${t(state.online ? 'side.none' : 'side.noLink')}</li>`;
  } else {
    list.innerHTML = state.players.map((p) => {
      const hp = p.maxHealth ? (100 * p.health) / p.maxHealth : 0;
      const st = p.maxStamina ? (100 * p.stamina) / p.maxStamina : 0;
      const tags = [
        p.dead ? `<span class="tag dead">${esc(t('player.dead'))}</span>` : '',
        p.exempt ? `<span class="tag">${esc(t('player.exempt'))}</span>` : '',
        ...PERKS.filter((perk) => p.perks[perk]).map((perk) => `<span class="tag">${esc(t(`tag.${perk}`))}</span>`),
      ].join('');
      return `<li><button data-id="${esc(p.id)}" aria-pressed="${p.id === selectedId}">
        <span class="player-row"><span class="player-name">${esc(p.name)}</span><span class="muted">${fmt(p.ping)} ms</span></span>
        <span class="bar" title="${esc(t('player.health'))}"><i style="width:${hp}%"></i></span>
        <span class="bar stamina" title="${esc(t('player.stamina'))}"><i style="width:${st}%"></i></span>
        ${tags ? `<span class="tags">${tags}</span>` : ''}
      </button></li>`;
    }).join('');
  }

  const banner = $('solo-banner');
  const solo = state.solo || {};
  if (solo.alone && solo.enabled && !solo.exempt) {
    const who = state.players.find((p) => p.id === solo.playerId);
    banner.hidden = false;
    banner.textContent = t('side.solo', { name: who ? who.name : t('side.someone'), time: minutes(solo.remainingSeconds) });
  } else {
    banner.hidden = true;
  }
  fillTargets();
  renderDetail(false);
}

$('players').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  selectedId = b.dataset.id === selectedId ? null : b.dataset.id;
  renderState();
  renderDetail(true);
});

/** The "give to" selectors follow the selected player, and pick the only one online by themselves. */
function fillTargets() {
  const players = state.players;
  const html = players.length
    ? players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
    : `<option value="">${esc(t('common.nobody'))}</option>`;
  const key = I18N.lang + players.map((p) => p.id + p.name).join();
  for (const sel of [$('item-target'), $('enemy-target')]) {
    if (sel.dataset.key !== key) {
      sel.innerHTML = html;
      sel.dataset.key = key;
    }
    if (selectedId && players.some((p) => p.id === selectedId) && sel.value !== selectedId) sel.value = selectedId;
    sel.disabled = !players.length;
  }
}

for (const id of ['item-target', 'enemy-target']) {
  $(id).addEventListener('change', (e) => {
    selectedId = e.target.value || null;
    renderState();
    renderDetail(true);
  });
}

/* ---------- player sheet ---------- */

const PERKS = ['health', 'stamina', 'hunger', 'thirst', 'endurance', 'cooldown'];
const form = { skill: '', xp: 1000, tx: '', ty: '', tz: '' };

function skillGrid() {
  return catalog.skills.map((s) => `<button type="button" class="skill" data-skill="${esc(s.id)}" aria-pressed="${s.id === form.skill}" title="${esc(nameOf(s))}">
    <img src="data/icons/skills/${esc(s.id)}.webp" alt="" loading="lazy"><span>${esc(nameOf(s))}</span></button>`).join('');
}

function renderDetail(rebuild) {
  const box = $('detail');
  const p = state.players.find((x) => x.id === selectedId);
  if (!p) {
    box.hidden = true;
    box.innerHTML = '';
    delete box.dataset.id;
    return;
  }
  box.hidden = false;
  if (box.dataset.id === p.id && !rebuild && box.innerHTML) {
    $('d-health').textContent = t('player.vitals', { hp: fmt(p.health), hpMax: fmt(p.maxHealth), st: fmt(p.stamina), stMax: fmt(p.maxStamina) });
    $('d-pos').textContent = p.pos ? `X ${fmt(p.pos.x)}  Y ${fmt(p.pos.y)}  Z ${fmt(p.pos.z)}` : t('player.noPawn');
    return;
  }
  box.dataset.id = p.id;
  if (!form.skill && catalog.skills[0]) form.skill = catalog.skills[0].id;
  const others = state.players.filter((x) => x.id !== p.id);
  box.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div id="d-health" class="detail-stats"></div>
    <div id="d-pos" class="detail-stats"></div>

    <h3>${esc(t('sheet.blessings'))}</h3>
    <div class="go-buttons">
      <button data-a="revive">${esc(t('sheet.revive'))}</button>
      <button data-a="restore">${esc(t('sheet.restore'))}</button>
    </div>
    <div class="perk-list">
      ${PERKS.map((perk) => `<label class="check"><input type="checkbox" data-perk="${perk}" ${p.perks[perk] ? 'checked' : ''}> ${esc(t(`perk.${perk}`))}</label>`).join('')}
    </div>

    <h3>${esc(t('sheet.teleport'))}</h3>
    <div class="grid-3">
      <input id="t-x" placeholder="X" inputmode="numeric" aria-label="X" value="${esc(form.tx)}">
      <input id="t-y" placeholder="Y" inputmode="numeric" aria-label="Y" value="${esc(form.ty)}">
      <input id="t-z" placeholder="${esc(t('sheet.zGround'))}" inputmode="numeric" aria-label="${esc(t('sheet.zAria'))}" title="${esc(t('sheet.zTitle'))}" value="${esc(form.tz)}">
    </div>
    <div class="go-buttons" style="margin-top:6px">
      <button data-a="teleport">${esc(t('sheet.tpButton'))}</button>
      <select id="t-player" aria-label="${esc(t('sheet.tpToPlayerAria'))}">
        <option value="">${esc(t('sheet.tpToPlayer'))}</option>
        ${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}
      </select>
    </div>

    <h3>${esc(t('sheet.knowledge'))}</h3>
    <div class="skills">${skillGrid()}</div>
    <div class="xp-row">
      <input id="xp-amount" type="number" min="1" value="${esc(form.xp)}" aria-label="${esc(t('sheet.xpAmount'))}">
      <button data-a="xp" class="primary">${esc(t('sheet.xpGive'))}</button>
    </div>

    <h3>${esc(t('sheet.shortcuts'))}</h3>
    <div class="go-buttons">
      <button data-go="items">${esc(t('sheet.giveItem'))}</button>
      <button data-go="enemies">${esc(t('sheet.summon'))}</button>
    </div>

    <h3>${esc(t('sheet.justice'))}</h3>
    <div class="go-buttons">
      <button data-a="kick">${esc(t('sheet.kick'))}</button>
      <button data-a="ban" class="danger">${esc(t('sheet.ban'))}</button>
    </div>
    <div class="perk-list">
      <label class="check"><input type="checkbox" data-exempt ${p.exempt ? 'checked' : ''}> ${esc(t('sheet.exempt'))}</label>
    </div>`;
  renderDetail(false);
}

/** Where a spell should appear for this player: their marker on the map, else their card. */
function playerFxPoint(id) {
  const p = state.players.find((x) => x.id === id);
  if (!$('tab-map').hidden && p && p.pos) {
    const r = canvas.getBoundingClientRect();
    const [sx, sy] = toScreen(...worldToMap(p.pos.x, p.pos.y));
    if (sx >= 0 && sy >= 0 && sx <= r.width && sy <= r.height) return { x: r.left + sx, y: r.top + sy };
  }
  const card = document.querySelector(`#players button[data-id="${CSS.escape(id)}"]`);
  return card && card.offsetParent ? FX.center(card) : null;
}

$('detail').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'xp-amount') form.xp = t.value;
  if (t.id === 't-x') form.tx = t.value;
  if (t.id === 't-y') form.ty = t.value;
  if (t.id === 't-z') form.tz = t.value;
});

$('detail').addEventListener('change', async (e) => {
  const t = e.target;
  const id = selectedId;
  if (t.dataset.perk) {
    const at = FX.center(t);
    await act(id, 'perk', { perk: t.dataset.perk, on: t.checked });
    if (t.checked) FX.runeCircle(at.x, at.y, t.dataset.perk === 'health' ? 'heal' : t.dataset.perk === 'stamina' ? 'gold' : 'arcane', 34);
  }
  if ('exempt' in t.dataset) act(id, 'exempt', { on: t.checked });
  if (t.id === 't-player' && t.value) {
    const o = state.players.find((x) => x.id === t.value);
    t.value = '';
    if (o && o.pos) teleportTo(id, o.pos.x, o.pos.y, o.pos.z + 100, t('toast.tpTo', { name: o.name }));
  }
});

async function teleportTo(id, x, y, z, message) {
  const before = playerFxPoint(id);
  if (await act(id, 'teleport', { x, y, z }, message)) {
    if (before) FX.runeCircle(before.x, before.y, 'arcane', 44);
    mapRipple(Number(x), Number(y), 'arcane');
  }
}

$('detail').addEventListener('click', async (e) => {
  const skill = e.target.closest('[data-skill]');
  if (skill) {
    form.skill = skill.dataset.skill;
    skill.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === skill));
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go) {
    showTab(go.dataset.go);
    return;
  }
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const id = selectedId;
  const p = state.players.find((x) => x.id === id);
  if (!p) return;
  const at = playerFxPoint(id) || FX.center(b);
  switch (b.dataset.a) {
    case 'revive':
      if (await act(id, 'revive', {}, t('toast.revived', { name: p.name }))) FX.pillar(at.x, at.y, 'gold');
      break;
    case 'restore':
      if (await act(id, 'restore', {}, t('toast.restored'))) FX.pillar(at.x, at.y, 'heal');
      break;
    case 'teleport':
      if (form.tx === '' || form.ty === '') toast(t('toast.fillXY'), true);
      else teleportTo(id, form.tx, form.ty, form.tz === '' ? undefined : form.tz, t('toast.tp'));
      break;
    case 'xp': {
      const src = `data/icons/skills/${form.skill}.webp`;
      const from = FX.center(b);
      if (await act(id, 'xp', { skill: form.skill, amount: form.xp }, t('toast.xp'))) FX.flyIcon(src, from, at, 'gold');
      break;
    }
    case 'kick':
      if (confirm(t('confirm.kick', { name: p.name })) && (await act(id, 'kick', {}, t('toast.kicked', { name: p.name })))) FX.runeCircle(at.x, at.y, 'ember', 60);
      break;
    case 'ban':
      if (confirm(t('confirm.ban', { name: p.name })) && (await act(id, 'ban', {}, t('toast.banned', { name: p.name })))) FX.summon(at.x, at.y);
      break;
    default:
  }
});

/* ---------- item and creature pages ---------- */

const ITEM_CATS = [
  ['all', () => true],
  ['armour', (i) => /Wearable/.test(i.kind)],
  ['weapons', (i) => /Held|Shield|SpadeTool|HarvestTool/.test(i.kind) && !/Seed/.test(i.kind)],
  ['ammo', (i) => /Ammo/.test(i.kind)],
  ['jewellery', (i) => /Trinket/.test(i.kind)],
  ['food', (i) => /Food|Drink/.test(i.kind)],
  ['potions', (i) => /Potion|ItemEmitter/.test(i.kind)],
  ['tomes', (i) => /Tome/.test(i.kind)],
  ['seeds', (i) => /Seed/.test(i.kind)],
  ['magic', (i) => i.group === 'Magic'],
  ['materials', (i) => i.kind === 'ItemData' && !['Key', 'PostBoxes', 'Magic'].includes(i.group)],
  ['quest', (i) => ['Key', 'PostBoxes'].includes(i.group) || i.kind === 'JournalItemData'],
];

const BOSS = /Boss|Colossal|Velgar|DragonImaru|Thane/i;
const ANIMAL = /Chicken|Cow|Deer|_Ram_|Sheep|Kebbit|Chinchompa|Falcon|Magpie|Raven|Dummy/i;
const ENEMY_CATS = [
  ['all', () => true],
  ['monsters', (e) => !BOSS.test(e.id) && !ANIMAL.test(e.id)],
  ['bosses', (e) => BOSS.test(e.id)],
  ['animals', (e) => ANIMAL.test(e.id)],
];

const filters = {
  item: { query: '', cat: 0 },
  enemy: { query: '', cat: 0 },
};

function matches(entry, query) {
  const q = query.trim().toLowerCase();
  return !q || nameOf(entry).toLowerCase().includes(q) || entry.name.toLowerCase().includes(q) || entry.id.toLowerCase().includes(q);
}

function sortedByName(list) {
  return list.map((entry) => [nameOf(entry), entry]).sort((a, b) => a[0].localeCompare(b[0], I18N.locale)).map((pair) => pair[1]);
}

function renderItems() {
  const test = ITEM_CATS[filters.item.cat][1];
  const list = sortedByName(catalog.items.filter((i) => test(i) && matches(i, filters.item.query)));
  $('item-grid').innerHTML = list.map((i) => `<button type="button" class="item" data-item="${esc(i.path)}" title="${esc(nameOf(i))}">
    <span class="item-slot"><img src="data/icons/items/${esc(i.id)}.webp" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></span>
    <span class="item-name">${esc(nameOf(i))}</span></button>`).join('');
  $('item-empty').hidden = list.length > 0;
}

function renderEnemies() {
  const test = ENEMY_CATS[filters.enemy.cat][1];
  const list = sortedByName(catalog.enemies.filter((e) => test(e) && matches(e, filters.enemy.query)));
  $('enemy-grid').innerHTML = list.map((e) => {
    const boss = BOSS.test(e.id);
    return `<button type="button" class="enemy ${boss ? 'danger-boss' : ''}" data-enemy="${esc(e.path)}" title="${esc(t('enemies.summonTitle', { name: nameOf(e) }))}">
      <span class="crest"><img src="data/icons/enemies/${esc(e.id)}.webp" alt="" loading="lazy"></span>
      <span class="enemy-name">${esc(nameOf(e))}</span>
      <span class="enemy-kind">${esc(t(boss ? 'ekind.boss' : ANIMAL.test(e.id) ? 'ekind.animal' : 'ekind.monster'))}</span>
    </button>`;
  }).join('');
  $('enemy-empty').hidden = list.length > 0;
}

function renderCats(el, cats, key, prefix, render) {
  el.innerHTML = cats.map(([name], i) => `<button type="button" data-cat="${i}" aria-pressed="${i === filters[key].cat}">${esc(t(`${prefix}.${name}`))}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    filters[key].cat = Number(b.dataset.cat);
    el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    render();
  };
}

function buildCatalogPages() {
  renderCats($('item-cats'), ITEM_CATS, 'item', 'cat', renderItems);
  renderCats($('enemy-cats'), ENEMY_CATS, 'enemy', 'ecat', renderEnemies);
  renderItems();
  renderEnemies();
}

$('item-search').addEventListener('input', (e) => { filters.item.query = e.target.value; renderItems(); });
$('enemy-search').addEventListener('input', (e) => { filters.enemy.query = e.target.value; renderEnemies(); });

$('item-grid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-item]');
  if (!b) return;
  const id = $('item-target').value;
  if (!id) {
    toast(t('toast.noTargetItem'), true);
    return;
  }
  const count = $('item-count').value;
  const icon = b.querySelector('img').getAttribute('src');
  const from = FX.center(b.querySelector('.item-slot'));
  const to = FX.center($('item-target'));
  if (await act(id, 'item', { path: b.dataset.item, count }, t('toast.item', { count, name: b.title }))) FX.flyIcon(icon, from, to, 'gold');
});

$('enemy-grid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-enemy]');
  if (!b) return;
  const id = $('enemy-target').value;
  if (!id) {
    toast(t('toast.noTargetEnemy'), true);
    return;
  }
  const at = FX.center(b.querySelector('.crest'));
  const name = b.querySelector('.enemy-name').textContent;
  if (await act(id, 'spawn', { path: b.dataset.enemy, count: $('enemy-count').value, level: $('enemy-level').value }, t('toast.summoned', { name }))) {
    FX.summon(at.x, at.y);
    const p = state.players.find((x) => x.id === id);
    if (p && p.pos) mapRipple(p.pos.x, p.pos.y, 'ruby');
  }
});

/* ---------- map ---------- */

const canvas = $('map');
const ctx = canvas.getContext('2d');
const view = { scale: 1, ox: 0, oy: 0 };
const loadImage = (src) => {
  const img = new Image();
  img.src = src;
  return img;
};
const mapImage = loadImage('data/map.webp');
const arrowImage = loadImage('data/ui/arrow.webp');
const reticleImage = loadImage('data/ui/reticle.webp');
const smooth = new Map(); // player id -> displayed position, eased toward the latest snapshot
const ripples = [];
let aiming = false;

const worldToMap = (x, y) => [(x - (WORLD.cx - WORLD.ext)) / (2 * WORLD.ext), (y - (WORLD.cy - WORLD.ext)) / (2 * WORLD.ext)];
const mapToWorld = (u, v) => [WORLD.cx - WORLD.ext + u * 2 * WORLD.ext, WORLD.cy - WORLD.ext + v * 2 * WORLD.ext];
const toScreen = (u, v) => [view.ox + u * view.scale, view.oy + v * view.scale];
const toMapPos = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];

function resizeMap() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function fitMap() {
  resizeMap();
  const r = canvas.getBoundingClientRect();
  view.scale = Math.max(50, Math.min(r.width, r.height) * 0.98);
  view.ox = (r.width - view.scale) / 2;
  view.oy = (r.height - view.scale) / 2;
}

function mapRipple(x, y, kind) {
  ripples.push({ x, y, kind, start: performance.now() });
}

function drawRipples(now) {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    const t = (now - rp.start) / 1600;
    if (t >= 1) {
      ripples.splice(i, 1);
      continue;
    }
    const [sx, sy] = toScreen(...worldToMap(rp.x, rp.y));
    const palette = FX.COLORS[rp.kind] || FX.COLORS.gold;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 3; k++) {
      const p = Math.min(1, t * 1.6 - k * 0.18);
      if (p <= 0) continue;
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.strokeStyle = palette[k];
      ctx.lineWidth = 2.5 - k * 0.6;
      ctx.beginPath();
      ctx.arc(sx, sy, 8 + p * 64, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = Math.sin(Math.min(1, t * 1.4) * Math.PI) * 0.8;
    const g = ctx.createLinearGradient(0, sy - 120, 0, sy);
    g.addColorStop(0, 'transparent');
    g.addColorStop(1, palette[1]);
    ctx.fillStyle = g;
    ctx.fillRect(sx - 7, sy - 120, 14, 120);
    ctx.restore();
  }
}

function drawPlayer(p, now) {
  const target = p.pos;
  let shown = smooth.get(p.id);
  if (!shown || Math.hypot(shown.x - target.x, shown.y - target.y) > 8000) shown = { x: target.x, y: target.y };
  shown.x += (target.x - shown.x) * MARKER_SMOOTHING;
  shown.y += (target.y - shown.y) * MARKER_SMOOTHING;
  smooth.set(p.id, shown);

  const [sx, sy] = toScreen(...worldToMap(shown.x, shown.y));
  const selected = p.id === selectedId;
  const pulse = 0.5 + 0.5 * Math.sin(now / 520);

  if (selected && reticleImage.complete && reticleImage.naturalWidth) {
    const size = 58 + pulse * 5;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(FX.reduced ? 0 : now / 2600);
    ctx.globalAlpha = 0.9;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(reticleImage, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 22);
  const tone = p.dead ? '238,90,90' : selected ? '245,217,139' : '114,170,255';
  glow.addColorStop(0, `rgba(${tone},${0.55 + pulse * 0.25})`);
  glow.addColorStop(1, `rgba(${tone},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(sx, sy, 22, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(sx, sy);
  // The icon points up on screen; yaw 0 points along +X, to the right.
  ctx.rotate((((p.yaw || 0) + 90) * Math.PI) / 180);
  if (arrowImage.complete && arrowImage.naturalWidth) {
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.drawImage(arrowImage, -13, -13, 26, 26);
  }
  ctx.restore();

  ctx.font = '700 15px "Bona Nova SC", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#0c0a08e6';
  ctx.fillStyle = selected ? '#f5d98b' : '#f7efdc';
  ctx.strokeText(p.name, sx, sy - 22);
  ctx.fillText(p.name, sx, sy - 22);
}

function drawMap(now) {
  requestAnimationFrame(drawMap);
  if ($('tab-map').hidden || document.hidden) return;
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  const [x0, y0] = toScreen(0, 0);
  if (mapImage.complete && mapImage.naturalWidth) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(mapImage, x0, y0, view.scale, view.scale);
  }
  for (const p of state.players) if (p.pos) drawPlayer(p, now);
  drawRipples(now);
}
requestAnimationFrame(drawMap);

function setAiming(on) {
  aiming = on && !!selectedId;
  $('tp-mode').setAttribute('aria-pressed', aiming);
  $('tp-hint').hidden = !aiming;
  canvas.classList.toggle('aiming', aiming);
}

$('tp-mode').addEventListener('click', () => {
  if (!selectedId) {
    toast(t('toast.select'), true);
    return;
  }
  setAiming(!aiming);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setAiming(false);
    $('map-menu').hidden = true;
  }
});

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  $('map-menu').hidden = true;
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = mapToWorld(...toMapPos(e.clientX - r.left, e.clientY - r.top));
  $('map-info').textContent = `X ${fmt(wx)}  Y ${fmt(wy)}`;
  if (!drag) return;
  view.ox = drag.ox + e.clientX - drag.x;
  view.oy = drag.oy + e.clientY - drag.y;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
});
canvas.addEventListener('pointerup', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  if (drag && !drag.moved) {
    if (aiming) {
      const [wx, wy] = mapToWorld(...toMapPos(sx, sy));
      teleportTo(selectedId, Math.round(wx), Math.round(wy), undefined, t('toast.tp'));
      setAiming(false);
    } else {
      for (const p of state.players) {
        if (!p.pos) continue;
        const [px, py] = toScreen(...worldToMap(p.pos.x, p.pos.y));
        if (Math.hypot(sx - px, sy - py) < 16) {
          selectedId = p.id;
          renderState();
          renderDetail(true);
          break;
        }
      }
    }
  }
  drag = null;
  canvas.classList.remove('dragging');
});

function zoomAt(sx, sy, factor) {
  const next = Math.min(40000, Math.max(100, view.scale * factor));
  const k = next / view.scale;
  view.ox = sx - (sx - view.ox) * k;
  view.oy = sy - (sy - view.oy) * k;
  view.scale = next;
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2);
}, { passive: false });
$('zoom-in').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.4); });
$('zoom-out').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.4); });
$('zoom-fit').addEventListener('click', fitMap);
window.addEventListener('resize', resizeMap);

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  const [wx, wy] = mapToWorld(...toMapPos(sx, sy));
  const menu = $('map-menu');
  const p = state.players.find((x) => x.id === selectedId);
  menu.innerHTML = `<small>X ${fmt(wx)}  Y ${fmt(wy)}</small>${p
    ? `<button data-tp>${esc(t('map.menuTp', { name: p.name }))}</button><button data-fill>${esc(t('map.menuFill'))}</button>`
    : `<small>${esc(t('map.menuPick'))}</small>`}`;
  menu.style.left = `${Math.min(sx, r.width - 230)}px`;
  menu.style.top = `${Math.min(sy, r.height - 100)}px`;
  menu.hidden = false;
  menu.dataset.x = Math.round(wx);
  menu.dataset.y = Math.round(wy);
});
$('map-menu').addEventListener('click', (e) => {
  const menu = $('map-menu');
  const { x, y } = menu.dataset;
  if (e.target.closest('[data-tp]')) {
    teleportTo(selectedId, x, y, undefined, t('toast.tp'));
  } else if (e.target.closest('[data-fill]')) {
    form.tx = x;
    form.ty = y;
    form.tz = '';
    renderDetail(true);
  } else {
    return;
  }
  menu.hidden = true;
});

/* ---------- rules and bans ---------- */

function renderSettings() {
  const s = settings.solo;
  if (!document.activeElement.closest || !document.activeElement.closest('#solo-form')) {
    $('solo-enabled').checked = !!s.enabled;
    $('solo-limit').value = s.limitMinutes ?? '';
    $('solo-warn').value = (s.warnMinutes || []).join(', ');
    $('solo-reason').value = s.kickReason || '';
    $('solo-warn-text').value = s.warnText || '';
    $('kick-message').value = settings.messages.kick || '';
    $('ban-message').value = settings.messages.ban || '';
  }
  const exempt = new Set(settings.exempt.map((x) => x.id));
  $('known').innerHTML = settings.known.length ? settings.known.map((k) => `<tr>
    <td>${esc(k.name)}</td>
    <td>${esc(when(k.lastSeen))}</td>
    <td>${minutes(k.soloUsed)}</td>
    <td><input type="checkbox" data-exempt="${esc(k.id)}" aria-label="${esc(t('rules.exemptAria', { name: k.name }))}" ${exempt.has(k.id) ? 'checked' : ''}></td>
    <td><button data-reset="${esc(k.id)}" ${k.soloUsed ? '' : 'disabled'}>${esc(t('rules.reset'))}</button></td>
  </tr>`).join('') : `<tr><td colspan="5" class="muted">${esc(t('rules.none'))}</td></tr>`;

  $('bans').innerHTML = settings.bans.length ? settings.bans.map((b) => `<tr>
    <td>${esc(b.name)}</td><td>${esc(b.reason) || '—'}</td><td>${esc(when(b.at))}</td>
    <td><button data-unban="${esc(b.id)}">${esc(t('bans.remove'))}</button></td>
  </tr>`).join('') : `<tr><td colspan="4" class="muted">${esc(t('bans.none'))}</td></tr>`;

  const banned = new Set(settings.bans.map((x) => x.id));
  $('ban-player').innerHTML = settings.known.filter((k) => !banned.has(k.id)).map((k) => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('');
}

$('solo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const warnMinutes = $('solo-warn').value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
  try {
    settings = await api('settings', { enabled: $('solo-enabled').checked, limitMinutes: Number($('solo-limit').value), warnMinutes, kickReason: $('solo-reason').value, warnText: $('solo-warn-text').value, kickMessage: $('kick-message').value, banMessage: $('ban-message').value });
    $('solo-saved').textContent = t('rules.saved');
    setTimeout(() => { $('solo-saved').textContent = ''; }, 2500);
    renderSettings();
    const at = FX.center(e.target.querySelector('button.primary'));
    FX.runeCircle(at.x, at.y, 'gold', 60);
  } catch (err) {
    toast(err.message, true);
  }
});

$('known').addEventListener('change', (e) => {
  const id = e.target.dataset.exempt;
  if (id) act(id, 'exempt', { on: e.target.checked });
});
$('known').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-reset]');
  if (b) act(b.dataset.reset, 'resetsolo', {}, t('toast.reset'));
});
$('bans').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-unban]');
  if (b) act(b.dataset.unban, 'unban', {}, t('toast.unbanned'));
});
$('ban-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('ban-player').value;
  if (id) act(id, 'ban', { reason: $('ban-reason').value }, t('toast.playerBanned'));
  $('ban-reason').value = '';
});

function logText(e) {
  const params = { ...(e.params || {}) };
  if (params.perk) params.perk = t(`perk.${params.perk}`);
  if (params.item) params.item = nameOfId(params.item, params.item);
  if (params.enemy) params.enemy = nameOfId(`${params.enemy}`, params.enemy);
  if (params.skill) params.skill = nameOfId(`SKILL_${params.skill}`, params.skill);
  if (e.err) params.err = errorText(e.err);
  return t(`l.${e.key}`, params);
}

function renderLogEntry(e) {
  const li = document.createElement('li');
  li.className = e.kind || '';
  const time = document.createElement('time');
  time.textContent = new Date(e.t).toLocaleTimeString(I18N.locale);
  li.append(time, logText(e));
  $('log').prepend(li);
  while ($('log').children.length > MAX_LOG_SHOWN) $('log').lastChild.remove();
}

function addLog(e) {
  logEntries.push(e);
  if (logEntries.length > MAX_LOG_SHOWN) logEntries.shift();
  renderLogEntry(e);
}

/* ---------- language ---------- */

function applyLanguage() {
  I18N.apply();
  document.querySelectorAll('[data-lang]').forEach((sel) => {
    if (!sel.options.length) sel.innerHTML = I18N.languages.map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('');
    sel.value = I18N.lang;
  });
  $('log').innerHTML = '';
  logEntries.forEach(renderLogEntry);
  if ($('app').hidden) return;
  renderSettings();
  renderState();
  renderDetail(true);
  if (catalog.items.length) buildCatalogPages();
}

document.querySelectorAll('[data-lang]').forEach((sel) => sel.addEventListener('change', () => {
  I18N.set(sel.value);
  applyLanguage();
}));

applyLanguage();
api('me').then(start).catch(showLogin);
