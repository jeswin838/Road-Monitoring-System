/*
 * ============================================================
 *  Smart Road Monitoring — ESP32 Firmware  (Production v2)
 *  Features:
 *    - Spike shape filtering (noise / pothole / speed breaker)
 *    - 2-cycle consistency check + peak tracking
 *    - WiFi auto-reconnect + offline event queue
 *    - HTTP retry with exponential back-off
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Arduino.h>

// ── Configuration ──────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* FLASK_HOST    = "http://192.168.1.100:5000";  // Update to your Flask IP

// ── Sensor Pins ────────────────────────────────────────────
const int TRIG_PIN = 5;
const int ECHO_PIN = 18;
const int VIB_PIN  = 34;   // Analog vibration sensor

// ── Detection Thresholds ───────────────────────────────────
const float  DIFF_THRESHOLD     = 10.0;   // cm — min diff to count as a hit
const float  VIB_THRESHOLD      = 500.0;  // ADC — min vibration per hit
const int    CONSISTENCY_CYCLES = 2;      // N consecutive windows required
const unsigned long COOLDOWN_MS = 4000;   // ms between valid triggers
const int    SAMPLE_WINDOW      = 5;      // Sensor readings per 250ms window

// ── Spike Shape Classification ─────────────────────────────
// impact duration (ms) → event type
//   <  200 ms  →  noise         (ignore)
//   200–600 ms →  pothole        (trigger)
//   >  600 ms  →  speed breaker  (ignore)
const unsigned long SPIKE_NOISE_MAX  = 200;
const unsigned long SPIKE_POTHOLE_MAX = 600;

// ── Event Queue ────────────────────────────────────────────
struct SensorEvent {
  float diff;
  float vib;
  unsigned long spike_ms;
  bool  sent;
};

const int QUEUE_SIZE = 10;
SensorEvent eventQueue[QUEUE_SIZE];
int queueHead = 0;
int queueTail = 0;
int queueCount = 0;

// ── State ──────────────────────────────────────────────────
float         baselineDist    = -1.0;
int           consecutiveHits = 0;
float         maxDiff         = 0.0;
float         maxVib          = 0.0;
unsigned long impactStart     = 0;
unsigned long lastTriggerMs   = 0;

// ──────────────────────────────────────────────────────────
//  ULTRASONIC — get distance in cm
// ──────────────────────────────────────────────────────────
float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);  // 30ms timeout
  if (duration == 0) return -1.0;
  return (duration * 0.0343f) / 2.0f;
}

// ──────────────────────────────────────────────────────────
//  SPIKE SHAPE CLASSIFIER
// ──────────────────────────────────────────────────────────
enum SpikeClass { SPIKE_NOISE, SPIKE_POTHOLE, SPIKE_BREAKER };

SpikeClass classifySpike(unsigned long duration_ms) {
  if (duration_ms < SPIKE_NOISE_MAX) {
    return SPIKE_NOISE;
  } else if (duration_ms <= SPIKE_POTHOLE_MAX) {
    return SPIKE_POTHOLE;
  } else {
    return SPIKE_BREAKER;
  }
}

const char* spikeLabel(SpikeClass cls) {
  switch(cls) {
    case SPIKE_NOISE:   return "NOISE";
    case SPIKE_POTHOLE: return "POTHOLE";
    case SPIKE_BREAKER: return "SPEED_BREAKER";
    default:            return "UNKNOWN";
  }
}

// ──────────────────────────────────────────────────────────
//  QUEUE HELPERS
// ──────────────────────────────────────────────────────────
bool enqueue(float diff, float vib, unsigned long spike_ms) {
  if (queueCount >= QUEUE_SIZE) {
    Serial.println("[QUEUE] Full — dropping oldest event");
    queueHead = (queueHead + 1) % QUEUE_SIZE;
    queueCount--;
  }
  eventQueue[queueTail] = {diff, vib, spike_ms, false};
  queueTail = (queueTail + 1) % QUEUE_SIZE;
  queueCount++;
  Serial.printf("[QUEUE] Enqueued diff=%.1f vib=%.0f spike=%lu | depth=%d\n",
                diff, vib, spike_ms, queueCount);
  return true;
}

SensorEvent* peekQueue() {
  if (queueCount == 0) return nullptr;
  return &eventQueue[queueHead];
}

void dequeue() {
  if (queueCount == 0) return;
  queueHead = (queueHead + 1) % QUEUE_SIZE;
  queueCount--;
}

// ──────────────────────────────────────────────────────────
//  WIFI — connect or reconnect
// ──────────────────────────────────────────────────────────
void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.println("[WiFi] Reconnecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n[WiFi] Failed — will retry later");
  }
}

// ──────────────────────────────────────────────────────────
//  HTTP — POST trigger to Flask (with retry + backoff)
// ──────────────────────────────────────────────────────────
bool sendTrigger(float diff, int vibration, unsigned long impactDuration, int retries = 3) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] No WiFi — skipping send");
    return false;
  }

  String url = String(FLASK_HOST) + "/trigger";

  for (int attempt = 1; attempt <= retries; attempt++) {
    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/x-www-form-urlencoded");
    http.setTimeout(5000);  // 5s timeout

    String postData = "diff=" + String(diff, 2) +
                      "&vib=" + String(vibration) +
                      "&spike_ms=" + String(impactDuration);

    int code = http.POST(postData);

    if (code == 200) {
      Serial.printf("[HTTP] Trigger OK | diff=%.2f vib=%d spike=%lu\n",
                    diff, vibration, impactDuration);
      http.end();
      return true;
    } else {
      Serial.printf("[HTTP] Attempt %d/%d failed — code=%d\n", attempt, retries, code);
      http.end();
      if (attempt < retries) delay(500 * attempt);  // exponential back-off
    }
  }
  Serial.println("[HTTP] All retries exhausted.");
  return false;
}

// ──────────────────────────────────────────────────────────
//  DRAIN QUEUE — send pending events when WiFi is up
// ──────────────────────────────────────────────────────────
void drainQueue() {
  if (WiFi.status() != WL_CONNECTED || queueCount == 0) return;
  Serial.printf("[QUEUE] Draining %d events...\n", queueCount);

  while (queueCount > 0) {
    SensorEvent* ev = peekQueue();
    if (ev == nullptr) break;
    bool ok = sendTrigger(ev->diff, (int)ev->vib, ev->spike_ms, 2);
    if (ok) {
      dequeue();
      delay(200);
    } else {
      Serial.println("[QUEUE] Send failed — will retry next cycle");
      break;
    }
  }
}

// ──────────────────────────────────────────────────────────
//  SETUP
// ──────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("[WiFi] Connecting");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n[WiFi] Not connected at boot — will queue events");
  }

  // Calibrate baseline (average of 10 readings)
  Serial.println("[SENSOR] Calibrating baseline...");
  float total = 0; int valid = 0;
  for (int i = 0; i < 10; i++) {
    float d = getDistance();
    if (d > 0) { total += d; valid++; }
    delay(100);
  }
  baselineDist = (valid > 0) ? (total / valid) : 30.0;
  Serial.printf("[SENSOR] Baseline = %.1f cm\n", baselineDist);
}

// ──────────────────────────────────────────────────────────
//  MAIN LOOP
// ──────────────────────────────────────────────────────────
void loop() {
  ensureWiFi();
  drainQueue();  // Flush queued events whenever WiFi is up

  // ── Sample sensor window (250ms, 5 readings) ────────────
  float peakDiff = 0.0;
  float peakVib  = 0.0;

  for (int i = 0; i < SAMPLE_WINDOW; i++) {
    float dist = getDistance();
    float vib  = analogRead(VIB_PIN);

    if (dist > 0 && baselineDist > 0) {
      float diff = abs(dist - baselineDist);
      if (diff > peakDiff) peakDiff = diff;
    }
    if (vib > peakVib) peakVib = vib;

    delay(50);  // 50ms per sample → 250ms window
  }

  Serial.printf("[SENSOR] peakDiff=%.1f cm  peakVib=%.0f\n", peakDiff, peakVib);

  // ── Consistency check (2 consecutive hits required) ─────
  bool conditionMet = (peakDiff >= DIFF_THRESHOLD && peakVib >= VIB_THRESHOLD);

  if (conditionMet) {
    if (consecutiveHits == 0) impactStart = millis();  // Capture rise time
    consecutiveHits++;
    if (peakDiff > maxDiff) maxDiff = peakDiff;
    if (peakVib  > maxVib)  maxVib  = peakVib;
    Serial.printf("[DETECT] Hit %d/%d | maxDiff=%.1f maxVib=%.0f\n",
                  consecutiveHits, CONSISTENCY_CYCLES, maxDiff, maxVib);
  } else {
    if (consecutiveHits > 0) {
      Serial.println("[DETECT] Streak broken — resetting");
    }
    consecutiveHits = 0;
    maxDiff = 0.0;
    maxVib  = 0.0;
    impactStart = 0;
  }

  // ── Trigger after N consecutive hits + cooldown ─────────
  if (consecutiveHits >= CONSISTENCY_CYCLES) {
    unsigned long now = millis();
    if (now - lastTriggerMs >= COOLDOWN_MS) {

      unsigned long impactDuration = now - impactStart;

      // ── SPIKE SHAPE FILTER ─────────────────────────────
      SpikeClass cls = classifySpike(impactDuration);
      Serial.printf("[SPIKE] duration=%lu ms → %s\n", impactDuration, spikeLabel(cls));

      if (cls == SPIKE_NOISE) {
        Serial.println("[SPIKE] Noise — skipping trigger");
      } else if (cls == SPIKE_BREAKER) {
        Serial.println("[SPIKE] Speed breaker / slope — skipping trigger");
      } else {
        // Valid pothole — send or queue
        Serial.printf("[TRIGGER] Pothole! diff=%.2f vib=%.0f spike=%lu\n",
                      maxDiff, maxVib, impactDuration);

        bool sent = sendTrigger(maxDiff, (int)maxVib, impactDuration);
        if (!sent) {
          Serial.println("[QUEUE] WiFi down — queuing event");
          enqueue(maxDiff, maxVib, impactDuration);
        }

        lastTriggerMs = now;
      }

      // Reset state regardless of spike class
      consecutiveHits = 0;
      maxDiff = 0.0;
      maxVib  = 0.0;
      impactStart = 0;

    } else {
      Serial.println("[TRIGGER] Cooldown active — ignoring");
      consecutiveHits = 0;
    }
  }

  delay(50);  // Tight loop for responsive detection
}
