'use strict';
// Game actions, written against the reflection names the module exposes. Names come from the
// server's own reflection dump (build c695030ea461f775).

const { AppError } = require('./errors');

const TRACE_TOP = 60000;
const ABOVE_GROUND = 150;
const REVIVE_WATCH_S = 15;
const RESPAWN_JUMP = 1000;

const SURVIVAL_STATS = {
  hunger: { comp: 'SustenanceComponent', current: 'GetCurrentSustenance', max: 'GetMaxSustenance', add: 'AddSustenance' },
  thirst: { comp: 'HydrationComponent', current: 'GetCurrentHydration', max: 'GetMaxHydration', add: 'AddHydration' },
  endurance: { comp: 'EnduranceComponent', current: 'GetCurrentEndurance', max: 'GetMaxEndurance', add: 'AddEndurance' },
};

const num = (v) => (v && typeof v === 'object' ? v.ReturnValue : v);

/** Turns the module's raw snapshot into what the panel and the rules use. */
function normalizeSnapshot(raw) {
  const players = (raw.players || [])
    .filter((p) => p.id)
    .map((p) => ({
      id: p.id,
      name: p.name || p.id,
      ping: (p.ping || 0) * 4,
      address: p.address || '',
      ps: p.ps,
      pc: p.pc,
      pawn: p.pawn,
      healthComp: p.healthComp,
      staminaComp: p.staminaComp,
      pos: p.location && p.location.ReturnValue ? { x: p.location.ReturnValue.X, y: p.location.ReturnValue.Y, z: p.location.ReturnValue.Z } : null,
      yaw: p.rotation && p.rotation.ReturnValue ? p.rotation.ReturnValue.Yaw : 0,
      health: num(p.health),
      maxHealth: num(p.maxHealth),
      stamina: num(p.stamina),
      maxStamina: num(p.maxStamina),
      dead: !!num(p.dead),
    }));
  return { world: raw.world, fps: raw.fps, players };
}

class Game {
  constructor(link) {
    this.link = link;
    this.cache = new Map();
  }

  /** Objects loaded by path stay valid while the server runs; the cache drops on reconnect. */
  async load(path) {
    const hit = this.cache.get(path);
    if (hit) return hit;
    const o = await this.link.rpc('load', path);
    if (!o) throw new AppError('load_failed', { path });
    this.cache.set(path, o.ptr);
    return o.ptr;
  }

  async component(pawn, prop) {
    const c = await this.link.rpc('get', pawn, prop);
    if (!c) throw new AppError('component_missing', { component: prop });
    return c.ptr;
  }

  async giveItem(player, itemPath, count) {
    const item = await this.load(itemPath);
    const inv = await this.component(player.pc, 'InventoryComponent');
    const r = await this.link.rpc('call', inv, 'AddItemByData', item, count, 100, '-');
    if (!num(r)) throw new AppError('inventory_refused');
  }

  async giveXp(player, skillName, amount) {
    const comp = await this.component(player.pc, 'SkillComponent');
    const skill = await this.link.rpc('named', skillName, 'SkillData');
    if (!skill) throw new AppError('skill_not_found');
    await this.link.rpc('xp', comp, skill.ptr, amount);
  }

  async skills(player) {
    const comp = await this.component(player.pc, 'SkillComponent');
    const list = await this.link.rpc('get', comp, 'Skills');
    return (list || []).map((s) => ({ id: s.SkillData && s.SkillData.name, xp: s.CurrentXP }));
  }

  async restoreHealth(player) {
    const missing = player.maxHealth - player.health;
    if (missing > 0) await this.link.rpc('call', player.healthComp, 'IncreaseHealth', missing, 'DWKit');
  }

  async restoreStamina(player) {
    const missing = player.maxStamina - player.stamina;
    if (missing > 0) await this.link.rpc('call', player.staminaComp, 'IncreaseStamina', missing);
  }

