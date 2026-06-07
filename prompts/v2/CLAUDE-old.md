# CLAUDE.md — VOXCTL Development Brief

This file defines the environment, scripts, and conventions for VOXCTL (React + Tauri v2 + Rust).

## Development & Build Commands

- **Frontend Dev Server**: `npm run dev` (Runs Vite dev server on port 5173)
- **Tauri Dev Loop**: `npm run tauri dev` (Spawns Rust backend & desktop window)
- **Production Build**: `npm run tauri build` (Compiles optimized desktop binaries)
- **Linter / Formatter**: 
  - JS/TS: `npx biome check --write .` (or standard `eslint`/`prettier` if configured)
  - Rust: `cargo clippy && cargo fmt`
- **Testing**:
  - Rust: `cargo test`

## Project Technology Stack

- **Frontend**: React (TypeScript), Vite, custom monospace CSS theme
- **Backend**: Rust (Tauri v2 core, native microphone capture via `cpal`)
- **Inter-Process Communication (IPC)**: Tauri commands (`#[tauri::command]`) and event emitters

## Tauri v2 Security & Capabilities Rules

- **Permissions Management**: Tauri v2 isolates frontend access to backend features using JSON capabilities.
- **Capabilties Location**: `src-tauri/capabilities/default.json`
- **Action Required**: Whenever a new Tauri plugin (e.g., `fs`, `shell`, `dialog`) is added, you **must** update the permissions array inside the capabilities JSON before attempting to use the JavaScript API.
- **Example Permission Entry**: `"permissions": ["core:path:default", "core:event:default", "core:window:default", "fs:allow-write"]`

## Coding Conventions & Architecture

- **State Management**: Keep highly transient, fast-updating states (like DB levels, clocks, and typewriter effects) confined to local, self-contained leaf components. Do not elevate them to the main `App` layout to prevent whole-app re-renders.
- **Process Separation**: Do not process raw microphone audio byte-by-byte in the JavaScript webview thread. Heavy audio processing, DSP (Digital Signal Processing), and recording capture must occur in Rust native threads, with decimated audio data or levels piped to the frontend via high-frequency Tauri events (`emit`).
- **Data Persistence**: Avoid relying on volatile webview `localStorage` for production settings. Use the native `@tauri-apps/plugin-store` to keep key-value configurations persistent and robust.
- **Rust Tauri v2 Structure**: Keep logic separated between `main.rs` (minimal entry point) and `lib.rs` (tauri app builder and commands) to support modular testing.