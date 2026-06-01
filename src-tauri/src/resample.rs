//! Resample captured mono f32 audio to 24 kHz mono PCM16 (the format the
//! realtime transcription API expects, and what we persist as WAV). Uses rubato
//! (anti-aliased sinc) so downsampling from 44.1/48 kHz doesn't introduce
//! aliasing artifacts that hurt transcription. Only runs once, on stop.

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub const TARGET_RATE: u32 = 24000;
const CHUNK: usize = 1024;

fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0) as i16
}

/// Convert mono f32 samples at `input_rate` to 24 kHz mono PCM16.
pub fn resample_to_pcm16_24k(input: &[f32], input_rate: u32) -> Vec<i16> {
    if input.is_empty() {
        return Vec::new();
    }
    if input_rate == TARGET_RATE {
        return input.iter().map(|&s| to_i16(s)).collect();
    }

    let ratio = TARGET_RATE as f64 / input_rate as f64;
    let mut resampler = match SincFixedIn::<f32>::new(ratio, 1.1, sinc_params(), CHUNK, 1) {
        Ok(r) => r,
        Err(e) => {
            log::error!("resampler init failed ({e}); falling back to linear");
            return linear_resample(input, ratio);
        }
    };

    let mut out: Vec<i16> = Vec::with_capacity((input.len() as f64 * ratio) as usize + CHUNK);
    let mut pos = 0;
    while pos + CHUNK <= input.len() {
        let block = input[pos..pos + CHUNK].to_vec();
        match resampler.process(&[block], None) {
            Ok(res) => out.extend(res[0].iter().map(|&s| to_i16(s))),
            Err(e) => {
                log::error!("resample chunk failed: {e}");
                break;
            }
        }
        pos += CHUNK;
    }
    // Final partial block: zero-pad to CHUNK, keep only the proportional output.
    if pos < input.len() {
        let remaining = input.len() - pos;
        let mut last = input[pos..].to_vec();
        last.resize(CHUNK, 0.0);
        if let Ok(res) = resampler.process(&[last], None) {
            let keep = (remaining as f64 * ratio).round() as usize;
            out.extend(res[0].iter().take(keep).map(|&s| to_i16(s)));
        }
    }
    out
}

/// Shared rubato parameters for anti-aliased sinc resampling.
fn sinc_params() -> SincInterpolationParameters {
    SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    }
}

/// Stateful, incremental resampler for the live-streaming path: fed arbitrary
/// mono f32 blocks as audio is captured and emits 24 kHz mono PCM16 in `CHUNK`
/// steps, keeping rubato's filter state continuous across cpal callback blocks
/// (no per-block discontinuities). `resample_to_pcm16_24k` stays the one-shot
/// path used for the saved WAV and re-transcription.
pub struct StreamResampler {
    inner: Option<SincFixedIn<f32>>,
    acc: Vec<f32>,
    ratio: f64,
    passthrough: bool,
}

impl StreamResampler {
    pub fn new(input_rate: u32) -> Self {
        if input_rate == TARGET_RATE {
            return Self {
                inner: None,
                acc: Vec::new(),
                ratio: 1.0,
                passthrough: true,
            };
        }
        let ratio = TARGET_RATE as f64 / input_rate as f64;
        let inner = match SincFixedIn::<f32>::new(ratio, 1.1, sinc_params(), CHUNK, 1) {
            Ok(r) => Some(r),
            Err(e) => {
                log::error!("stream resampler init failed: {e}");
                None
            }
        };
        Self {
            inner,
            acc: Vec::new(),
            ratio,
            passthrough: false,
        }
    }

