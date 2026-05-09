// ═══════════════════════════════════════════════════════════════════════════
// map.js — Leaflet map with clustering, heatmap, severity markers, auto-refresh
// ═══════════════════════════════════════════════════════════════════════════

/* MAP_SETTINGS is injected by dashboard.html */
const defaultSettings = window.MAP_SETTINGS || { lat: 20.5937, lon: 78.9629, zoom: 13, refresh: 5 };

// ── Init map ────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center:          [defaultSettings.lat, defaultSettings.lon],
  zoom:            defaultSettings.zoom,
  zoomControl:     true,
  attributionControl: true,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// ── State ───────────────────────────────────────────────────────────────────
let markerClusterGroup = L.markerClusterGroup({ maxClusterRadius: 50, disableClusteringAtZoom: 17 });
let allData            = [];
let userReports        = [];
let showClusters       = true;
let refreshTimer       = null;
let activeFilters      = { severity: '', status: '', confidence: 0 };
let userMarker         = null;
let firstLoad           = true;

map.addLayer(markerClusterGroup);

// ── Geolocation ─────────────────────────────────────────────────────────────
function initGeolocation() {
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        
        // Basic sanity check
        if (Math.abs(lat) < 0.1 && Math.abs(lon) < 0.1) return;

        map.setView([lat, lon], 14);
        userMarker = L.circleMarker([lat, lon], { radius: 10, color: '#6366f1', fillOpacity: 0.7 })
          .addTo(map).bindPopup('My Location').openPopup();
      }, 
      (err) => {
        console.warn("GPS unavailable on init", err);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }
}

function locateMe() {
  if ('geolocation' in navigator) {
    if (typeof showToast === 'function') showToast('Getting your location...', 'info', 2000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        
        if (Math.abs(lat) < 0.1 && Math.abs(lon) < 0.1) {
          if (typeof showToast === 'function') showToast('Low accuracy GPS data. Please try again.', 'warning');
          return;
        }

        map.setView([lat, lon], 16);
        if (userMarker) {
          userMarker.setLatLng([lat, lon]);
          userMarker.openPopup();
        } else {
          userMarker = L.circleMarker([lat, lon], { radius: 10, color: '#6366f1', fillOpacity: 0.7 })
            .addTo(map).bindPopup('My Location').openPopup();
        }
        if (typeof showToast === 'function') showToast('Located ✓', 'success');
      },
      (err) => {
        let msg = "Geolocation failed: " + err.message;
        if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
           msg = "Secure connection (HTTPS) required for GPS.";
        }
        if (typeof showToast === 'function') showToast(msg, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  } else {
    if (typeof showToast === 'function') showToast('Location not supported', 'warning');
  }
}

// ── Marker icons ─────────────────────────────────────────────────────────────
function makeIcon(severity, isUserReport = false) {
  const sev = (severity || '').toLowerCase();
  const colors = { critical: '#DC2626', high: '#ef4444', medium: '#f97316', low: '#22c55e' };
  const color  = isUserReport ? '#3b82f6' : (colors[sev] || '#6366f1');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32" width="24" height="32">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 8 12 20 12 20S24 20 24 12C24 5.4 18.6 0 12 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="5" fill="#fff" opacity="0.9"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize:   [24, 32],
    iconAnchor: [12, 32],
    popupAnchor:[0, -32],
  });
}

