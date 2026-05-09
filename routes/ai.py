# ================= IMPORTS =================
import os
import re
import uuid
import time
import hashlib
import cv2
import numpy as np
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify

# Production-safe YOLO import (for Render memory limits)
try:
    from ultralytics import YOLO
except ImportError:
    YOLO = None
    print("[AI] ⚠️ YOLO (ultralytics) not installed. Running in sensor-only mode.")

from config import Config
from utils.helpers import haversine, is_duplicate

try:
    from PIL import Image
except Exception:
    Image = None

# ================= INIT =================
ai_bp = Blueprint("ai", __name__)

# ================= MODEL (LAZY LOADING) =================
model = None

def load_model():
    global model
    
    if YOLO is None:
        print("[AI] ⚠️ YOLO disabled in production (import failed).")
        return None

    if model is None:
        print("🚀 Loading YOLO model...")
        # Path logic: look for best.pt in the root directory
        model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'best.pt')
        
        if not os.path.exists(model_path):
            print(f"❌ MODEL NOT FOUND at {model_path}. AI disabled.")
            return None
            
        try:
            model = YOLO(model_path)
            print("✅ YOLO Model loaded successfully")
        except Exception as e:
            print(f"❌ Error loading YOLO: {e}. Falling back to sensor-only mode.")
            return None
    return model


# ================= TRIGGER STATE =================
trigger_flag      = False
last_trigger_time = 0
last_sensor       = {"diff": 0.0, "vib": 0.0, "spike_ms": 0}
processing        = False   # Global request lock — prevents duplicate inserts


@ai_bp.route("/trigger", methods=["POST"])
def trigger():
    """ESP32 hardware trigger. Stores sensor payload and signals Android to capture."""
    global trigger_flag, last_trigger_time, last_sensor
    now = time.time()
    if now - last_trigger_time < 3:
        return jsonify({"status": "ignored", "reason": "cooldown"})

    try:
        diff     = float(request.form.get("diff",     0) or 0)
        vib      = float(request.form.get("vib",      0) or 0)
        spike_ms = float(request.form.get("spike_ms", 0) or 0)
    except (ValueError, TypeError):
        diff, vib, spike_ms = 0.0, 0.0, 0.0

    last_sensor = {"diff": diff, "vib": vib, "spike_ms": spike_ms}
    trigger_flag      = True
    last_trigger_time = now
    print(f"[SENSOR] ESP32 TRIGGER | diff={diff} vib={vib} spike_ms={spike_ms}")
    return jsonify({"status": "ok", "diff": diff, "vib": vib, "spike_ms": spike_ms})


@ai_bp.route("/check", methods=["GET"])
def check():
    """Android polling endpoint. Returns capture=True once per trigger."""
    global trigger_flag
    if trigger_flag:
        trigger_flag = False
        print("📸 Capture signal sent to Android")
        return jsonify({"capture": True})
    return jsonify({"capture": False})


# ================= UPLOAD WITH RETRY =================
def upload_with_retry(img_bytes: bytes, base_name: str):
    """Upload image bytes to Supabase storage, retrying up to 3 times."""
    from app import supabase
    for i in range(3):
        try:
            filename = f"{base_name}_{i}.jpg"
            supabase.storage.from_("pothole-images").upload(
                path=filename,
                file=img_bytes,
                file_options={"content-type": "image/jpeg"}
            )
            print("✅ Uploaded:", filename)
            return filename
        except Exception as e:
            print(f"[DB] Upload retry {i+1}/3: {e}")
            time.sleep(1)
    return None


# ================= DATABASE INSERT WITH RETRY =================
def db_insert_with_retry(supabase, record: dict, retries: int = 3) -> bool:
    """Insert a pothole record into Supabase, retrying up to `retries` times."""
    for attempt in range(1, retries + 1):
        try:
            supabase.table("potholes").insert(record).execute()
            print(f"[DB] Saved on attempt {attempt}")
            return True
        except Exception as e:
            print(f"[DB] Insert attempt {attempt}/{retries} failed: {e}")
            if attempt < retries:
                time.sleep(1)
    print("[DB] All insert attempts exhausted.")
    return False


# ================= SEVERITY ORDERING =================
SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}

def max_severity(a: str, b: str) -> str:
    """Return the higher of two severity strings. Never downgrade existing records."""
    return a if SEVERITY_RANK.get(a, 0) >= SEVERITY_RANK.get(b, 0) else b


