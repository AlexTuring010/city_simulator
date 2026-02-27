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
import { RandomWanderController } from '../sim/controllers/RandomWanderController.js';

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

    // Input
    this.cursors = this.input.keyboard.createCursorKeys();

    // NPC animations
    this.anims.create({ key: 'npc_walk_down',  frames: this.anims.generateFrameNumbers('npc_sprite', { start: 0,  end: 4  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_right', frames: this.anims.generateFrameNumbers('npc_sprite', { start: 5,  end: 9  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_up',    frames: this.anims.generateFrameNumbers('npc_sprite', { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_left',  frames: this.anims.generateFrameNumbers('npc_sprite', { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

    // Spawn NPCs
    const spawnerObjects = map.getObjectLayer('NPC_spawners')?.objects || [];
    this.npcs = {};

    if (spawnerObjects.length > 0) {
      const maxNPCs = 100;

      for (let i = 0; i < maxNPCs; i++) {
        const spawner = Phaser.Utils.Array.GetRandom(spawnerObjects);

        // Convert spawner object position -> base-1 tile coords (shared rules)
        const t = this.GRID.objectToTile(spawner.x, spawner.y);

        const npc = new NPC(this, this.GRID, t.x, t.y);
        npc.controller = new RandomWanderController(this, npc, this.GRID);

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
      const tile = this.collisionLayer.getTileAtWorldXY(p.x, p.y);
      if (tile && tile.properties && tile.properties.collides) {
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