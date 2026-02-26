// - Game logic uses BASE-1 tile coords everywhere: (1,1) is origin tile
// - Only GRID talks to Phaser tile layers (base-0) internally
// - Only GRID knows how Tiled object snapping -> tile coords works
// - NPCs / pathfinding / object placement all share the same conventions
// ==========================================

// --------------------------
// Global variables
// --------------------------
let mascot;
let cursors;
let collisionLayer;
let wallSprites = [];
let npcs = [];
let mapRef;

// The one source of truth for conventions:
let GRID = null;

// ==========================================
// GRID + ISO ADAPTER (single source of truth)
// ==========================================
function makeGridIso(map, collisionLayer, originX, originY) {
  const tileW = map.tileWidth;
  const tileH = map.tileHeight;

  // You observed Tiled snap-to-grid for object layers steps by tileHeight
  const step = tileH;

  return {
    tileW,
    tileH,
    originX,
    originY,
    width: map.width,
    height: map.height,
    step,

    // Base-1 bounds
    inBounds(tX, tY) {
      return tX >= 1 && tY >= 1 && tX <= map.width && tY <= map.height;
    },

    // Base-1 -> Phaser layer (base-0)
    getTile(tX, tY) {
      if (!this.inBounds(tX, tY)) return null;
      return collisionLayer.getTileAt(tX - 1, tY - 1);
    },

    isBlocked(tX, tY) {
      const tile = this.getTile(tX, tY);
      return !!(tile && tile.properties && tile.properties.collides);
    },

    // Base-1 tile -> world pixels (your iso projection + origin)
    tileToWorld(tX, tY) {
      return {
        x: (tX - tY) * tileW * 0.5 + originX,
        y: (tX + tY) * tileH * 0.5 + originY
      };
    },

    // Tiled object pixel position -> base-1 tile coords
    // Based on your observed behavior:
    //   first tile anchor is at (step, step) => tile (1,1)
    objectToTile(objX, objY) {
      return {
        x: Math.floor(objX / step),
        y: Math.floor(objY / step)
      };
    }
  };
}

// ==========================================
// LIGHTWEIGHT A* PATHFINDING (BASE-1)
// ==========================================
function findPath(GRID, startX, startY, endX, endY) {
  const openSet = [{ x: startX, y: startY, g: 0, f: 0, parent: null }];
  const closedSet = new Set();

  const key = (x, y) => `${x},${y}`;
  const heuristic = (x, y) => Math.abs(x - endX) + Math.abs(y - endY);

  while (openSet.length > 0) {
    openSet.sort((a, b) => a.f - b.f);
    const current = openSet.shift();

    if (current.x === endX && current.y === endY) {
      const path = [];
      for (let n = current; n; n = n.parent) path.push({ x: n.x, y: n.y });
      return path.reverse();
    }

    closedSet.add(key(current.x, current.y));

    const neighbors = [
      { x: current.x,     y: current.y - 1 },
      { x: current.x,     y: current.y + 1 },
      { x: current.x - 1, y: current.y },
      { x: current.x + 1, y: current.y }
    ];

    for (const n of neighbors) {
      if (!GRID.inBounds(n.x, n.y)) continue;
      if (GRID.isBlocked(n.x, n.y)) continue;
      if (closedSet.has(key(n.x, n.y))) continue;

      const gScore = current.g + 1;
      const existing = openSet.find(node => node.x === n.x && node.y === n.y);

      if (!existing || gScore < existing.g) {
        if (!existing) {
          openSet.push({
            x: n.x, y: n.y,
            g: gScore,
            f: gScore + heuristic(n.x, n.y),
            parent: current
          });
        } else {
          existing.g = gScore;
          existing.f = gScore + heuristic(n.x, n.y);
          existing.parent = current;
        }
      }
    }
  }

  return null;
}

// ==========================================
// DEBUG PATHFINDING MAP (BASE-1 display)
// ==========================================
function printDebugMap(GRID, startX, startY, targetX, targetY, path) {
  const mapWidth = GRID.width;
  const mapHeight = GRID.height;

  const grid = [];

  for (let y = 1; y <= mapHeight; y++) {
    const row = [];
    for (let x = 1; x <= mapWidth; x++) {
      row.push(GRID.isBlocked(x, y) ? 'x' : '.');
    }
    grid.push(row);
  }

  if (path) {
    path.forEach(node => {
      const gx = node.x - 1;
      const gy = node.y - 1;
      if (grid[gy] && grid[gy][gx] !== undefined) grid[gy][gx] = '*';
    });
  }

  const tGX = targetX - 1, tGY = targetY - 1;
  if (grid[tGY] && grid[tGY][tGX] !== undefined) grid[tGY][tGX] = 'q';

  const sGX = startX - 1, sGY = startY - 1;
  if (grid[sGY] && grid[sGY][sGX] !== undefined) grid[sGY][sGX] = 'p';

  console.log("--- A* Pathfinding Logical Grid (base-1 coords) ---");
  for (let y0 = 0; y0 < mapHeight; y0++) {
    const rowNum = (y0 + 1).toString().padStart(2, '0');
    console.log(`${rowNum}: ${grid[y0].join('  ')}`);
  }
  console.log("--------------------------------------------------");
}


