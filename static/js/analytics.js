// ═══════════════════════════════════════════════════════════════════════════
// analytics.js — Chart.js charts for the Analytics page
// ═══════════════════════════════════════════════════════════════════════════

let lineChart = null, pieChart = null, barChart = null;
let currentPeriod = 'daily';

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: '#e6edf3', font: { family: 'Inter' } } } },
};

// ── Colour palette ────────────────────────────────────────────────────────────
const PALETTE = ['#6366f1','#f59e0b','#22c55e','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];

function rgba(hex, alpha = 0.15) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Load data & update charts ─────────────────────────────────────────────────
async function loadAnalytics() {
  const conf   = document.getElementById('aConf')?.value    || 0;
  const period = currentPeriod;
  try {
    const res  = await fetch(`/api/analytics?period=${period}&confidence=${conf}`);
    const data = await res.json();
    updateLineChart(data.timeseries || []);
    updatePieChart(data.severity_dist || []);
    updateBarChart(data.type_dist || []);
    updateTopAreas(data.top_areas || []);
  } catch (e) {
    console.error('Analytics fetch error', e);
  }
}

// ── Line chart — potholes over time ────────────────────────────────────────────
function updateLineChart(timeseries) {
  const labels = timeseries.map(r => r.label);
  const values = timeseries.map(r => r.count);
  const ctx    = document.getElementById('lineChart').getContext('2d');

  if (lineChart) { lineChart.destroy(); }

  lineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Potholes Detected',
        data:  values,
        borderColor:     '#6366f1',
        backgroundColor: rgba('#6366f1', 0.12),
        borderWidth: 2.5,
        fill: true,
        tension: 0.4,
        pointRadius:      4,
        pointBackgroundColor: '#6366f1',
        pointHoverRadius:     6,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: '#7d8590', font: { size: 11 } }, grid: { color: '#2d333b' } },
        y: { ticks: { color: '#7d8590', font: { size: 11 } }, grid: { color: '#2d333b' }, beginAtZero: true },
      },
    },
  });
}

// ── Pie chart — severity distribution ──────────────────────────────────────────
function updatePieChart(severities) {
  const labels = severities.map(r => r.severity || 'Unknown');
  const values = severities.map(r => r.count);
  const colors = severities.map(r => {
    const s = (r.severity || '').toLowerCase();
    return s === 'high' ? '#ef4444' : s === 'medium' ? '#eab308' : '#22c55e';
  });
  const ctx = document.getElementById('pieChart').getContext('2d');

  if (pieChart) { pieChart.destroy(); }

  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data:            values,
        backgroundColor: colors.map(c => rgba(c, 0.75)),
        borderColor:     colors,
        borderWidth:     2,
        hoverOffset:     8,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      cutout: '60%',
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { position: 'bottom', labels: { color: '#e6edf3', font: { family: 'Inter' }, padding: 14 } },
      },
    },
  });
}

// ── Bar chart — by type ────────────────────────────────────────────────────────
function updateBarChart(types) {
  const labels = types.map(r => r.type || 'Unknown');
  const values = types.map(r => r.count);
  const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
  const ctx    = document.getElementById('barChart').getContext('2d');

  if (barChart) { barChart.destroy(); }

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label:           'Count',
        data:            values,
        backgroundColor: colors.map(c => rgba(c, 0.5)),
        borderColor:     colors,
        borderWidth:     2,
        borderRadius:    6,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ticks: { color: '#7d8590' }, grid: { color: '#2d333b' } },
        y: { ticks: { color: '#7d8590' }, grid: { color: '#2d333b' }, beginAtZero: true },
      },
    },
  });
}

// ── Top affected areas ─────────────────────────────────────────────────────────
function updateTopAreas(areas) {
  const container = document.getElementById('topAreas');
  if (!container) return;
  if (!areas.length) {
    container.innerHTML = '<p style="color:#7d8590;font-size:.82rem">No data available</p>';
    return;
  }
  const max = areas[0].count || 1;
  container.innerHTML = areas.map((a, i) => `
    <div class="area-row">
      <span class="area-label" style="min-width:24px;color:#7d8590;font-weight:600">#${i+1}</span>
      <span class="area-label" style="min-width:160px;font-family:monospace;font-size:.75rem">
        ${(+a.lat).toFixed(3)}, ${(+a.lon).toFixed(3)}
      </span>
      <div class="area-bar-wrap">
        <div class="area-bar" style="width:${Math.round((a.count/max)*100)}%"></div>
      </div>
      <span class="area-count">${a.count}</span>
    </div>`).join('');
}

// ── Period selection ───────────────────────────────────────────────────────────
function setPeriod(el, p) {
  currentPeriod = p;
  document.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  loadAnalytics();
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadAnalytics();
