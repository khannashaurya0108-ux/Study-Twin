"""
StudyTwin Blink Detection Server
Based on: Kan repo (Socket.IO architecture) +
          Eye-Blink-Detection repo (optimal EAR params)

Run:  python blink_server.py
Port: http://localhost:5001
"""

import cv2
import mediapipe as mp
import numpy as np
import time
import threading
from flask import Flask
from flask_socketio import SocketIO
from flask_cors import CORS

# ── App setup ────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode='threading',
    logger=False,
    engineio_logger=False
)

# ── MediaPipe Face Mesh — EAR landmark indices ───────────────────────────────
# Verified against MediaPipe 468-point model
RIGHT_EYE_EAR = [33,  159, 158, 133, 153, 145]
LEFT_EYE_EAR  = [362, 380, 374, 263, 386, 385]

# ── Optimal parameters (from Eye-Blink-Detection notebook analysis) ──────────
EAR_THRESHOLD_DEFAULT = 0.285   # sweet spot: 0.275–0.300
CONSEC_FRAMES         = 3       # sweet spot: 2–4
CALIBRATION_SECONDS   = 5       # match ESP32 60s calibration phase

# ── Shared state (thread-safe via _lock) ─────────────────────────────────────
_lock = threading.Lock()
state = {
    'running':     False,
    'blink_count': 0,
    'blink_rate':  15,
    'blink_score': 20,
    'ear':         0.30,
    'baseline':    0.30,
    'threshold':   EAR_THRESHOLD_DEFAULT,
    'calibrated':  False,
}


# ── Core EAR calculation ─────────────────────────────────────────────────────
def compute_ear(landmarks, eye_indices, img_w, img_h):
    """
    Eye Aspect Ratio: EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
    Returns float, defaults to 0.30 on degenerate geometry.
    """
    pts = np.array([
        [landmarks[i].x * img_w, landmarks[i].y * img_h]
        for i in eye_indices
    ], dtype=np.float32)

    A = np.linalg.norm(pts[1] - pts[5])
    B = np.linalg.norm(pts[2] - pts[4])
    C = np.linalg.norm(pts[0] - pts[3])

    return float((A + B) / (2.0 * C)) if C > 1e-6 else 0.30


def blink_rate_to_score(bpm):
    """
    Score peaks at 15 blinks/min (100), drops toward 0 or 8 blinks/min extremes.
    """
    if bpm <= 0:
        return 0
    # Optimal is 15 bpm, score drops away from that
    score = 100 - abs(bpm - 15) * 8
    return max(0, min(100, round(score)))