// ==========================================
// SCRIBBLE EFFECT FOR PATH INDICATOR (OPTIONAL EXTRA)
// ==========================================

// ---------- helpers ----------
function hash01(n) {
  const s = Math.sin(n) * 10000;
  return s - Math.floor(s);
}

function buildScribblePoints(rawPoints, jitterPx = 2, samplesPerSegment = 3, seed = 1234) {
  if (rawPoints.length < 2) return rawPoints;

  const pts = [];

  for (let i = 0; i < rawPoints.length - 1; i++) {
    const a = rawPoints[i];
    const b = rawPoints[i + 1];

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));

    const nx = -dy / len;
    const ny = dx / len;

    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;

      const x = a.x + dx * t;
      const y = a.y + dy * t;

      const fade = Math.sin(Math.PI * t); // 0..1..0

      const r = hash01(seed + i * 100 + s * 17) * 2 - 1; // -1..1
      const j = r * jitterPx * fade;

      pts.push({ x: x + nx * j, y: y + ny * j });
    }
  }

  pts.push(rawPoints[rawPoints.length - 1]);
  return pts;
}

function catmullRomInterpolate(points, samples = 3) {
  if (!points || points.length < 2) return points || [];

  const curve = new Phaser.Curves.Spline(points);
  const out = [];
  const total = Math.max(1, points.length * samples);

  for (let i = 0; i <= total; i++) {
    const t = i / total;
    const p = curve.getPoint(t);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

function decimatePoints(pts, minDist = 8) {
  if (!pts || pts.length < 2) return pts || [];
  const out = [pts[0]];
  let last = pts[0];

  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) {
      out.push(p);
      last = p;
    }
  }

  out.push(pts[pts.length - 1]);
  return out;
}


ARROW_ALPHA = 0.58;

function strokeMarkerFast(graphics, pts, color = 0x33ff77) {
  // glow + core (2 passes)
  const passes = [
    { w: 10, a: 0.08 },
    { w:  5, a: ARROW_ALPHA },
  ];

  for (const pass of passes) {
    graphics.lineStyle(pass.w, color, pass.a);
    graphics.beginPath();
    graphics.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) graphics.lineTo(pts[i].x, pts[i].y);
    graphics.strokePath();
  }
}

// ==========================================
// NPC CLASS (uses GRID as black box)
// ==========================================
class NPC {
  constructor(scene, GRID, startTileX, startTileY) {
    this.pathCacheIdx = 0;    // where along the cached polyline we start drawing
    this.pathSeed = (Math.random() * 1e9) | 0; // stable per NPC instance
    this.scene = scene;
    this.GRID = GRID;
    this.facing = 'down'; // 'up' | 'down' | 'left' | 'right'

    this.tileX = startTileX; // base-1
    this.tileY = startTileY; // base-1

    const pos = GRID.tileToWorld(this.tileX, this.tileY);

    this.sprite = scene.add.sprite(pos.x, pos.y, 'npc_sprite', 15);
    this.sprite.setOrigin(0.5, 1);

    this.pathSegments = [];     // pool of graphics segments
    this.arrowG = null;         // arrowhead graphics
    this.pathDirty = true;      // rebuild when path changes
    this.pathCache = null;      // cached smoothed points

    this.state = 'WAITING';
    this.setIdleFacing();
    this.path = [];
    this.targetNode = null;
    this.speed = 1;

    this.startWaiting();
  }

  startWaiting() {
    this.state = 'WAITING';
    this.setIdleFacing();

    this.scene.time.delayedCall(4000, () => {
      this.pickRandomGoal();
    });
  }