SEVERITY_ORDER = ["low", "medium", "high", "critical"]

def bump_severity(level: str, step: int = 1) -> str:
    if level not in SEVERITY_ORDER:
        return level
    idx = min(len(SEVERITY_ORDER) - 1, SEVERITY_ORDER.index(level) + step)
    return SEVERITY_ORDER[idx]

def reduce_severity(level: str, step: int = 1) -> str:
    if level not in SEVERITY_ORDER:
        return level
    idx = max(0, SEVERITY_ORDER.index(level) - step)
    return SEVERITY_ORDER[idx]


def score_user_report_severity(img: np.ndarray, detections: list) -> dict:
    """
    Severity for user reports using image features only:
    - bbox coverage ratio
    - center-lane position
    - cluster count
    - darkness/depth inside pothole ROI
    """
    h, w = img.shape[:2]
    img_area = float(max(1, h * w))

    valid = []
    for d in detections:
        conf = float(d.get("confidence", 0.0) or 0.0)
        box = d.get("box") or [0, 0, 0, 0]
        x1, y1, x2, y2 = [int(max(0, v)) for v in box]
        x2 = min(x2, w - 1)
        y2 = min(y2, h - 1)
        bw = max(0, x2 - x1)
        bh = max(0, y2 - y1)
        ratio = (bw * bh) / img_area

        # False detection filtering
        if conf < 0.45:
            continue
        if ratio < 0.01:
            continue

        roi = img[y1:y2, x1:x2]
        if roi.size == 0:
            continue
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        mean_gray = float(np.mean(gray))
        darkness_score = max(0.0, min(30.0, ((160.0 - mean_gray) / 160.0) * 30.0))
        center_x_ratio = ((x1 + x2) / 2.0) / float(max(1, w))
        center_bonus = 15.0 if 0.35 < center_x_ratio < 0.65 else 0.0
        size_score = max(0.0, min(55.0, ratio * 900.0))

        valid.append({
            **d,
            "bbox_ratio": round(ratio, 4),
            "center_x_ratio": round(center_x_ratio, 4),
            "darkness_score": round(darkness_score, 2),
            "size_score": round(size_score, 2),
            "center_bonus": round(center_bonus, 2),
        })

    if not valid:
        return {
            "severity": "low",
            "score": 0,
            "valid_detections": [],
            "primary": None
        }

    primary = max(valid, key=lambda d: d.get("bbox_ratio", 0.0))
    cluster_bonus = float(min(15, max(0, len(valid) - 1) * 7))
    severity_score = (
        float(primary.get("size_score", 0.0))
        + float(primary.get("center_bonus", 0.0))
        + float(primary.get("darkness_score", 0.0))
        + cluster_bonus
    )
    severity_score = int(round(min(100.0, severity_score)))

    if severity_score >= 80:
        sev = "critical"
    elif severity_score >= 50:
        sev = "high"
    elif severity_score >= 25:
        sev = "medium"
    else:
        sev = "low"

    return {
        "severity": sev,
        "score": severity_score,
        "valid_detections": valid,
        "primary": primary
    }


def road_scene_check(img: np.ndarray) -> bool:
    """
    Lightweight road/outdoor heuristic:
    - prefer texture in lower half
    - avoid very flat indoor-like regions
    """
    h, w = img.shape[:2]
    lower = img[h // 2:, :]
    gray = cv2.cvtColor(lower, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 60, 160)
    edge_density = float(np.mean(edges > 0))
    brightness = float(np.mean(gray))
    return edge_density > 0.02 and brightness > 30


def dominant_face_present(img: np.ndarray) -> bool:
    """
    Reject selfie-like captures where a face occupies major frame area.
    """
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))
        if len(faces) == 0:
            return False
        h, w = gray.shape[:2]
        img_area = float(max(1, h * w))
        max_face_area = max((fw * fh for (_, _, fw, fh) in faces), default=0.0)
        return (max_face_area / img_area) > 0.18
    except Exception:
        return False


def exif_metadata_valid(file_bytes: bytes) -> bool:
    if Image is None:
        return False
    try:
        from io import BytesIO
        pil_img = Image.open(BytesIO(file_bytes))
        exif = pil_img.getexif()
        if not exif:
            return False
        has_time = bool(exif.get(306) or exif.get(36867))  # DateTime / DateTimeOriginal
        has_device = bool(exif.get(271) or exif.get(272))  # Make / Model
        return has_time and has_device
    except Exception:
        return False


