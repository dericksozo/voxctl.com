//! Native microphone capture + dB metering. The cpal input stream is opened
//! ONLY while recording and lives on its own thread; when idle there is no
//! stream and no CPU use. The audio callback downmixes to mono, accumulates raw
//! f32 samples (consumed by transcription/WAV in later slices) and writes an
//! RMS-derived 0..1 level to an atomic. A 60 ms loop emits that level as a
//! single `voxctl:mic-level` event — no per-sample work crosses into the webview.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedSender;

use crate::events::{self, MicLevel, RecState};
use crate::hud;
use crate::transcription::{OpenAiRealtimeTranscriber, RealtimeSession};

/// A live capture: shared buffers + the thread that owns the cpal stream.
pub struct Capture {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    join: Option<JoinHandle<()>>,
}

/// Context captured at record start, attached to the saved history row and used
/// to drive transcription (which provider/model + capability settings).
#[derive(Default, Clone)]
pub struct RecordingContext {
    pub language: Option<String>,
    pub app_name: Option<String>,
    pub website: Option<String>,
    pub mode_name: Option<String>,
    /// Resolved active-mode model id (registry).
    pub model_id: String,
    /// Effective transcription settings for the file path (language + keywords
    /// + capability toggles, intersected with model support).
    pub options: crate::file_transcribe::TranscribeOptions,
}

#[derive(Default)]
pub struct RecorderInner {
    active: Option<Capture>,
    /// Explicit language override (set by the HUD picker; None = use default/auto).
    pub language: Option<String>,
    /// Resolved context for the in-flight recording.
    pub current_ctx: RecordingContext,
    pub recording: bool,
    /// Live transcription session for the in-flight recording (None when there's
    /// no API key — the recording is still captured and saved, transcribed on stop).
    pub session: Option<RealtimeSession>,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<RecorderInner>);

/// Map an RMS amplitude (0..1) to a 0..1 meter level over a -60..0 dBFS range.
fn rms_to_norm(rms: f32) -> f32 {
    let dbfs = 20.0 * rms.max(1e-7).log10();
    ((dbfs + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// Play a start/stop cue if sound effects are enabled (default ON).
fn play_sfx(app: &AppHandle, start: bool) {
    if crate::commands::config::load_config(app).sfx_enabled {
        crate::platform::macos::play_system_sound(if start { "Tink" } else { "Bottle" });
    }
}

/// Downmix one interleaved block to mono, push it, and update the level atomic.
fn process_block(mono: &[f32], samples: &Mutex<Vec<f32>>, level: &AtomicU32) {
    if mono.is_empty() {
        return;
    }
    let sumsq: f32 = mono.iter().map(|s| s * s).sum();
    let rms = (sumsq / mono.len() as f32).sqrt();
    level.store(rms_to_norm(rms).to_bits(), Ordering::Relaxed);
    if let Ok(mut v) = samples.lock() {
        v.extend_from_slice(mono);
    }
}

fn downmix<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> Vec<f32> {
    if channels <= 1 {
        return data.iter().map(|&s| to_f32(s)).collect();
    }
    let frames = data.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut acc = 0.0;
        for c in 0..channels {
            acc += to_f32(data[f * channels + c]);
        }
        out.push(acc / channels as f32);
    }
    out
}

fn start_capture(
    app: &AppHandle,
    raw_tx: Option<UnboundedSender<Vec<f32>>>,
) -> Result<Capture, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("input config: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let stop = Arc::new(AtomicBool::new(false));
    let level = Arc::new(AtomicU32::new(0));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));

    let stop_t = stop.clone();
    let level_t = level.clone();
    let samples_t = samples.clone();
    let app_t = app.clone();

    let join = std::thread::spawn(move || {
        let err_fn = |e| log::error!("audio stream error: {e}");
        let cb_samples = samples_t.clone();
        let cb_level = level_t.clone();
        // Forward raw mono blocks to the live-transcription resampler (if any).
        // The send is non-blocking, so the audio callback stays cheap.
        let cb_raw_tx = raw_tx;

        let stream_res = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    let mono = downmix(data, channels, |s| s);
                    process_block(&mono, &cb_samples, &cb_level);
                    if let Some(tx) = &cb_raw_tx {
                        let _ = tx.send(mono);
                    }
                },
                err_fn,
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let mono = downmix(data, channels, |s| s as f32 / 32768.0);
                    process_block(&mono, &cb_samples, &cb_level);
                    if let Some(tx) = &cb_raw_tx {
                        let _ = tx.send(mono);
                    }
                },
                err_fn,
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let mono = downmix(data, channels, |s| (s as f32 - 32768.0) / 32768.0);
                    process_block(&mono, &cb_samples, &cb_level);
                    if let Some(tx) = &cb_raw_tx {
                        let _ = tx.send(mono);
                    }
                },
                err_fn,
                None,
            ),
            other => {
                log::error!("unsupported sample format: {other:?}");
                return;
            }
        };

        let stream = match stream_res {
            Ok(s) => s,
            Err(e) => {
                log::error!("failed to build input stream: {e}");
                return;
            }
        };
        if let Err(e) = stream.play() {
            log::error!("failed to start stream: {e}");
            return;
        }

        // Emit the level ~16x/sec while recording. Sleeps, so no busy loop.
        while !stop_t.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(60));
            let lvl = f32::from_bits(level_t.load(Ordering::Relaxed));
            let _ = app_t.emit(events::MIC_LEVEL, MicLevel { db: lvl, peak: lvl });
        }
        drop(stream); // closes the stream on this thread (cpal Stream is !Send)
    });

    Ok(Capture {
        stop,
        samples,
        sample_rate,
        join: Some(join),
    })
}