  pickRandomGoal() {
    let attempts = 0;

    while (attempts++ < 10) {
      const goalX = Phaser.Math.Between(1, this.GRID.width);
      const goalY = Phaser.Math.Between(1, this.GRID.height);

      if (!this.GRID.isBlocked(goalX, goalY)) {
        const path = findPath(this.GRID, this.tileX, this.tileY, goalX, goalY);
        if (path && path.length > 1) {
          // printDebugMap(this.GRID, this.tileX, this.tileY, goalX, goalY, path);
          this.pathSeed = (this.pathSeed ^ (goalX * 73856093) ^ (goalY * 19349663)) | 0;
          this.path = path;
          this.path.shift();          // remove current tile
          this.targetNode = this.path.shift();
          this.state = 'MOVING';
          this.pathCache = null;
          this.pathCacheIdx = 0;
          return;
        }
      }
    }

    this.startWaiting();
  }

  setIdleFacing() {
    const key =
        this.facing === 'right' ? 'npc_walk_right' :
        this.facing === 'left'  ? 'npc_walk_left'  :
        this.facing === 'up'    ? 'npc_walk_up'    :
                                'npc_walk_down';

    // Ensure the correct sheet/frames are applied, then freeze on frame 0 (idle)
    this.sprite.anims.play(key, true);
    this.sprite.anims.pause();
    this.sprite.anims.setProgress(0); // first frame is idle
  }

  update() {
    if (this.state !== 'MOVING' || !this.targetNode) {
        for (const g of this.pathSegments) g.setVisible(false);
        if (this.arrowG) this.arrowG.setVisible(false);
        this.sprite.setDepth(this.sprite.y);
        return;
    }

    // ---- MOVE FIRST ----
    const targetWorld = this.GRID.tileToWorld(this.targetNode.x, this.targetNode.y);

    const distance = Phaser.Math.Distance.Between(
        this.sprite.x, this.sprite.y,
        targetWorld.x, targetWorld.y
    );

    if (distance < this.speed) {
        this.sprite.x = targetWorld.x;
        this.sprite.y = targetWorld.y;
        this.tileX = this.targetNode.x;
        this.tileY = this.targetNode.y;

        if (this.path.length > 0) {
            this.targetNode = this.path.shift();
        } else {
            this.targetNode = null;

            // clear indicator cache immediately
            this.pathCache = null;
            this.pathCacheIdx = 0;

            this.startWaiting();
        }
    } else {
        const angle = Phaser.Math.Angle.Between(
        this.sprite.x, this.sprite.y,
        targetWorld.x, targetWorld.y
        );

        this.sprite.x += Math.cos(angle) * this.speed;
        this.sprite.y += Math.sin(angle) * this.speed;

        // Animations + facing based on next tile direction
        if (this.targetNode.x > this.tileX) { this.facing = 'right'; this.sprite.anims.play('npc_walk_right', true); }
        else if (this.targetNode.x < this.tileX) { this.facing = 'left'; this.sprite.anims.play('npc_walk_left', true); }
        else if (this.targetNode.y > this.tileY) { this.facing = 'down'; this.sprite.anims.play('npc_walk_down', true); }
        else if (this.targetNode.y < this.tileY) { this.facing = 'up'; this.sprite.anims.play('npc_walk_up', true); }
    }

    // ---- THEN DRAW, USING UPDATED POS + UPDATED TARGET ----
    if (this.targetNode) {
        const nextWorld = this.GRID.tileToWorld(this.targetNode.x, this.targetNode.y);
        this.drawPathIndicator(nextWorld);
    } else {
        this.drawPathIndicator(null);
    }

    this.sprite.setDepth(this.sprite.y);
  }

