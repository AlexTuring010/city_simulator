// src/metrics/charts.js
// Renders 6 Chart.js comparison charts for Baseline vs AI sim

const chartInstances = {};

const COLORS = {
  baseline: 'rgba(54, 162, 235, 0.7)',
  baselineBorder: 'rgba(54, 162, 235, 1)',
  ai: 'rgba(75, 192, 130, 0.7)',
  aiBorder: 'rgba(75, 192, 130, 1)'
};

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: { color: '#ccc' }
    }
  },
  scales: {
    x: { ticks: { color: '#aaa' }, grid: { color: '#333' } },
    y: { ticks: { color: '#aaa' }, grid: { color: '#333' }, beginAtZero: true }
  }
};

function getOrCreate(canvasId, type, config) {
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return null;

  const existing = chartInstances[canvasId];
  if (existing) {
    existing.data = config.data;
    existing.update('none');
    return existing;
  }

  chartInstances[canvasId] = new Chart(ctx, {
    type,
    data: config.data,
    options: { ...CHART_DEFAULTS, ...config.options }
  });
  return chartInstances[canvasId];
}

function computeMetersPerTile() {
  const simData = window.__simMaps__?.baseline || window.__simMaps__?.ai;
  if (!simData?.tileToLatLng || !window.google?.maps?.geometry) return 11;

  try {
    const ll1 = simData.tileToLatLng(1, 1, 200, 100, { base1: true });
    const ll2 = simData.tileToLatLng(2, 1, 200, 100, { base1: true });
    if (!ll1 || !ll2) return 11;
    return google.maps.geometry.spherical.computeDistanceBetween(ll1, ll2);
  } catch {
    return 11;
  }
}

function buildWalkDistHistogram(npcStats, metersPerTile, binSize = 50) {
  const distances = npcStats
    .map(n => (n.walkedToStoresTiles || 0) * metersPerTile)
    .filter(d => d > 0);

  if (!distances.length) return { labels: [], counts: [] };

  const maxDist = Math.max(...distances);
  const numBins = Math.ceil(maxDist / binSize) || 1;
  const counts = new Array(numBins).fill(0);
  const labels = [];

  for (let i = 0; i < numBins; i++) {
    labels.push(`${i * binSize}-${(i + 1) * binSize}m`);
  }

  for (const d of distances) {
    const bin = Math.min(Math.floor(d / binSize), numBins - 1);
    counts[bin]++;
  }

  return { labels, counts };
}

function sumBins(storeStats, binKey) {
  const result = {};
  for (const s of Object.values(storeStats)) {
    const bins = s[binKey] || {};
    for (const [k, v] of Object.entries(bins)) {
      result[k] = (result[k] || 0) + v;
    }
  }
  return result;
}

function buildAbandonmentCount(npcStats) {
  return npcStats.reduce((sum, n) => sum + (n.abandonedDueToQueue || 0), 0);
}

function buildServedPerStore(storeStats) {
  const labels = [];
  const counts = [];
  const sorted = Object.values(storeStats).sort((a, b) => a.storeId - b.storeId);
  for (const s of sorted) {
    labels.push(`Store ${s.storeId}`);
    counts.push(s.servedCount || 0);
  }
  return { labels, counts };
}

function buildBadExperience(npcStats) {
  const bins = { '0': 0, '1': 0, '2': 0, '3+': 0 };
  for (const n of npcStats) {
    const rej = n.abandonedDueToQueue || 0;
    if (rej === 0) bins['0']++;
    else if (rej === 1) bins['1']++;
    else if (rej === 2) bins['2']++;
    else bins['3+']++;
  }
  return bins;
}

