

export class Table {
  constructor(scene, GRID, tileX, tileY, { frame = 0 } = {}) {
    this.scene = scene;
    this.GRID = GRID;
    this.tileX = tileX;
    this.tileY = tileY;

    this.seats = [null, null];

    this.seatTransforms = [
      { pos: { x: 0, y: 0 }, depth: -1, facing: 'right' },
      { pos: { x: 8, y: 3 }, depth: 0, facing: 'left' }
    ];

    // stamp collision 
    if (typeof GRID.setBlocked === 'function') {
      GRID.setBlocked(tileX, tileY, true, { mirrorToLayer: true, weak: true });
    }

    const p = GRID.tileToWorld(tileX, tileY);
    this.sprite = scene.add.sprite(p.x, p.y, 'table', frame);
    this.sprite.setOrigin(0.5, 1);
    this.sprite.setDepth(this.sprite.y);
  }

  // -----------------------------
  // Stats
  // -----------------------------

  getFreeSeatCount() {
    return this.seats.filter(s => !s).length;
  }

  hasFreeSeat() {
    return this.getFreeSeatCount() > 0;
  }

  seatIndexFor(npc) {
    return this.seats[0] === npc ? 0 :
           this.seats[1] === npc ? 1 : -1;
  }

  // -----------------------------
  // Seating
  // -----------------------------

  seatNpc(npc) {
    if (!npc) return -1;

    const idx = this.seats.findIndex(s => !s);
    if (idx === -1) return -1;

    this.seats[idx] = npc;
    this._applySeatTransform(npc, idx);
    return idx;
  }

  unseatNpc(npc) {
    const idx = this.seatIndexFor(npc);
    if (idx < 0) return -1;

    this._clearSeatTransform(npc);
    this.seats[idx] = null;
    return idx;
  }

  // -----------------------------
  // Transform helpers
  // -----------------------------

  getSeatTransform(seatIdx) {
    return this.seatTransforms[seatIdx] ?? {
      pos: { x: 0, y: 0 },
      depth: 0
    };
  }

  _applySeatTransform(npc, seatIdx) {
    const t = this.getSeatTransform(seatIdx);
    npc.setDepthOffset?.(t.depth ?? 0);
    npc.setPositionOffset?.(t.pos?.x ?? 0, t.pos?.y ?? 0);
    if (t.facing) npc.setFacing?.(t.facing);
  }

  _clearSeatTransform(npc) {
    npc.setDepthOffset?.(0);
    npc.setPositionOffset?.(0, 0);
  }
}