  drawPathIndicator(nextWorld) {
    const color = 0x33ff77;
    const yOffset = this.GRID.tileH * 0.5;

    // Ensure fields exist (safe even if you didn’t add them in constructor yet)
    if (this.lastPathDraw === undefined) this.lastPathDraw = 0;
    if (this.pathSeed === undefined) this.pathSeed = ((Math.random() * 1e9) | 0);
    if (this.pathCacheIdx === undefined) this.pathCacheIdx = 0;

    // If no target, hide and exit
    if (!nextWorld) {
        for (const g of this.pathSegments) g.setVisible(false);
        if (this.arrowG) this.arrowG.setVisible(false);
        return;
    }

    // Start point anchored to *current* sprite position
    const startPt = { x: this.sprite.x, y: this.sprite.y - yOffset };

    // Throttle drawing (but we still keep visibility correct)
    const now = this.scene.time.now;
    const canRedraw = (now - this.lastPathDraw) >= 50; // 20 FPS-ish
    if (canRedraw) this.lastPathDraw = now;

    // ------------------------------------------------------------
    // 1) Build the scribbled/smoothed polyline ONLY when pathDirty
    //    (stable seed => stable curves for the life of this path)
    // ------------------------------------------------------------
    if ((this.pathDirty || !this.pathCache) && canRedraw) {
        const raw = [];
        raw.push(startPt);

        // Always include the immediate next node
        const first = { x: nextWorld.x, y: nextWorld.y - yOffset };
        raw.push(first);

        // Cap by pixel length so huge paths don’t lag
        const MAX_PIXELS = 500; // tune 300–700
        let acc = 0;
        let last = first;

        for (let i = 0; i < this.path.length; i++) {
        const wp = this.GRID.tileToWorld(this.path[i].x, this.path[i].y);
        const pt = { x: wp.x, y: wp.y - yOffset };

        acc += Math.hypot(pt.x - last.x, pt.y - last.y);
        if (acc > MAX_PIXELS) break;

        raw.push(pt);
        last = pt;
        }

        const nodeCount = raw.length;

        // Adaptive sampling
        const samplesPerSegment = nodeCount > 20 ? 2 : nodeCount > 12 ? 3 : 5;
        const splineSamples     = nodeCount > 20 ? 2 : nodeCount > 12 ? 3 : 5;

        // IMPORTANT: stable seed (do NOT use sprite position)
        // Set this.pathSeed when you pick a new goal/path, e.g.:
        // this.pathSeed = (this.pathSeed ^ (goalX*73856093) ^ (goalY*19349663)) | 0;
        const jittered = buildScribblePoints(raw, /*jitterPx*/ 2, samplesPerSegment, this.pathSeed);
        const smooth   = catmullRomInterpolate(jittered, splineSamples);

        const minDist = nodeCount > 20 ? 10 : 8;
        this.pathCache = decimatePoints(smooth, minDist);

        // reset trimming position when a new cached curve is built
        this.pathCacheIdx = 0;

        this.pathDirty = false;
    }

    // If we have no cache yet (throttled on first frame), just bail gracefully
    if (!this.pathCache || this.pathCache.length < 2) return;

    // ------------------------------------------------------------
    // 2) While moving, TRIM along the cached polyline
    //    so the start follows the NPC WITHOUT changing the curve.
    // ------------------------------------------------------------
    // Advance idx until the next point is "far enough" from the sprite.
    // This keeps the start from trailing behind.
    while (this.pathCacheIdx < this.pathCache.length - 2) {
        const pNext = this.pathCache[this.pathCacheIdx + 1];
        const d = Phaser.Math.Distance.Between(startPt.x, startPt.y, pNext.x, pNext.y);
        if (d > 12) break; // tune 8–16
        this.pathCacheIdx++;
    }

    // Slice visible portion; force first point to be exactly at sprite
    const pts = this.pathCache.slice(this.pathCacheIdx);
    if (pts.length < 2) return;
    pts[0] = startPt;

    // ------------------------------------------------------------
    // 3) Draw chunked segments (your existing performance strategy)
    // ------------------------------------------------------------
    for (const g of this.pathSegments) g.setVisible(false);

    const MAX_LEN = 150;
    let segIndex = 0;
    let chunk = [pts[0]];
    let accLen = 0;

    for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        accLen += Math.hypot(cur.x - prev.x, cur.y - prev.y);
        chunk.push(cur);

        const isLast = (i === pts.length - 1);

        if (accLen >= MAX_LEN || isLast) {
        let g = this.pathSegments[segIndex];
        if (!g) {
            g = this.scene.add.graphics();
            this.pathSegments.push(g);
        }
        segIndex++;

        g.clear();
        g.setVisible(true);

        // depth by average y of chunk
        let sumY = 0;
        for (const p of chunk) sumY += p.y;
        g.setDepth(sumY / chunk.length);

        strokeMarkerFast(g, chunk, color);

        chunk = [cur];
        accLen = 0;
        }
    }

    for (let k = segIndex; k < this.pathSegments.length; k++) {
        this.pathSegments[k].setVisible(false);
    }

    // ------------------------------------------------------------
    // 4) Arrowhead
    // ------------------------------------------------------------
    const lastPt = pts[pts.length - 1];
    const prevPt = pts[pts.length - 2];
    const angle = Phaser.Math.Angle.Between(prevPt.x, prevPt.y, lastPt.x, lastPt.y);

    if (!this.arrowG) this.arrowG = this.scene.add.graphics();
    this.arrowG.clear();
    this.arrowG.setVisible(true);
    this.arrowG.setDepth(lastPt.y + 1);

