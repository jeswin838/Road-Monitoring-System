import os
from supabase import create_client
from config import Config

def setup():
    print("🚀 Attempting to initialize Supabase database...")
    
    try:
        supabase = create_client(Config.SUPABASE_URL, Config.SUPABASE_KEY)
        
        # Read the SQL file
        with open("supabase_setup.sql", "r") as f:
            sql = f.read()

        # Supabase Python client doesn't support raw SQL execution directly 
        # on the public API (which uses PostgREST). 
        # Raw SQL usually requires the SQL Editor in the Dashboard.
        
        print("\n[IMPORTANT] ───────────────────────────────────────────────────")
        print("The Supabase Python SDK cannot create tables directly.")
        print("You MUST run the SQL manually in the Supabase Dashboard.")
        print("───────────────────────────────────────────────────────────────")
        print("\n1. Go to: https://app.supabase.com/")
        print("2. Open your project: " + Config.SUPABASE_URL.split("//")[1].split(".")[0])
        print("3. Click 'SQL Editor' in the left menu (icon looks like '>')")
        print("4. Click 'New Query'")
        print("5. Paste the content of 'supabase_setup.sql' and click 'RUN'")
        print("───────────────────────────────────────────────────────────────\n")
        
        # Check if table exists now
        try:
            supabase.table("users").select("id").limit(1).execute()
            print("✅ Success! The 'users' table is already connected and working.")
        except Exception as e:
            if "PGRST205" in str(e) or "does not exist" in str(e):
                print("❌ Error: The 'users' table still doesn't exist.")
                print("Please follow the steps above to run the SQL in your dashboard.")
            else:
                print(f"❓ Unexpected error: {e}")

    except Exception as e:
        print(f"💥 Failed to connect: {e}")

if __name__ == "__main__":
    setup()
