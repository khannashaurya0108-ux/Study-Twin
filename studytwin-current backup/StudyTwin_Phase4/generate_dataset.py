#!/usr/bin/env python3
"""
StudyTwin Synthetic Dataset Generator
Phase 4 - TinyML Cognitive Load Classifier Training Data
=========================================================

This script creates realistic synthetic physiological data for training
the Edge Impulse 1D-CNN cognitive load classifier.

WHY SYNTHETIC DATA?
  We do not yet have real labelled subject sessions. This synthetic data
  is generated from peer-reviewed literature values and will be replaced
  by real NASA-TLX-labelled data after your user study (Phase 7).
  The model trained on this data is fully functional and can be improved
  by retraining on real data later.

SIGNALS GENERATED:
  1. GSR z-score  — galvanic skin response deviation from personal baseline
  2. HR BPM       — heart rate in beats per minute

SCIENTIFIC BASIS:
  GSR values from Shi et al. 2007 (wristband validation study, n=48)
  HR/HRV from Shaffer & Ginsberg 2017 (HRV metrics meta-analysis)
  Load thresholds from StudyTwin IEEE paper §V (CLI fusion weights)

USAGE:
  pip install numpy
  python generate_dataset.py

OUTPUT:
  studytwin_dataset/
    training/
      calm/         ~440 CSV files
      focused/      ~880 CSV files
      elevated/     ~252 CSV files
      overloaded/   ~188 CSV files
    testing/
      calm/         ~110 CSV files
      focused/      ~220 CSV files
      elevated/      ~63 CSV files
      overloaded/    ~47 CSV files
"""

import numpy as np
import csv
import os
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# REPRODUCIBILITY
# ─────────────────────────────────────────────────────────────────────────────
np.random.seed(2025)

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────
SAMPLE_RATE_HZ  = 1     # 1 Hz matches the ESP32 main loop (one data point per second)
WINDOW_SECONDS  = 30    # 30-second analysis window
N_SAMPLES       = SAMPLE_RATE_HZ * WINDOW_SECONDS   # = 30 samples per CSV file

# ─────────────────────────────────────────────────────────────────────────────
# DATASET SIZE
# Distribution roughly mirrors the paper (5535 : 11070 : 3150 : 2385)
# scaled to ~10% so Edge Impulse trains in under 10 minutes.
# ─────────────────────────────────────────────────────────────────────────────
N_WINDOWS_PER_CLASS = {
    'calm':       550,    # baseline / resting states
    'focused':   1100,    # optimal learning zone (largest class)
    'elevated':   315,    # pre-overload, early stress signs
    'overloaded': 235,    # cognitive overload, break needed
}
TRAIN_FRACTION = 0.80   # 80 % training, 20 % testing

