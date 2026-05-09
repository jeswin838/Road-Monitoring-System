# Smart Pothole Monitoring Dashboard

A full-stack pothole monitoring system built with **Flask**, **MySQL**, **Leaflet.js**, and **Chart.js**.

---

## Tech Stack

| Layer    | Technology                          |
|----------|-------------------------------------|
| Backend  | Python 3.10+ / Flask 3.0            |
| Database | MySQL 8.0+ (or MariaDB)             |
| Map      | Leaflet.js + OpenStreetMap (no Google Maps) |
| Charts   | Chart.js 4                          |
| Frontend | Vanilla HTML / CSS / JavaScript     |

---

## Project Structure

```
Road Quality Monitoring System/
├── app.py              ← Flask entry point
├── config.py           ← DB + upload config (edit here)
├── requirements.txt
├── schema.sql          ← Run once to migrate DB
├── routes/
│   ├── api.py          ← REST API endpoints
│   └── pages.py        ← Page routes
├── utils/
│   └── helpers.py      ← Haversine, dedup, conf filter
├── static/
│   ├── css/main.css
│   ├── js/
│   │   ├── map.js      ← Leaflet map + clustering + heatmap
│   │   ├── analytics.js← Chart.js charts
│   │   ├── alerts.js   ← Live polling + notifications
│   │   └── main.js     ← Shared utilities
│   └── uploads/        ← Pothole images stored here
└── templates/
    ├── base.html
    ├── login.html
    ├── dashboard.html
    ├── alerts.html
    ├── analytics.html
    ├── maintenance.html
    ├── image_logs.html
    └── settings.html
```

---

## Quick Setup

### 1. Install Python dependencies

```bash
pip install -r requirements.txt
```

> **If `mysqlclient` fails to install on Windows**, install the prebuild wheel:
> ```bash
> pip install mysqlclient --only-binary=:all:
> ```
> or use PyMySQL as a drop-in:
> ```bash
> pip install PyMySQL
> ```
> and add this to the top of `app.py`:
> ```python
> import pymysql; pymysql.install_as_MySQLdb()
> ```

### 2. Configure Database

Edit `config.py` (or set env variables):

```python
DB_HOST     = "localhost"
DB_USER     = "root"
DB_PASSWORD = ""          # your MySQL password
DB_NAME     = "pothole_db"  # your database name
```

### 3. Run Schema Migration

```bash
mysql -u root -p pothole_db < schema.sql
```

This will:
- Add `status` column to existing `pothole` table (safe, uses `IF NOT EXISTS`)
- Create `users`, `assignments`, `app_settings` tables

### 4. Start the Application

```bash
python app.py
```

Open your browser at: **http://localhost:5000**

---

## REST API Reference

| Method | Endpoint                  | Description                        |
|--------|---------------------------|------------------------------------|
| GET    | `/api/potholes`           | List potholes (filters supported)  |
| POST   | `/api/pothole`            | Add new pothole (multipart/form)   |
| PUT    | `/api/pothole/<id>`       | Update status/severity             |
| DELETE | `/api/pothole/<id>`       | Delete pothole                     |
| GET    | `/api/stats`              | Summary counts                     |
| GET    | `/api/analytics`          | Chart data (timeseries, severity)  |
| GET    | `/api/assignments`        | List all assignments               |
| POST   | `/api/assignments`        | Assign pothole to worker           |
| PUT    | `/api/assignments/<id>`   | Update assignment status           |
| GET    | `/api/settings`           | Get app settings                   |
| POST   | `/api/settings`           | Save app settings                  |
| POST   | `/api/login`              | Login (JSON: email, password)      |
| POST   | `/api/logout`             | Logout                             |

### Query Parameters for GET `/api/potholes`

| Param        | Example        | Description                    |
|--------------|----------------|--------------------------------|
| `severity`   | `High`         | Filter by severity             |
| `status`     | `Pending`      | Filter by status               |
| `type`       | `pothole`      | Filter by type                 |
| `date_from`  | `2024-01-01`   | Start date filter              |
| `date_to`    | `2024-12-31`   | End date filter                |
| `confidence` | `0.7`          | Minimum confidence threshold   |
| `limit`      | `10`           | Limit number of results        |
| `sort`       | `desc`/`asc`   | Sort by created_at             |

---

## Pages

| URL            | Description                              |
|----------------|------------------------------------------|
| `/`            | Real-time dashboard with Leaflet map     |
| `/alerts`      | Alert management table with CRUD         |
| `/analytics`   | Charts: line, pie, bar + top locations   |
| `/maintenance` | Worker assignments + status tracking     |
| `/image-logs`  | Image gallery with lightbox              |
| `/settings`    | App configuration                        |
| `/login`       | Role-based login (admin / worker)        |

---

## Default Admin Login

After running schema.sql, create a proper admin user with a hashed password:

```python
from werkzeug.security import generate_password_hash
print(generate_password_hash("admin123"))
```

Then insert into `users` table:
```sql
INSERT INTO users (name, email, password_hash, role)
VALUES ('Admin', 'admin@pothole.local', '<paste_hash_here>', 'admin');
```

---

## Environment Variables (optional)

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=pothole_db
SECRET_KEY=some-secret-string
```
