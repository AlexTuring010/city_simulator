// Global variables
let mascot;
let cursors;
let collisionLayer;
let wallSprites = [];
let npcs = []; // Track all our NPCs
let mapRef;    // Global reference to the map for pathfinding boundaries

// ==========================================
// LIGHTWEIGHT A* PATHFINDING
// ==========================================
function findPath(startX, startY, endX, endY) {
    const openSet = [{ x: startX, y: startY, g: 0, f: 0, parent: null }];
    const closedSet = new Set();
    
    const getPosKey = (x, y) => `${x},${y}`;
    const heuristic = (x, y) => Math.abs(x - endX) + Math.abs(y - endY);

    while (openSet.length > 0) {
        // Get node with lowest f score
        openSet.sort((a, b) => a.f - b.f);
        const current = openSet.shift();

        if (current.x === endX && current.y === endY) {
            const path = [];
            let curr = current;
            while (curr) {
                path.push({ x: curr.x, y: curr.y });
                curr = curr.parent;
            }
            return path.reverse(); // Return path from start to end
        }

        closedSet.add(getPosKey(current.x, current.y));

        // 4-way movement (Up, Down, Left, Right in grid space)
        const neighbors = [
            { x: current.x, y: current.y - 1 },
            { x: current.x, y: current.y + 1 },
            { x: current.x - 1, y: current.y },
            { x: current.x + 1, y: current.y }
        ];

        for (let n of neighbors) {
            // Check bounds
            if (n.x < 0 || n.y < 0 || n.x >= mapRef.width || n.y >= mapRef.height) continue;
            
            // Check collisions
            const tile = collisionLayer.getTileAt(n.x, n.y);
            if (tile && tile.properties && tile.properties.collides) continue;

            if (closedSet.has(getPosKey(n.x, n.y))) continue;

            const gScore = current.g + 1;
            const existingNode = openSet.find(node => node.x === n.x && node.y === n.y);

            if (!existingNode || gScore < existingNode.g) {
                if (!existingNode) {
                    openSet.push({
                        x: n.x, y: n.y, 
                        g: gScore, 
                        f: gScore + heuristic(n.x, n.y),
                        parent: current
                    });
                } else {
                    existingNode.g = gScore;
                    existingNode.f = gScore + heuristic(n.x, n.y);
                    existingNode.parent = current;
                }
            }
        }
    }
    return null; // No path found
}

// ==========================================
// DEBUG PATHFINDING MAP
// ==========================================
function printDebugMap(collisionLayer, startX, startY, targetX, targetY, path) {
    const mapWidth = mapRef.width;
    const mapHeight = mapRef.height;
    
    let grid = [];
    for (let y = 0; y < mapHeight; y++) {
        let row = [];
        for (let x = 0; x < mapWidth; x++) {
            const tile = collisionLayer.getTileAt(x, y);
            // Check if tile exists and has the collides property
            if (tile && tile.index !== -1 && tile.properties && tile.properties.collides) { 
                row.push('x');
            } else {
                row.push('.');
            }
        }
        grid.push(row);
    }

    // Overlay Path, Target, and Start (Existing logic...)
    if (path) path.forEach(node => { if(grid[node.y]) grid[node.y][node.x] = '*'; });
    if (grid[targetY]) grid[targetY][targetX] = 'q';
    if (grid[startY]) grid[startY][startX] = 'p';

    console.log("--- A* Pathfinding Logical Grid ---");
    for (let y = 0; y < mapHeight; y++) {
        // ADDING THE ROW NUMBER HERE prevents console grouping
        let rowNum = y.toString().padStart(2, '0');
        console.log(`${rowNum}: ${grid[y].join('  ')}`); 
    }
    console.log("-----------------------------------");
}