// ── Build popup ──────────────────────────────────────────────────────────────
function buildPopup(r) {
  const img = r.image_url
    ? `<img src="${r.image_url}" onerror="this.onerror=null;this.outerHTML='<div style=\\'width:100%;height:80px;background:#1c2128;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#ef4444;margin-bottom:10px\\'><i class=\\'fa-solid fa-image-slash fa-2x\\'></i></div>';" style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:10px;cursor:pointer"
            onclick="window.open('${r.image_url}','_blank')"/>`
    : `<div style="width:100%;height:80px;background:#1c2128;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#7d8590;margin-bottom:10px"><i class="fa-solid fa-image fa-2x"></i></div>`;
  const sevLower = (r.severity || '').toLowerCase();
  const sevColor = sevLower === 'critical' ? '#DC2626' : sevLower === 'high' ? '#ef4444' : sevLower === 'medium' ? '#f97316' : '#22c55e';
  const stsColor = r.status   === 'Fixed'? '#22c55e' : r.status === 'In Progress' ? '#3b82f6' : '#f59e0b';
  const conf     = Math.round((r.confidence || 0) * 100);
  return `
  <div style="min-width:220px;font-family:Inter,sans-serif;font-size:13px;color:#e6edf3">
    ${img}
    <div style="display:grid;gap:5px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:14px">Pothole #${r.id}</strong>
        <span style="background:${sevColor}22;color:${sevColor};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${r.severity || '—'}</span>
      </div>
      <div style="color:#7d8590;font-size:11px"><i class="fa-solid fa-map-pin"></i> ${parseFloat(r.latitude).toFixed(5)}, ${parseFloat(r.longitude).toFixed(5)}</div>
      <div style="color:#7d8590;font-size:11px"><i class="fa-solid fa-clock"></i> ${r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:2px">
        <span style="background:${stsColor}22;color:${stsColor};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${r.status || 'Pending'}</span>
        <span style="font-size:11px;color:#7d8590">Type: ${r.type || '—'}</span>
        ${r.report_count > 1 ? `<span style="font-size:11px;color:var(--accent);font-weight:600"><i class="fa-solid fa-users"></i> ${r.report_count} reports</span>` : ''}
      </div>
      <div>
        <div style="background:#161b22;border-radius:4px;height:5px;overflow:hidden;margin:4px 0">
          <div style="height:100%;width:${conf}%;background:${conf>=75?'#22c55e':conf>=50?'#f59e0b':'#ef4444'};border-radius:4px"></div>
        </div>
        <span style="font-size:11px;color:#7d8590">Confidence: ${conf}%</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button onclick="markFixedFromMap(${r.id})"
          style="flex:1;padding:5px;background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3);border-radius:6px;cursor:pointer;font-size:11px">
          ✓ Mark Fixed
        </button>
        <button onclick="openAssignModal(${r.id})"
          style="flex:1;padding:5px;background:rgba(99,102,241,.15);color:#6366f1;border:1px solid rgba(99,102,241,.3);border-radius:6px;cursor:pointer;font-size:11px">
          + Assign
        </button>
      </div>
    </div>
  </div>`;
}

function buildUserReportPopup(r) {
  const media = r.type === 'video'
    ? `<video src="${r.media_url}" controls style="width:100%;border-radius:8px;margin-bottom:10px"></video>`
    : `<img src="${r.media_url}" style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:10px;cursor:pointer" onclick="window.open('${r.media_url}','_blank')"/>`;
  
  return `
  <div style="min-width:220px;font-family:Inter,sans-serif;font-size:13px;color:#e6edf3">
    ${media}
    <div style="display:grid;gap:5px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:14px">User Report</strong>
        <span style="background:#3b82f622;color:#3b82f6;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">PENDING</span>
      </div>
      <div style="color:#7d8590;font-size:11px"><i class="fa-solid fa-map-pin"></i> ${parseFloat(r.latitude).toFixed(5)}, ${parseFloat(r.longitude).toFixed(5)}</div>
      <div style="color:#7d8590;font-size:11px"><i class="fa-solid fa-clock"></i> ${new Date(r.created_at).toLocaleString()}</div>
      <div style="margin-top:5px; padding:8px; background:#161b22; border-radius:6px; font-style:italic">
        "${r.description || 'No description provided'}"
      </div>
    </div>
  </div>`;
}

// ── Load & render markers ────────────────────────────────────────────────────
async function loadMarkers() {
  const container = map.getContainer();
  let spinner = document.getElementById('map-spinner');
  if(!spinner && container) {
    spinner = document.createElement('div');
    spinner.id = 'map-spinner';
    spinner.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:24px;color:#6366f1"></i>';
    spinner.style.cssText = 'position:absolute;top:15px;right:15px;z-index:9999;background:var(--card-bg);padding:10px;border-radius:50%;box-shadow:0 4px 12px rgba(0,0,0,0.5);display:none;';
    container.appendChild(spinner);
  }
  if (spinner) spinner.style.display = 'block';

  try {
    const res = await fetch('/api/alerts');
    allData = await res.json();
    userReports = []; // No longer needed separately
  } catch (e) {
    console.error('Map fetch error', e);
    if (spinner) spinner.style.display = 'none';
    return;
  }
  
  if (spinner) spinner.style.display = 'none';
  renderMarkers();
  updateStats();
  
  // Update alerts panel using the same data to save API calls
  if (typeof pollAlerts === 'function') {
    pollAlerts(allData);
  }
}