export function renderAllCharts(data) {
  if (!data.baseline || !data.ai) return;
  if (typeof Chart === 'undefined') return;

  const mpt = computeMetersPerTile();

  // 1. Walk Distance Histogram
  const walkB = buildWalkDistHistogram(data.baseline.npcStats, mpt);
  const walkA = buildWalkDistHistogram(data.ai.npcStats, mpt);
  const allWalkLabels = walkB.labels.length >= walkA.labels.length ? walkB.labels : walkA.labels;
  const padTo = (arr, len) => { while (arr.length < len) arr.push(0); return arr; };

  getOrCreate('chart-walk-dist', 'bar', {
    data: {
      labels: allWalkLabels,
      datasets: [
        { label: 'Baseline', data: padTo(walkB.counts, allWalkLabels.length), backgroundColor: COLORS.baseline, borderColor: COLORS.baselineBorder, borderWidth: 1 },
        { label: 'AI', data: padTo(walkA.counts, allWalkLabels.length), backgroundColor: COLORS.ai, borderColor: COLORS.aiBorder, borderWidth: 1 }
      ]
    }
  });

  // 2. Crowdedness at Arrival
  const crowdB = sumBins(data.baseline.storeStats, 'crowdnessAtArrivalBins');
  const crowdA = sumBins(data.ai.storeStats, 'crowdnessAtArrivalBins');
  const crowdLabels = ['0_20', '20_40', '40_60', '60_80', '80_100'];
  const crowdDisplay = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'];

  getOrCreate('chart-crowdedness', 'bar', {
    data: {
      labels: crowdDisplay,
      datasets: [
        { label: 'Baseline', data: crowdLabels.map(k => crowdB[k] || 0), backgroundColor: COLORS.baseline, borderColor: COLORS.baselineBorder, borderWidth: 1 },
        { label: 'AI', data: crowdLabels.map(k => crowdA[k] || 0), backgroundColor: COLORS.ai, borderColor: COLORS.aiBorder, borderWidth: 1 }
      ]
    }
  });

  // 3. Queue Length at Arrival
  const queueB = sumBins(data.baseline.storeStats, 'queueAtArrivalBins');
  const queueA = sumBins(data.ai.storeStats, 'queueAtArrivalBins');
  const qLabels = ['0', '1_5', '6_10', '10_plus'];
  const qDisplay = ['0', '1-5', '6-10', '10+'];

  getOrCreate('chart-queue-len', 'bar', {
    data: {
      labels: qDisplay,
      datasets: [
        { label: 'Baseline', data: qLabels.map(k => queueB[k] || 0), backgroundColor: COLORS.baseline, borderColor: COLORS.baselineBorder, borderWidth: 1 },
        { label: 'AI', data: qLabels.map(k => queueA[k] || 0), backgroundColor: COLORS.ai, borderColor: COLORS.aiBorder, borderWidth: 1 }
      ]
    }
  });

  // 4. Queue Abandonments
  const abandB = buildAbandonmentCount(data.baseline.npcStats);
  const abandA = buildAbandonmentCount(data.ai.npcStats);

  getOrCreate('chart-abandonment', 'bar', {
    data: {
      labels: ['Queue Abandonments'],
      datasets: [
        { label: 'Baseline', data: [abandB], backgroundColor: COLORS.baseline, borderColor: COLORS.baselineBorder, borderWidth: 1 },
        { label: 'AI', data: [abandA], backgroundColor: COLORS.ai, borderColor: COLORS.aiBorder, borderWidth: 1 }
      ]
    }
  });

  // 5. Customers Served / Store
  const servedB = buildServedPerStore(data.baseline.storeStats);
  const servedA = buildServedPerStore(data.ai.storeStats);

  getOrCreate('chart-served', 'bar', {
    data: {
      labels: servedB.labels,
      datasets: [
        { label: 'Baseline', data: servedB.counts, backgroundColor: COLORS.baseline, borderColor: COLORS.baselineBorder, borderWidth: 1 },
        { label: 'AI', data: servedA.counts, backgroundColor: COLORS.ai, borderColor: COLORS.aiBorder, borderWidth: 1 }
      ]
    }
  });

  // 6. Bad Experience per User
  const badB = buildBadExperience(data.baseline.npcStats);
  const badA = buildBadExperience(data.ai.npcStats);
  const badLabels = ['0', '1', '2', '3+'];

  getOrCreate('chart-bad-exp', 'bar', {
    data: {
      labels: badLabels.map(l => `${l} rejections`),
      datasets: [
        { label: 'Baseline', data: badLabels.map(k => badB[k] || 0), backgroundColor: COLORS.baseline, borderColor: COLORS.baselineBorder, borderWidth: 1 },
        { label: 'AI', data: badLabels.map(k => badA[k] || 0), backgroundColor: COLORS.ai, borderColor: COLORS.aiBorder, borderWidth: 1 }
      ]
    }
  });
}