# ── Detection thread ─────────────────────────────────────────────────────────
def detection_loop():
    """
    Runs in background thread.
    Camera → MediaPipe → EAR → blink count → emit via Socket.IO.
    """
    mp_mesh  = mp.solutions.face_mesh
    face_mesh = mp_mesh.FaceMesh(
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    cap = cv2.VideoCapture(2, cv2.CAP_DSHOW)  # DroidCam via OBS
    if not cap.isOpened():
        cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)  # fallback to laptop cam
        print("[BLINK SERVER] DroidCam not found at index 2, fell back to webcam index 0")
    if not cap.isOpened():
        print("[BLINK SERVER] ERROR: No camera found at index 2 or 0")
        with _lock:
            state['running'] = False
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    cap.set(cv2.CAP_PROP_FPS,          30)

    frame_ctr       = 0     # consecutive below-threshold frames
    blink_timestamps = []   # timestamps for sliding 60s window
    calib_ears      = []    # collected during calibration
    calib_start     = time.time()
    count_start     = time.time()
    last_emit       = time.time()
    threshold       = EAR_THRESHOLD_DEFAULT

    print(f"[BLINK SERVER] Camera open. Calibrating EAR baseline for {CALIBRATION_SECONDS}s ...")

    while state['running']:
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.01)
            continue

        img_h, img_w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = face_mesh.process(rgb)

        ear = threshold  # neutral default: treated as "open"

        if results.multi_face_landmarks:
            lm    = results.multi_face_landmarks[0].landmark
            l_ear = compute_ear(lm, LEFT_EYE_EAR,  img_w, img_h)
            r_ear = compute_ear(lm, RIGHT_EYE_EAR, img_w, img_h)
            ear   = (l_ear + r_ear) / 2.0

            # ── Calibration phase ──────────────────────────────────────────
            if not state['calibrated']:
                calib_ears.append(ear)
                if time.time() - calib_start >= CALIBRATION_SECONDS:
                    baseline  = float(np.percentile(calib_ears, 60))
                    threshold = max(0.18, min(0.35, baseline * 0.75))
                    with _lock:
                        state['baseline']   = round(baseline, 3)
                        state['threshold']  = round(threshold, 3)
                        state['calibrated'] = True
                    print(
                        f"[BLINK SERVER] Calibrated  "
                        f"baseline={baseline:.3f}  threshold={threshold:.3f}"
                    )
                    count_start = time.time()

            # ── Blink detection ────────────────────────────────────────────
            else:
                if ear < threshold:
                    frame_ctr += 1
                else:
                    if frame_ctr >= CONSEC_FRAMES:
                        with _lock:
                            state['blink_count'] += 1
                        blink_timestamps.append(time.time())
                    frame_ctr = 0

        # ── Blink rate: count events over elapsed minutes ──────────────────
        now = time.time()
        blink_timestamps = [t for t in blink_timestamps if now - t <= 60.0]
        elapsed_minutes = max((now - count_start) / 60.0, 1/60)
        blink_rate = round(state['blink_count'] / elapsed_minutes, 1)
        blink_score = blink_rate_to_score(blink_rate)

        with _lock:
            state['ear']         = round(ear, 3)
            state['blink_rate']  = blink_rate
            state['blink_score'] = blink_score

        # ── Emit summary to dashboard once per second ─────────────────────
        if now - last_emit >= 1.0:
            payload = {
                'blink_count':        state['blink_count'],
                'total_blinks':       state['blink_count'],       # alias for blink.html
                'blink_rate':         state['blink_rate'],
                'blink_rate_per_min': state['blink_rate'],        # alias for blink.html
                'blink_score':        state['blink_score'],
                'ear':                state['ear'],
                'calibrated':         state['calibrated'],
            }
            socketio.emit('blink_data', payload)
            last_emit = now

    # ── Cleanup ───────────────────────────────────────────────────────────
    cap.release()
    face_mesh.close()
    print("[BLINK SERVER] Detection stopped and camera released.")


# ── Socket.IO event handlers ─────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    print("[BLINK SERVER] Dashboard connected")
    # Start detection thread on first dashboard connection
    if not state['running']:
        with _lock:
            state['running'] = True
        t = threading.Thread(target=detection_loop, daemon=True, name='BlinkDetect')
        t.start()


@socketio.on('disconnect')
def on_disconnect():
    print("[BLINK SERVER] Dashboard disconnected")


@socketio.on('reset_blinks')
def on_reset():
    with _lock:
        state['blink_count'] = 0
        state['calibrated']  = False
    # Signal thread to stop so it restarts with fresh calibration on next connect
    state['running'] = False
    print("[BLINK SERVER] Session reset")


# ── Health endpoint (browser can poll this to check server status) ───────────
@app.route('/health')
def health():
    return {
        'status':    'ok',
        'calibrated': state['calibrated'],
        'blink_rate': state['blink_rate'],
    }


# ── Entry point ──────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 55)
    print(" StudyTwin Blink Detection Server")
    print(" Socket.IO  →  http://localhost:5001")
    print(" Health     →  http://localhost:5001/health")
    print("=" * 55)
    socketio.run(
        app,
        host='127.0.0.1',
        port=5001,
        debug=False,
        use_reloader=False,   # CRITICAL: prevents thread starting twice
    )