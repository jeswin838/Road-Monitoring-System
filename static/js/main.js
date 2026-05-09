// ═══════════════════════════════════════════════════════════════════════════
// main.js — Common utilities shared across all pages
// ═══════════════════════════════════════════════════════════════════════════

// ── Sidebar toggle ──────────────────────────────────────────────────────────
const toggle = document.getElementById('sidebarToggle');
const overlay = document.getElementById('sidebarOverlay');

if (toggle) {
  toggle.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      document.body.classList.toggle('sidebar-open');
    } else {
      document.body.classList.toggle('sidebar-collapsed');
    }
  });
}

if (overlay) {
  overlay.addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
  });
}

// Close sidebar on outside click (mobile)
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 768
      && !e.target.closest('.sidebar')
      && !e.target.closest('#sidebarToggle')) {
    document.body.classList.remove('sidebar-open');
  }
});

// ── Toast notification ──────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info', warning: 'fa-triangle-exclamation' };
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .3s, transform .3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Assign Modal ────────────────────────────────────────────────────────────
const assignModal = document.getElementById('assignModal');
const deleteModal = document.getElementById('deleteModal');

function openAssignModal(potholeId) {
  document.getElementById('assignPotholeId').value = potholeId;
  document.getElementById('assignWorkerName').value = '';
  document.getElementById('assignNotes').value      = '';
  if (assignModal) assignModal.style.display = 'flex';
}

function openDeleteModal(targetId, type = 'pothole') {
  document.getElementById('deleteTargetId').value = targetId;
  document.getElementById('deleteModal').dataset.type = type;
  if (deleteModal) deleteModal.style.display = 'flex';
}

function closeDeleteModal() {
  if (deleteModal) deleteModal.style.display = 'none';
}

async function confirmGlobalDelete() {
  const modal = document.getElementById('deleteModal');
  const type  = modal.dataset.type || 'pothole';
  const tid   = document.getElementById('deleteTargetId').value;
  
  const endpoint = type === 'pothole' ? `/api/pothole/${tid}` : `/api/assignments/${tid}`;
  
  try {
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (res.ok) {
      showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} removed ✓`, 'info');
      closeDeleteModal();
      if (typeof loadTable === 'function') loadTable();
      if (typeof loadAssignments === 'function') loadAssignments();
    } else {
      showToast('Action failed', 'error');
    }
  } catch (e) {
    showToast('Connection error', 'error');
  }
}

['closeAssignModal', 'closeAssignModal2'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => assignModal.style.display = 'none');
});

const confirmAssignBtn = document.getElementById('confirmAssign');
if (confirmAssignBtn) {
  confirmAssignBtn.addEventListener('click', async () => {
    const pid  = document.getElementById('assignPotholeId').value;
    const name = document.getElementById('assignWorkerName').value.trim();
    const notes= document.getElementById('assignNotes').value;
    if (!name) { showToast('Enter worker name', 'error'); return; }
    const res = await fetch('/api/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pothole_id: +pid, worker_name: name, notes })
    });
    const d = await res.json();
    if (res.ok) {
      showToast('Worker assigned ✓', 'success');
      assignModal.style.display = 'none';
    } else {
      showToast(d.error || 'Error', 'error');
    }
  });
}

// ── Formatting helpers ──────────────────────────────────────────────────────
function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function severityBadge(s) {
  const cls = s === 'High' ? 'badge-danger' : s === 'Medium' ? 'badge-warning' : 'badge-success';
  return `<span class="badge ${cls}">${s || '—'}</span>`;
}

function statusBadge(s) {
  const cls = s === 'Fixed' ? 'badge-success' : s === 'In Progress' ? 'badge-info' : 'badge-warning';
  return `<span class="badge ${cls}">${s || 'Pending'}</span>`;
}

// ── Sidebar active state ────────────────────────────────────────────────────
const currentPath = window.location.pathname;
document.querySelectorAll('.nav-item').forEach(link => {
  if (link.getAttribute('href') === currentPath) {
    link.classList.add('active');
  }
});

// ── Load user info ──────────────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const u = await res.json();
      const el = document.getElementById('sidebar-user');
      if (el) el.textContent = u.name || 'User';
    }
  } catch (_) {}
})();