/// Stop the stream, join the thread, and return (raw mono f32 samples, input rate).
fn finish_capture(mut cap: Capture) -> (Vec<f32>, u32) {
    cap.stop.store(true, Ordering::Relaxed);
    if let Some(j) = cap.join.take() {
        let _ = j.join();
    }
    let samples = cap
        .samples
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default();
    (samples, cap.sample_rate)
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RecorderState>();
    let override_lang = {
        let inner = state.0.lock().unwrap();
        if inner.recording {
            return Ok(());
        }
        inner.language.clone()
    };

    // Resolve context (frontmost app/website → mode) and the effective language.
    let ctx = crate::commands::modes::resolve_context(app, override_lang);
    let language = ctx.language.clone();

    // Decide the transcription path from the active mode's model. Live-capable
    // models stream while recording (lowest latency) — OpenAI realtime and xAI
    // Grok STT (WebSocket); every other model is transcribed from the saved WAV
    // on stop (see audio_pipeline). Audio is buffered locally for the WAV
    // regardless of which path runs.
    let reg = crate::registry::effective(app);
    let model = reg.model_by_id(&ctx.model_id);
    let provider = model.map(|m| m.provider.clone());
    let can_live = model.map(|m| m.can_live).unwrap_or(false);
    let live_key = if can_live {
        provider
            .as_deref()
            .and_then(crate::commands::config::get_api_key)
    } else {
        None
    };

    let session = match (provider.as_deref(), live_key) {
        (Some("openai"), Some(key)) => Some(OpenAiRealtimeTranscriber::open_session(
            key,
            ctx.options.language.clone(),
        )),
        (Some("xai"), Some(key)) => Some(crate::xai_live::open_session(key, ctx.options.clone())),
        _ => None,
    };

    let session_bits = session.map(|session| {
        let pcm_tx = session.sender();
        let (raw_tx, raw_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();
        (session, raw_tx, raw_rx, pcm_tx)
    });

    let capture_raw_tx = session_bits
        .as_ref()
        .map(|(_, raw_tx, _, _)| raw_tx.clone());
    let cap = start_capture(app, capture_raw_tx)?;
    let input_rate = cap.sample_rate;

    let session = session_bits.map(|(session, raw_tx, raw_rx, pcm_tx)| {
        // The capture thread holds the live sender; drop ours so `raw_rx` closes
        // when capture stops. The forwarder resamples f32 → 24 kHz PCM16 and
        // streams it to the session, flushing the tail before dropping `pcm_tx`.
        drop(raw_tx);
        let mut raw_rx = raw_rx;
        tauri::async_runtime::spawn(async move {
            let mut rs = crate::resample::StreamResampler::new(input_rate);
            while let Some(block) = raw_rx.recv().await {
                let pcm = rs.push(&block);
                if !pcm.is_empty() {
                    let _ = pcm_tx.send(pcm);
                }
            }
            let tail = rs.finish();
            if !tail.is_empty() {
                let _ = pcm_tx.send(tail);
            }
        });
        session
    });

    {
        let mut inner = state.0.lock().unwrap();
        inner.active = Some(cap);
        inner.current_ctx = ctx;
        inner.recording = true;
        inner.session = session;
    }
    hud::show_hud(app);
    play_sfx(app, true);
    let _ = app.emit(
        events::REC_STATE,
        RecState {
            recording: true,
            language,
        },
    );
    log::info!("recording started");
    Ok(())
}

pub fn stop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RecorderState>();
    let (cap, ctx, session) = {
        let mut inner = state.0.lock().unwrap();
        if !inner.recording {
            return Ok(());
        }
        inner.recording = false;
        (
            inner.active.take(),
            inner.current_ctx.clone(),
            inner.session.take(),
        )
    };

    play_sfx(app, false);
    // Tell the HUD we've moved from "listening" to "transcribing". The pipeline
    // hides the HUD once the final transcript arrives (or on failure).
    let _ = app.emit(
        events::REC_STATE,
        RecState {
            recording: false,
            language: None,
        },
    );

    match cap {
        Some(cap) => {
            // Joining the capture thread drops the audio sender, which closes the
            // forwarder so the live session can commit.
            let (samples, rate) = finish_capture(cap);
            let secs = samples.len() as f32 / rate.max(1) as f32;
            log::info!(
                "recording stopped: {} samples @ {} Hz (~{:.1}s)",
                samples.len(),
                rate,
                secs
            );
            if samples.is_empty() {
                drop(session); // nothing to transcribe; let the session task wind down
                hud::hide_hud(app);
            } else {
                crate::audio_pipeline::on_recording_finished(app, samples, rate, ctx, session);
            }
        }
        None => {
            drop(session);
            hud::hide_hud(app);
        }
    }
    Ok(())
}