// ==========================================
// SCALABLE NPC CLASS (With Path Drawing)
// ==========================================
class NPC {
    constructor(scene, startTileX, startTileY, tileWidth, tileHeight, originX, originY) {
        this.scene = scene;
        this.tileX = startTileX;
        this.tileY = startTileY;
        this.tileW = tileWidth;
        this.tileH = tileHeight;
        this.originX = originX;
        this.originY = originY;

        // Calculate initial isometric position
        const isoPos = this.getIsoPos(this.tileX, this.tileY);
        
        // Create the sprite
        this.sprite = scene.add.sprite(isoPos.x, isoPos.y, 'npc_sprite', 15);
        this.sprite.setOrigin(0.5, 1);

        // --- NEW: Create a graphics object to draw the path ---
        this.pathGraphics = scene.add.graphics();
        this.pathGraphics.setDepth(10000); // High depth so it draws over walls/floors like a UI layer

        // State Machine
        this.state = 'WAITING';
        this.path = [];
        this.targetNode = null;
        this.speed = 1;

        // Start the behavior loop
        this.startWaiting();
    }

    getIsoPos(tX, tY) {
        return {
            x: (tX - tY) * this.tileW * 0.5 + this.originX,
            y: (tX + tY) * this.tileH * 0.5 + this.originY
        };
    }

    startWaiting() {
        this.state = 'WAITING';
        this.sprite.anims.stop(); 
        
        // Wait 4 seconds, then pick a new goal
        this.scene.time.delayedCall(4000, () => {
            this.pickRandomGoal();
        });
    }

    pickRandomGoal() {
        let attempts = 0;
        let goalX, goalY, path;

        while (attempts < 10) {
            goalX = Phaser.Math.Between(0, mapRef.width - 1);
            goalY = Phaser.Math.Between(0, mapRef.height - 1);

            const tile = collisionLayer.getTileAt(goalX, goalY);
            if (!tile || !tile.properties || !tile.properties.collides) {
                path = findPath(this.tileX, this.tileY, goalX, goalY);
                if (path && path.length > 1) {
                    
                    printDebugMap(collisionLayer, this.tileX, this.tileY, goalX, goalY, path);

                    this.path = path;
                    this.path.shift(); 
                    this.targetNode = this.path.shift();
                    this.state = 'MOVING';
                    return; 
                }
            }
            attempts++;
        }
        
        this.startWaiting();
    }

    update() {
        // --- NEW: Clear the path graphics every frame ---
        this.pathGraphics.clear();

        if (this.state !== 'MOVING' || !this.targetNode) {
            this.sprite.setDepth(this.sprite.y);
            return;
        }

        const targetIso = this.getIsoPos(this.targetNode.x, this.targetNode.y);

        // --- NEW: Draw the path ---
        this.drawPathIndicator(targetIso);

        const distance = Phaser.Math.Distance.Between(this.sprite.x, this.sprite.y, targetIso.x, targetIso.y);

        if (distance < this.speed) {
            // Reached the current tile
            this.sprite.x = targetIso.x;
            this.sprite.y = targetIso.y;
            this.tileX = this.targetNode.x;
            this.tileY = this.targetNode.y;

            if (this.path.length > 0) {
                this.targetNode = this.path.shift();
            } else {
                this.targetNode = null;
                this.startWaiting();
            }
        } else {
            // Move towards target
            const angle = Phaser.Math.Angle.Between(this.sprite.x, this.sprite.y, targetIso.x, targetIso.y);
            this.sprite.x += Math.cos(angle) * this.speed;
            this.sprite.y += Math.sin(angle) * this.speed;

            // Handle Animations
            if (this.targetNode.x > this.tileX) {
                this.sprite.anims.play('npc_walk_right', true);
            } else if (this.targetNode.x < this.tileX) {
                this.sprite.anims.play('npc_walk_left', true);
            } else if (this.targetNode.y > this.tileY) {
                this.sprite.anims.play('npc_walk_down', true); 
            } else if (this.targetNode.y < this.tileY) {
                this.sprite.anims.play('npc_walk_up', true);  
            }
        }

        this.sprite.setDepth(this.sprite.y);
    }

