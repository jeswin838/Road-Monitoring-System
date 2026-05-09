// ═══════════════════════════════════════════════════════════════════════════
// navigation.js  —  Safe Route Navigation (Leaflet + ORS backend)
// ═══════════════════════════════════════════════════════════════════════════

/* ── Config ───────────────────────────────────────────────────────────────── */
const NAV_CFG = {
  defaultLat:     12.1326,
  defaultLon:     78.1944,
  defaultZoom:    13,
  refreshMs:      12000,    // pothole refresh interval
  potholeCache:   null,
  potholeExpiry:  0,
};

/* ── State ────────────────────────────────────────────────────────────────── */
let navMap            = null;
let clickMode         = 'start';   // 'start' | 'end'
let startLatLon       = null;
let endLatLon         = null;
let startMarker       = null;
let endMarker         = null;
let userMarker        = null;      // Current GPS location
let userLatLon        = null;
let safeRouteLayer    = null;
let fallbackRouteLayer= null;
let potholeLayerGroup = null;
let dangerZoneGroup   = null;
let refreshTimer      = null;
let notifyTimer       = null;
let lastNotifiedId    = null;

/* ── Icons ────────────────────────────────────────────────────────────────── */
function makeIcon(color, label) {
  return L.divIcon({
    className: '',
    iconSize:  [30, 42],
    iconAnchor:[15, 42],
    popupAnchor:[0, -40],
    html: `
      <svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">
        <path d="M15 0 C6.7 0 0 6.7 0 15 C0 26 15 42 15 42 C15 42 30 26 30 15 C30 6.7 23.3 0 15 0Z"
              fill="${color}" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>
        <text x="15" y="20" text-anchor="middle" font-size="13" font-weight="bold"
              font-family="Inter,sans-serif" fill="#fff">${label}</text>
      </svg>`,
  });
}

const startIcon = makeIcon('#22c55e', 'A');
const endIcon   = makeIcon('#ef4444', 'B');

/* ── Map initialisation ───────────────────────────────────────────────────── */
function initNavMap() {
  navMap = L.map('navMap', { zoomControl: true }).setView(
    [NAV_CFG.defaultLat, NAV_CFG.defaultLon], NAV_CFG.defaultZoom
  );

  // OpenStreetMap tiles with dark-ish overlay
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(navMap);

  potholeLayerGroup = L.layerGroup().addTo(navMap);
  dangerZoneGroup   = L.layerGroup().addTo(navMap);

  navMap.on('click', onMapClick);

  // Load potholes immediately then schedule refresh
  loadPotholes();
  refreshTimer = setInterval(loadPotholes, NAV_CFG.refreshMs);
}

/* ── Map click handler ────────────────────────────────────────────────────── */
function onMapClick(e) {
  const { lat, lng } = e.latlng;
  if (clickMode === 'start') {
    placeMarker('start', lat, lng);
  } else {
    placeMarker('end', lat, lng);
  }
}

function placeMarker(type, lat, lng) {
  if (type === 'start') {
    if (startMarker) navMap.removeLayer(startMarker);
    startLatLon = [lat, lng];
    startMarker = L.marker([lat, lng], { icon: startIcon })
      .bindPopup('<b>Start</b>').addTo(navMap);
    document.getElementById('startInput').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } else {
    if (endMarker) navMap.removeLayer(endMarker);
    endLatLon = [lat, lng];
    endMarker = L.marker([lat, lng], { icon: endIcon })
      .bindPopup('<b>Destination</b>').addTo(navMap);
    document.getElementById('endInput').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

/* ── Click mode toggle ────────────────────────────────────────────────────── */
function setClickMode(mode) {
  clickMode = mode;
  document.getElementById('modeStart').style.opacity = mode === 'start' ? '1' : '.5';
  document.getElementById('modeEnd').style.opacity   = mode === 'end'   ? '1' : '.5';
  navMap.getContainer().style.cursor = 'crosshair';
}

/* ── Clear a point ────────────────────────────────────────────────────────── */
function clearPoint(type) {
  if (type === 'start') {
    if (startMarker) navMap.removeLayer(startMarker);
    startMarker = null; startLatLon = null;
    document.getElementById('startInput').value = '';
  } else {
    if (endMarker) navMap.removeLayer(endMarker);
    endMarker = null; endLatLon = null;
    document.getElementById('endInput').value = '';
  }
  clearRoutes();
}

/* ── Use GPS location ─────────────────────────────────────────────────────── */
function useMyLocation() {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported by your browser', 'error');
    return;
  }
  showToast('Getting your location…', 'info', 2000);
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      
      // Basic sanity check for GPS data
      if (Math.abs(lat) < 0.1 && Math.abs(lng) < 0.1) {
        showToast('Low accuracy GPS data received. Please try again.', 'warning');
        return;
      }

      userLatLon = [lat, lng];
      placeMarker('start', lat, lng);
      updateUserMarker(lat, lng);
      navMap.setView([lat, lng], 17); // Closer zoom for current location
      showToast('Start set to your location ✓', 'success');
      
      // Start continuous tracking
      trackUserLocation();
    },
    err => showToast('Could not get location: ' + err.message, 'error'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function trackUserLocation() {
  navigator.geolocation.watchPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      userLatLon = [lat, lng];
      updateUserMarker(lat, lng);
    },
    err => console.warn('WatchPosition error:', err),
    { enableHighAccuracy: true }
  );
}

