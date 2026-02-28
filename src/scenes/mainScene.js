// src/scenes/mainScene.js

/**
 * Main Scene
 * ----------
 * Owns Phaser concerns (map, layers, sprites, input).
 * Uses GRID as the single source of truth for:
 * - object snapping -> base-1 tile coords
 * - base-1 tile -> world pixels
 * - collision queries (via GRID.isBlocked when needed)
 */
import { NPC } from '../sim/npc/index.js';
import { makeGridIso } from '../grid/gridIso.js';
import { EatOutController } from '../sim/controllers/EatOutController.js';
import { RandomWanderController } from '../sim/controllers/RandomWanderController.js';
import { RandomRestaurantGoal } from '../strategies/RandomRestaurantGoal.js';
import { Store, STORE_EVENTS } from '../sim/store/Store.js';
import { Table } from '../sim/store/Table.js';

export const mainScene = {
  key: 'MainScene',

  // --------------------------
  // Scene-level state
  // --------------------------
  mascot: null,
  cursors: null,
  collisionLayer: null,
  wallSprites: [],
  npcs: {},
  mapRef: null,
  GRID: null,

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

    // NPC spritesheet
    this.load.spritesheet('npc_sprite', 'assets/person_tiles.png', {
      frameWidth: 32,
      frameHeight: 32
    });
    this.load.spritesheet('npc_sprite2', 'assets/person_tiles2.png', {
      frameWidth: 32,
      frameHeight: 32
    });

    // Store and table spritesheets 
    this.load.spritesheet('stores', 'assets/stores_160x138.png', {
      frameWidth: 160,
      frameHeight: 138
    });

    this.load.spritesheet('table', 'assets/tables.png', {
      frameWidth: 32,
      frameHeight: 32
    });
  },

  create() {
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
          const prop = object.properties.find(
            p => p.name.toLowerCase() === 'isvisible'
          );
          if (prop) isVisible = prop.value !== false;
          console.log('Found IsVisible property in array properties');
        } else if (object.properties.IsVisible !== undefined) {
          isVisible = object.properties.IsVisible !== false;
          console.log('Found IsVisible property in non-array properties; consider using array format for consistency');
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

    // Player
    const playerObjects = map.getObjectLayer('Player')?.objects || [];
    if (playerObjects.length > 0) {
      this.mascot = createIsoSprite(playerObjects[0]);
      if (this.mascot) this.cameras.main.startFollow(this.mascot, true, 0.1, 0.1);
    }

    // --- STORES ---
    const storeObjects = map.getObjectLayer('stores')?.objects || [];
    this.stores = {}; // store_id -> Store

    for (const obj of storeObjects) {
      // objects are indicators; we construct stores from them
      const t = this.GRID.objectToTile(obj.x, obj.y);

      // read properties safely
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
        storeType
      });

      // (optional) listen to queue ready signals
      store.on(STORE_EVENTS.READY, ({ npc }) => {
        // This is the handshake: store says "you can enter now".
        // NPC-side logic decides whether to accept.
        // Example auto-accept:
        store.acceptInvite(npc);
        store.moveNpcIndoors(npc).catch(() => {
          // if movement failed, free spot for others (since we didn't actually add indoors)
          store._onSpotFreed?.();
        });
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

      // choose frame: 0 = no chairs, 1 = chairs (adjust to match your png)
      const frame = Number(props.has_chairs ?? 1) ? 1 : 0;

      const table = new Table(this, this.GRID, t.x, t.y, { belongsTo, frame });

      const store = this.stores[belongsTo];
      if (store) store.addTable(table);
    }
    
    // Input
    this.cursors = this.input.keyboard.createCursorKeys();

    // NPC animations
    this.anims.create({ key: 'npc_walk_down',  frames: this.anims.generateFrameNumbers('npc_sprite', { start: 0,  end: 4  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_right', frames: this.anims.generateFrameNumbers('npc_sprite', { start: 5,  end: 9  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_up',    frames: this.anims.generateFrameNumbers('npc_sprite', { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_left',  frames: this.anims.generateFrameNumbers('npc_sprite', { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

    this.anims.create({ key: 'npc_walk_down2',  frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 0,  end: 4  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_right2', frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 5,  end: 9  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_up2',    frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_left2',  frames: this.anims.generateFrameNumbers('npc_sprite2', { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

    // Spawn NPCs
    const spawnerObjects = map.getObjectLayer('NPC_spawners')?.objects || [];
    this.npcs = {};

    if (spawnerObjects.length > 0) {
      const maxNPCs = 200;

      // Factory keeps EatOutController independent
      const wanderFactory = (scene, npc, GRID) =>
      new RandomWanderController(scene, npc, GRID, { minWaitMs: 800, maxWaitMs: 2500 });

      for (let i = 0; i < maxNPCs; i++) {
        const spawner = Phaser.Utils.Array.GetRandom(spawnerObjects);
        const t = this.GRID.objectToTile(spawner.x, spawner.y);

        // 50 / 50 split
        const type = Math.random() < 0.5 ? 'type2' : 'type1';

        const npc = new NPC(this, this.GRID, t.x, t.y, { type });

        window.debugNpc = npc;
        window.debugScene = this.scene;
        // Each NPC has a strategy to acquire a restaurant/store goal, and an EatOutController to execute it
        // For example, one NPC may walk around scanning, another may use google maps, onother may use Crowdless
        const strategy = new RandomRestaurantGoal(this, this.GRID, this.stores);
      
        // Start with EatOutController (it will push Wander temporarily after eating)
        const eatCtrl = new EatOutController(this, npc, this.GRID, this.stores, strategy, {
          eatMode: 'auto',            // 'auto' | 'indoors' | 'table'
          queueLoiterRadius: 4,
          queueLoiterStepMinMs: 700,
          queueLoiterStepMaxMs: 1800,
          loiterMaxRadiusSearch: 25,
          eatMinMs: 4000,
          eatMaxMs: 12000,
          postEatWanderMinMs: 5000,
          postEatWanderMaxMs: 12000,
          wanderFactory
        });

        window.debugNpcs = this.npcs;

        npc.setController(eatCtrl);

        this.npcs[npc.id] = npc;
      }
    }
  },

  update() {
    // Update NPCs
    Object.values(this.npcs).forEach(npc => npc.update());

    // Player movement
    if (!this.mascot || !this.collisionLayer) return;

    const speed = 2;
    let vx = 0;
    let vy = 0;

    if (this.cursors.left.isDown)       { vx = -speed; vy = -speed / 2; }
    else if (this.cursors.right.isDown) { vx =  speed; vy =  speed / 2; }
    else if (this.cursors.up.isDown)    { vx =  speed; vy = -speed / 2; }
    else if (this.cursors.down.isDown)  { vx = -speed; vy =  speed / 2; }

    const nextX = this.mascot.x + vx;
    const nextY = this.mascot.y + vy;

    const offsetX = 14;
    const offsetY = 7;
    const checkPoints = [
      { x: nextX, y: nextY },
      { x: nextX - offsetX, y: nextY - offsetY },
      { x: nextX + offsetX, y: nextY - offsetY },
      { x: nextX, y: nextY - 2 * offsetY }
    ];

    let isBlocked = false;

    for (const p of checkPoints) {
      // Convert world → BASE-1 tile
      const { x: tX, y: tY } = this.GRID.worldToTile(p.x, p.y);

      if (this.GRID.isBlocked(tX, tY, { allowWeak: false })) {
        isBlocked = true;
        break;
      }
    }

    if (!isBlocked) {
      this.mascot.x = nextX;
      this.mascot.y = nextY;
    }

    this.mascot.setDepth(this.mascot.y);
  }
};