    // --- NEW: Helper method to handle all the drawing logic ---
    drawPathIndicator(targetIso) {
        this.pathGraphics.lineStyle(2, 0xffaa00, 0.8);
        this.pathGraphics.beginPath();

        // --- NEW: The offset to raise the line from the bottom edge to the tile center ---
        // Subtracting half the tile height lifts the visual line to the center of the diamond
        const yOffset = this.tileH * 0.5;

        // 1. Start exactly where the NPC is standing, but shifted up
        this.pathGraphics.moveTo(this.sprite.x, this.sprite.y - yOffset);

        // 2. Draw line to the immediate next node (shifted up)
        this.pathGraphics.lineTo(targetIso.x, targetIso.y - yOffset);

        // 3. Draw lines to all remaining nodes in the path array
        let lastNode = { x: targetIso.x, y: targetIso.y - yOffset };
        for (let i = 0; i < this.path.length; i++) {
            const isoNode = this.getIsoPos(this.path[i].x, this.path[i].y);
            
            // Apply the offset to every point on the path
            const adjustedX = isoNode.x;
            const adjustedY = isoNode.y - yOffset;
            
            this.pathGraphics.lineTo(adjustedX, adjustedY);
            lastNode = { x: adjustedX, y: adjustedY };
        }
        
        this.pathGraphics.strokePath();

        // 4. Calculate the angle for the arrowhead
        let prevNode = { x: this.sprite.x, y: this.sprite.y - yOffset };
        if (this.path.length > 0) {
            if (this.path.length > 1) {
                const pNode = this.getIsoPos(this.path[this.path.length - 2].x, this.path[this.path.length - 2].y);
                prevNode = { x: pNode.x, y: pNode.y - yOffset };
            } else {
                prevNode = { x: targetIso.x, y: targetIso.y - yOffset };
            }
        }

        const finalAngle = Phaser.Math.Angle.Between(prevNode.x, prevNode.y, lastNode.x, lastNode.y);

        // 5. Draw the arrowhead at 'lastNode'
        const arrowSize = 8;
        this.pathGraphics.fillStyle(0xffaa00, 0.8);
        this.pathGraphics.beginPath();
        this.pathGraphics.moveTo(lastNode.x, lastNode.y);
        
        // Left point of arrow
        this.pathGraphics.lineTo(
            lastNode.x - arrowSize * Math.cos(finalAngle - Math.PI / 6),
            lastNode.y - arrowSize * Math.sin(finalAngle - Math.PI / 6)
        );
        // Right point of arrow
        this.pathGraphics.lineTo(
            lastNode.x - arrowSize * Math.cos(finalAngle + Math.PI / 6),
            lastNode.y - arrowSize * Math.sin(finalAngle + Math.PI / 6)
        );
        
        this.pathGraphics.closePath();
        this.pathGraphics.fillPath();
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
        mapData.tilesets.forEach(ts => {
            const filename = ts.image.split(/[\/\\]/).pop();
            const assetPath = 'assets/' + filename;
            this.load.spritesheet(ts.name, assetPath, {
                frameWidth: ts.tilewidth,
                frameHeight: ts.tileheight
            });
        });

        // Load NPC Spritesheet
        this.load.spritesheet('npc_sprite', 'assets/person_tiles.png', {
            frameWidth: 32,
            frameHeight: 32
        });
    },

