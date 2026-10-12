# Investigation: Packaged macOS app opens but renders a blank window

## TL;DR

The packaged app is blank because the React tree throws **React error #300**
("Rendered fewer hooks than expected") during startup, and — with no error
boundary — React unmounts the entire UI, leaving a white window. The root cause
is a **React hooks-order violation** in `src/App.tsx`: a `useMemo` is called
*after* a conditional early `return`.

## Symptom

- `npm run tauri dev` → renders perfectly.
- `npm run tauri build` → the `.app` window opens (correct title/size) but the
  UI never renders; the webview stays blank and the app is unusable.
- Reproduced reliably: launching the `.app` via `open`/double-click is blank
  3/3 times, while running the same binary directly from a terminal renders
  3/3 times.

## Root cause

### 1. A hook is called after a conditional early return (the actual bug)

In `src/App.tsx` the `App` component does this:

```tsx
// src/App.tsx:127
const showOnboarding =
  ready && providersReady && permsReady &&
  (!config.onboardingCompleted || !perms.microphone ||
   !perms.accessibility || !apiKeySet);

// ... several effects ...

// src/App.tsx:241  ← EARLY RETURN
if (showOnboarding) {
  return (
    <div className="app onb-full ...">
      <OnboardingPanel ... />
    </div>
  );
}

function renderPanel() { ... }   // fine: this is a function, not a hook

// src/App.tsx:314  ← HOOK CALLED AFTER THE EARLY RETURN
const frameTr = useMemo(() => (
  <>VX-<Typewriter key={trHexPart} text={trHexPart} run speed={11} /></>
), [trHexPart]);
```

React requires the *same* hooks to be called, in the *same* order, on every
render. Here, `useMemo` (line 314) is only reached when `showOnboarding` is
`false`.

### 2. Why `showOnboarding` flips mid-session (the trigger)

On the very first render `ready`, `providersReady`, and `permsReady` are all
still `false`, so `showOnboarding` is `false` and every hook — including the
`useMemo` — runs. A moment later the async data arrives (`useConfig`, `getPermissions`,
`providerStatus`) and `showOnboarding` is re-evaluated. If any of the four
conditions is unmet, it flips to `true`:

```tsx
!config.onboardingCompleted || !perms.microphone ||
!perms.accessibility || !apiKeySet
```

When it flips to `true`, the component early-returns and skips the `useMemo`.
The hook count changes from render to render, so React throws:

```
Error: Minified React error #300 ... "Rendered fewer hooks than expected.
This may be caused by an accidental early return statement."
```

With no error boundary and no dev overlay, the whole tree unmounts → blank.

### 3. Why dev works but the packaged app does not

The flip is gated on permissions/onboarding state, and that state differs
between the two binaries:

- In **dev**, `target/debug/voxctlcom` is a long-lived identity that has already
  been granted **Microphone** and **Accessibility** in System Settings, and the
  onboarding/key are complete. So `showOnboarding` is `false` and never flips →
  no error.
- The **packaged** `VOXCTL.app` is a *different* binary identity. macOS TCC
  grants (Accessibility in particular) are tied to the code identity, so the
  packaged app reports `perms.accessibility === false` (the README already
  documents this: *"the unsigned dev binary changes path each build, so macOS
  may re-ask for Accessibility after rebuilds"*). That makes `!perms.accessibility`
  true, so `showOnboarding` flips `false → true` on first launch → crash.

This also explains the direct-vs-`open` observation: `open`/double-click launches
through LaunchServices with the app's bundle identity (Accessibility not yet
granted), while a direct terminal launch resolves the process differently, so
the permission probe differs and the flip does not happen.

## Evidence

To capture the actual error (it is invisible in a blank production webview), I
temporarily added a global `error`/`unhandledrejection`/`console.error` handler
to `index.html`, rebuilt, and read the captured text from the webview via the
accessibility API. It produced exactly one error:

```
window.error: Error: Minified React error #300;
  visit https://react.dev/errors/300 ...
  | tauri://localhost/assets/react-LvxH85PJ.js:8
```

Confirmed against the React source (`react-dom-client` 19.2.6):

```js
if (didRenderTooFewHooks) throw Error(formatProdErrorMessage(300));
// 300 → "Rendered fewer hooks than expected. This may be caused by an
//       accidental early return statement."
```

The diagnostic was removed after capture; `git status` is clean. A rebuild of
the production frontend produces byte-identical hashes, so the source under test
matches the shipped bundle.

## Proposed fix

### Primary fix — keep all hooks above any early return

Move the `frameTr` `useMemo` (and, more generally, ensure every hook runs
unconditionally) above the `if (showOnboarding)` block. Concretely, relocate the
block at `src/App.tsx:309–322` so it sits before `src/App.tsx:241`:

```tsx
const baseLabel = MENU.find((m) => m.id === view)?.label ?? "";
const sectionActive = headerSection;
const descText = flashDesc ?? (sectionActive?.desc ? sectionActive.desc : (DESC[view] ?? ""));
const frameCls = "content-frame " + (phase === "closing" ? "closing" : phase === "opening" ? "opening" : "");
const trHexPart = activeHexId ? `0x${activeHexId}` : "ALL";
const frameTr = useMemo(
  () => (<>VX-<Typewriter key={trHexPart} text={trHexPart} run speed={11} /></>),
  [trHexPart],
);

if (showOnboarding) {
  return (/* ... onboarding ... */);
}
```

This is the correct long-term fix: it makes hook order stable regardless of
onboarding state. (The `useMemo` itself is a minor perf optimization; if
preferred, it can simply be dropped or inlined, but it must never be placed
after a conditional return.)

### Defense-in-depth (recommended)

1. **Wrap the app in a React error boundary** so any future render error shows a
   recoverable message instead of a blank window. This is especially valuable for
   a production/blank webview where the dev overlay is unavailable.
2. **Audit for other conditional hooks.** `src/hud/Hud.tsx` and the panels were
   checked and are clean; `App.tsx` is the only offender found.
3. **Optional robustness for onboarding:** the `perms` initial state
   (`{ microphone: true, accessibility: true }` at `src/App.tsx:71`) assumes
   grants exist. Combined with the TCC caveat for unsigned binaries, a fresh
   install will always flip to onboarding on first launch — which is intended
   behavior, but only safe once the hook-order bug above is fixed.

## Verification

1. Apply the primary fix, then `npm run tauri build`.
2. `open src-tauri/target/release/bundle/macos/VOXCTL.app` and confirm the
   onboarding (or dashboard) renders instead of a blank window.
3. Regress both paths: launch via Finder/`open` (fresh identity, should show
   onboarding if Accessibility isn't granted) and via `npm run tauri dev`
   (should still show the dashboard).

## Files touched / references

- `src/App.tsx:241` — conditional early return (`if (showOnboarding)`).
- `src/App.tsx:314` — `useMemo` hook called after that return (the bug).
- `src/App.tsx:127–131` — `showOnboarding` gate that triggers the flip.
- `src/App.tsx:71` — `perms` initial state (assumes grants exist).
- `src-tauri/src/commands/permissions.rs:18–24` — `get_permissions` TCC checks.
- `README.md:39` — existing note about TCC/Accessibility on unsigned builds.