# ─────────────────────────────────────────────────────────────────────────────
# PHYSIOLOGICAL PARAMETERS PER COGNITIVE STATE
#
# GSR z-score (deviation from 60-second personal baseline):
#   Calm:       Very near 0.  Occasional tiny spikes.
#   Focused:    Slight elevation. Moderate occasional SCR.
#   Elevated:   Significant elevation. Frequent SCR events.
#   Overloaded: Large elevation. Very frequent, large SCR events.
#
# Heart Rate BPM (derived from MAX30102 PPG):
#   The inverse HRV ↔ HR relationship (Shaffer & Ginsberg 2017):
#     RMSSD  75 ms  →  HR ~63 bpm  (calm, strong parasympathetic)
#     RMSSD  50 ms  →  HR ~70 bpm  (focused, moderate HRV)
#     RMSSD  30 ms  →  HR ~80 bpm  (elevated, reduced HRV)
#     RMSSD  20 ms  →  HR ~91 bpm  (overloaded, suppressed HRV)
# ─────────────────────────────────────────────────────────────────────────────
PARAMS = {
    'calm': {
        # ── GSR z-score ──────────────────────────────────────────────
        'gsr_mean':     0.22,    # mean z-score near baseline
        'gsr_std':      0.28,    # low within-window variability
        'gsr_ar':       0.88,    # high autocorrelation = smooth signal
        'gsr_min':     -0.60,    # can briefly dip below baseline
        'gsr_max':      1.40,
        'scr_prob':     0.02,    # 2 % chance of SCR per sample
        'scr_amp_mean': 0.35,
        'scr_amp_std':  0.15,
        'scr_decay':    0.40,    # how fast SCR decays (higher = faster)
        # ── Heart Rate BPM ───────────────────────────────────────────
        'hr_mean':     63.5,     # slow resting HR
        'hr_std':       4.8,     # high HRV = high HR variability in BPM
        'hr_ar':        0.90,
        'hr_min':      52.0,
        'hr_max':      76.0,
        # ── Baseline drift ──────────────────────────────────────────
        'drift_rate':   0.010,   # very slow drift per sample
    },
    'focused': {
        'gsr_mean':     0.80,
        'gsr_std':      0.42,
        'gsr_ar':       0.83,
        'gsr_min':      0.00,
        'gsr_max':      2.30,
        'scr_prob':     0.05,
        'scr_amp_mean': 0.60,
        'scr_amp_std':  0.22,
        'scr_decay':    0.38,
        'hr_mean':     70.2,
        'hr_std':       5.6,
        'hr_ar':        0.86,
        'hr_min':      59.0,
        'hr_max':      84.0,
        'drift_rate':   0.020,
    },
    'elevated': {
        'gsr_mean':     2.15,
        'gsr_std':      0.68,
        'gsr_ar':       0.78,
        'gsr_min':      0.80,
        'gsr_max':      4.50,
        'scr_prob':     0.12,
        'scr_amp_mean': 0.95,
        'scr_amp_std':  0.35,
        'scr_decay':    0.32,
        'hr_mean':     80.8,
        'hr_std':       6.8,
        'hr_ar':        0.80,
        'hr_min':      67.0,
        'hr_max':      96.0,
        'drift_rate':   0.040,
    },
    'overloaded': {
        'gsr_mean':     4.05,
        'gsr_std':      0.92,
        'gsr_ar':       0.72,
        'gsr_min':      2.20,
        'gsr_max':      7.80,
        'scr_prob':     0.21,
        'scr_amp_mean': 1.45,
        'scr_amp_std':  0.55,
        'scr_decay':    0.28,
        'hr_mean':     91.4,
        'hr_std':       7.5,
        'hr_ar':        0.74,
        'hr_min':      78.0,
        'hr_max':     108.0,
        'drift_rate':   0.050,
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# VIRTUAL SUBJECTS
# Simulates 15 participants with unique baseline physiology.
# This prevents the model from just memorising one person's patterns.
# ─────────────────────────────────────────────────────────────────────────────
def create_virtual_subjects(n=15):
    subjects = []
    for _ in range(n):
        subjects.append({
            # Each person has a unique resting GSR baseline offset
            'gsr_offset':    np.random.normal(0.0, 0.25),
            # Heart rate varies ±12 % between individuals
            'hr_scale':      np.random.uniform(0.88, 1.12),
            # Stress reactivity: some people react more strongly to load
            'reactivity':    np.random.uniform(0.80, 1.20),
        })
    return subjects

N_VIRTUAL_SUBJECTS = 15
SUBJECTS = create_virtual_subjects(N_VIRTUAL_SUBJECTS)


# ─────────────────────────────────────────────────────────────────────────────
# SIGNAL GENERATORS
# ─────────────────────────────────────────────────────────────────────────────

def generate_gsr_window(state: str, subject: dict) -> np.ndarray:
    """
    Generate one 30-sample GSR z-score time series for the given state.

    Model:
      x[i] = ar * x[i-1] + (1-ar) * mean + noise   (AR-1 process)
      + SCR events (random spikes with exponential decay)
      + slow baseline drift (fatigue / habituation)
    """
    p = PARAMS[state]
    s = subject

    # Adjust target mean for this subject's reactivity and baseline offset
    effective_mean = (p['gsr_mean'] + s['gsr_offset']) * s['reactivity']
    effective_mean = max(p['gsr_min'], min(p['gsr_max'], effective_mean))

    gsr = np.zeros(N_SAMPLES)
    # Initialise first sample with moderate random offset
    gsr[0] = np.clip(
        effective_mean + np.random.normal(0, p['gsr_std']),
        p['gsr_min'], p['gsr_max']
    )

    # Slow baseline drift direction (random per window)
    drift_direction = np.random.choice([-1.0, 1.0]) * np.random.uniform(0.5, 1.5)
    drift = drift_direction * p['drift_rate'] * np.arange(N_SAMPLES)

    # AR(1) generation with SCR events
    scr_carry = np.zeros(N_SAMPLES)   # accumulates SCR decay tails
    for i in range(1, N_SAMPLES):
        noise = np.random.normal(0, p['gsr_std'] * np.sqrt(1 - p['gsr_ar']**2))
        gsr[i] = p['gsr_ar'] * gsr[i-1] + effective_mean * (1 - p['gsr_ar']) + noise

        # Random SCR event at this sample
        if np.random.random() < p['scr_prob']:
            amp = max(0.05, np.random.normal(
                p['scr_amp_mean'] * s['reactivity'],
                p['scr_amp_std']
            ))
            # Inject SCR: sharp rise then exponential decay over next ~8 samples
            n_decay = min(10, N_SAMPLES - i)
            for j in range(n_decay):
                if i + j < N_SAMPLES:
                    scr_carry[i + j] += amp * np.exp(-p['scr_decay'] * j)

        gsr[i] += scr_carry[i] + drift[i]
        gsr[i] = np.clip(gsr[i], p['gsr_min'], p['gsr_max'])

    # Add tiny high-frequency noise (electrode impedance / ADC noise)
    gsr += np.random.normal(0, 0.03, N_SAMPLES)

    return np.round(gsr, 4)


def generate_hr_window(state: str, subject: dict) -> np.ndarray:
    """
    Generate one 30-sample heart rate (BPM) time series for the given state.

    Key biological features:
      - AR(1) process with state-specific mean and std
      - Respiratory Sinus Arrhythmia (RSA): ~0.25 Hz oscillation
        (stronger when calm because of high vagal tone)
      - Subject-specific HR scaling (±12 %)
    """
    p = PARAMS[state]
    s = subject

    effective_mean = p['hr_mean'] * s['hr_scale']
    effective_mean = np.clip(effective_mean, p['hr_min'], p['hr_max'])

    hr = np.zeros(N_SAMPLES)
    hr[0] = np.clip(
        effective_mean + np.random.normal(0, p['hr_std']),
        p['hr_min'], p['hr_max']
    )

    for i in range(1, N_SAMPLES):
        noise = np.random.normal(0, p['hr_std'] * np.sqrt(1 - p['hr_ar']**2))
        hr[i] = p['hr_ar'] * hr[i-1] + effective_mean * (1 - p['hr_ar']) + noise
        hr[i] = np.clip(hr[i], p['hr_min'], p['hr_max'])

    # Respiratory Sinus Arrhythmia (RSA): HR oscillates at breathing frequency
    # RSA amplitude is much larger when calm (strong parasympathetic tone)
    rsa_amplitude = {'calm': 2.8, 'focused': 2.0, 'elevated': 1.1, 'overloaded': 0.5}[state]
    rsa_freq = np.random.uniform(0.18, 0.32)   # breathing ~11-19 breaths/min
    rsa_phase = np.random.uniform(0, 2 * np.pi)
    t = np.arange(N_SAMPLES) / SAMPLE_RATE_HZ
    hr += rsa_amplitude * np.sin(2 * np.pi * rsa_freq * t + rsa_phase)

    hr = np.clip(hr, p['hr_min'], p['hr_max'])
    hr += np.random.normal(0, 0.35, N_SAMPLES)   # sensor noise

    return np.round(hr, 2)


# ─────────────────────────────────────────────────────────────────────────────
# CSV WRITER
# ─────────────────────────────────────────────────────────────────────────────

def save_csv(filepath: Path, gsr: np.ndarray, hr: np.ndarray):
    """
    Write one window as an Edge Impulse-compatible CSV file.

    Format:
      timestamp (ms)  |  gsr_z (z-score)  |  hr_bpm (BPM)
      0               |  0.2341           |  63.5
      1000            |  0.2187           |  64.1
      ...
      29000           |  0.1954           |  62.8
    """
    with open(filepath, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['timestamp', 'gsr_z', 'hr_bpm'])
        dt_ms = int(1000 / SAMPLE_RATE_HZ)   # 1000 ms between samples at 1 Hz
        for i in range(N_SAMPLES):
            writer.writerow([i * dt_ms, gsr[i], hr[i]])


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    out_dir = Path('studytwin_dataset')

    total_windows = sum(N_WINDOWS_PER_CLASS.values())
    n_train_total = int(total_windows * TRAIN_FRACTION)
    n_test_total  = total_windows - n_train_total

    print("=" * 62)
    print("  StudyTwin Synthetic Dataset Generator")
    print("=" * 62)
    print(f"  Signals  : GSR z-score  +  Heart Rate BPM")
    print(f"  Rate     : {SAMPLE_RATE_HZ} Hz  |  Window: {WINDOW_SECONDS}s  |  Samples/window: {N_SAMPLES}")
    print(f"  Subjects : {N_VIRTUAL_SUBJECTS} virtual subjects (inter-subject variability)")
    print(f"  Split    : {int(TRAIN_FRACTION*100)}% train / {int((1-TRAIN_FRACTION)*100)}% test")
    print(f"  Total    : {total_windows} windows  ({n_train_total} train, {n_test_total} test)")
    print("=" * 62)

    # Create all output directories
    for split in ['training', 'testing']:
        for cls in PARAMS.keys():
            (out_dir / split / cls).mkdir(parents=True, exist_ok=True)

    grand_total = 0

    for cls, n_total in N_WINDOWS_PER_CLASS.items():
        n_train = int(n_total * TRAIN_FRACTION)
        n_test  = n_total - n_train

        print(f"\n  [{cls.upper():12s}]  generating {n_total} windows ...")

        # Generate all windows for this class first
        windows = []
        for win_idx in range(n_total):
            # Cycle through virtual subjects with slight per-window variation
            base_subject = SUBJECTS[win_idx % N_VIRTUAL_SUBJECTS]
            subject = {
                'gsr_offset':  base_subject['gsr_offset']  + np.random.normal(0, 0.04),
                'hr_scale':    base_subject['hr_scale']    * np.random.uniform(0.98, 1.02),
                'reactivity':  base_subject['reactivity']  * np.random.uniform(0.97, 1.03),
            }
            gsr = generate_gsr_window(cls, subject)
            hr  = generate_hr_window(cls, subject)
            windows.append((gsr, hr))

        # Shuffle then split into train / test
        indices = list(range(n_total))
        np.random.shuffle(indices)
        train_idx = indices[:n_train]
        test_idx  = indices[n_train:]

        # Save training files
        for i, idx in enumerate(train_idx):
            gsr, hr = windows[idx]
            path = out_dir / 'training' / cls / f"{cls}.{i+1:04d}.csv"
            save_csv(path, gsr, hr)

        # Save testing files
        for i, idx in enumerate(test_idx):
            gsr, hr = windows[idx]
            path = out_dir / 'testing' / cls / f"{cls}.{i+1:04d}.csv"
            save_csv(path, gsr, hr)

        grand_total += n_total
        print(f"    ✓  {n_train} training  |  {n_test} testing  → studytwin_dataset/{cls}/")

    print("\n" + "=" * 62)
    print(f"  ✅  Done!  {grand_total} windows saved.")
    print(f"  📁  Folder: {out_dir.resolve()}")
    print()
    print("  Class breakdown:")
    print(f"  {'Class':>12}  {'Total':>6}  {'Train':>6}  {'Test':>5}")
    print(f"  {'-'*38}")
    for cls, n in N_WINDOWS_PER_CLASS.items():
        nt = int(n * TRAIN_FRACTION)
        nv = n - nt
        print(f"  {cls:>12}  {n:>6}  {nt:>6}  {nv:>5}")
    print()
    print("  NEXT STEP: Follow the Phase 4 Guide to upload this")
    print("  dataset to Edge Impulse and train your model.")
    print("=" * 62)


if __name__ == '__main__':
    main()