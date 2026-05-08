// ===========================================
// DOWN PLAYER SYSTEM
// ===========================================

import { system, world, TicksPerSecond } from '@minecraft/server';
import { Config } from 'system/config.js';

// ===========================================
// CONFIG
// ===========================================

const DOWN_TIME_GROUND = 30;
const DOWN_TIME_WATER = 20;

const UPDATE_INTERVAL = 1;

// ⚙️ Configure o item de resgate aqui
const REVIVE_ITEM = 'minecraft:golden_apple';

// Distância máxima para resgatar agachando
const REVIVE_CROUCH_DISTANCE = 2.5;

// Tempo agachado necessário para resgatar (em segundos)
const REVIVE_CROUCH_TIME = 3;

// ===========================================
// STORAGE
// ===========================================

/**
 * player.id => {
 *    player,
 *    timer,
 *    mode,
 *    lastBlock,
 *    grounded,
 *    reviveProgress: Map<rescuerId, secondsHeld>
 * }
 */
const downPlayers = new Map();

// ===========================================
// MAIN CLASS
// ===========================================

export class DownPlayer {
  static init() {
    this.deathDetection();
    this.rescueDetection();
    this.updateLoop();
  }

  // ===========================================
  // DAMAGE / DEATH DETECTION
  // ===========================================

  static deathDetection() {
    world.beforeEvents.entityHurt.subscribe(event => {
      const player = event.hurtEntity;

      if (player.typeId !== 'minecraft:player') return;
      if (player.hasTag('dead_final')) return;

      const health = player.getComponent('minecraft:health');
      if (!health) return;

      const finalHealth = health.currentValue - event.damage;

      // Queda com dano > 100 = morte instantânea
      if (event.damageSource.cause === 'fall' && event.damage > 100) return;

      if (finalHealth <= 0) {
        event.cancel = true;

        system.run(() => {
          health.setCurrentValue(1);
          this.startDown(player);
        });
      }
    });
  }

  // ===========================================
  // RESCUE DETECTION — ITEM
  // ===========================================

  // DEPOIS ✅
  static rescueDetection() {
    world.beforeEvents.itemUse.subscribe(event => {
      const rescuer = event.source;

      if (rescuer.typeId !== 'minecraft:player') return;
      if (rescuer.hasTag(Config.tag_down)) return;

      const item = event.itemStack;
      if (!item || item.typeId !== REVIVE_ITEM) return;

      const target = this.getNearestDown(rescuer, REVIVE_CROUCH_DISTANCE);
      if (!target) return;

      event.cancel = true;

      system.run(() => {
        this.revivePlayer(target);
      });
    });
  }

  // ===========================================
  // START DOWN STATE
  // ===========================================

  static startDown(player) {
    if (downPlayers.has(player.id)) return;

    const mode = this.detectEnvironment(player);

    // Lava = morte instantânea, sem estado down
    if (mode === 'lava') {
      this.killPlayer(player);
      return;
    }

    let timer = DOWN_TIME_GROUND;
    if (mode === 'water') timer = DOWN_TIME_WATER;

    player.addTag(Config.tag_down);

    this.applyDownEffects(player, mode);

    downPlayers.set(player.id, {
      player,
      timer,
      mode,
      lastBlock: null,
      grounded: false,
      reviveProgress: new Map(),
    });
  }

  // ===========================================
  // DETECT ENVIRONMENT
  // ===========================================

  static detectEnvironment(player) {
    const loc = player.location;
    const block = player.dimension.getBlock({
      x: Math.floor(loc.x),
      y: Math.floor(loc.y),
      z: Math.floor(loc.z),
    });

    if (!block) return 'ground';

    if (block.isLiquid) {
      return block.typeId.includes('lava') ? 'lava' : 'water';
    }

    return 'ground';
  }

  // ===========================================
  // APPLY EFFECTS
  // ===========================================

