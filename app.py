import os
from dotenv import load_dotenv

# 1. Load environment variables before importing Config
env_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(env_path):
    load_dotenv(env_path, override=True)
else:
    load_dotenv()

from flask import Flask
from flask_cors import CORS
from flask_bcrypt import Bcrypt
from supabase import create_client, Client
from config import Config

Config.check_env()

# 2. Initialize Supabase Client safely
supabase: Client = None
if Config.SUPABASE_URL and Config.SUPABASE_KEY:
    try:
        supabase = create_client(Config.SUPABASE_URL, Config.SUPABASE_KEY)
        print("[+] Supabase client initialized successfully.")
    except Exception as e:
        print(f"[!] Critical: Failed to initialize Supabase: {e}")
else:
    print("[!] Supabase credentials missing. Database features will be disabled.")

bcrypt = Bcrypt()

def create_app():
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB limit
    
    # Enable CORS for all routes (important for deployment)
    CORS(app)
    
    bcrypt.init_app(app)

    # Ensure upload folder exists
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)

    # Register blueprints
    from routes.api   import api_bp
    from routes.pages import pages_bp
    from routes.ai    import ai_bp
    
    app.register_blueprint(api_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(ai_bp)

    return app

# Global app instance for Gunicorn
app = create_app()

if __name__ == "__main__":
    # Production run — debug=False prevents state loss from auto-reloader
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
