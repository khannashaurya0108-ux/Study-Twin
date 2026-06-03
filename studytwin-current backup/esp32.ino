// ============================================================
//  STUDYTWIN — Phase 2 Complete Firmware
//  Board: ESP32 Dev Module (WROOM-32)
//  Libraries needed (install via Arduino Library Manager):
//    - Firebase ESP32 Client by Mobizt (v3.x)
//    - Adafruit SSD1306 + Adafruit GFX
//    - SparkFun MAX3010x Pulse and Proximity Sensor Library
//    - ArduinoJson by Benoit Blanchon (v6.x ONLY, NOT v7)
//
//  Firebase paths used:
//    /sessions/{uid}/live/current  <-- overwrite every 1s
//    /sessions/{uid}/live/history  <-- push append every 5s
//    /sessions/{uid}/live/current/blink_rate  <-- READ every 15s (from browser MediaPipe)
//
//  OLED layout:
//    Row 0:  "CLI: XX" (large, textSize 2)
//    Row 2:  "CALM / FOCUSED / ELEVATED / OVERLOADED"
//    Row 3:  "HR: XX bpm"    <- Heart rate from MAX30102
//    Row 4:  "GSR: +XX%"     <- GSR deviation from baseline
//    Row 5:  "BL: XX /m"     <- Blink rate read back from Firebase (MediaPipe)
//    Row 6:  "BAT: ---"      <- Battery placeholder
//
//  NOTE on "BPM":
//    HR BPM = Heart Rate Beats Per Minute (from MAX30102, biological)
//    BL     = Blink rate per minute (from MediaPipe browser, via Firebase)
//    These are TWO DIFFERENT things. OLED labels them separately.
// ============================================================

#include <WiFi.h>
#include <WebServer.h>
#include <SPIFFS.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "MAX30105.h"
#include "heartRate.h"
#include <FirebaseESP32.h>
#include <ArduinoJson.h>

// ── Pins ─────────────────────────────────────────────────────
#define GSR_PIN    34
#define I2C_SDA    21
#define I2C_SCL    22

// ── OLED ─────────────────────────────────────────────────────
#define OLED_WIDTH  128
#define OLED_HEIGHT  64
#define OLED_ADDR   0x3C
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);

// ── MAX30102 ─────────────────────────────────────────────────
MAX30105 hrSensor;

// ── Firebase objects ─────────────────────────────────────────
FirebaseData   fbdo;
FirebaseConfig fbCfg;
FirebaseAuth   fbAuth;

// ── Config struct (loaded from SPIFFS /config.json) ──────────
struct DeviceConfig {
  String wifi_ssid;
  String wifi_password;
  String firebase_host;   // e.g. studytwin-rvce-default-rtdb.asia-southeast1.firebasedatabase.app
  String firebase_secret; // Firebase Database Secret (legacy token)
  String uid;             // Firebase Auth UID of the student
};
DeviceConfig cfg;

// ── Config portal web server ──────────────────────────────────
WebServer portal(80);

// ── GSR state ────────────────────────────────────────────────
#define GSR_SMOOTH_N  5
int   gsrBuf[GSR_SMOOTH_N] = {0};
int   gsrBufIdx = 0;
bool  gsrBufFull = false;
float mu_gsr     = 2048.0f;   // session baseline mean
float sigma_gsr  = 20.0f;     // session baseline std-dev
float gsr_score  = 50.0f;     // 0-100 mapped score

// ── HRV / HR state ───────────────────────────────────────────
#define IBI_WINDOW  30         // store last 30 IBIs for RMSSD
long  ibiBuf[IBI_WINDOW] = {0};
int   ibiBufIdx  = 0;
int   beatCount  = 0;
long  lastBeatMs = 0;
float rmssd_val  = 55.0f;
float hr_bpm     = 0.0f;

// ── Blink state (read back from Firebase, written by browser) ─
float blink_rate_web = -1.0f;  // -1 = not received yet
unsigned long lastBlinkReadMs = 0;
#define BLINK_READ_INTERVAL_MS  15000  // read from Firebase every 15s

// ── CLI state ─────────────────────────────────────────────────
float cli_smoothed = 50.0f;
const float EMA_ALPHA = 0.28f;

