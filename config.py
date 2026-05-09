import os

class Config:
    # ── Database (Supabase) ───────────────────────────────────────────────────
    # Move keys to environment variables for security. No hardcoding.
    SUPABASE_URL = os.environ.get("SUPABASE_URL")
    SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

    # ── External APIs ─────────────────────────────────────────────────────────
    ORS_API_KEY = os.environ.get("ORS_API_KEY")

    # ── Flask ─────────────────────────────────────────────────────────────────
    SECRET_KEY  = os.environ.get("SECRET_KEY",  "pothole_secret_prod_2024")
    DEBUG       = os.environ.get("FLASK_DEBUG", "False").lower() == "true"

    # ── File uploads ─────────────────────────────────────────────────────────
    BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
    UPLOAD_FOLDER = os.path.join(BASE_DIR, "static", "uploads")
    ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}

    # ── Defaults ──────────────────────────────────────────────────────────────
    DEFAULT_CONFIDENCE_THRESHOLD = 0.5
    DEFAULT_ALERT_THRESHOLD      = 10
    DEFAULT_MAP_LAT  = 12.1326
    DEFAULT_MAP_LON  = 78.1944
    DEFAULT_MAP_ZOOM = 13
    AUTO_REFRESH_SEC = 10
    STRICT_LIVE_CAPTURE_ONLY = os.environ.get("STRICT_LIVE_CAPTURE_ONLY", "false").lower() == "true"

    @staticmethod
    def check_env():
        """Check if critical environment variables are missing."""
        missing = []
        if not Config.SUPABASE_URL: missing.append("SUPABASE_URL")
        if not Config.SUPABASE_KEY: missing.append("SUPABASE_KEY")
        if not Config.ORS_API_KEY:  missing.append("ORS_API_KEY")
        
        if missing:
            print(f"[!] WARNING: Missing environment variables: {', '.join(missing)}")
            print("    The app may fail to fetch data or provide routing.")
        else:
            print("[+] All critical environment variables are loaded.")