function updateUserMarker(lat, lng) {
  if (!navMap) return;
  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    userMarker = L.circleMarker([lat, lng], {
      radius: 8,
      fillColor: '#3b82f6',
      color: '#fff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8
    }).addTo(navMap).bindPopup('Your Location');
  }
}

/* ── Load & render potholes ───────────────────────────────────────────────── */
async function loadPotholes() {
  try {
    const res = await fetch('/api/alerts');
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    renderPotholes(data);
  } catch (e) {
    console.warn('Could not fetch real-time potholes:', e);
  }
}

function renderPotholes(potholes) {
  potholeLayerGroup.clearLayers();
  dangerZoneGroup.clearLayers();

  const clusters = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 40,
    spiderfyOnMaxZoom: true
  });

  potholes.forEach(p => {
    const lat = parseFloat(p.latitude);
    const lon = parseFloat(p.longitude);
    if (isNaN(lat) || isNaN(lon)) return;

    const isUserReport = p.type === 'user_report';
    const sev   = (p.severity || 'low').toLowerCase();
    const color = isUserReport ? '#3b82f6' : (sev === 'critical' ? '#DC2626' : sev === 'high' ? '#ef4444' : sev === 'medium' ? '#f59e0b' : '#22c55e');
    
    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        iconSize: [24, 32],
        iconAnchor: [12, 32],
        html: `<svg viewBox="0 0 24 32"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="${color}" stroke="#fff" stroke-width="1.5"/></svg>`
      })
    });

    const imgHtml = p.image ? `<img src="${p.image}" style="width:140px;border-radius:6px;margin-bottom:6px;display:block"/>` : '';
    
    marker.bindPopup(`
      <div style="font-family:Inter,sans-serif;font-size:13px;min-width:180px">
        ${imgHtml}
        <div style="font-weight:700; margin-bottom:4px">${isUserReport ? 'User Report' : `#${p.id} Pothole`}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
          <span style="color:#7d8590">${p.report_count || 1} reports</span>
          <b style="color:${color}">${sev.toUpperCase()}</b>
        </div>
        <div style="color:#7d8590; font-size:11px; line-height:1.5">
          <i class="fa-solid fa-clock"></i> ${p.last_seen}<br>
          <i class="fa-solid fa-bullseye"></i> Status: ${p.status || 'Pending'}<br>
          <i class="fa-solid fa-info-circle"></i> Source: ${p.source}
        </div>
        <button onclick="showReports(${lat}, ${lon})" style="width:100%; margin-top:10px; padding:6px; background:var(--accent); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:11px; font-weight:600">View Reports</button>
      </div>
    `, { maxWidth: 220 });
    
    clusters.addLayer(marker);

    // Hazard zone for routing avoidance
    if (sev === 'critical' || sev === 'high' || isUserReport) {
      L.circle([lat, lon], {
        radius: 50, color: color, fillColor: color, fillOpacity: 0.08, weight: 1, dashArray: '4 4'
      }).addTo(dangerZoneGroup);
    }
  });

  potholeLayerGroup.addLayer(clusters);
}

// ── Reports Modal Logic ──────────────────────────────────────────────────────
window.showReports = async function(lat, lon) {
  const modal = document.getElementById('reportsModal');
  const container = document.getElementById('reportsContainer');
  if (!modal || !container) return;

  modal.style.display = 'flex';
  container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>';

  try {
    const res = await fetch('/api/user-reports');
    const allReports = await res.json();
    const nearby = allReports.filter(r => {
      const d = haversineDist(lat, lon, parseFloat(r.latitude), parseFloat(r.longitude));
      return d < 50.0;
    });

    if (nearby.length === 0) {
      container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--muted)">No reports found.</div>';
      return;
    }

    container.innerHTML = nearby.map(r => {
      const isVideo = r.type === 'video';
      return `
        <div style="background:rgba(255,255,255,0.05); border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,0.1)">
          ${isVideo ? `<video src="${r.media_url}" controls style="width:100%; height:140px; object-fit:cover"></video>` 
                    : `<img src="${r.media_url}" style="width:100%; height:140px; object-fit:cover" onclick="window.open('${r.media_url}', '_blank')">`}
          <div style="padding:10px; font-size:11px">
            <div style="color:var(--muted); margin-bottom:4px">${new Date(r.created_at).toLocaleDateString()}</div>
            <div style="color:var(--text); line-height:1.4">${r.description || 'User report'}</div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--danger)">Error loading reports.</div>';
  }
};