# ================= UPDATE EXISTING POTHOLE =================
def update_existing_pothole(supabase, pothole_id: int, new_severity: str):
    """
    Update an existing pothole record:
    - Severity is only raised, never lowered.
    - last_reported_at is always refreshed.
    - report_count is incremented via RPC.
    """
    try:
        # Fetch existing severity
        existing = supabase.table("potholes").select("severity").eq("id", pothole_id).execute()
        if existing.data:
            old_severity = existing.data[0].get("severity", "low")
            final_severity = max_severity(old_severity, new_severity)
        else:
            final_severity = new_severity

        supabase.table("potholes") \
            .update({
                "severity": final_severity,
                "last_reported_at": datetime.now(timezone.utc).isoformat()
            }) \
            .eq("id", pothole_id) \
            .execute()

        # Increment report count via RPC
        try:
            supabase.rpc("increment_report_count", {"row_id": pothole_id}).execute()
        except Exception as rpc_err:
            print(f"[DB] RPC increment failed (non-critical): {rpc_err}")

        print(f"[DB] Pothole {pothole_id} updated → severity={final_severity}, count++")
    except Exception as e:
        print(f"[DB] ❌ Update failed: {e}")


# ================= SPIKE VALIDATION =================
def classify_spike(spike_ms: float) -> str:
    """
    Categorize spike by duration:
      < 200ms  → noise
      200–600ms → pothole
      > 600ms  → speed_breaker
    """
    if spike_ms <= 0:
        return "unknown"  # Not yet reported by ESP32, don't block
    elif spike_ms < 200:
        return "noise"
    elif spike_ms <= 600:
        return "pothole"
    else:
        return "speed_breaker"