function renderMarkers() {
  markerClusterGroup.clearLayers();

    allData.forEach(r => {
    const lat = parseFloat(r.latitude);
    const lon = parseFloat(r.longitude);
    if (isNaN(lat) || isNaN(lon)) return;
    
    if (showClusters) {
      const isUserReport = r.type === 'user_report';
      const color = isUserReport ? '#3b82f6' : (r.severity === 'critical' ? '#DC2626' : r.severity === 'high' ? '#ef4444' : r.severity === 'medium' ? '#f97316' : '#22c55e');
      const marker = L.marker([lat, lon], { icon: makeIcon(r.severity, isUserReport) });
      
      const popupHtml = `
        <div style="min-width:180px; font-family:Inter,sans-serif; color:#e6edf3">
          ${r.image ? `<img src="${r.image}" style="width:100%; height:120px; object-fit:cover; border-radius:8px; margin-bottom:10px"/>` : ''}
          <div style="font-weight:700; font-size:14px; margin-bottom:4px">${isUserReport ? 'User Report' : `#${r.id} Pothole`}</div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
            <span style="font-size:12px; color:var(--muted)">${r.report_count || 1} reports</span>
            <span class="badge" style="background:${color}22; color:${color}; padding:2px 8px; border-radius:12px; font-size:10px">${(r.severity || 'medium').toUpperCase()}</span>
          </div>
          <div style="font-size:11px; color:var(--muted); line-height: 1.6">
            <i class="fa-solid fa-clock"></i> Last seen: ${r.last_seen}<br>
            <i class="fa-solid fa-bullseye"></i> Status: ${r.status || 'Pending'}<br>
            <i class="fa-solid fa-info-circle"></i> Source: ${r.source}<br>
            ${isUserReport ? `<i class="fa-solid fa-comment"></i> ${r.description || 'No description'}` : ''}
          </div>
          <div style="display:flex; flex-direction:column; gap:6px; margin-top:12px">
            <button onclick="showReports(${lat}, ${lon})" style="width:100%; padding:8px; background:var(--accent); color:#fff; border:none; border-radius:8px; cursor:pointer; font-size:11px; font-weight:600"><i class="fa-solid fa-images"></i> View Reports</button>
            ${!isUserReport ? `<button onclick="markFixedFromMap(${r.id})" style="width:100%; padding:6px; background:rgba(34,197,94,.1); color:#22c55e; border:1px solid #22c55e33; border-radius:6px; cursor:pointer; font-size:11px">Mark Fixed</button>` : ''}
          </div>
        </div>
      `;
      
      marker.bindPopup(popupHtml, { maxWidth: 280, className: 'pothole-popup' });
      markerClusterGroup.addLayer(marker);
    }
  });

}

// ── Stats cards ──────────────────────────────────────────────────────────────
async function updateStats() {
  try {
    const res  = await fetch('/api/stats');
    const data = await res.json();
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('stat-total',   data.total   ?? '—');
    setEl('stat-today',   data.today   ?? '—');
    setEl('stat-fixed',   data.fixed   ?? '—');
    setEl('stat-pending', data.pending ?? '—');
  } catch (_) {}
}

// ── Toggling ─────────────────────────────────────────────────────────────────
function toggleClusters() {
  showClusters = !showClusters;
  document.getElementById('btnClusters').classList.toggle('active', showClusters);
  renderMarkers();
}


// ── Filter chips ─────────────────────────────────────────────────────────────
document.querySelectorAll('#severityFilters .filter-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#severityFilters .filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilters.severity = btn.dataset.val;
    scheduleRefresh();
  });
});

document.querySelectorAll('#statusFilters .filter-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#statusFilters .filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilters.status = btn.dataset.val;
    scheduleRefresh();
  });
});

const confSlider = document.getElementById('confSlider');
if (confSlider) {
  confSlider.addEventListener('change', () => {
    activeFilters.confidence = confSlider.value;
    scheduleRefresh();
  });
}

// ── Auto refresh ─────────────────────────────────────────────────────────────
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadMarkers, 400);
}

function startAutoRefresh() {
  loadMarkers();
  setInterval(loadMarkers, (defaultSettings.refresh || 5) * 1000);
}

// ── Mark fixed from popup ────────────────────────────────────────────────────
window.markFixedFromMap = async function(id) {
  await fetch(`/api/pothole/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Fixed' }),
  });
  map.closePopup();
  loadMarkers();
  if (typeof showToast === 'function') showToast('Marked as Fixed ✓', 'success');
};

// ── Start ────────────────────────────────────────────────────────────────────
// ── Reports Modal Logic ──────────────────────────────────────────────────────
window.showReports = async function(lat, lon) {
  const modal = document.getElementById('reportsModal');
  const container = document.getElementById('reportsContainer');
  if (!modal || !container) return;

  modal.style.display = 'flex';
  container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading reports...</div>';

  try {
    console.log(`[Reports] Fetching for lat=${lat}, lon=${lon}...`);
    const res = await fetch(`/api/location-reports?lat=${lat}&lon=${lon}`);
    
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error("[Reports] API Error:", errData);
      throw new Error(errData.error || `Server error: ${res.status}`);
    }

    const reports = await res.json();
    console.log(`[Reports] Found ${reports?.length || 0} reports.`);
    
    if (!Array.isArray(reports) || reports.length === 0) {
      container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--muted)">No media reports found for this location.</div>';
      return;
    }

    container.innerHTML = reports.map(r => {
      const isVideo = r.type === 'video';
      const sourceColor = r.source === 'AI' ? 'var(--accent)' : '#3b82f6';
      
      // Fallback for missing images
      const displayMedia = r.image || '/static/img/placeholder.jpg';
      
      return `
        <div class="report-tile" style="background:rgba(255,255,255,0.05); border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); position:relative">
          <div style="position:absolute; top:8px; left:8px; background:${sourceColor}; color:#fff; font-size:9px; padding:2px 6px; border-radius:4px; font-weight:700; z-index:10; box-shadow:0 2px 4px rgba(0,0,0,0.3)">
            ${r.source.toUpperCase()}
          </div>
          ${isVideo 
            ? `<video src="${displayMedia}" controls style="width:100%; height:140px; object-fit:cover"></video>` 
            : `<img src="${displayMedia}" style="width:100%; height:140px; object-fit:cover; cursor:pointer" onclick="window.open('${displayMedia}', '_blank')" onerror="this.src='/static/img/placeholder.jpg'; this.onerror=null;">`}
          <div style="padding:10px; font-size:11px">
            <div style="display:flex; justify-content:space-between; margin-bottom:4px">
              <span style="color:var(--muted)">${r.created_at ? new Date(r.created_at).toLocaleDateString() : 'Unknown date'}</span>
              <span style="color:${r.status === 'Fixed' ? '#22c55e' : '#f59e0b'}">${r.status || 'Pending'}</span>
            </div>
            <div style="color:var(--text); line-height:1.4; height:32px; overflow:hidden; text-overflow:ellipsis">
              ${r.description || (r.source === 'AI' ? `AI detected ${r.severity} severity hazard` : 'User report')}
            </div>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error("[Reports] Modal Error:", err);
    container.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--danger)">
      <i class="fa-solid fa-circle-exclamation fa-2x" style="margin-bottom:10px"></i><br>
      Failed to load reports.<br>
      <small style="color:var(--muted)">${err.message}</small>
    </div>`;
  }
};

window.closeReportsModal = function() {
  const modal = document.getElementById('reportsModal');
  if (modal) {
    modal.style.display = 'none';
    const container = document.getElementById('reportsContainer');
    if (container) container.innerHTML = ''; // Stop videos
  }
};

// Haversine for JS
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

initGeolocation();
startAutoRefresh();
