/**
 * Scribble / Path Indicator Helpers
 * --------------------------------
 * Pure helper functions (except CatmullRom uses Phaser.Curves.Spline).
 */

export const ARROW_ALPHA = 0.58;

// ---------- helpers ----------
function hash01(n) {
  const s = Math.sin(n) * 10000;
  return s - Math.floor(s);
}

export function buildScribblePoints(rawPoints, jitterPx = 2, samplesPerSegment = 3, seed = 1234) {
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

export function catmullRomInterpolate(points, samples = 3) {
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

export function decimatePoints(pts, minDist = 8) {
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

export function strokeMarkerFast(graphics, pts, color = 0x33ff77) {
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