# ================= YOLO INFERENCE ON SINGLE FRAME =================
def run_inference(m, img: np.ndarray) -> tuple:
    """Run YOLO on a single image. Returns (results, detections_list)."""
    detections = []
    results = None
    
    if m is None:
        return None, []

    try:
        start = time.time()
        results = m.predict(source=img, conf=0.4, imgsz=640, verbose=False)
        elapsed = (time.time() - start) * 1000
        print(f"[AI] Inference: {elapsed:.0f}ms")
        h, w = img.shape[:2]
        img_area = float(max(1, h * w))
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                cls  = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(float, box.xyxy[0])
                w_px, h_px = x2 - x1, y2 - y1
                ratio = (max(0.0, w_px) * max(0.0, h_px)) / img_area
                center_x = (x1 + x2) / 2.0
                center_x_ratio = center_x / float(max(1.0, w))
                detections.append({
                    "type":       m.names[cls],
                    "confidence": round(conf, 2),
                    "box":        [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "max_dim":    round(max(w_px, h_px), 1),
                    "bbox_ratio": round(ratio, 4),
                    "center_x_ratio": round(center_x_ratio, 4)
                })
    except Exception as e:
        print(f"[AI] Inference error: {e}")
    return results, detections


# ================= BEST FRAME SELECTION =================
def select_best_frame(frames: list) -> tuple:
    """
    Given a list of (results, detections, img) tuples,
    pick the frame with the highest (confidence * max_dim) score.
    Returns (results, detections, img) of the best frame.
    """
    best_score = -1
    best = frames[0]
    for frame in frames:
        results, detections, img = frame
        if detections:
            primary = max(detections, key=lambda d: d["max_dim"])
            score = primary["confidence"] * primary["max_dim"]
            if score > best_score:
                best_score = score
                best = frame
    return best


# ================= DECISION LOGIC =================
def decide_severity(diff: float, sensor: dict, detections: list) -> str:
    """
    Strict Sensor-Authority Severity Logic:
      - AI confirms pothole existence (conf >= 0.5 required)
      - Sensor diff determines severity level
      - If AI fails, only very strong sensor signal allowed (fallback)
    """
    vib = float(sensor.get("vib", 0) or 0)
    spike_ms = float(sensor.get("spike_ms", 0) or 0)

    ai_valid = False
    best_ratio = 0.0
    best_conf = 0.0
    if detections:
        primary = max(detections, key=lambda d: d.get("bbox_ratio", 0.0))
        best_ratio = float(primary.get("bbox_ratio", 0.0) or 0.0)
        best_conf = float(primary.get("confidence", 0.0) or 0.0)
        ai_valid = best_conf >= 0.50

    # Ignore weak sensor noise if AI is also weak.
    if diff < 10 and best_conf < 0.50:
        return "ignored"

    # Sensor-authority baseline severity with ratio-assisted uplift.
    if diff > 45 or best_ratio > 0.12:
        sev = "critical"
    elif diff > 35 or best_ratio > 0.07:
        sev = "high"
    elif diff > 20 or best_ratio > 0.03:
        sev = "medium"
    elif diff > 10:
        sev = "low"
    else:
        sev = "ignored"

    # If sensor is weak and AI cannot confirm pothole, ignore.
    if sev == "ignored":
        if diff > 45 and vib > 0:
            sev = "high"  # sensor fallback
        else:
            return "ignored"

    if not ai_valid and not (diff > 45 and vib > 0):
        return "ignored"

    # Spike-shape adjustment
    if diff > 35 and spike_ms < 120:
        sev = reduce_severity(sev, 1)
    elif diff > 35 and spike_ms > 180:
        sev = bump_severity(sev, 1)

    return sev


# ================= /analyze ENDPOINT =================
@ai_bp.route("/analyze", methods=["POST"])
def analyze():
    """
    Main fusion pipeline:
    1. Validate inputs
    2. Load sensor state
    3. Classify spike shape
    4. Run YOLO inference on all submitted frames
    5. Select best frame
    6. Decide severity (sensor authority)
    7. Upload annotated image
    8. Persist (insert or update duplicate)
    """
    global processing
    if processing:
        print("[FUSION] Already processing → skip")
        return jsonify({"status": "busy"})

    processing = True
    try:
        from app import supabase
        from utils.helpers import is_duplicate

        m = load_model()
        if m is None:
            print("[FUSION] Running sensor-only mode (YOLO unavailable)")
        
        # ----- 1. Extract Inputs -----
        files = request.files.getlist("image")   # Support multi-frame upload
        if not files:
            files = [request.files.get("image")]  # Fallback to single frame
        files = [f for f in files if f is not None]

        lat = request.form.get("lat", type=float)
        lon = request.form.get("lon", type=float)

        if not files or lat is None or lon is None:
            return jsonify({"error": "Missing image, lat, or lon"}), 400

        # ----- 2. Sensor State -----
        diff     = last_sensor.get("diff",     0.0)
        vib      = last_sensor.get("vib",      0.0)
        spike_ms = last_sensor.get("spike_ms", 0)
        sensor   = {"diff": diff, "vib": vib, "spike_ms": spike_ms}
        print(f"[SENSOR] diff={diff} vib={vib} spike_ms={spike_ms}")

        # ----- 3. Spike Classification -----
        spike_class = classify_spike(spike_ms)
        print(f"[SENSOR] spike_class={spike_class}")
        if spike_class == "noise":
            print("[FUSION] Noise spike — ignoring")
            return jsonify({"status": "ignored", "reason": "noise_spike"})
        if spike_class == "speed_breaker":
            print("[FUSION] Speed breaker spike — ignoring")
            return jsonify({"status": "ignored", "reason": "speed_breaker"})
        # Unknown (spike_ms=0) is allowed through — don't block real detections

        # ----- 4. Decode & Infer All Frames -----
        frames = []
        for f in files:
            file_bytes = f.read()
            np_arr = np.frombuffer(file_bytes, np.uint8)
            img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            
            if m:
                results, detections = run_inference(m, img)
                frames.append((results, detections, img))
            else:
                # Sensor-only: No results/detections
                frames.append((None, [], img))

        if not frames:
            return jsonify({"error": "All frames invalid"}), 400

        # ----- 5. Best Frame Selection -----
        best_results, best_detections, best_img = select_best_frame(frames)
        print(f"[AI] Best frame: {len(best_detections)} detection(s)")

        # ----- 6. Decision Logic -----
        decision = decide_severity(diff, sensor, best_detections)

        if best_detections:
            db_type = "ai_verified"
        elif decision != "ignored":
            db_type = "sensor_fallback"
        else:
            db_type = "none"

        print(f"[FUSION] decision={decision.upper()} | db_type={db_type}")
        if decision == "ignored":
            reason = "diff too low" if diff <= 10 else ("no AI detection" if not best_detections else "low confidence")
            print(f"[FUSION] ignored reason: {reason}")
            return jsonify({
                "status":     "ignored",
                "decision":   decision,
                "diff":       diff,
                "spike_ms":   spike_ms,
                "detections": best_detections
            })

        # ----- 7. Select Primary Detection -----
        primary = max(best_detections, key=lambda d: d.get("bbox_ratio", 0.0)) if best_detections \
                  else {"confidence": 0.0, "type": "sensor_only", "bbox_ratio": 0.0}

        # ----- 8. Annotate & Upload Image -----
        image_url = None
        try:
            if best_results is not None:
                annotated = best_results[0].plot()
            else:
                annotated = best_img  # Raw frame if no results
            _, buffer = cv2.imencode('.jpg', annotated)
            base_name = f"fusion_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
            filename  = upload_with_retry(buffer.tobytes(), base_name)
            if filename:
                image_url = f"{Config.SUPABASE_URL}/storage/v1/object/public/pothole-images/{filename}"
                print("[FUSION] Image uploaded")
            else:
                print("[FUSION] Image upload failed — aborting save")
        except Exception as e:
            print(f"[FUSION] ❌ Image upload error: {e}")

        if image_url is None:
            return jsonify({"status": "upload_failed", "decision": decision}), 500

        # ----- 9. Persist (Update or Insert) -----
        try:
            duplicate = is_duplicate(supabase, lat, lon, threshold_m=5.0)
        except Exception as e:
            print(f"[DB] Duplicate check error: {e}")
            duplicate = None

        if duplicate:
            print(f"[FUSION] Duplicate ({duplicate['id']}) → updating")
            update_existing_pothole(supabase, duplicate['id'], decision)
            return jsonify({
                "status":     "updated",
                "decision":   decision,
                "diff":       diff,
                "spike_ms":   spike_ms,
                "detections": best_detections,
                "image_url":  image_url
            })

        # New pothole — insert
        db_insert_with_retry(supabase, {
            "latitude":   lat,
            "longitude":  lon,
            "severity":   decision,
            "confidence": primary["confidence"],
            "image_url":  image_url,
            "type":       db_type,
            "pothole":    True,
            "created_at": datetime.now(timezone.utc).isoformat()
        })
        print("[DB] New pothole saved")

        # Keep image logs enriched with fusion metadata (best effort).
        try:
            supabase.table("image_logs").insert({
                "image_url": image_url,
                "confidence": primary.get("confidence", 0.0),
                "severity": decision,
                "status": "approved",
                "latitude": lat,
                "longitude": lon,
                "detection_type": primary.get("type", "sensor_only"),
                "source_type": "sensor_ai_fusion",
                "diff": round(float(diff or 0), 2),
                "bbox_ratio": round(float(primary.get("bbox_ratio", 0.0) or 0.0), 4),
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
        except Exception as e:
            print(f"[DB] fusion image_logs insert skipped: {e}")

        # ----- 10. Response -----
        return jsonify({
            "status":     "success",
            "decision":   decision,
            "diff":       diff,
            "spike_ms":   spike_ms,
            "detections": best_detections,
            "image_url":  image_url
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[FUSION] ❌ Unhandled error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        processing = False


# ================= USER REPORT ENDPOINT =================
@ai_bp.route("/user-report", methods=["POST"])
def user_report():
    """Analyze a user report with hybrid AI logic and return preview payload."""
    from app import supabase

    file = request.files.get("image")
    lat = request.form.get("lat") or request.form.get("latitude")
    lon = request.form.get("lon") or request.form.get("longitude")

    if not file or not lat or not lon:
        return jsonify({"error": "Missing image or location"}), 400

    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except ValueError:
        return jsonify({"error": "Invalid coordinates"}), 400

    # Decode image once. AI uses this frame; upload uses annotated or original.
    try:
        file_bytes = file.read()  # Preserve original bytes from upload
        byte_size = len(file_bytes or b"")
        np_arr = np.frombuffer(file_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Decode failed")
    except Exception:
        return jsonify({"error": "Invalid image data"}), 400

    # Basic quality gates to reduce false detections.
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(np.mean(gray))
    bytes_per_pixel = (byte_size / float(max(1, w * h)))

    if blur_score < 80.0:
        return jsonify({"error": "image_too_blurry", "blur_score": round(blur_score, 2)}), 400
    if brightness < 35.0:
        return jsonify({"error": "image_too_dark", "brightness": round(brightness, 2)}), 400
    if bytes_per_pixel < 0.03:
        return jsonify({"error": "image_over_compressed"}), 400

    diff = request.form.get("diff", type=float, default=0.0)
    capture_source = (request.form.get("capture_source") or "live").strip().lower()
    capture_type = "upload" if capture_source in ("upload", "gallery_upload") else "live"
    strict_live_only = bool(getattr(Config, "STRICT_LIVE_CAPTURE_ONLY", False))
    gps_accuracy = request.form.get("gps_accuracy", type=float)
    image_hash = hashlib.sha256(file_bytes).hexdigest()

    m = load_model()
    ai_available = m is not None
    results = None
    allowed_detections = []
    top_detection = None

    if ai_available:
        try:
            # Higher-quality inference configuration for user uploads.
            results = m.predict(source=img, conf=0.5, imgsz=960, verbose=False)
            for r in (results or []):
                if r.boxes is None:
                    continue
                for box in r.boxes:
                    cls = int(box.cls[0])
                    conf = float(box.conf[0])
                    class_name = str(m.names[cls]).lower()
                    if class_name not in ["pothole", "crack"]:
                        continue
                    x1, y1, x2, y2 = map(float, box.xyxy[0])
                    bw = max(0.0, x2 - x1)
                    bh = max(0.0, y2 - y1)
                    # Tiny boxes are usually noise on high-res frames.
                    if bw < 24 or bh < 24:
                        continue
                    if (bw * bh) / float(max(1, w * h)) < 0.001:
                        continue
                    det = {
                        "type": class_name,
                        "confidence": round(conf, 4),
                        "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)]
                    }
                    allowed_detections.append(det)
                    if top_detection is None or conf > top_detection["confidence"]:
                        top_detection = det
        except Exception as e:
            print(f"[USER REPORT] AI inference failed, fallback pending: {e}")
            ai_available = False
            results = None
            allowed_detections = []
            top_detection = None

    confidence = float(top_detection["confidence"]) if top_detection else 0.0
    pothole_detected = top_detection is not None
    bbox_ratio = float(top_detection.get("bbox_ratio", 0.0) or 0.0) if top_detection else 0.0

    # Severity from image analysis only (size + center + cluster + darkness).
    severity_eval = score_user_report_severity(img, allowed_detections if ai_available else [])
    severity = severity_eval["severity"]
    severity_score = int(severity_eval["score"])
    valid_detections = severity_eval["valid_detections"]
    primary_valid = severity_eval["primary"]
    if primary_valid:
        bbox_ratio = float(primary_valid.get("bbox_ratio", bbox_ratio) or bbox_ratio)

    # Security and anti-fake validations
    live_capture_verified = capture_type == "live" or capture_source in ("live_camera", "live")
    gps_verified = (gps_accuracy is not None and gps_accuracy <= 120.0) or (lat_f is not None and lon_f is not None)
    road_scene_valid = road_scene_check(img)
    face_dominant = dominant_face_present(img)
    metadata_valid = exif_metadata_valid(file_bytes)
    suspicious_reasons = []

    duplicate_image = False
    try:
        dup = supabase.table("user_reports").select("id").eq("image_hash", image_hash).limit(1).execute()
        duplicate_image = bool(getattr(dup, "data", []) or [])
    except Exception:
        duplicate_image = False

    if not road_scene_valid:
        suspicious_reasons.append("non_road_scene")
    if face_dominant:
        suspicious_reasons.append("face_dominant")
    if duplicate_image:
        suspicious_reasons.append("duplicate_image")
    if not metadata_valid:
        suspicious_reasons.append("missing_exif")

    trust_score = 0
    trust_score += 30 if live_capture_verified else 0
    trust_score += 20 if gps_verified else 0
    trust_score += 20 if road_scene_valid else 0
    trust_score += 20 if (pothole_detected and confidence >= 0.50 and bbox_ratio >= 0.01) else 0
    trust_score += 10 if metadata_valid else 0
    if capture_type == "upload":
        trust_score -= 25
    if not gps_verified:
        trust_score -= 20
    if duplicate_image:
        trust_score -= 25
    trust_score = int(max(0, min(100, trust_score)))

    if trust_score > 80:
        trust_level = "trusted"
    elif trust_score >= 50:
        trust_level = "review"
    else:
        trust_level = "untrusted"

    # Valid detection + approval workflow.
    # STEP 1: VALIDATE ROAD
    if not road_scene_valid or face_dominant:
        status = "rejected"
    elif strict_live_only and capture_type == "upload":
        status = "rejected"
    elif not ai_available or not pothole_detected:
        status = "rejected"
    # STEP 2: POTHOLE DETECTION (Only confidence + trust validation)
    # User rule: NEVER REJECT automatically if live + gps + road + conf >= 0.85
    elif live_capture_verified and gps_verified and road_scene_valid and confidence >= 0.85:
        if confidence >= 0.90:
            status = "approved"
        else:
            status = "pending"
    elif confidence >= 0.90 and live_capture_verified and gps_verified:
        status = "approved"
    elif confidence >= 0.70:
        status = "pending"
    else:
        status = "rejected"

    # Hybrid approval fallback: Trust score constraint / Uploads
    if capture_type == "upload" and status == "approved":
        status = "pending"
    if trust_score < 50 and status == "approved":
        status = "pending"

    review_required = status == "pending"

    print(f"[USER REPORT] status={status} conf={confidence:.4f}")

    # Upload original + annotated (or raw) for preview/submit
    try:
        ok_original, original_buffer = cv2.imencode(".jpg", img)
        annotated_or_raw = results[0].plot() if (results and len(results) > 0) else img
        ok_annotated, annotated_buffer = cv2.imencode(".jpg", annotated_or_raw)
        if not ok_original or not ok_annotated:
            raise ValueError("cv2.imencode failed")
        base_name = f"user_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        original_filename = upload_with_retry(original_buffer.tobytes(), f"{base_name}_orig")
        annotated_filename = upload_with_retry(annotated_buffer.tobytes(), f"{base_name}_ann")
    except Exception as e:
        print(f"[USER REPORT] image processing/upload prep failed: {e}")
        return jsonify({"error": "processing_failed"}), 500

    if not original_filename or not annotated_filename:
        return jsonify({"error": "upload_failed"}), 500

    image_url = f"{Config.SUPABASE_URL}/storage/v1/object/public/pothole-images/{original_filename}"
    annotated_image_url = f"{Config.SUPABASE_URL}/storage/v1/object/public/pothole-images/{annotated_filename}"

    return jsonify({
        "upload_id": base_name,
        "status": status,
        "ai_status": status,
        "review_required": review_required,
        "confidence": round(confidence, 4),
        "severity": severity,
        "severity_score": severity_score,
        "bbox_ratio": round(bbox_ratio, 4),
        "diff": round(float(diff or 0), 2),
        "trust_score": trust_score,
        "trust_level": trust_level,
        "live_capture_verified": live_capture_verified,
        "gps_verified": gps_verified,
        "road_scene_valid": road_scene_valid,
        "metadata_valid": metadata_valid,
        "duplicate_image": duplicate_image,
        "suspicious_reasons": suspicious_reasons,
        "capture_source": capture_source,
        "capture_type": capture_type,
        "image_hash": image_hash,
        "detections": valid_detections if valid_detections else allowed_detections,
        "pothole_detected": pothole_detected,
        "image_url": image_url,
        "annotated_image_url": annotated_image_url,
        "latitude": lat_f,
        "longitude": lon_f
    })


@ai_bp.route("/user-report/submit", methods=["POST"])
def submit_user_report():
    """Persist analyzed user report and route approved ones to potholes."""
    from app import supabase

    data = request.get_json(silent=True) or {}
    required = [
        "latitude", "longitude", "image_url", "annotated_image_url",
        "status", "confidence", "severity"
    ]
    if any(k not in data for k in required):
        return jsonify({"error": "Missing analyzed report fields"}), 400

    try:
        lat_f = float(data["latitude"])
        lon_f = float(data["longitude"])
        confidence = float(data["confidence"])
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid numeric fields"}), 400

    status = str(data.get("status", "pending")).lower()
    severity = str(data.get("severity", "low")).lower()
    review_required = bool(data.get("review_required", status == "pending"))
    detections = data.get("detections", [])
    detection_type = detections[0]["type"] if detections else "none"
    upload_id = data.get("upload_id")
    bbox_ratio = float(data.get("bbox_ratio", 0.0) or 0.0)
    diff_val = float(data.get("diff", 0.0) or 0.0)
    trust_score = int(float(data.get("trust_score", 0) or 0))
    trust_level = str(data.get("trust_level") or "review")
    capture_source = str(data.get("capture_source") or "live")
    capture_type = str(data.get("capture_type") or ("upload" if capture_source in ("upload", "gallery_upload") else "live"))
    image_hash = data.get("image_hash")
    now_iso = datetime.now(timezone.utc).isoformat()

    def insert_with_missing_column_retry(table_name: str, payload: dict, max_retries: int = 8):
        current = dict(payload)
        for _ in range(max_retries):
            try:
                return supabase.table(table_name).insert(current).execute(), current
            except Exception as e:
                err = str(e)
                m = re.search(r"Could not find the '([^']+)' column", err)
                if m and m.group(1) in current:
                    missing_col = m.group(1)
                    current.pop(missing_col, None)
                    print(f"[DB] {table_name} missing column '{missing_col}', retrying")
                    continue
                raise
        raise RuntimeError(f"{table_name} insert retries exhausted")

    # Always insert into user_reports
    user_payload = {
        "latitude": lat_f,
        "longitude": lon_f,
        "media_url": data["annotated_image_url"],
        "image_url": data["image_url"],
        "annotated_image_url": data["annotated_image_url"],
        "upload_id": upload_id,
        "type": "image",
        "description": f"AI Decision: {status}",
        "status": status,
        "ai_status": status,
        "review_required": review_required,
        "confidence": round(confidence, 4),
        "severity": severity,
        "trust_score": trust_score,
        "trust_level": trust_level,
        "source_type": capture_type,
        "capture_type": capture_type,
        "image_hash": image_hash,
        "created_at": now_iso
    }
    try:
        user_res, inserted_user_payload = insert_with_missing_column_retry("user_reports", user_payload)
        user_rows = getattr(user_res, "data", []) or []
        user_report_id = user_rows[0].get("id") if user_rows else None
    except Exception as e:
        print(f"[DB] user_reports rich insert failed, trying minimal fallback: {e}")
        try:
            minimal_payload = {
                "latitude": lat_f,
                "longitude": lon_f,
                "media_url": data["annotated_image_url"],
                "status": status,
                "type": "image",
                "description": f"AI Decision: {status}"
            }
            user_res, _ = insert_with_missing_column_retry("user_reports", minimal_payload)
            user_rows = getattr(user_res, "data", []) or []
            user_report_id = user_rows[0].get("id") if user_rows else None
        except Exception as e2:
            print(f"[DB] ❌ user_reports minimal insert failed: {e2}")
            return jsonify({"error": "user_report_insert_failed", "detail": str(e2)}), 500

    # Keep image logs in sync (best-effort)
    try:
        insert_with_missing_column_retry("image_logs", {
            "upload_id": upload_id,
            "report_id": user_report_id,
            "image_url": data["annotated_image_url"],
            "confidence": round(confidence, 4),
            "severity": severity,
            "status": status,
            "latitude": lat_f,
            "longitude": lon_f,
            "detection_type": detection_type,
            "source_type": "user_report_ai",
            "diff": round(diff_val, 2),
            "bbox_ratio": round(bbox_ratio, 4),
            "trust_score": trust_score,
            "created_at": now_iso
        })
    except Exception as e:
        print(f"[DB] image_logs insert skipped: {e}")

    # Only approved go into potholes
    if status == "approved":
        try:
            # Prevent duplicate pothole insert for same analyzed upload.
            existing = supabase.table("potholes").select("id").eq("image_url", data["annotated_image_url"]).limit(1).execute()
            if getattr(existing, "data", []):
                print("[DB] Skipping pothole insert (already exists for this upload image)")
            else:
                pothole_payload = {
                    "upload_id": upload_id,
                    "report_id": user_report_id,
                    "source_report_id": user_report_id,
                    "latitude": lat_f,
                    "longitude": lon_f,
                    "severity": severity,
                    "image_url": data["annotated_image_url"],
                    "confidence": round(confidence, 4),
                    "type": detection_type if detection_type in ["pothole", "crack"] else "pothole",
                    "pothole": True,
                    "status": "approved",
                    "created_at": now_iso,
                    "last_reported_at": now_iso
                }
                insert_with_missing_column_retry("potholes", pothole_payload)
        except Exception as e:
            print(f"[DB] potholes insert failed: {e}")

    # Keep user report status synchronized for non-approved paths as source of truth.
    if status in ("pending", "rejected"):
        try:
            supabase.table("user_reports").update({
                "status": status
            }).eq("id", user_report_id).execute()
        except Exception:
            pass

    print(f"[USER REPORT] status={status} conf={confidence:.4f}")
    return jsonify({
        "message": "Report saved",
        "status": status,
        "confidence": round(confidence, 4),
        "severity": severity
    }), 201