  /**
   * Revive only restores health: the game's death timer keeps running and moves the player to their
   * respawn point seconds later. So watch the position for that jump and bring them back.
   */
  async revive(player) {
    await this.link.rpc('call', player.healthComp, 'Revive');
    if (player.pos) this.holdPosition(player, player.pos).catch(() => {});
  }

  async holdPosition(player, spot) {
    for (let i = 0; i < REVIVE_WATCH_S; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const at = (await this.link.rpc('call', player.pawn, 'K2_GetActorLocation')).ReturnValue;
      if (Math.hypot(at.X - spot.x, at.Y - spot.y) > RESPAWN_JUMP) {
        await this.teleport(player, spot.x, spot.y, spot.z + ABOVE_GROUND);
        return;
      }
    }
  }

  /** Height of the terrain at x, y. A fall from far above the ground hurts or kills the player. */
  async groundZ(player, x, y) {
    const lib = await this.link.rpc('cdo', 'KismetSystemLibrary');
    if (!lib) throw new AppError('trace_unavailable');
    const r = await this.link.rpc('call', lib.ptr, 'LineTraceSingle', player.pawn, `${x},${y},${TRACE_TOP}`, `${x},${y},${-TRACE_TOP}`, 0, 1, '-', 0, '-', 1, '-', '-', 0);
    return r.ReturnValue && r.OutHit && r.OutHit.ImpactPoint ? r.OutHit.ImpactPoint.Z : null;
  }

  /** The game's own teleport: it shows a loading screen, so far-away terrain can stream in. */
  async teleport(player, x, y, z) {
    let target = z;
    if (target === null || target === undefined) {
      const ground = await this.groundZ(player, x, y);
      if (ground === null) throw new AppError('no_ground');
      target = ground + ABOVE_GROUND;
    }
    const sys = (await this.link.rpc('find', 'TeleportationSubsystem', 1))[0];
    if (!sys) throw new AppError('teleport_unavailable');
    const params = `TargetLocation=${x},${y},${target};TargetRotation=0,${player.yaw || 0},0;bShowLoadingScreen=1;bNoCheck=1`;
    const r = await this.link.rpc('call', sys.ptr, 'TeleportWithParams', player.pawn, params, '-');
    if (!num(r)) throw new AppError('teleport_refused');
    return target;
  }

  /** Shows a line in the player's chat. ';' separates struct fields in the module's argument format. */
  async say(player, text) {
    const chat = await this.component(player.pc, 'PlayerChatComponent');
    await this.link.rpc('call', chat, 'Client_ReceiveChatMessage', `MessageBody=${String(text).replace(/;/g, ',')}`);
  }

  async spawnEnemy(enemyPath, near, x, y, z, radius, level) {
    const cdo = await this.link.rpc('cdo', 'AsyncAction_DomSpawnAI');
    if (!cdo) throw new AppError('spawn_unavailable');
    const action = await this.link.rpc('call', cdo.ptr, 'AsyncDomSpawnAI', near.pawn, near.pawn, near.pawn, `${x},${y},${z}`, radius, enemyPath, level);
    if (!action || !action.ReturnValue) throw new AppError('spawn_refused');
    await this.link.rpc('call', action.ReturnValue.ptr, 'Activate');
  }

  /** Tops up hunger, thirst or endurance. It never adds past the maximum: overeating has a penalty. */
  async refillSurvival(player, stat) {
    const s = SURVIVAL_STATS[stat];
    const comp = await this.component(player.pawn, s.comp);
    const current = num(await this.link.rpc('call', comp, s.current));
    const max = num(await this.link.rpc('call', comp, s.max));
    if (current < max) await this.link.rpc('call', comp, s.add, max - current, 0);
  }

  async clearSpellCooldowns(player) {
    const comp = await this.component(player.pawn, 'PlayerUtilityMagicComponent');
    return this.link.rpc('clearcooldowns', comp);
  }

  async kick(player, reason) {
    return this.link.rpc('kick', player.pc, reason || '');
  }
}

module.exports = { Game, normalizeSnapshot, SURVIVAL_STATS };
