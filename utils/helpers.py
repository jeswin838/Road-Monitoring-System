import math

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return distance in metres between two GPS coordinates."""
    R = 6_371_000  # Earth radius in metres
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi  = math.radians(lat2 - lat1)
    dlam  = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def is_duplicate(supabase, lat: float, lon: float, threshold_m: float = 50.0):
    """
    Checks if a pothole exists within threshold_m using a bounding box filter (±0.0005 deg).
    Returns existing pothole record if found, else None.
    """
    try:
        # Bounding box filter for performance (approx 55m at 0.0005)
        res = supabase.table("potholes")\
            .select("*")\
            .eq("pothole", True)\
            .gte("latitude", lat - 0.0005)\
            .lte("latitude", lat + 0.0005)\
            .gte("longitude", lon - 0.0005)\
            .lte("longitude", lon + 0.0005)\
            .execute()
            
        for p in res.data:
            dist = haversine(lat, lon, float(p["latitude"]), float(p["longitude"]))
            if dist < threshold_m:
                return p
    except Exception as e:
        print(f"Duplicate check error: {e}")
        
    return None


def count_nearby_potholes(supabase, lat: float, lon: float, radius_m: float = 5.0):
    """
    Counts potholes within radius_m using a bounding box filter (±0.0001 deg ~ 11m).
    """
    try:
        # Bounding box for 5m (approx 0.00005)
        res = supabase.table("potholes")\
            .select("id, latitude, longitude")\
            .eq("pothole", True)\
            .gte("latitude", lat - 0.0001)\
            .lte("latitude", lat + 0.0001)\
            .gte("longitude", lon - 0.0001)\
            .lte("longitude", lon + 0.0001)\
            .execute()
        
        count = 0
        for p in res.data:
            if haversine(lat, lon, float(p["latitude"]), float(p["longitude"])) <= radius_m:
                count += 1
        return count
    except Exception as e:
        print(f"Count nearby error: {e}")
        return 0


def filter_by_confidence(records: list, threshold: float = 0.5) -> list:
    """
    Remove records whose confidence is below threshold.
    Manual reports (without confidence field) are always kept (treated as 1.0).
    """
    return [r for r in records if r.get("confidence") is None or float(r.get("confidence")) >= threshold]


def calculate_risk_score(severity, report_count):
    """
    Calculates a risk score based on severity and report count.
    Distinct values to allow cumulative calculation.
    """
    severity_map = {"low": 10, "medium": 25, "high": 45}
    sev_val = severity_map.get(str(severity).lower(), 25)
    
    # Reports add extra danger (capped)
    report_bonus = min(20, int(report_count or 0) * 3)
    
    return sev_val + report_bonus


def allowed_file(filename: str, allowed: set) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed


def human_time(dt_str: str) -> str:
    """Convert ISO timestamp to human readable relative time."""
    if not dt_str: return "unknown"
    try:
        from datetime import datetime, timezone
        import math
        
        # Parse timestamp (handle Z and offset formats)
        try:
            dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        except:
            dt = datetime.strptime(dt_str.split('.')[0], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
            
        now = datetime.now(timezone.utc)
        diff = (now - dt).total_seconds()
        
        if diff < 0: diff = 0 # Future safety
        if diff < 60: return "just now"
        if diff < 3600: return f"{math.floor(diff/60)} min ago"
        if diff < 86400: return f"{math.floor(diff/3600)} hours ago"
        if diff < 604800: return f"{math.floor(diff/86400)} days ago"
        return dt.strftime("%b %d, %Y")
    except Exception as e:
        print(f"Time parse error: {e}")
        return dt_str