	    create: function () {
	        const map = this.make.tilemap({ key: 'map' });
	        mapRef = map; // Store globally for pathfinding
        
        map.tilesets.forEach(ts => {
            map.addTilesetImage(ts.name, ts.name);
        });

        const tileset = map.tilesets;

        // 1. Floor & Collision Layers
        const floorLayer = map.createLayer('floors', tileset);
        if (floorLayer) floorLayer.setDepth(-1000);

        collisionLayer = map.createLayer('collides', tileset);
        if (collisionLayer) collisionLayer.setVisible(false);

        // Setup Isometric Projection Variables
	        const tileWidth = map.tileWidth;
	        const tileHeight = map.tileHeight;
	        const originX = 16;
	        const originY = 16;

	        const tiledObjectToGrid = (x, y) => {
	            return {
	                tileX: Math.floor((x - originX) / tileHeight),
	                tileY: Math.floor((y - originY) / tileHeight)
	            };
	        };

        const gidMap = {};
        map.tilesets.forEach(ts => {
            for (let i = 0; i < ts.total; i++) {
                gidMap[ts.firstgid + i] = { key: ts.name, frame: i };
            }
        });

        const createIsoSprite = (object) => {
            const mappedInfo = gidMap[object.gid];
            if (!mappedInfo) return null;

	            const { tileX, tileY } = tiledObjectToGrid(object.x, object.y);
	            const isoX = (tileX - tileY) * tileWidth * 0.5 + originX;
	            const isoY = (tileX + tileY) * tileHeight * 0.5 + originY;

            const sprite = this.add.sprite(isoX, isoY, mappedInfo.key, mappedInfo.frame);
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

        // 2. Create Walls
        const wallObjects = map.getObjectLayer('walls')?.objects || [];
        wallSprites = [];
        wallObjects.forEach(object => {
            const sprite = createIsoSprite(object);
            if (sprite) wallSprites.push(sprite);
        });

        // 3. Mascot Setup
        const playerObjects = map.getObjectLayer('Player')?.objects || [];
        if (playerObjects.length > 0) {
            mascot = createIsoSprite(playerObjects[0]);
            if (mascot) {
                this.cameras.main.startFollow(mascot, true, 0.1, 0.1);
            }
        }

        // 4. Input
        cursors = this.input.keyboard.createCursorKeys();

        // ------------------------------------------
        // NPC SYSTEM SETUP
        // ------------------------------------------

        // Define Animations
        this.anims.create({ key: 'npc_walk_down', frames: this.anims.generateFrameNumbers('npc_sprite', { start: 0, end: 4 }), frameRate: 8, repeat: -1 });
        this.anims.create({ key: 'npc_walk_right', frames: this.anims.generateFrameNumbers('npc_sprite', { start: 5, end: 9 }), frameRate: 8, repeat: -1 });
        this.anims.create({ key: 'npc_walk_up', frames: this.anims.generateFrameNumbers('npc_sprite', { start: 10, end: 14 }), frameRate: 8, repeat: -1 });
        this.anims.create({ key: 'npc_walk_left', frames: this.anims.generateFrameNumbers('npc_sprite', { start: 15, end: 19 }), frameRate: 8, repeat: -1 });

        // Grab spawner objects
        const spawnerObjects = map.getObjectLayer('NPC_spawners')?.objects || [];
        
        if (spawnerObjects.length > 0) {
            // Set EXACTLY how many NPCs you want in your game
            const maxNPCs = 1; // Change this number to whatever you need!

            for (let i = 0; i < maxNPCs; i++) {
                // Pick a random spawner from the array for THIS specific NPC
                // Because it picks randomly every loop, multiple NPCs can get the same spawner
                const spawner = Phaser.Utils.Array.GetRandom(spawnerObjects);
                
                // Convert pixel coordinates from Tiled into tile indices
	                const { tileX: startTileX, tileY: startTileY } = tiledObjectToGrid(spawner.x, spawner.y);

                const newNPC = new NPC(this, startTileX, startTileY, tileWidth, tileHeight, originX, originY);
                npcs.push(newNPC);
            }
        }
    },

    update: function () {
        // Update all NPCs
        npcs.forEach(npc => npc.update());

        // Mascot Movement (Your original code)
        if (!mascot || !collisionLayer) return;

        const speed = 2;
        let vx = 0;
        let vy = 0;

        if (cursors.left.isDown)  { vx = -speed; vy = -speed / 2; }
        else if (cursors.right.isDown) { vx = speed;  vy = speed / 2; }
        else if (cursors.up.isDown)    { vx = speed;  vy = -speed / 2; }
        else if (cursors.down.isDown)  { vx = -speed; vy = speed / 2; }

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
        for (let p of checkPoints) {
            const tile = collisionLayer.getTileAtWorldXY(p.x, p.y);
            if (tile && tile.properties.collides) {
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

const game = new Phaser.Game(config);
