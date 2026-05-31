//! Tauri command modules. Organized by domain so each slice owns its surface.
//! Many commands are thin stubs in early slices and grow real bodies later.

pub mod audio;
pub mod config;
pub mod history;
pub mod inject;
pub mod modes;
pub mod permissions;
pub mod transcription;