window.closeReportsModal = function() {
  const modal = document.getElementById('reportsModal');
  if (modal) {
    modal.style.display = 'none';
    document.getElementById('reportsContainer').innerHTML = '';
  }
};

function haversineDist(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ── Find Safe Route ──────────────────────────────────────────────────────── */
async function findSafeRoute() {
  if (!startLatLon || !endLatLon) {
    showToast('Please set both start and destination on the map', 'error');
    return;
  }

  clearRoutes();

  const btn = document.getElementById('findRouteBtn');
  btn.innerHTML = '<span class="spinner"></span> Calculating…';
  btn.disabled  = true;

  try {
    const res = await fetch('/api/safe-route', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ start: startLatLon, end: endLatLon }),
    });

    const data = await res.json();

    if (!res.ok) {
      const errorMsg = data.detail ? `${data.error}: ${data.detail}` : (data.error || '⚠️ Routing service unavailable');
      showToast(errorMsg, 'error', 6000);
      return;
    }

    drawRoute(data);

  } catch (e) {
    showToast('⚠️ Routing service unavailable', 'error', 5000);
    console.error(e);
  } finally {
    btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Find Safe Route';
    btn.disabled  = false;
  }
}

/* ── Draw route on map ────────────────────────────────────────────────────── */
function drawRoute(data) {
  const { route, safety, risk_score, potholes_on_path, detected_potholes, avoided_potholes } = data;
  if (!route || route.length < 2) {
    showToast('No route coordinates received', 'error');
    return;
  }

  // 1. Determine Route Color & Risk Label
  let routeColor = '#22c55e'; // default safe (green)
  let statusText = 'Safe (No potholes)';
  let badgeClass = 'safe-badge';

  if (safety === 'unsafe' || risk_score > 70) {
    routeColor = '#ef4444'; // red
    statusText = 'High Risk (Danger)';
    badgeClass = 'unsafe-badge';
  } else if (safety === 'moderate' || (risk_score > 0 && risk_score <= 70)) {
    routeColor = '#f59e0b'; // orange
    statusText = 'Moderate Risk (Few potholes)';
    badgeClass = 'moderate-badge';
  }

  const routeOptions = {
    color:  routeColor,
    weight: 6,
    opacity: 0.9,
    lineJoin: 'round',
    lineCap:  'round',
  };

  safeRouteLayer = L.polyline(route, routeOptions).addTo(navMap);

  // 2. Highlight detected potholes on the path
  if (detected_potholes && detected_potholes.length > 0) {
    detected_potholes.forEach(p => {
      L.circle([p.lat, p.lon], {
        radius: 60, // visual highlight radius
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.4,
        weight: 2,
        dashArray: '5, 5'
      })
      .bindPopup(`<b>Hazard Detected</b><br>Severity: ${p.severity}<br>Distance to path: ${p.dist.toFixed(1)}m`)
      .addTo(navMap);
    });
  }

  // Animate: zoom to route bounds
  navMap.fitBounds(safeRouteLayer.getBounds(), { padding: [50, 50], animate: true });

  // 3. Update status panel UI
  document.getElementById('routeStatus').style.display = 'block';
  const safetyEl = document.getElementById('safetyBadge');
  safetyEl.textContent = statusText;
  safetyEl.className   = `status-value ${badgeClass}`;
  
  // Update Risk Score display
  const riskValEl = document.getElementById('riskValue');
  if (riskValEl) {
    riskValEl.textContent = `${risk_score}%`;
    riskValEl.style.color = routeColor;
  }

  document.getElementById('potholesOnPath').textContent = potholes_on_path;
  document.getElementById('avoidedCount').textContent    = avoided_potholes;

  // 4. Warning Box & Accuracy Note
  const warnBox = document.getElementById('routeWarningBox');
  let warnHtml = '';
  
  if (safety === 'unsafe') {
    warnBox.style.background = 'rgba(239, 68, 68, 0.1)';
    warnBox.style.border = '1px solid rgba(239, 68, 68, 0.3)';
    warnBox.style.color = 'var(--danger)';
    warnHtml = `<i class="fa-solid fa-triangle-exclamation"></i> <b>Danger:</b> ${potholes_on_path} high-risk hazards detected within 100m of this path.`;
  } else if (safety === 'moderate') {
    warnBox.style.background = 'rgba(245, 158, 11, 0.1)';
    warnBox.style.border = '1px solid rgba(245, 158, 11, 0.3)';
    warnBox.style.color = 'var(--warning)';
    warnHtml = `<i class="fa-solid fa-circle-exclamation"></i> <b>Caution:</b> ${potholes_on_path} minor hazards detected near this path.`;
  }
  
  // Add accuracy note
  warnHtml += `<div style="margin-top:8px; font-size:0.7rem; opacity:0.7; border-top:1px solid rgba(0,0,0,0.1); padding-top:4px">
    <i class="fa-solid fa-bullseye"></i> Detection corridor: 100m radius from route center.
  </div>`;
  
  warnBox.innerHTML = warnHtml;
  warnBox.style.display = (safety === 'safe') ? 'none' : 'block';

  // 5. Route banner on map
  const banner = document.getElementById('routeBanner');
  banner.style.display = 'block';
  banner.style.color = routeColor;
  banner.innerHTML = `<i class="fa-solid ${safety === 'safe' ? 'fa-shield-check' : 'fa-triangle-exclamation'}"></i> ${statusText} — Risk: ${risk_score}%`;

  // Toast
  if (safety === 'safe') showToast('✅ Safe route found!', 'success');
  else if (safety === 'moderate') showToast(`⚠️ Moderate route: Risk ${risk_score}%`, 'warning');
  else showToast(`❌ Unsafe route: Risk ${risk_score}%`, 'error');
}

