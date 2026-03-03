// src/heat/heatOverlay.js
export class HeatOverlay {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.gridW = opts.gridW ?? 60;
    this.gridH = opts.gridH ?? 60;

    this._counts = new Uint16Array(this.gridW * this.gridH);
    this._lastDraw = 0;
    this.throttleMs = opts.throttleMs ?? 50; // ~20 FPS

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  setGridSize(gridW, gridH = gridW) {
    if (gridW === this.gridW && gridH === this.gridH) return;
    this.gridW = gridW;
    this.gridH = gridH;
    this._counts = new Uint16Array(this.gridW * this.gridH);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));

    // Draw in CSS pixels
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * npcsScreenPoints: array of {u, v} where u/v are normalized [0..1] screen coords
   */
  drawNormalizedPoints(npcsScreenPoints) {
    const now = performance.now();
    if (now - this._lastDraw < this.throttleMs) return;
    this._lastDraw = now;

    const { gridW, gridH } = this;
    const counts = this._counts;
    counts.fill(0);

    // Bin
    for (const p of npcsScreenPoints) {
      const u = p.u, v = p.v;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

      const x = (u * gridW) | 0;
      const y = (v * gridH) | 0;
      counts[y * gridW + x]++;
    }

    // max for normalization
    let maxV = 0;
    for (let i = 0; i < counts.length; i++) if (counts[i] > maxV) maxV = counts[i];

    // Draw
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    const cellW = w / gridW;
    const cellH = h / gridH;

    const denom = Math.log1p(maxV || 1);

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const v = counts[gy * gridW + gx];
        if (!v) continue;

        // log scale feels nicer for crowds
        const t = Math.log1p(v) / denom; // 0..1

        // hue: blue (240) -> red (0)
        const hue = (1 - t) * 240;
        const alpha = Math.min(0.85, 0.15 + t * 0.7);

        ctx.fillStyle = `hsla(${hue}, 100%, 50%, ${alpha})`;
        ctx.fillRect(gx * cellW, gy * cellH, cellW, cellH);
      }
    }

    // Optional: make it “smoother”
    // ctx.globalAlpha = 1;
    // ctx.filter = "blur(8px)";
    // ctx.drawImage(this.canvas, 0, 0, w, h);
    // ctx.filter = "none";
  }
}