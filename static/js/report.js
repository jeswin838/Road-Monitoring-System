// ═══════════════════════════════════════════════════════════════════════════
// report.js — User Reporting Module logic
// ═══════════════════════════════════════════════════════════════════════════

let stream = null;
let capturedBlob = null;
let currentCoords = null;
let gpsAccuracy = null;
let useFacingMode = 'environment';
let analysisResult = null;
let captureSource = 'live_camera';
const strictLiveCaptureOnly = !!(window.REPORT_SECURITY && window.REPORT_SECURITY.strictLiveCaptureOnly);

const video = document.getElementById('cameraStream');
const canvas = document.createElement('canvas');
const preview = document.getElementById('capturedPreview');
const captureBtn = document.getElementById('captureBtn');
const retakeBtn = document.getElementById('retakeBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const submitBtn = document.getElementById('submitBtn');
const gpsStatus = document.getElementById('gpsStatus');
const resultCard = document.getElementById('analyzeResultCard');
const resultImg = document.getElementById('resultPreviewImage');
const resultMeta = document.getElementById('resultMeta');
const resultBadge = document.getElementById('resultStatusBadge');

/* ── Camera Logic ────────────────────────────────────────────────────────── */
async function startCamera() {
  try {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: useFacingMode },
      audio: false
    });
    video.srcObject = stream;
    video.style.display = 'block';
    preview.style.display = 'none';
  } catch (err) {
    console.error("Camera error:", err);
    showToast("Could not access camera. Please use file upload.", "error");
  }
}

function captureImage() {
  const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;

  // Prefer ImageCapture to keep original camera quality.
  if (track && 'ImageCapture' in window) {
    const imageCapture = new ImageCapture(track);
    imageCapture.takePhoto()
      .then((blob) => {
        capturedBlob = blob; // original-quality capture blob
        captureSource = 'live_camera';
        const url = URL.createObjectURL(blob);
        preview.src = url;
        preview.style.display = 'block';
        video.style.display = 'none';
        captureBtn.style.display = 'none';
        retakeBtn.style.display = 'flex';
        checkSubmitReady();
      })
      .catch(() => {
        // Fallback only if ImageCapture fails.
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
          capturedBlob = blob;
          captureSource = 'live_camera';
          const url = URL.createObjectURL(blob);
          preview.src = url;
          preview.style.display = 'block';
          video.style.display = 'none';
          captureBtn.style.display = 'none';
          retakeBtn.style.display = 'flex';
          checkSubmitReady();
        }, 'image/png');
      });
    return;
  }

  // Legacy fallback (avoid lossy JPEG recompression).
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    capturedBlob = blob;
    captureSource = 'live_camera';
    const url = URL.createObjectURL(blob);
    preview.src = url;
    preview.style.display = 'block';
    video.style.display = 'none';
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'flex';
    checkSubmitReady();
  }, 'image/png');
}

function retake() {
  capturedBlob = null;
  analysisResult = null;
  preview.style.display = 'none';
  video.style.display = 'block';
  captureBtn.style.display = 'flex';
  retakeBtn.style.display = 'none';
  if (resultCard) resultCard.style.display = 'none';
  checkSubmitReady();
}

function setCaptureMode(mode) {
  captureSource = mode;
}

/* ── GPS Logic ───────────────────────────────────────────────────────────── */
function initGPS() {
  if (!navigator.geolocation) {
    gpsStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> GPS not supported';
    gpsStatus.className = 'gps-status searching';
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      currentCoords = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude
      };
      gpsAccuracy = pos.coords.accuracy ?? null;
      document.getElementById('latInput').value = currentCoords.lat.toFixed(6);
      document.getElementById('lonInput').value = currentCoords.lon.toFixed(6);
      
      gpsStatus.innerHTML = '<i class="fa-solid fa-circle-check"></i> GPS Location Ready';
      gpsStatus.className = 'gps-status ready';
      checkSubmitReady();
    },
    (err) => {
      console.warn("GPS Error:", err);
      gpsStatus.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> GPS Error: ' + err.message;
      gpsStatus.className = 'gps-status searching';
    },
    { enableHighAccuracy: true }
  );
}

/* ── Submission Logic ────────────────────────────────────────────────────── */
function checkSubmitReady() {
  analyzeBtn.disabled = !(capturedBlob && currentCoords);
  submitBtn.disabled = !analysisResult;
}

