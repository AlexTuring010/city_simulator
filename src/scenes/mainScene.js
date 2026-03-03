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
import { Store } from '../sim/store/Store.js';
import { Table } from '../sim/store/Table.js';

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
      const indoorsCapacity = Number(props.indoors_capacity ?? 0);
      const storeType = String(props.store_type ?? 'left_restaurant');

      if (!Number.isFinite(storeId)) continue;

      const store = new Store(this, this.GRID, t.x, t.y, {
        storeId,
        indoorsCapacity,
        storeType,
        MaxQueue: 2000
      });

      this.stores[storeId] = store;
    }

    // --- TABLES ---
    const tableObjects = map.getObjectLayer('tables')?.objects || [];
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

      const store = this.stores[belongsTo];
      if (store) store.addTable(table);
    }

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

    // --------------------------
    // Spawn NPCs
    // --------------------------
    const spawnerObjects = map.getObjectLayer('NPC_spawners')?.objects || [];
    this.npcs = {};

    if (spawnerObjects.length > 0) {
      const maxNPCs = 100;

      const wanderFactory = (scene, npc, GRID) =>
        new RandomWanderController(scene, npc, GRID, { minWaitMs: 800, maxWaitMs: 2500 });

      for (let i = 0; i < maxNPCs; i++) {
        const spawner = Phaser.Utils.Array.GetRandom(spawnerObjects);
        const t = this.GRID.objectToTile(spawner.x, spawner.y);

        const type = Math.random() < 0.5 ? 'type2' : 'type1';
        const npc = new NPC(this, this.GRID, t.x, t.y, { type });

        const strategy = new RandomRestaurantGoal(this, this.GRID, this.stores);

        const eatCtrl = new EatOutController(this, npc, this.GRID, this.stores, strategy, {
          eatMode: 'auto',
          queueLoiterRadius: 4,
          queueLoiterStepMinMs: 700,
          queueLoiterStepMaxMs: 1800,
          loiterMaxRadiusSearch: 25,
          postEatWanderMinMs: 5000,
          postEatWanderMaxMs: 12000,
          wanderFactory
        });

        npc.setController(eatCtrl);
        this.npcs[npc.id] = npc;
      }
    }

    // --------------------------
    // Simulator Camera Controls (improved)
    // --------------------------
    const cam = this.cameras.main;

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

    const minZoom = 0.5;
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
  },

  update(time, delta) {
    // Update NPCs
    Object.values(this.npcs).forEach(npc => npc.update());

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

    // --------------------------
    // Google Maps Heatmap update
    // (tilemap corners -> visible map corners)
    // --------------------------
    const heat = window.__GM_HEAT__;
    const tileToLatLngViewport = window.__tileToLatLngViewport__;

    // Google script loads async; mapping may not be ready yet
    if (!heat || !tileToLatLngViewport || !this.mapRef) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._heat.lastMs < this._heat.throttleMs) return;
    this._heat.lastMs = now;

    const mapW = this.mapRef.width;   // tiles
    const mapH = this.mapRef.height;  // tiles

    const pts = [];

    for (const npc of Object.values(this.npcs)) {
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

    heat.setData(pts);
  }
};