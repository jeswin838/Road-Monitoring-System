from flask import Blueprint, render_template, session, redirect, url_for
from config import Config

pages_bp = Blueprint("pages", __name__)


import sqlite3

def get_settings():
    try:
        conn = sqlite3.connect("local_db.sqlite")
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM app_settings WHERE id = 1")
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else {}
    except Exception:
        return {}


@pages_bp.route("/")
def dashboard():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    settings = get_settings()
    return render_template("dashboard.html", settings=settings, page="dashboard")


@pages_bp.route("/alerts")
def alerts():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    if session.get("role") != "admin": return redirect(url_for("pages.dashboard"))
    return render_template("alerts.html", page="alerts")


@pages_bp.route("/analytics")
def analytics():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    if session.get("role") != "admin": return redirect(url_for("pages.dashboard"))
    return render_template("analytics.html", page="analytics")


@pages_bp.route("/maintenance")
def maintenance():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    if session.get("role") != "admin": return redirect(url_for("pages.dashboard"))
    return render_template("maintenance.html", page="maintenance")


@pages_bp.route("/image-logs")
def image_logs():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    return render_template("image_logs.html", page="image_logs")


@pages_bp.route("/settings")
def settings():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    if session.get("role") != "admin": return redirect(url_for("pages.dashboard"))
    s = get_settings()
    return render_template("settings.html", settings=s, page="settings")


@pages_bp.route("/admin")
def admin():
    if "user_id" not in session or session.get("role") != "admin":
        return redirect(url_for("pages.login"))
    return render_template("admin.html", page="admin")


@pages_bp.route("/navigation")
def navigation():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    return render_template("navigation.html", page="navigation")


@pages_bp.route("/report")
def report():
    if "user_id" not in session: return redirect(url_for("pages.login"))
    return render_template("report.html", page="report", strict_live_capture_only=Config.STRICT_LIVE_CAPTURE_ONLY)


@pages_bp.route("/admin/user-reports")
def user_reports():
    if session.get("role") != "admin": return redirect(url_for("pages.dashboard"))
    return render_template("admin_reports.html", page="admin_reports")


@pages_bp.route("/login")
def login():
    if "user_id" in session: return redirect(url_for("pages.dashboard"))
    return render_template("login.html", page="login")
