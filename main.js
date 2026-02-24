const config = {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    parent: 'game-container',
    pixelArt: true,
    scene: {
        preload: preload,
        create: create,
        update: update
    }
};

const game = new Phaser.Game(config);

let mascot;
let cursors;
let collisionLayer;
let wallSprites = [];

function preload() {
    this.load.tilemapTiledJSON('map', 'map.json');
    
    // Spritesheet for 32x32 tiles (GID 1-9)
    this.load.spritesheet('tiles', 'assets/tiles.png', { 
        frameWidth: 32, 
        frameHeight: 32 
    });

    this.load.spritesheet('tiles2', 'assets/tiles.png', {
        frameWidth: 32,
        frameHeight: 16
    });

    this.load.image('big_block', 'assets/big_block.png'); // 128x112
    
    // Standalone images
    this.load.image('character_idle', 'assets/character_idle.png');
    this.load.image('walls_tower', 'assets/walls_tower.png'); // 32x64
}

function create() {
    const map = this.make.tilemap({ key: 'map' });
    const tileset = map.addTilesetImage('tiles', 'tiles');

    // 1. Floor
    const floorLayer = map.createLayer('floor', tileset);
    if (floorLayer) floorLayer.setDepth(-1000);

    // 2. Collision Layer
    collisionLayer = map.createLayer('collides', tileset);
    if (collisionLayer) collisionLayer.setVisible(true);

    // 3. Create Walls & Towers
    wallSprites = map.createFromObjects('walls', [
        { gid: 1, key: 'tiles', frame: 0 },
        { gid: 2, key: 'tiles', frame: 1 },
        { gid: 3, key: 'tiles', frame: 2 },
        { gid: 4, key: 'tiles', frame: 3 },
        { gid: 5, key: 'tiles', frame: 4 },
        { gid: 6, key: 'tiles', frame: 5 },
        { gid: 7, key: 'tiles', frame: 6 },
        { gid: 8, key: 'tiles', frame: 7 },
        { gid: 9, key: 'tiles', frame: 8 },
        { gid: 11, key: 'walls_tower' },
        { gid: 12, key: 'tiles2', frame: 0},
        { gid: 13, key: 'tiles2', frame: 1},
        { gid: 14, key: 'tiles2', frame: 2},
        { gid: 15, key: 'tiles2', frame: 3},
        { gid: 16, key: 'tiles2', frame: 4},
        { gid: 17, key: 'tiles2', frame: 5},
        { gid: 18, key: 'tiles2', frame: 6},
        { gid: 19, key: 'tiles2', frame: 7},
        { gid: 20, key: 'tiles2', frame: 8},
        { gid: 30, key: 'big_block' }
    ]);

    wallSprites.forEach(sprite => {
        let pixelOffset;
        let pixelOffsetX;
        let depthOffset = 0; // Adjust this if you want to fine-tune depth sorting further.

        // Ive not found a way to control depth for more complex sprites that arent cubes, for wide
        // or tall sprites, I recommend breaking them into multiple objects in Tiled, so one part can
        // be behind the player while the other is front.

        // Offset is how many pixels from the top of the sprite to the 'feet' that should align with the grid.
        // For 32x16 tiles, 
    
        // Check which asset we are dealing with to apply your specific offsets
        if (sprite.texture.key === 'walls_tower') {
            pixelOffset = 48; 
            pixelOffsetX = 16; 
        } else if (sprite.texture.key === 'tiles') {
            pixelOffset = 32;
            pixelOffsetX = 16; 
            depthOffset = - 8;
        } else if (sprite.texture.key === 'big_block') {
            pixelOffset = 72;
            pixelOffsetX = 16; 
            depthOffset = - 32;
        } else {
            // When using the 16px high tiles, we want to align the bottom of the tile with the grid, so we use a smaller offset.
            pixelOffset = 24;
            pixelOffsetX = 16; 
        }

        const preciseOriginX = (sprite.width - pixelOffsetX) / sprite.width;

        // Formula: (Height - Offset) / Height
        const preciseOriginY = (sprite.height - pixelOffset) / sprite.height;
        
        sprite.setOrigin(preciseOriginX, preciseOriginY);
        
        // Depth Sorting
        // To keep sorting consistent, we calculate depth based on 
        // where the 'feet' actually hit the floor.
        sprite.setDepth(sprite.y + pixelOffset + depthOffset);
    });
    // 4. Mascot Setup
    const playerArray = map.createFromObjects('Player', [
        { gid: 10, key: 'character_idle' }
    ]);
    
    if (playerArray.length > 0) {
        mascot = playerArray[0];
        // Mascot is 48px high. To align feet with the 32px grid depth:
        mascot.setOrigin(0.5, 1); 
        this.cameras.main.startFollow(mascot, true, 0.1, 0.1);
    }

    cursors = this.input.keyboard.createCursorKeys();
}

function update() {
    if (!mascot || !collisionLayer) return;

    const speed = 2;
    let vx = 0;
    let vy = 0;

    if (cursors.left.isDown)  { vx = -speed; vy = -speed / 2; }
    else if (cursors.right.isDown) { vx = speed;  vy = speed / 2; }
    else if (cursors.up.isDown)    { vx = speed;  vy = -speed / 2; }
    else if (cursors.down.isDown)  { vx = -speed; vy = speed / 2; }

    const nextX = mascot.x + vx;
    const nextY = mascot.y + vy;

    // Isometric Collision check
    const offsetX = 14; 
    const offsetY = 7; 
    const checkPoints = [
        { x: nextX, y: nextY },
        { x: nextX - offsetX, y: nextY - offsetY },
        { x: nextX + offsetX, y: nextY - offsetY },
        { x: nextX, y: nextY - 2 * offsetY }
    ];

    // Debug: Draw diamond footprint at mascot's feet
    if (!this.debugGraphics) {
        this.debugGraphics = this.add.graphics();
        this.debugGraphics.setDepth(9999); // Always on top
    }
    this.debugGraphics.clear();
    this.debugGraphics.lineStyle(2, 0x00ff00, 1);
    this.debugGraphics.beginPath();
    this.debugGraphics.moveTo(mascot.x, mascot.y);
    this.debugGraphics.lineTo(mascot.x - offsetX, mascot.y - offsetY);
    this.debugGraphics.lineTo(mascot.x, mascot.y - 2 * offsetY);
    this.debugGraphics.lineTo(mascot.x + offsetX, mascot.y - offsetY);
    this.debugGraphics.lineTo(mascot.x, mascot.y);
    this.debugGraphics.strokePath();
    this.debugGraphics.closePath();

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

    // Depth Sorting
    // Mascot's depth is her Y (since origin is 1, Y is her feet)
    mascot.setDepth(mascot.y);
}