// src/scenes/mainScene.js

/**
 * Main Scene (Simulator) — Factory
 * ---------------------------------
 * createMainScene(opts) returns a fresh Phaser scene config object.
 * Each call produces an isolated instance for A/B testing.
 */

import { NPC } from '../sim/npc/index.js';
import { makeGridIso } from '../grid/gridIso.js';
import { EatOutController } from '../sim/controllers/EatOutController.js';
import { RandomWanderController } from '../sim/controllers/RandomWanderController.js';
import { NearestRestaurantGoal } from '../strategies/NearestRestaurantGoal.js';
import { Store } from '../sim/store/Store.js';
import { Table } from '../sim/store/Table.js';
import { buildRestaurantNavFields } from '../pathfinding/buildStoreNavFields.js';
import { assignAutoIndoorsCapacities } from '../sim/store/assignAutoCapacities.js';
import { EpisodeManager } from '../sim/episodes/EpisodeManager.js';

export function createMainScene({
  simKey = 'baseline',
  strategyFactory = null,
  hudElementId = 'hud-npcs',
  onEpisodeEnd = null,
  onLiveUpdate = null,
  population = 2000,
  deferStart = false,
  onReady = null,
  autoRestart = true,
} = {}) {
  return {
    key: 'MainScene',

    collisionLayer: null,
    wallSprites: [],
    npcs: {},
    mapRef: null,
    GRID: null,
    stores: null,
    _simKey: simKey,

    // camera drag state
    _camDrag: null,

    preload() {
      const mapData = this.cache.tilemap.get('map').data;

      // Load tilesets as spritesheets
      mapData.tilesets.forEach(ts => {
        const filename = ts.image.split(/[\/\\]/).pop();
        const assetPath = 'assets/' + filename;
        this.load.spritesheet(ts.name, assetPath, {
          frameWidth: ts.tilewidth,
          frameHeight: ts.tileheight
        });
      });

      // NPC spritesheets
      this.load.spritesheet('npc_sprite', 'assets/person_tiles.png', { frameWidth: 32, frameHeight: 32 });
      this.load.spritesheet('npc_sprite2', 'assets/person_tiles2.png', { frameWidth: 32, frameHeight: 32 });
      this.load.spritesheet('npc_sprite3', 'assets/person_tiles3.png', { frameWidth: 32, frameHeight: 32 });

      // Store and table spritesheets
      this.load.spritesheet('stores', 'assets/stores_160x138.png', { frameWidth: 160, frameHeight: 138 });
      this.load.spritesheet('table', 'assets/tables.png', { frameWidth: 32, frameHeight: 32 });
    },

    create() {
      // Seed RNG if provided via registry (deterministic A/B)
      const seed = this.game.registry.get('rngSeed');
      if (seed) Phaser.Math.RND.sow([seed]);

      // Init per-instance throttling state
      this._heat = {
        lastMs: 0,
        throttleMs: 150,
        base1Tiles: true
      };

      this._hudNpcEl = document.getElementById(hudElementId);
      this._hudLastMs = 0;
      this._hudThrottleMs = 150;

      this._liveStatsLastMs = 0;
      this._liveStatsThrottleMs = 2000;

      const map = this.make.tilemap({ key: 'map' });
      this.mapRef = map;

      map.tilesets.forEach(ts => map.addTilesetImage(ts.name, ts.name));
      const tileset = map.tilesets;

      // Layers
      const floorLayer = map.createLayer('floors', tileset);
      if (floorLayer) floorLayer.setDepth(-1000);

      this.collisionLayer = map.createLayer('collides', tileset);
      if (this.collisionLayer) this.collisionLayer.setVisible(false);

      // World origin for iso projection
      const originX = 16;
      const originY = 16;

      // Build the single source-of-truth adapter
      this.GRID = makeGridIso(map, this.collisionLayer, originX, originY);

      // gid -> (key, frame)
      const gidMap = {};
      map.tilesets.forEach(ts => {
        for (let i = 0; i < ts.total; i++) {
          gidMap[ts.firstgid + i] = { key: ts.name, frame: i };
        }
      });

      // Create isometric sprite from a Tiled tile-object (gid)
      const createIsoSprite = (object) => {
        const mappedInfo = gidMap[object.gid];
        if (!mappedInfo) return null;

        let isVisible = true;
        if (object.properties) {
          if (Array.isArray(object.properties)) {
            const prop = object.properties.find(p => p.name.toLowerCase() === 'isvisible');
            if (prop) isVisible = prop.value !== false;
          } else if (object.properties.IsVisible !== undefined) {
            isVisible = object.properties.IsVisible !== false;
          }
        }
        if (!isVisible) return null;

        const t = this.GRID.objectToTile(object.x, object.y);
        const p = this.GRID.tileToWorld(t.x, t.y);

        const sprite = this.add.sprite(p.x, p.y, mappedInfo.key, mappedInfo.frame);
        sprite.setOrigin(0.5, 1);

        let depthOffset = 0;
        if (object.properties) {
          if (Array.isArray(object.properties)) {
            const prop = object.properties.find(p => p.name.toLowerCase() === 'depthoffset');
            if (prop) depthOffset = prop.value;
          } else if (object.properties.DepthOffset !== undefined) {
            depthOffset = object.properties.DepthOffset;
          }
        }

        sprite.setDepth(sprite.y - depthOffset);
        return sprite;
      };

      // Walls
      const wallObjects = map.getObjectLayer('walls')?.objects || [];
      this.wallSprites = [];
      wallObjects.forEach(obj => {
        const s = createIsoSprite(obj);
        if (s) this.wallSprites.push(s);
      });

      // --- STORES ---
      const storeObjects = map.getObjectLayer('stores')?.objects || [];
      this.stores = {};

      for (const obj of storeObjects) {
        const t = this.GRID.objectToTile(obj.x, obj.y);

        const props = {};
        if (Array.isArray(obj.properties)) {
          for (const p of obj.properties) props[p.name] = p.value;
        } else if (obj.properties) {
          Object.assign(props, obj.properties);
        }

        const storeId = Number(props.store_id);
        const indoorsCapacity = 0;
        const storeType = String(props.store_type ?? 'left_restaurant');

        if (!Number.isFinite(storeId)) continue;

        const store = new Store(this, this.GRID, t.x, t.y, {
          storeId,
          indoorsCapacity,
          storeType,
        });

        this.stores[storeId] = store;
      }

      // --- TABLES ---
      const tableObjects = map.getObjectLayer('tables')?.objects || [];
      this.tables = [];
      for (const obj of tableObjects) {
        const t = this.GRID.objectToTile(obj.x, obj.y);

        const props = {};
        if (Array.isArray(obj.properties)) {
          for (const p of obj.properties) props[p.name] = p.value;
        } else if (obj.properties) {
          Object.assign(props, obj.properties);
        }

        const belongsTo = Number(props.belongs_to);
        if (!Number.isFinite(belongsTo)) continue;

        const frame = Number(props.has_chairs ?? 1) ? 1 : 0;

        const table = new Table(this, this.GRID, t.x, t.y, { belongsTo, frame });

        this.tables.push(table);

        const store = this.stores[belongsTo];
        if (store) store.addTable(table);
      }

      const maxNPCs = population;

      assignAutoIndoorsCapacities(this.stores, maxNPCs, {
        storeTypes: ['left_restaurant', 'right_restaurant'],
        seatsPerTable: 2,
        maxExtraAbs: 20,
        maxExtraMult: 1.0
      });

      const restaurants = Object.values(this.stores).filter(s => s.storeType.includes('restaurant'));
      restaurants.sort((a,b) => a.storeId - b.storeId);

      console.warn(`[${simKey}] RESTAURANT SUMMARY:`);
      console.table(restaurants.map(s => ({
        id: s.storeId,
        tables: (s.tables?.length ?? 0),
        goal: s.goalTile ? `${s.goalTile.x},${s.goalTile.y}` : '',
        indoorsCapacity: s.indoorsCapacity
      })));

      // --- Build per-restaurant nav fields ---
      const mapW = this.mapRef.width;
      const mapH = this.mapRef.height;

      buildRestaurantNavFields(this.GRID, this.stores, mapW, mapH, {
        storeTypes: ['left_restaurant', 'right_restaurant'],
        closestTileMaxRadius: 50,
        allowSame: true,
        allowWeakCollision: false
      });

      // --------------------------
      // NPC animations
      // --------------------------
      this.anims.create({ key: 'npc_walk_down',  frames: this.anims.generateFrameNumbers('npc_sprite',  { start: 0,  end: 4  }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_right', frames: this.anims.generateFrameNumbers('npc_sprite',  { start: 5,  end: 9  }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_up',    frames: this.anims.generateFrameNumbers('npc_sprite',  { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_left',  frames: this.anims.generateFrameNumbers('npc_sprite',  { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

      this.anims.create({ key: 'npc_walk_down2',  frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 0,  end: 4  }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_right2', frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 5,  end: 9  }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_up2',    frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_left2',  frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

      this.anims.create({ key: 'npc_walk_down3',  frames: this.anims.generateFrameNumbers('npc_sprite3', { start: 0,  end: 4  }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_right3', frames: this.anims.generateFrameNumbers('npc_sprite3', { start: 5,  end: 9  }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_up3',    frames: this.anims.generateFrameNumbers('npc_sprite3', { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
      this.anims.create({ key: 'npc_walk_left3',  frames: this.anims.generateFrameNumbers('npc_sprite3', { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

      // --------------------------
      // Spawn NPCs
      // --------------------------
      const spawnerObjects = map.getObjectLayer('NPC_spawners')?.objects || [];

      this.episode = new EpisodeManager(this, {
        GRID: this.GRID,
        stores: this.stores,
        spawners: spawnerObjects,
        wanderFactory: (scene, npc, GRID) =>
          new RandomWanderController(scene, npc, GRID, { minWaitMs: 800, maxWaitMs: 2500 }),
        strategyFactory: strategyFactory ||
          ((scene, G, st) => new NearestRestaurantGoal(scene, G, st)),
        onEpisodeEnd: onEpisodeEnd,
        autoRestart,
      });

      this._episodeCfg = {
        population: maxNPCs,
        spawnMode: 'rate',
        spawnRatePerSec: 80,
        maxEpisodeMs: 5 * 60_000
      };

      if (deferStart) {
        onReady?.(this);
      } else {
        this.episode.startEpisode(this._episodeCfg);
      }

      // --------------------------
      // Simulator Camera Controls
      // --------------------------
      const cam = this.cameras.main;

      cam.roundPixels = true;

      const PAD = 2000;
      cam.setBounds(
        -PAD,
        -PAD,
        map.widthInPixels + PAD * 2,
        map.heightInPixels + PAD * 2
      );

      this.input.setDefaultCursor('grab');
      this.input.mouse.disableContextMenu();

      this._camDrag = {
        isDragging: false,
        vx: 0,
        vy: 0
      };

      this.input.on('pointerdown', (pointer) => {
        if (pointer.leftButtonDown() || pointer.rightButtonDown()) {
          this._camDrag.isDragging = true;
          this._camDrag.vx = 0;
          this._camDrag.vy = 0;
          this.input.setDefaultCursor('grabbing');
        }
      });

      this.input.on('pointerup', () => {
        this._camDrag.isDragging = false;
        this.input.setDefaultCursor('grab');
      });

      this.input.on('pointermove', (pointer) => {
        if (!this._camDrag.isDragging) return;

        const dx = (pointer.x - pointer.prevPosition.x) / cam.zoom;
        const dy = (pointer.y - pointer.prevPosition.y) / cam.zoom;

        cam.scrollX -= dx;
        cam.scrollY -= dy;

        this._camDrag.vx = -dx;
        this._camDrag.vy = -dy;
      });

      const minZoom = 0.2;
      const maxZoom = 2.0;
      const zoomStep = 0.1;

      this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
        const oldZoom = cam.zoom;
        const newZoom = Phaser.Math.Clamp(
          oldZoom + (deltaY > 0 ? -zoomStep : zoomStep),
          minZoom,
          maxZoom
        );
        if (newZoom !== oldZoom) cam.setZoom(newZoom);
      });

      let width = this.GRID.tileToWorld(map.width + 1, map.height + 1).x + originX;
      let height = this.GRID.tileToWorld(map.width + 1, map.height + 1).y + originY;
      cam.centerOn((width / 2) + 50, (height / 2) + 100);
    },

    update(time, delta) {
      // Update episode manager
      this.episode?.update?.();

      // Update NPCs
      if (this.episode?.activeNpcs) {
        for (const npc of this.episode.activeNpcs.values()) {
          npc.update();
        }
      }

      // Camera inertia
      if (!this._camDrag) return;

      const cam = this.cameras.main;

      if (!this._camDrag.isDragging) {
        const friction = 0.90;

        this._camDrag.vx *= friction;
        this._camDrag.vy *= friction;

        if (Math.abs(this._camDrag.vx) < 0.01) this._camDrag.vx = 0;
        if (Math.abs(this._camDrag.vy) < 0.01) this._camDrag.vy = 0;

        if (this._camDrag.vx || this._camDrag.vy) {
          cam.scrollX += this._camDrag.vx;
          cam.scrollY += this._camDrag.vy;
        }
      }

      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - this._hudLastMs > this._hudThrottleMs) {
        this._hudLastMs = now;
        const count = this.episode?.activeNpcs?.size ?? 0;
        if (this._hudNpcEl) this._hudNpcEl.textContent = `NPCs: ${count}`;
      }

      // --------------------------
      // Live stats collection
      // --------------------------
      if (onLiveUpdate && this.episode?.running
          && now - this._liveStatsLastMs > this._liveStatsThrottleMs) {
        this._liveStatsLastMs = now;
        const liveNpcStats = [];
        for (const npc of this.episode.activeNpcs.values()) {
          if (npc?.episodeStats) liveNpcStats.push({ id: npc.id, ...npc.episodeStats });
        }
        const liveStoreStats = {};
        for (const [id, store] of Object.entries(this.stores)) {
          if (typeof store.getEpisodeStats === 'function')
            liveStoreStats[id] = store.getEpisodeStats();
        }
        onLiveUpdate(liveNpcStats, liveStoreStats);
      }

      // --------------------------
      // Google Maps Heatmap update
      // --------------------------
      const simData = window.__simMaps__?.[simKey];
      const heat = simData?.heatmap;
      const tileToLatLngViewport = simData?.tileToLatLng;

      if (!heat || !tileToLatLngViewport || !this.mapRef) return;

      if (now - this._heat.lastMs < this._heat.throttleMs) return;
      this._heat.lastMs = now;

      const mapW = this.mapRef.width;
      const mapH = this.mapRef.height;

      const pts = [];

      const npcsIter = this.episode?.activeNpcs?.values?.();
      if (npcsIter) {
        for (const npc of npcsIter) {
          const ll = tileToLatLngViewport(
            npc.tileX,
            npc.tileY,
            mapW,
            mapH,
            { base1: this._heat.base1Tiles }
          );

          if (!ll) continue;

          pts.push({
            location: ll,
            weight: 1
          });
        }
      }

      heat.setData(pts);
    }
  };
}

// Backward compat
export const mainScene = createMainScene();