async function handleAnalyze() {
  if (!capturedBlob || !currentCoords) return;

  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';
  submitBtn.disabled = true;
  analysisResult = null;

  const formData = new FormData();
  formData.append('image', capturedBlob, 'capture.jpg');
  formData.append('lat', currentCoords.lat);
  formData.append('lon', currentCoords.lon);
  formData.append('description', document.getElementById('descInput').value);
  formData.append('capture_source', captureSource === 'gallery_upload' ? 'upload' : 'live');
  if (gpsAccuracy !== null) formData.append('gps_accuracy', gpsAccuracy);

  try {
    const res = await fetch('/user-report', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (res.ok) {
      analysisResult = data;
      renderAnalyzeResult(data);
      submitBtn.disabled = false;
      showToast(`Analysis complete: ${formatStatus(data.status)}`, data.status === 'approved' ? 'success' : data.status === 'rejected' ? 'error' : 'warning');
    } else {
      showToast(data.error || "Inference failed", "error");
    }
  } catch (err) {
    showToast("Network error occurred", "error");
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Analyze';
    checkSubmitReady();
  }
}

function formatStatus(status) {
  if (!status) return 'Pending';
  if (status === 'approved') return 'Auto Approved';
  if (status === 'pending') return 'Needs Admin Review';
  return 'Rejected';
}

function renderAnalyzeResult(data) {
  if (!resultCard) return;
  resultCard.style.display = 'block';

  const status = data.status || 'pending';
  const badgeColor = status === 'approved' ? 'var(--success)' : status === 'rejected' ? 'var(--danger)' : 'var(--warning)';
  const confidence = typeof data.confidence === 'number' ? `${Math.round(data.confidence * 100)}%` : '0%';

  resultBadge.textContent = formatStatus(status);
  resultBadge.style.background = badgeColor;
  resultBadge.style.color = '#fff';
  resultBadge.style.border = '1px solid rgba(255,255,255,0.2)';

  if (data.annotated_image_url) {
    resultImg.src = data.annotated_image_url;
    resultImg.style.display = 'block';
  }

  resultMeta.innerHTML = `
    <div><i class="fa-solid fa-chart-line"></i> Confidence: <b>${confidence}</b></div>
    <div><i class="fa-solid fa-gauge-high"></i> Severity: <b>${(data.severity || 'low').toUpperCase()}</b></div>
    <div><i class="fa-solid fa-ranking-star"></i> Severity Score: <b>${data.severity_score ?? '—'}</b></div>
    <div><i class="fa-solid fa-brain"></i> AI Decision: <b>${(data.ai_status || status).toUpperCase()}</b></div>
    <div><i class="fa-solid fa-clipboard-check"></i> Review Required: <b>${data.review_required ? 'YES' : 'NO'}</b></div>
    <div><i class="fa-solid fa-video"></i> Live Capture Verified: <b>${data.live_capture_verified ? 'YES' : 'NO'}</b></div>
    <div><i class="fa-solid fa-location-crosshairs"></i> GPS Verified: <b>${data.gps_verified ? 'YES' : 'NO'}</b></div>
    <div><i class="fa-solid fa-road"></i> Road Scene Detected: <b>${data.road_scene_valid ? 'YES' : 'NO'}</b></div>
    <div><i class="fa-solid fa-shield-halved"></i> Trust Score: <b>${data.trust_score ?? 0}</b> (${data.trust_level || 'review'})</div>
  `;
}

async function handleSubmit() {
  if (!analysisResult) return;

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

  try {
    const res = await fetch('/user-report/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analysisResult)
    });
    const data = await res.json();
    if (!res.ok) {
      const detail = data.detail ? ` (${data.detail})` : '';
      showToast((data.error || 'Save failed') + detail, 'error');
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Report';
      return;
    }
    showToast(`Saved: ${formatStatus(data.status)}`, data.status === 'approved' ? 'success' : data.status === 'rejected' ? 'error' : 'warning');
    setTimeout(() => window.location.href = '/', 1500);
  } catch (err) {
    showToast('Network error occurred', 'error');
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Report';
  }
}

/* ── File Upload Fallback Removed ─────────────────────────────────────── */

/* ── Boot ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  startCamera();
  initGPS();
  setCaptureMode('live_camera');

  captureBtn.onclick = captureImage;
  retakeBtn.onclick = retake;
  analyzeBtn.onclick = handleAnalyze;
  submitBtn.onclick = handleSubmit;
  document.getElementById('switchCameraBtn').onclick = () => {
    useFacingMode = useFacingMode === 'user' ? 'environment' : 'user';
    startCamera();
  };
});
