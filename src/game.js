/**
 * Game Entry Point
 * ----------------
 * Wires scenes into Phaser and starts the game.
 */
import { bootScene } from './scenes/bootScene.js';
import { mainScene } from './scenes/mainScene.js';

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'game-container',
  pixelArt: true,
  scene: [bootScene, mainScene]
};

new Phaser.Game(config);