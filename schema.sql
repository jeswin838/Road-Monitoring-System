-- ============================================================
-- Smart Pothole Monitoring Dashboard — Schema Migration
-- Safe to re-run: uses IF NOT EXISTS / IGNORE
-- ============================================================

-- 1. Add status column to existing pothole table
ALTER TABLE pothole
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'Pending';

-- 2. Users table
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  email         VARCHAR(150)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NOT NULL,
  role          ENUM('admin','worker') NOT NULL DEFAULT 'worker',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Default admin (password: admin123 — bcrypt hash below, update as needed)
INSERT IGNORE INTO users (name, email, password_hash, role)
VALUES ('Admin', 'admin@pothole.local',
        'pbkdf2:sha256:600000$placeholder$abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        'admin');

-- 3. Assignments table
CREATE TABLE IF NOT EXISTS assignments (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  pothole_id  INT NOT NULL,
  worker_name VARCHAR(100) NOT NULL,
  notes       TEXT,
  status      ENUM('Pending','In Progress','Completed') NOT NULL DEFAULT 'Pending',
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pothole_id) REFERENCES pothole(id) ON DELETE CASCADE
);

-- 4. App settings table (single-row config)
CREATE TABLE IF NOT EXISTS app_settings (
  id                      INT PRIMARY KEY DEFAULT 1,
  detection_sensitivity   FLOAT   NOT NULL DEFAULT 0.5,
  alert_threshold         INT     NOT NULL DEFAULT 10,
  map_center_lat          FLOAT   NOT NULL DEFAULT 20.5937,
  map_center_lon          FLOAT   NOT NULL DEFAULT 78.9629,
  map_zoom                INT     NOT NULL DEFAULT 13,
  auto_refresh_seconds    INT     NOT NULL DEFAULT 10,
  notification_sound      TINYINT NOT NULL DEFAULT 1
);

INSERT IGNORE INTO app_settings (id) VALUES (1);
