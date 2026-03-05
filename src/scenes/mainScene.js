// src/scenes/mainScene.js

/**
 * Main Scene (Simulator)
 * ----------------------
 * - No player
 * - Drag to pan (nice feel + cursor changes)
 * - Mouse wheel zoom (normal zoom, NOT towards cursor)
 * - Optional inertia + padded bounds so you can pan freely
 * - Google Maps Heatmap: map tilemap corners -> visible map corners
 */

import { NPC } from '../sim/npc/index.js';
import { makeGridIso } from '../grid/gridIso.js';
import { EatOutController } from '../sim/controllers/EatOutController.js';
import { RandomWanderController } from '../sim/controllers/RandomWanderController.js';
import { RandomRestaurantGoal } from '../strategies/RandomRestaurantGoal.js';
import { NearestRestaurantGoal } from '../strategies/NearestRestaurantGoal.js';
import { Store } from '../sim/store/Store.js';
import { Table } from '../sim/store/Table.js';
import { buildRestaurantNavFields } from '../pathfinding/buildStoreNavFields.js';
import { assignAutoIndoorsCapacities } from '../sim/store/assignAutoCapacities.js';
import { EpisodeManager } from '../sim/episodes/EpisodeManager.js';

export const mainScene = {
  key: 'MainScene',

  collisionLayer: null,
  wallSprites: [],
  npcs: {},
  mapRef: null,
  GRID: null,
  stores: null,

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
    // Init per-instance throttling state HERE (important in Phaser)
    this._heat = {
      lastMs: 0,
      throttleMs: 150, // tune: 80..300ms
      base1Tiles: true // your GRID comment suggests base-1 tile coords
    };

    this._hudNpcEl = document.getElementById('hud-npcs');
    this._hudLastMs = 0;
    this._hudThrottleMs = 150;

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

      // ---- Check IsVisible property ----
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

      // Convert snapped object position -> base-1 tile coords
      const t = this.GRID.objectToTile(object.x, object.y);

      // Convert tile coords -> world
      const p = this.GRID.tileToWorld(t.x, t.y);

      const sprite = this.add.sprite(p.x, p.y, mappedInfo.key, mappedInfo.frame);
      sprite.setOrigin(0.5, 1);

      // Optional custom depth offset from Tiled properties
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
    this.stores = {}; // store_id -> Store

    for (const obj of storeObjects) {
      const t = this.GRID.objectToTile(obj.x, obj.y);

      const props = {};
      if (Array.isArray(obj.properties)) {
        for (const p of obj.properties) props[p.name] = p.value;
      } else if (obj.properties) {
        Object.assign(props, obj.properties);
      }

      const storeId = Number(props.store_id);
      const indoorsCapacity = 0; // will be auto-assigned later based on tables
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
    this.tables = []; // flat list of all tables (for easy iteration); also linked from stores
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

    const maxNPCs = 2000;

    assignAutoIndoorsCapacities(this.stores, maxNPCs, {
      storeTypes: ['left_restaurant', 'right_restaurant'],
      seatsPerTable: 2,

      // cap policy:
      // 10 tables => 20 seats => max extra is max(20, 20*1.0)=20 => cap 40 (prevents 80)
      maxExtraAbs: 20,
      maxExtraMult: 1.0
    });

    const restaurants = Object.values(this.stores).filter(s => s.storeType.includes('restaurant'));
    restaurants.sort((a,b) => a.storeId - b.storeId);

    console.warn("RESTAURANT SUMMARY:");

    console.table(restaurants.map(s => ({
      id: s.storeId,
      tables: (s.tables?.length ?? 0),
      goal: s.goalTile ? `${s.goalTile.x},${s.goalTile.y}` : '',
      indoorsCapacity: s.indoorsCapacity
    })));

    // --- Build per-restaurant nav fields AFTER tables (blocked tiles finalized) ---
    const mapW = this.mapRef.width;   // tiles
    const mapH = this.mapRef.height;  // tiles
    

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
        new RandomWanderController(scene, npc, GRID, { minWaitMs: 800, maxWaitMs: 2500 })
    });

    // start first episode
    this.episode.startEpisode({
      population: maxNPCs,       // you already have this
      spawnMode: 'rate',         // or 'waves'
      spawnRatePerSec: 80,       // tune
      maxEpisodeMs: 5 * 60_000
    });

    // --------------------------
    // Simulator Camera Controls (improved)
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
    // Update episode manager (spawning, episode state)
    this.episode?.update?.();

    // Update NPCs (episode-driven)
    if (this.episode?.activeNpcs) {
      for (const npc of this.episode.activeNpcs.values()) {
        npc.update();
      }
    }

    // ---------------- DEBUG: print remaining NPCs ----------------
   /*
    const npcs = this.episode?.activeNpcs;

    if (npcs && npcs.size <= 10) {
      for (const npc of npcs.values()) {
        const ctrl = npc.getController?.();
        console.warn(`[NPC DEBUG]`, {
          id: npc.id,
          npcState: npc.state,
          busy: npc.isBusy?.(),
          isInside: npc.isInside,
          tile: [npc.tileX, npc.tileY],
          goal: npc._goal,
          targetNode: npc.targetNode,

          controller: ctrl?.constructor?.name,
          ctrlState: ctrl?.state,
          ctrlActive: ctrl?._active,
          ctrlHasTimer: !!ctrl?._timer,
          ctrlHasQueueTimer: !!ctrl?._queueTimer,
          ctrlHasHandoffTimer: !!ctrl?._handoffTimer,
          storeId: ctrl?.store?.storeId ?? null,
          assignKind: ctrl?._assignment?.kind ?? null,
          meals: ctrl?._mealsEaten ?? null,
          mealsMax: ctrl?._mealsBeforeDespawn ?? null
        });
      }
    }*/

    // Camera inertia (smooth glide) when not dragging
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
    // Google Maps Heatmap update
    // (tilemap corners -> visible map corners)
    // --------------------------
    const heat = window.__GM_HEAT__;
    const tileToLatLngViewport = window.__tileToLatLngViewport__;

    // Google script loads async; mapping may not be ready yet
    if (!heat || !tileToLatLngViewport || !this.mapRef) return;

    if (now - this._heat.lastMs < this._heat.throttleMs) return;
    this._heat.lastMs = now;

    const mapW = this.mapRef.width;   // tiles
    const mapH = this.mapRef.height;  // tiles

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