    /// Feed mono f32 samples; returns any 24 kHz PCM16 produced so far.
    pub fn push(&mut self, input: &[f32]) -> Vec<i16> {
        if self.passthrough {
            return input.iter().map(|&s| to_i16(s)).collect();
        }
        let Some(resampler) = self.inner.as_mut() else {
            return Vec::new();
        };
        self.acc.extend_from_slice(input);
        let mut out = Vec::new();
        while self.acc.len() >= CHUNK {
            let block: Vec<f32> = self.acc.drain(..CHUNK).collect();
            match resampler.process(&[block], None) {
                Ok(res) => out.extend(res[0].iter().map(|&s| to_i16(s))),
                Err(e) => {
                    log::error!("stream resample failed: {e}");
                    break;
                }
            }
        }
        out
    }

    /// Flush the trailing partial block (zero-padded) at end of stream so the
    /// final fraction of a second isn't dropped.
    pub fn finish(&mut self) -> Vec<i16> {
        if self.passthrough || self.acc.is_empty() {
            return Vec::new();
        }
        let Some(resampler) = self.inner.as_mut() else {
            return Vec::new();
        };
        let remaining = self.acc.len();
        let mut last = std::mem::take(&mut self.acc);
        last.resize(CHUNK, 0.0);
        match resampler.process(&[last], None) {
            Ok(res) => {
                let keep = (remaining as f64 * self.ratio).round() as usize;
                res[0].iter().take(keep).map(|&s| to_i16(s)).collect()
            }
            Err(_) => Vec::new(),
        }
    }
}

/// Dependency-free fallback used only if rubato init fails.
fn linear_resample(input: &[f32], ratio: f64) -> Vec<i16> {
    let out_len = (input.len() as f64 * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let a = input.get(i0).copied().unwrap_or(0.0);
        let b = input.get(i0 + 1).copied().unwrap_or(a);
        out.push(to_i16(a + (b - a) * frac));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_at_target_rate() {
        let input = vec![0.0, 0.5, -0.5, 1.0];
        let out = resample_to_pcm16_24k(&input, TARGET_RATE);
        assert_eq!(out.len(), 4);
        assert_eq!(out[3], 32767);
    }

    #[test]
    fn halves_length_from_48k() {
        // 48k -> 24k should produce ~half the samples.
        let input: Vec<f32> = (0..4800).map(|i| (i as f32 * 0.01).sin()).collect();
        let out = resample_to_pcm16_24k(&input, 48000);
        let expected = 2400;
        let diff = (out.len() as i64 - expected as i64).abs();
        assert!(diff < 200, "got {} expected ~{}", out.len(), expected);
    }

    #[test]
    fn stream_resampler_passthrough_at_target() {
        let mut rs = StreamResampler::new(TARGET_RATE);
        let out = rs.push(&[0.0, 1.0, -1.0]);
        assert_eq!(out.len(), 3);
        assert_eq!(out[1], 32767);
        assert!(rs.finish().is_empty());
    }

    #[test]
    fn stream_resampler_length_matches_oneshot() {
        // Feeding arbitrary-sized blocks through the streaming resampler should
        // produce ~the same number of 24 kHz samples as the one-shot path.
        let input: Vec<f32> = (0..9600).map(|i| (i as f32 * 0.02).sin()).collect();
        let oneshot = resample_to_pcm16_24k(&input, 48000);
        let mut rs = StreamResampler::new(48000);
        let mut streamed = Vec::new();
        for block in input.chunks(512) {
            streamed.extend(rs.push(block));
        }
        streamed.extend(rs.finish());
        let diff = (streamed.len() as i64 - oneshot.len() as i64).abs();
        assert!(
            diff < 300,
            "streamed {} vs oneshot {}",
            streamed.len(),
            oneshot.len()
        );
    }

    #[test]
    fn handles_fractional_rate() {
        let input: Vec<f32> = (0..4410).map(|i| (i as f32 * 0.02).sin()).collect();
        let out = resample_to_pcm16_24k(&input, 44100);
        let expected = 2400;
        let diff = (out.len() as i64 - expected as i64).abs();
        assert!(diff < 200, "got {} expected ~{}", out.len(), expected);
    }
}