// ── Sensor validity ───────────────────────────────────────────
bool sensor_valid = false;
unsigned long lastValidMs = 0;
#define GRACE_MS 5000          // keep valid for 5s after finger removed

// ── Timing ───────────────────────────────────────────────────
unsigned long lastSecMs     = 0;
unsigned long lastHistMs    = 0;
#define HISTORY_INTERVAL_MS  5000

// ============================================================
//  CONFIG PORTAL HTML
// ============================================================
const char PORTAL_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StudyTwin Setup</title>
<style>
  body{font-family:sans-serif;background:#060d1f;color:#e2e8f0;
       display:flex;justify-content:center;padding:32px 16px;}
  .card{background:#0f1b30;border:1px solid #1e3a5f;border-radius:14px;
        padding:28px;max-width:440px;width:100%;}
  h2{color:#3b82f6;margin:0 0 6px;}
  .sub{color:#64748b;font-size:13px;margin:0 0 24px;}
  label{display:block;font-size:12px;color:#94a3b8;margin-bottom:4px;}
  input{width:100%;box-sizing:border-box;background:#0a1628;
        border:1px solid #1e3a5f;color:#e2e8f0;padding:10px 12px;
        border-radius:8px;font-size:14px;margin-bottom:14px;}
  input:focus{outline:none;border-color:#3b82f6;}
  button{width:100%;background:#3b82f6;color:#fff;border:none;
         padding:13px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;}
  button:hover{background:#2563eb;}
  .hint{font-size:11px;color:#475569;margin-top:16px;text-align:center;line-height:1.6;}
</style>
</head>
<body>
<div class="card">
  <h2>StudyTwin Setup</h2>
  <p class="sub">Configure WiFi and Firebase credentials</p>
  <form action="/save" method="POST">
    <label>WiFi Network Name (SSID)</label>
    <input type="text" name="ssid" placeholder="Your home/lab WiFi name" required>
    <label>WiFi Password</label>
    <input type="password" name="password" placeholder="Leave blank for open networks">
    <label>Firebase Database Host</label>
    <input type="text" name="host"
      value="studytwin-rvce-default-rtdb.asia-southeast1.firebasedatabase.app">
    <label>Firebase Database Secret</label>
    <input type="text" name="secret"
      placeholder="Firebase Console > Project Settings > Service Accounts > Database Secrets">
    <label>Your Firebase UID</label>
    <input type="text" name="uid"
      placeholder="Firebase Console > Authentication > Users > copy your UID">
    <button type="submit">Save & Start StudyTwin</button>
  </form>
  <div class="hint">
    After saving, ESP32 restarts automatically.<br>
    Reconnect to your normal WiFi to access the dashboard.
  </div>
</div>
</body></html>
)HTML";

const char SAVED_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html>
<head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saved</title>
<style>body{font-family:sans-serif;background:#060d1f;color:#e2e8f0;
  display:flex;justify-content:center;padding:60px 16px;text-align:center;}
h2{color:#22c55e;margin-bottom:12px;}
p{color:#64748b;font-size:14px;}</style></head>
<body>
<div><h2>&#10003; Saved!</h2>
<p>StudyTwin is restarting and connecting to your WiFi.<br>
Close this page. The setup hotspot will disappear.</p></div>
</body></html>
)HTML";

// ============================================================
//  SPIFFS CONFIG FUNCTIONS
// ============================================================
bool loadConfig() {
  if (!SPIFFS.exists("/config.json")) {
    Serial.println("[SPIFFS] /config.json not found");
    return false;
  }
  File f = SPIFFS.open("/config.json", "r");
  if (!f) { Serial.println("[SPIFFS] open failed"); return false; }

  DynamicJsonDocument doc(512);
  auto err = deserializeJson(doc, f);
  f.close();
  if (err) { Serial.println("[SPIFFS] JSON parse error"); return false; }

  cfg.wifi_ssid      = doc["ssid"]   | "";
  cfg.wifi_password  = doc["pass"]   | "";
  cfg.firebase_host  = doc["host"]   | "";
  cfg.firebase_secret= doc["secret"] | "";
  cfg.uid            = doc["uid"]    | "";

  if (cfg.wifi_ssid.isEmpty() || cfg.firebase_secret.isEmpty() || cfg.uid.isEmpty()) {
    Serial.println("[SPIFFS] Config incomplete");
    return false;
  }
  Serial.println("[SPIFFS] Config OK  UID=" + cfg.uid);
  return true;
}

bool saveConfig(String ssid, String pass, String host, String secret, String uid) {
  DynamicJsonDocument doc(512);
  doc["ssid"]   = ssid;
  doc["pass"]   = pass;
  doc["host"]   = host;
  doc["secret"] = secret;
  doc["uid"]    = uid;

  File f = SPIFFS.open("/config.json", "w");
  if (!f) return false;
  serializeJson(doc, f);
  f.close();
  Serial.println("[SPIFFS] Config saved");
  return true;
}

// ============================================================
//  CONFIG PORTAL  (blocks until user submits form + reboot)
// ============================================================
void runConfigPortal() {
  Serial.println("[PORTAL] No config. Starting AP: StudyTwin-Setup");

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0); display.println("SETUP MODE");
  display.setCursor(0,10); display.println("WiFi: StudyTwin-Setup");
  display.setCursor(0,20); display.println("(no password)");
  display.setCursor(0,34); display.println("Open browser:");
  display.setCursor(0,44); display.println("192.168.4.1");
  display.display();

  WiFi.mode(WIFI_AP);
  WiFi.softAP("StudyTwin-Setup");

  portal.on("/", HTTP_GET, []() {
    portal.send_P(200, "text/html", PORTAL_HTML);
  });

  portal.on("/save", HTTP_POST, []() {
    String ssid   = portal.arg("ssid");
    String pass   = portal.arg("password");
    String host   = portal.arg("host");
    String secret = portal.arg("secret");
    String uid    = portal.arg("uid");

    portal.send_P(200, "text/html", SAVED_HTML);
    saveConfig(ssid, pass, host, secret, uid);
    delay(1500);
    ESP.restart();
  });

  portal.begin();
  Serial.println("[PORTAL] Waiting for form submission at 192.168.4.1 ...");
  while (true) { portal.handleClient(); delay(5); }
}

// ============================================================
//  GSR HELPERS
// ============================================================
float gsrSmooth(int raw) {
  gsrBuf[gsrBufIdx] = raw;
  gsrBufIdx = (gsrBufIdx + 1) % GSR_SMOOTH_N;
  if (!gsrBufFull && gsrBufIdx == 0) gsrBufFull = true;
  int n = gsrBufFull ? GSR_SMOOTH_N : gsrBufIdx;
  float s = 0;
  for (int i = 0; i < n; i++) s += gsrBuf[i];
  return (n > 0) ? s / n : (float)raw;
}

void runGSRCalibration() {
  Serial.println("[CAL] 60s GSR baseline calibration – sit still");
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0); display.println("GSR CALIBRATION");
  display.setCursor(0,12); display.println("Keep clips still");
  display.setCursor(0,22); display.println("60 seconds...");
  display.display();

  const int N = 60;
  float readings[N];
  for (int i = 0; i < N; i++) {
    readings[i] = gsrSmooth(analogRead(GSR_PIN));
    // Progress bar
    int barW = (int)(((float)(i + 1) / N) * OLED_WIDTH);
    display.fillRect(0, 56, barW, 8, SSD1306_WHITE);
    display.display();
    Serial.printf("[CAL] %2d/60  raw=%.0f\n", i + 1, readings[i]);
    delay(1000);
  }

  // Compute mean
  double sum = 0;
  for (int i = 0; i < N; i++) sum += readings[i];
  mu_gsr = (float)(sum / N);

  // Compute std-dev
  double varSum = 0;
  for (int i = 0; i < N; i++) {
    double d = readings[i] - mu_gsr;
    varSum += d * d;
  }
  sigma_gsr = (float)sqrt(varSum / N);
  if (sigma_gsr < 1.0f) sigma_gsr = 1.0f;  // guard div-by-zero

  Serial.printf("[CAL] Done  mu=%.1f  sigma=%.1f\n", mu_gsr, sigma_gsr);

  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(14, 22);
  display.println("READY!");
  display.display();
  delay(1200);
}

// ============================================================
//  HRV HELPERS
// ============================================================
float computeRMSSD() {
  int avail = min(beatCount, IBI_WINDOW);
  if (avail < 2) return 55.0f;
  double sumSq = 0;
  int cnt = 0;
  for (int i = 1; i < avail; i++) {
    int cur  = (ibiBufIdx - avail + i     + IBI_WINDOW) % IBI_WINDOW;
    int prev = (ibiBufIdx - avail + i - 1 + IBI_WINDOW) % IBI_WINDOW;
    long d = ibiBuf[cur] - ibiBuf[prev];
    sumSq += (double)d * d;
    cnt++;
  }
  return (cnt > 0) ? (float)sqrt(sumSq / cnt) : 55.0f;
}

float computeHR() {
  int avail = min(beatCount, 6);
  if (avail < 1) return 0.0f;
  double s = 0;
  for (int i = 0; i < avail; i++) {
    int idx = (ibiBufIdx - avail + i + IBI_WINDOW) % IBI_WINDOW;
    s += ibiBuf[idx];
  }
  float meanIBI = (float)(s / avail);
  return (meanIBI > 0) ? 60000.0f / meanIBI : 0.0f;
}

// ============================================================
//  CLI STATE
// ============================================================
const char* cliState(float cli) {
  if (cli < 26.0f) return "CALM";
  if (cli < 56.0f) return "FOCUSED";
  if (cli < 78.0f) return "ELEVATED";
  return "OVERLOADED";
}

// ============================================================
//  OLED UPDATE
// ============================================================
void updateOLED(int cli, const char* state,
                int hr, float gsrDev,
                float blinkRate, bool valid) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  if (!valid) {
    // No finger – show prompt
    display.setTextSize(1);
    display.setCursor(0, 0);  display.println("STUDYTWIN");
    display.setCursor(0,16); display.println("Place finger on");
    display.setCursor(0,26); display.println("MAX30102 sensor");
    display.setCursor(0,44); display.println("& attach GSR clips");
    display.display();
    return;
  }

  // Row 0-15: CLI (textSize 2 = 12x16px each char)
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.print("CLI:");
  display.println(cli);

  // Row 16: State (textSize 1)
  display.setTextSize(1);
  display.setCursor(0, 17);
  display.println(state);

  // Row 25: Heart Rate
  display.setCursor(0, 27);
  display.print("HR: ");
  if (hr > 0) { display.print(hr); display.println("bpm"); }
  else          display.println("--bpm");

  // Row 35: GSR deviation
  display.setCursor(0, 37);
  display.print("GSR:");
  if (gsrDev >= 0) display.print("+");
  display.print((int)gsrDev);
  display.println("%");

  // Row 45: Blink rate (from browser MediaPipe via Firebase)
  display.setCursor(0, 47);
  display.print("BL: ");
  if (blinkRate >= 0) {
    display.print((int)blinkRate);
    display.println("/m");
  } else {
    display.println("--/m");
  }

  display.display();
}

// ============================================================
//  FIREBASE WRITE — live/current (overwrite every 1s)
// ============================================================
void fbWriteLive(int gsrRaw, float gsrZ, float rmssd,
                 int cliScore, const char* state,
                 int hrBpm, bool valid) {
  if (!Firebase.ready()) return;

  String path = "/sessions/" + cfg.uid + "/live/current";

  FirebaseJson json;
  json.set("ts",           (int)millis());
  json.set("gsr_raw",      gsrRaw);
  json.set("gsr_z",        (double)roundf(gsrZ * 100.0f) / 100.0);
  json.set("rmssd",        (double)roundf(rmssd * 10.0f) / 10.0);
  json.set("cli_score",    cliScore);
  json.set("cli_state",    String(state));
  json.set("hr_bpm",       hrBpm);
  json.set("battery",      3800);   // static for Phase 2 (no voltage divider yet)
  json.set("sensor_valid", valid);

  if (Firebase.setJSON(fbdo, path.c_str(), json)) {
    Serial.println("[FB] live/current OK");
  } else {
    Serial.print("[FB] live/current FAIL: ");
    Serial.println(fbdo.errorReason());
  }
}

// ============================================================
//  FIREBASE WRITE — live/history (push append every 5s)
// ============================================================
void fbWriteHistory(int cliScore, const char* state,
                    int hrBpm, float rmssd) {
  if (!Firebase.ready()) return;

  String path = "/sessions/" + cfg.uid + "/live/history";

  FirebaseJson json;
  json.set("ts",        (int)millis());
  json.set("cli_score", cliScore);
  json.set("cli_state", String(state));
  json.set("hr_bpm",    hrBpm);
  json.set("rmssd",     (double)roundf(rmssd * 10.0f) / 10.0);

  if (Firebase.pushJSON(fbdo, path.c_str(), json)) {
    Serial.println("[FB] history push OK");
  } else {
    Serial.print("[FB] history FAIL: ");
    Serial.println(fbdo.errorReason());
  }
}

// ============================================================
//  FIREBASE READ — blink_rate written by browser MediaPipe
//  blink-detection.js updates /sessions/{uid}/live/current/blink_rate
//  We read it here every 15s to display on OLED
// ============================================================
void fbReadBlinkRate() {
  if (!Firebase.ready()) return;

  String path = "/sessions/" + cfg.uid + "/live/current/blink_rate";

  if (Firebase.getFloat(fbdo, path.c_str())) {
    float val = fbdo.floatData();
    if (val >= 0 && val <= 50) {   // sanity check: 0-50 blinks/min
      blink_rate_web = val;
      Serial.printf("[FB] blink_rate read: %.1f /min\n", blink_rate_web);
    }
  } else {
    // Field not written yet by browser – silently ignore
    Serial.println("[FB] blink_rate not yet in Firebase (browser not started?)");
  }
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("\n\n====== STUDYTWIN BOOT ======");

  // I2C + OLED (needed for setup messages)
  Wire.begin(I2C_SDA, I2C_SCL);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("[ERR] OLED not found – check wiring");
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(2, 20);
  display.println("STUDYTWIN");
  display.display();
  Serial.println("STUDYTWIN");
  delay(1000);

  // SPIFFS
  if (!SPIFFS.begin(true)) {
    Serial.println("[ERR] SPIFFS failed");
  }

  // Config – if missing/incomplete, launch portal (blocks until reboot)
  if (!loadConfig()) {
    runConfigPortal();   // never returns
  }

  // WiFi connect
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0); display.print("WiFi:");
  display.println(cfg.wifi_ssid);
  display.display();

  WiFi.begin(cfg.wifi_ssid.c_str(), cfg.wifi_password.c_str());
  Serial.print("[WiFi] Connecting");
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500); Serial.print("."); tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] OK  IP=" + WiFi.localIP().toString());
    display.setCursor(0,12); display.println("WiFi: OK");
  } else {
    Serial.println("\n[WiFi] FAILED – running offline");
    display.setCursor(0,12); display.println("WiFi: FAIL");
  }
  display.display();
  delay(700);

  // Firebase init
  fbCfg.host = cfg.firebase_host.c_str();
  fbCfg.signer.tokens.legacy_token = cfg.firebase_secret.c_str();
  Firebase.begin(&fbCfg, &fbAuth);
  Firebase.reconnectWiFi(true);
  Serial.println("[Firebase] Initialized");

  // MAX30102
  display.clearDisplay();
  display.setCursor(0, 0); display.println("Init MAX30102...");
  display.display();

  if (!hrSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("[ERR] MAX30102 not found – check wiring");
    display.println("MAX30102: FAIL");
    display.display();
    delay(2000);
  } else {
    // Setup: brightness=60, sampleAvg=4, mode=2(red+IR), sampleRate=400, pulseWidth=411, adcRange=4096
    hrSensor.setup(60, 4, 2, 400, 411, 4096);
    Serial.println("[MAX30102] OK");
    display.println("MAX30102: OK");
    display.display();
    delay(500);
  }

  // 60s GSR calibration
  runGSRCalibration();

  lastSecMs  = millis();
  lastHistMs = millis();
  lastBlinkReadMs = 0;

  Serial.println("[BOOT] Complete. Streaming...");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  unsigned long now = millis();

  // ── MAX30102 beat detection (runs every loop iteration, fast) ─
  long irValue = hrSensor.getIR();

  if (checkForBeat(irValue)) {
    long beatNow = millis();
    if (lastBeatMs != 0) {
      long ibi = beatNow - lastBeatMs;
      // Physiologically valid IBI: 300-2000ms (30-200 bpm)
      if (ibi >= 300 && ibi <= 2000) {
        ibiBuf[ibiBufIdx] = ibi;
        ibiBufIdx = (ibiBufIdx + 1) % IBI_WINDOW;
        beatCount++;
        Serial.printf("[HRV] Beat  IBI=%ldms  total=%d\n", ibi, beatCount);
      }
    }
    lastBeatMs = beatNow;
  }

  // ── Sensor validity ──────────────────────────────────────────
  // IR > 50000 means finger is present on the sensor
  bool fingerOn = (irValue > 50000);
  if (fingerOn) lastValidMs = now;
  sensor_valid = fingerOn || (lastValidMs > 0 && (now - lastValidMs) < GRACE_MS);

  // ── 1-second tick ─────────────────────────────────────────────
  if (now - lastSecMs < 1000) return;
  lastSecMs = now;

  // 1. GSR processing
  int   gsrRaw     = analogRead(GSR_PIN);
  float filtered   = gsrSmooth(gsrRaw);
  float gsr_z      = (filtered - mu_gsr) / sigma_gsr;
  float gsrDevPct  = gsr_z * 100.0f;  // human-readable percentage deviation

  if (sensor_valid) {
    // Map z-score to 0-100: z=0 → score=50, z=+2 → score~80
    gsr_score = constrain(50.0f + gsr_z * 15.0f, 0.0f, 100.0f);
  }
  Serial.printf("[GSR] raw=%d  z=%.2f  dev=%.1f%%  score=%.1f\n",
                gsrRaw, gsr_z, gsrDevPct, gsr_score);

  // 2. HRV / HR processing
  if (sensor_valid && beatCount >= 4) {
    rmssd_val = computeRMSSD();
    hr_bpm    = computeHR();
  }
  float hrv_score = constrain(
    100.0f - ((rmssd_val - 18.0f) / 70.0f) * 100.0f, 0.0f, 100.0f);
  Serial.printf("[HRV] rmssd=%.1f  hr=%.0f  hrv_score=%.1f\n",
                rmssd_val, hr_bpm, hrv_score);

  // 3. CLI fusion (only update when sensor is valid)
  //    blink_rate_web = from browser MediaPipe (15% weight)
  //    If browser not started yet, use 50 as neutral blink score
  float blinkScore = 50.0f;
  if (blink_rate_web >= 0) {
    // Higher blink rate = less load; lower blink rate = more load
    blinkScore = constrain(8.0f * (12.0f - blink_rate_web), 0.0f, 100.0f);
  }

  if (sensor_valid) {
    float raw_cli  = (gsr_score * 0.50f) + (hrv_score * 0.35f) + (blinkScore * 0.15f);
    cli_smoothed   = cli_smoothed * (1.0f - EMA_ALPHA) + raw_cli * EMA_ALPHA;
  }
  const char* state = cliState(cli_smoothed);
  Serial.printf("[CLI] %.1f  state=%s  valid=%s\n",
                cli_smoothed, state, sensor_valid ? "YES" : "NO");

  // 4. Update OLED
  updateOLED((int)cli_smoothed, state,
             (int)hr_bpm, gsrDevPct,
             blink_rate_web, sensor_valid);

  // 5. Firebase: overwrite live/current every 1s
  fbWriteLive(gsrRaw, gsr_z, rmssd_val,
              (int)cli_smoothed, state,
              (int)hr_bpm, sensor_valid);

  // 6. Firebase: push history every 5s (only when sensor valid)
  if (sensor_valid && (now - lastHistMs >= HISTORY_INTERVAL_MS)) {
    lastHistMs = now;
    fbWriteHistory((int)cli_smoothed, state, (int)hr_bpm, rmssd_val);
  }

  // 7. Firebase: read blink_rate from browser every 15s
  //    blink-detection.js writes blink_rate to /sessions/{uid}/live/current
  if (now - lastBlinkReadMs >= BLINK_READ_INTERVAL_MS) {
    lastBlinkReadMs = now;
    fbReadBlinkRate();
  }
}
