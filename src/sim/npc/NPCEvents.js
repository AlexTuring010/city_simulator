// NPCEvents.js
// Centralized event names + reason enums to avoid string typos
// Keep this file Phaser-free (headless-friendly).

export const NPC_EVENTS = Object.freeze({
  STATE_CHANGED: 'stateChanged',
  GOAL_SET: 'goalSet',
  ARRIVED: 'arrived',
  STUCK: 'stuck',
  STOPPED: 'stopped',
  WAIT_DONE: 'waitDone', 
  CALLED_TO_ENTER: 'called_to_enter',
  DESPAWNED: 'DESPAWNED' // for episodes to know when NPCs are fully removed
});

export const NPC_STUCK_REASONS = Object.freeze({
  GOAL_BLOCKED: 'goal_blocked',
  NO_PATH: 'no_path',
  INTERNAL: 'internal'
});

export const NPC_STOP_REASONS = Object.freeze({
  STOPPED: 'stopped',
  NAV_STOP: 'nav_stop',
  DESPAWN: 'despawn'
});