  static applyDownEffects(player, mode) {
    // Água: imobiliza até tocar o fundo
    if (mode === 'water') {
      player.runCommand('inputpermission set @s movement disabled');
      return;
    }

    // Ar: imobiliza até tocar o chão
    if (!player.isOnGround) {
      player.runCommand('inputpermission set @s movement disabled');
      return;
    }

    // Chão: animação de rastejo
    player.runCommand('playanimation @s animation.player.swim');
  }

  // ===========================================
  // UPDATE LOOP
  // ===========================================

  static updateLoop() {
    system.runInterval(() => {
      for (const [id, data] of downPlayers) {
        const player = data.player;

        // ===================================
        // INVALID PLAYER
        // ===================================

        if (!player?.isValid) {
          this.cleanup(id);
          continue;
        }

        // ===================================
        // AR / ÁGUA -> AGUARDA TOCAR O CHÃO
        // ===================================

        if (!data.grounded && player.isOnGround) {
          data.grounded = true;

          player.runCommand('inputpermission set @s movement enabled');
          player.runCommand('effect @s slowness 1 2 true');

          // Água: ao tocar o fundo coloca o bloco imediatamente
          if (data.mode === 'water') {
            this.updateFollowBlock(player, data);
          }
        }
        // ===================================
        // MONITOR AMBIENTE (agua durante down)
        // ===================================

        this.updateEnvironment(player, data);
        // ===================================
        // BLOCK FOLLOW
        // ===================================

        this.updateFollowBlock(player, data);

        // ===================================
        // CROUCH RESCUE PROGRESS
        // ===================================

        this.updateCrouchRevive(data);

        // ===================================
        // ACTIONBAR
        // ===================================

        const reviving = this.getRevivingRescuer(data);

        if (reviving) {
          const progress = data.reviveProgress.get(reviving.id) ?? 0;
          const remaining = REVIVE_CROUCH_TIME - progress;

          player.onScreenDisplay.setActionBar(
            `§aSendo resgatado: §f${remaining.toFixed(1)}s`
          );
        } else {
          player.onScreenDisplay.setActionBar(
            `§cSangrando: §f${data.timer.toFixed(1)}s`
          );
        }

        // ===================================
        // TIMER
        // ===================================

        data.timer -= UPDATE_INTERVAL / TicksPerSecond;

        // ===================================
        // MORTE
        // ===================================

        if (data.timer <= 0) {
          this.killPlayer(player);
          this.cleanup(id);
        }
      }
    }, UPDATE_INTERVAL);
  }

  // ===========================================
  // CROUCH REVIVE UPDATE
  // ===========================================

  static updateCrouchRevive(data) {
    const downPlayer = data.player;

    for (const rescuer of world.getAllPlayers()) {
      if (rescuer.id === downPlayer.id) continue;
      if (rescuer.hasTag(Config.tag_down)) continue;

      const dist = this.distance(rescuer.location, downPlayer.location);

      if (!rescuer.isSneaking || dist > REVIVE_CROUCH_DISTANCE) {
        data.reviveProgress.delete(rescuer.id);
        continue;
      }

      const prev = data.reviveProgress.get(rescuer.id) ?? 0;
      const next = prev + UPDATE_INTERVAL / TicksPerSecond;

      data.reviveProgress.set(rescuer.id, next);

      rescuer.onScreenDisplay.setActionBar(
        `§eResgatando ${downPlayer.name}: §f${Math.max(0, REVIVE_CROUCH_TIME - next).toFixed(1)}s`
      );

      if (next >= REVIVE_CROUCH_TIME) {
        this.revivePlayer(downPlayer);
        return;
      }
    }
  }

  // ===========================================
  // GET NEAREST DOWN PLAYER
  // ===========================================

  static getNearestDown(rescuer, maxDist) {
    let nearest = null;
    let bestDist = Infinity;

    for (const [, data] of downPlayers) {
      const d = this.distance(rescuer.location, data.player.location);

      if (d <= maxDist && d < bestDist) {
        nearest = data.player;
        bestDist = d;
      }
    }

    return nearest;
  }

  // ===========================================
  // GET REVIVING RESCUER (para o actionbar)
  // ===========================================