/* ── Clear existing routes ────────────────────────────────────────────────── */
function clearRoutes() {
  if (safeRouteLayer)    { navMap.removeLayer(safeRouteLayer);    safeRouteLayer    = null; }
  if (fallbackRouteLayer){ navMap.removeLayer(fallbackRouteLayer); fallbackRouteLayer= null; }
  document.getElementById('routeStatus').style.display  = 'none';
  document.getElementById('routeBanner').style.display  = 'none';
}

/* ── Manual Input Parsing ────────────────────────────────────────────────── */
function handleManualInput(type) {
  const el = document.getElementById(type === 'start' ? 'startInput' : 'endInput');
  const val = el.value.trim();
  if (!val) return;

  // Expected format: "lat, lon"
  const parts = val.split(',').map(s => parseFloat(s.trim()));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    placeMarker(type, parts[0], parts[1]);
    // Also zoom to the new point
    navMap.setView([parts[0], parts[1]], 15);
  } else {
    showToast('Invalid format. Use "lat, lon"', 'warning');
  }
}

/* ── Nearby Notifications ─────────────────────────────────────────────────── */
async function checkNearbyPotholes() {
  if (!userLatLon) return;

  try {
    const res = await fetch(`/api/nearby-potholes?lat=${userLatLon[0]}&lon=${userLatLon[1]}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.potholes && data.potholes.length > 0) {
      const topPothole = data.potholes[0];
      if (topPothole.id !== lastNotifiedId) {
        lastNotifiedId = topPothole.id;
        showNearbyNotification(topPothole);
      }
    }
    
    // Handle Admin Alerts
    if (data.admin_alerts && data.admin_alerts.length > 0) {
      data.admin_alerts.forEach(alert => {
         showToast(alert.message, 'error', 10000);
      });
    }
  } catch (e) {
    console.warn('Nearby fetch failed:', e);
  }
}

function showNearbyNotification(pothole) {
  const msg = `⚠️ New pothole detected nearby! (${pothole.distance}m)`;
  showToast(msg, 'warning', 5000);
  
  // Highlight on map if visible
  L.circle([pothole.latitude, pothole.longitude], {
    radius: 100,
    color: '#f59e0b',
    fillOpacity: 0.3,
    weight: 3
  }).addTo(navMap).bindPopup('Nearby Hazard!').openPopup();
  
  // Play sound if requested
  try {
    const audio = new Audio('/static/sounds/alert.mp3');
    audio.play();
  } catch(e) {}
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initNavMap();
  setClickMode('start');   // default mode = place start marker

  // Start nearby checking
  notifyTimer = setInterval(checkNearbyPotholes, 10000);

  // Add listeners for manual input
  document.getElementById('startInput').addEventListener('blur', () => handleManualInput('start'));
  document.getElementById('endInput').addEventListener('blur', () => handleManualInput('end'));
  
  // Allow Enter key to trigger parsing
  [ 'startInput', 'endInput' ].forEach(id => {
    document.getElementById(id).addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleManualInput(id === 'startInput' ? 'start' : 'end');
    });
  });
});