    const arrowSize = 10;
    this.arrowG.lineStyle(4, color, ARROW_ALPHA);
    this.arrowG.beginPath();
    this.arrowG.moveTo(lastPt.x, lastPt.y);
    this.arrowG.lineTo(
        lastPt.x - arrowSize * Math.cos(angle - Math.PI / 6),
        lastPt.y - arrowSize * Math.sin(angle - Math.PI / 6)
    );
    this.arrowG.moveTo(lastPt.x, lastPt.y);
    this.arrowG.lineTo(
        lastPt.x - arrowSize * Math.cos(angle + Math.PI / 6),
        lastPt.y - arrowSize * Math.sin(angle + Math.PI / 6)
    );
    this.arrowG.strokePath();
  }
}

// ==========================================
// SCENE 1: BOOT SCENE
// ==========================================
const bootScene = {
  key: 'BootScene',
  preload: function () {
    this.load.tilemapTiledJSON('map', 'map.json');
  },
  create: function () {
    this.scene.start('MainScene');
  }
};

// ==========================================
// SCENE 2: MAIN SCENE
// ==========================================
const mainScene = {
  key: 'MainScene',

  preload: function () {
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

  create: function () {
    const map = this.make.tilemap({ key: 'map' });
    mapRef = map;

    map.tilesets.forEach(ts => {
      map.addTilesetImage(ts.name, ts.name);
    });

    const tileset = map.tilesets;

    // Layers
    const floorLayer = map.createLayer('floors', tileset);
    if (floorLayer) floorLayer.setDepth(-1000);

    collisionLayer = map.createLayer('collides', tileset);
    if (collisionLayer) collisionLayer.setVisible(false);

    // Your chosen world origin for iso projection
    const originX = 16;
    const originY = 16;

    // Build the single source-of-truth adapter
    GRID = makeGridIso(map, collisionLayer, originX, originY);

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
      const t = GRID.objectToTile(object.x, object.y);

      // Convert tile coords -> world
      const p = GRID.tileToWorld(t.x, t.y);

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
    wallSprites = [];
    wallObjects.forEach(obj => {
      const s = createIsoSprite(obj);
      if (s) wallSprites.push(s);
    });

    // Player
    const playerObjects = map.getObjectLayer('Player')?.objects || [];
    if (playerObjects.length > 0) {
      mascot = createIsoSprite(playerObjects[0]);
      if (mascot) this.cameras.main.startFollow(mascot, true, 0.1, 0.1);
    }

    // Input
    cursors = this.input.keyboard.createCursorKeys();

    // NPC animations
    this.anims.create({ key: 'npc_walk_down',  frames: this.anims.generateFrameNumbers('npc_sprite', { start: 0,  end: 4  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_right', frames: this.anims.generateFrameNumbers('npc_sprite', { start: 5,  end: 9  }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_up',    frames: this.anims.generateFrameNumbers('npc_sprite', { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
    this.anims.create({ key: 'npc_walk_left',  frames: this.anims.generateFrameNumbers('npc_sprite', { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

    // Spawn NPCs
    const spawnerObjects = map.getObjectLayer('NPC_spawners')?.objects || [];
    npcs = [];

    if (spawnerObjects.length > 0) {
      const maxNPCs = 10;

      for (let i = 0; i < maxNPCs; i++) {
        const spawner = Phaser.Utils.Array.GetRandom(spawnerObjects);

        // Convert spawner object position -> base-1 tile coords with the shared rules
        const t = GRID.objectToTile(spawner.x, spawner.y);

        npcs.push(new NPC(this, GRID, t.x, t.y));
      }
    }
  },

  update: function () {
    // Update NPCs
    npcs.forEach(npc => npc.update());

    // Player movement
    if (!mascot || !collisionLayer) return;

    const speed = 2;
    let vx = 0;
    let vy = 0;

    if (cursors.left.isDown)       { vx = -speed; vy = -speed / 2; }
    else if (cursors.right.isDown) { vx =  speed; vy =  speed / 2; }
    else if (cursors.up.isDown)    { vx =  speed; vy = -speed / 2; }
    else if (cursors.down.isDown)  { vx = -speed; vy =  speed / 2; }

    const nextX = mascot.x + vx;
    const nextY = mascot.y + vy;

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
      const tile = collisionLayer.getTileAtWorldXY(p.x, p.y);
      if (tile && tile.properties && tile.properties.collides) {
        isBlocked = true;
        break;
      }
    }

    if (!isBlocked) {
      mascot.x = nextX;
      mascot.y = nextY;
    }

    mascot.setDepth(mascot.y);
  }
};

// ==========================================
// GAME CONFIGURATION
// ==========================================
const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'game-container',
  pixelArt: true,
  scene: [bootScene, mainScene]
};

new Phaser.Game(config);