pub fn toggle(app: &AppHandle) -> Result<(), String> {
    let recording = {
        let state = app.state::<RecorderState>();
        let inner = state.0.lock().unwrap();
        inner.recording
    };
    if recording {
        stop(app)
    } else {
        start(app)
    }
}

pub fn set_language(app: &AppHandle, language: Option<String>) {
    let state = app.state::<RecorderState>();
    let mut inner = state.0.lock().unwrap();
    inner.language = language;
}

/// Briefly open an input stream to trigger the macOS microphone (TCC) prompt
/// when permission is undetermined. Used by onboarding.
pub fn trigger_mic_prompt() {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return;
    };
    let Ok(supported) = device.default_input_config() else {
        return;
    };
    let fmt = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let err_fn = |_| {};
    let stream = match fmt {
        SampleFormat::F32 => {
            device.build_input_stream(&config, move |_: &[f32], _| {}, err_fn, None)
        }
        SampleFormat::I16 => {
            device.build_input_stream(&config, move |_: &[i16], _| {}, err_fn, None)
        }
        SampleFormat::U16 => {
            device.build_input_stream(&config, move |_: &[u16], _| {}, err_fn, None)
        }
        _ => return,
    };
    if let Ok(stream) = stream {
        let _ = stream.play();
        std::thread::sleep(Duration::from_millis(300));
        drop(stream);
    }
}

// ---- commands ----

#[tauri::command]
pub fn start_recording(app: AppHandle) -> Result<(), String> {
    start(&app)
}

#[tauri::command]
pub fn stop_recording(app: AppHandle) -> Result<(), String> {
    stop(&app)
}

#[tauri::command]
pub fn set_recording_language(app: AppHandle, language: Option<String>) -> Result<(), String> {
    set_language(&app, language);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_mono_passthrough() {
        let d = [0.1f32, -0.2, 0.3];
        assert_eq!(downmix(&d, 1, |s| s), vec![0.1, -0.2, 0.3]);
    }

    #[test]
    fn downmix_stereo_averages_channels() {
        // L/R interleaved: (0,1) -> 0.5, (1,1) -> 1.0
        let d = [0.0f32, 1.0, 1.0, 1.0];
        assert_eq!(downmix(&d, 2, |s| s), vec![0.5, 1.0]);
    }

    #[test]
    fn rms_to_norm_bounds() {
        assert_eq!(rms_to_norm(0.0), 0.0); // silence -> 0
        assert!((rms_to_norm(1.0) - 1.0).abs() < 1e-6); // full scale -> 1
        let mid = rms_to_norm(0.0316); // ~-30 dBFS -> ~0.5
        assert!(mid > 0.45 && mid < 0.55, "mid={mid}");
    }
}