  static getRevivingRescuer(data) {
    for (const rescuer of world.getAllPlayers()) {
      if (data.reviveProgress.has(rescuer.id)) return rescuer;
    }
    return null;
  }

  // ===========================================
  // REVIVE PLAYER
  // ===========================================

  static revivePlayer(player) {
    const id = player.id;
    if (!downPlayers.has(id)) return;

    const health = player.getComponent('minecraft:health');
    if (health) health.setCurrentValue(4); // 2 corações ao reviver

    this.cleanup(id);

    player.onScreenDisplay.setActionBar('§aVocê foi resgatado!');
  }

  // ===========================================
  // UPDATE ENVIRONMENT
  // ===========================================

  static updateEnvironment(player, data) {
    const currentMode = this.detectEnvironment(player);

    // Entrou na lava durante o down = morte
    if (currentMode === 'lava') {
      this.killPlayer(player);
      this.cleanup(player.id);
      return;
    }

    // Entrou na água durante o down = imobiliza
    if (currentMode === 'water' && data.mode !== 'water') {
      data.mode = 'water';
      data.grounded = false;

      player.runCommand('inputpermission set @s movement disabled');
      player.runCommand('effect @s slowness infinite 2 true'); // cancela slowness anterior se havia

      // Remove bloco da cabeça caso estivesse no chão antes
      if (data.lastBlock) {
        const block = player.dimension.getBlock(data.lastBlock);
        if (block && block.typeId === Config.down_block) {
          player.dimension.setBlockType(data.lastBlock, 'minecraft:air');
        }
        data.lastBlock = null;
      }

      return;
    }

    // Saiu da água e tocou o chão = volta ao modo ground
    if (
      data.mode === 'water' &&
      currentMode === 'ground' &&
      player.isOnGround
    ) {
      data.mode = 'ground';
    }
  }
  // ===========================================
  // BLOCK FOLLOW SYSTEM
  // ===========================================

  static updateFollowBlock(player, data) {
    // Funciona para chão e água (após grounded)
    if (data.mode !== 'ground' && data.mode !== 'water') return;
    if (!player.isOnGround) return;

    const dimension = player.dimension;
    const loc = player.location;
    const floorY = Math.floor(loc.y);
    const x = Math.floor(loc.x);
    const z = Math.floor(loc.z);

    const headLoc = { x, y: floorY + 1, z };
    const groundLoc = { x, y: floorY - 1, z };

    const headBlock = dimension.getBlock(headLoc);
    const groundBlock = dimension.getBlock(groundLoc);

    if (!headBlock || !groundBlock) return;
    if (groundBlock.isAir) return;
    if (!headBlock.isAir && headBlock.typeId !== Config.down_block) return;

    if (data.lastBlock) {
      const oldBlock = dimension.getBlock(data.lastBlock);
      if (oldBlock && oldBlock.typeId === Config.down_block) {
        dimension.setBlockType(data.lastBlock, 'minecraft:air');
      }
    }

    dimension.setBlockType(headLoc, Config.down_block);
    data.lastBlock = headLoc;
  }

  // ===========================================
  // KILL PLAYER
  // ===========================================

  static killPlayer(player) {
    player.addTag('dead_final');

    player.runCommand('damage @s 99999 override');

    system.runTimeout(() => {
      if (player?.isValid) player.removeTag('dead_final');
    }, 20);
  }

  // ===========================================
  // CLEANUP
  // ===========================================

  static cleanup(id) {
    const data = downPlayers.get(id);
    if (!data) return;

    const player = data.player;

    if (data.lastBlock && player?.isValid) {
      const dimension = player.dimension;
      const block = dimension.getBlock(data.lastBlock);

      if (block && block.typeId === Config.down_block) {
        dimension.setBlockType(data.lastBlock, 'minecraft:air');
      }
    }

    if (player?.isValid) {
      player.runCommand('effect @s clear');
      player.runCommand('inputpermission set @s movement enabled');
      player.runCommand('inputpermission set @s camera enabled');
      player.removeTag(Config.tag_down);
    }

    downPlayers.delete(id);
  }

  // ===========================================
  // UTILS
  // ===========================================

  static distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
