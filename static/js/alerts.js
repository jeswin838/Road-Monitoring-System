// ═══════════════════════════════════════════════════════════════════════════
// alerts.js — Live alert panel + notification system
// Used on both dashboard.html (panel) and alerts.html (table page hints)
// ═══════════════════════════════════════════════════════════════════════════

let knownIds    = new Set();
let alertCount  = 0;
let alertSound  = null;
let notifBadge  = 0;

// Simple beep via Web Audio API
function playBeep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type      = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (_) {}
}

// Browser Notification
function sendBrowserNotif(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/static/favicon.ico' });
  }
}

// ── Update the live alert panel (dashboard only) ────────────────────────────
function renderAlertPanel(alerts) {
  const panel = document.getElementById('liveAlerts');
  const countEl = document.getElementById('alertCount');
  if (!panel) return;

  panel.innerHTML = '';
  // Sort by last_reported_at desc
  const sorted = [...alerts].sort((a,b) => new Date(b.last_reported_at) - new Date(a.last_reported_at));
  
  const recent = sorted.slice(0, 15);
  recent.forEach(r => {
    const div = document.createElement('div');
    const sev = (r.severity || '').toLowerCase();
    const sevColor = sev === 'critical' ? '#DC2626' : sev === 'high' ? '#ef4444' : sev === 'medium' ? '#f97316' : '#22c55e';
    
    div.className = `alert-item severity-${sev}`;
    div.innerHTML = `
      <div class="alert-title" style="display:flex; justify-content:space-between; align-items:center">
        <span><b style="color:${sevColor}">#${r.id}</b> pothole (${r.report_count} reports)</span>
        <span class="badge" style="background:${sevColor}22; color:${sevColor}; font-size:0.6rem">${sev.toUpperCase()}</span>
      </div>
      <div class="alert-meta" style="margin-top:4px">
        <div style="color:var(--text); font-size:0.75rem"><i class="fa-solid fa-clock"></i> Last seen: ${r.last_seen}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px">
           <span style="font-size:0.7rem; color:var(--muted)"><i class="fa-solid fa-map-pin"></i> ${r.latitude}, ${r.longitude}</span>
           <span style="font-size:0.7rem; font-style:italic; color:var(--accent)">Source: ${r.source}</span>
        </div>
      </div>`;
    panel.appendChild(div);
  });

  if (countEl) countEl.textContent = recent.length;

  // ── Handle Admin Emergency Alerts ───────────────────────────────────────
  const emergencyPanel = document.getElementById('adminEmergencyAlert');
  const emergencyList  = document.getElementById('emergencyAlertList');
  if (emergencyPanel && emergencyList) {
    const critical = alerts.filter(r => ["critical", "high"].includes((r.severity || '').toLowerCase()) && (r.report_count || 0) > 3);
    if (critical.length > 0) {
      emergencyPanel.style.display = 'block';
      emergencyList.innerHTML = critical.map(r => `
        <div style="padding:12px; background:rgba(239,68,68,0.12); border-radius:14px; border:1px solid rgba(239,68,68,0.2); display:flex; flex-direction:column; gap:4px; transition: all 0.2s">
            <div style="display:flex; justify-content:space-between; align-items:center">
                <b style="color:#ef4444; font-size:0.85rem">🚨 Hazard #${r.id}</b>
                <span style="font-size:0.65rem; background:#ef4444; color:#fff; padding:2px 8px; border-radius:10px; font-weight:800">CRITICAL</span>
            </div>
            <div style="opacity:0.9; font-size:0.75rem; color:var(--text)">
                <i class="fa-solid fa-users" style="margin-right:4px"></i> ${r.report_count} citizen reports
            </div>
            <div style="opacity:0.7; font-size:0.7rem; color:var(--muted)">
                <i class="fa-solid fa-location-dot" style="margin-right:4px"></i> ${r.latitude}, ${r.longitude}
            </div>
        </div>
      `).join('');
    } else {
      emergencyPanel.style.display = 'none';
    }
  }
}

// ── Detect new arrivals & notify ────────────────────────────────────────────
function detectNew(potholes) {
  const newOnes = potholes.filter(r => !knownIds.has(r.id));
  newOnes.forEach(r => {
    knownIds.add(r.id);
    alertCount++;
    notifBadge++;

    // Toast
    if (typeof showToast === 'function') {
      const sevLower = String(r.severity || '').toLowerCase();
      showToast(`New ${r.severity} pothole #${r.id} detected!`, (sevLower === 'critical' || sevLower === 'high') ? 'error' : 'warning', 4000);
    }

    // Beep & browser notification for High severity
    if (["critical", "high"].includes(String(r.severity || '').toLowerCase())) {
      playBeep();
      sendBrowserNotif('🚨 High Severity Pothole', `#${r.id} at ${(+r.latitude).toFixed(4)}, ${(+r.longitude).toFixed(4)}`);
    }

    // Highlight badge
    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.style.display = 'flex';
      badge.textContent   = notifBadge;
    }
  });
}

// ── Request notification permission on load ──────────────────────────────────
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ── Main poll loop ───────────────────────────────────────────────────────────
async function pollAlerts(data = null) {
  try {
    const alerts = data || await (await fetch('/api/alerts')).json();
    detectNew(alerts);
    renderAlertPanel(alerts);
    updateDashboardUserReports();
  } catch (err) {
    console.warn("Poll alerts error", err);
  }
}

// ── User Reports Dashboard Panel ──────────────────────────────────────────
async function updateDashboardUserReports() {
  const panel = document.getElementById('dashboardUserReports');
  if (!panel) return;

  try {
    const res = await fetch('/api/user-reports?status=pending');
    const reports = await res.json();

    if (reports.length === 0) {
      panel.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted); font-size:0.8rem">No pending user reports.</div>';
      return;
    }

    panel.innerHTML = reports.slice(0, 10).map(r => `
      <div class="alert-item" style="border-left: 4px solid #3b82f6; background: rgba(59, 130, 246, 0.05); padding: 10px; border-radius: 8px; margin-bottom: 8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px">
           <span style="font-size:0.85rem; font-weight:600; color:#3b82f6">User Report</span>
           <span style="font-size:0.7rem; color:var(--muted)">${new Date(r.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
        </div>
        <div style="font-size:0.8rem; margin-bottom:4px; color:var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${r.description || 'Pothole reported via mobile.'}
        </div>
        <div style="font-size:0.7rem; color:var(--muted); display:flex; justify-content:space-between">
           <span><i class="fa-solid fa-location-dot"></i> ${parseFloat(r.latitude).toFixed(4)}, ${parseFloat(r.longitude).toFixed(4)}</span>
           <a href="/admin/user-reports" style="color:#3b82f6; text-decoration:none; font-weight:600">Review →</a>
        </div>
      </div>
    `).join('');

  } catch (err) {
    console.warn("Failed to update user reports panel", err);
  }
}

// ── Poll interval (uses MAP_SETTINGS if on dashboard, else 10s) ──────────────
const pollInterval = (window.MAP_SETTINGS?.refresh || 10) * 1000;

// Initial load (delayed to prioritise map init)
setTimeout(() => {
  // If we are on the dashboard, map.js will call pollAlerts() via loadMarkers()
  if (!window.MAP_SETTINGS) {
    pollAlerts();
    setInterval(pollAlerts, pollInterval);
  } else {
    // Just do one initial poll if map hasn't loaded yet
    pollAlerts();
  }
}, 800);

// Clear notif badge on click
const bell = document.getElementById('notifBell');
if (bell) {
  bell.addEventListener('click', () => {
    notifBadge = 0;
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'none';
  });
}
