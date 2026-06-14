# VoxCTL App — Feedback & Dev Notes

## 1. Product Feedback (AI-Assisted Review)

- Used Claude to perform an expert product design review of the app
- Provided screenshots and a detailed transcript covering: target market, app direction, and goals
- Received substantive, actionable feedback worth incorporating into the roadmap
- This thread is a strong reference for product positioning and competitive strategy

### Feedback Items Flagged for Implementation

- Post-processing pipeline
- File import support
- Capture HUD
- First-run / onboarding dictation moment (polish)
- Local model fallback option
- Cost comparisons between models/tiers
- General UI/UX polish

**Takeaway:** To compete seriously in the voice-to-text market, these features are considered baseline expectations.

---

## 2. Competitive Analysis — Claude App (Android) Voice Feature

- Tested the Claude Android app's voice input feature as a benchmark
- Observation: voice input feels fast and polished because it uses a **real-time streaming model**
- Text is processed and ready **immediately upon hitting Enter** — no perceptible post-processing delay

### Key Difference vs. Current App
\
- Current app has a noticeable processing step after the user stops speaking
- Claude app sends instantly on Enter with no lag
- This gap creates a worse perceived UX in the current implementation

### Web vs. Android Behavior

- Behavior may differ between Claude web and Claude Android app
- On web: likely failed due to microphone conflict (already in use by another app)
- On Android app: real-time waveform display + immediate send on Enter

---

## 3. Action Item — Implement Real-Time Streaming Fix

- **Priority fix:** Implement real-time streaming transcription so text is ready immediately when the user hits Enter
- Goal: match the snappy, zero-delay feel of the Claude Android voice feature
- This is scheduled for implementation today