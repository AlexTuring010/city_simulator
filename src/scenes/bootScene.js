/**
 * Boot Scene
 * ----------
 * Loads the tilemap JSON, then jumps to MainScene.
 */
export const bootScene = {
  key: 'BootScene',

  preload() {
    this.load.tilemapTiledJSON('map', 'map.json');
  },

  create() {
    this.scene.start('MainScene');
  }
};