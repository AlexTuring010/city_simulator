/**
 * Boot Scene
 * ----------
 * Loads the tilemap JSON, then jumps to MainScene.
 */

export function createBootScene() {
  return {
    key: 'BootScene',

    preload() {
      this.load.tilemapTiledJSON('map', 'map.json');
    },

    create() {
      this.scene.start('MainScene');
    }
  };
}

// Backward compat
export const bootScene = createBootScene();
