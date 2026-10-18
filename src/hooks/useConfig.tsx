// App-wide settings, persisted with tauri-plugin-store (settings.json). The
// same store file is read by Rust (single source of truth for non-secret
// config). Secrets (the OpenAI key) are NOT stored here — see ipc.setApiKey.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { DEFAULT_CONFIG, type Config, type DeliveryMode } from "../lib/types";
import { setLocale } from "../i18n";
import { reloadConfig } from "../lib/ipc";

const STORE_FILE = "settings.json";
const KEY = "config";

/** Stored shape before the delivery mode replaced the copy-to-clipboard flag. */
type StoredConfig = Partial<Config> & { copyToClipboard?: boolean };

function isDeliveryMode(v: unknown): v is DeliveryMode {
  return v === "review" || v === "paste" || v === "clipboard";
}

interface ConfigCtx {
  config: Config;
  ready: boolean;
  set: <K extends keyof Config>(key: K, value: Config[K], options?: { reloadShortcut?: boolean }) => void;
}

const Ctx = createContext<ConfigCtx | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [ready, setReady] = useState(false);
  const storeRef = useRef<Store | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const store = await load(STORE_FILE, { autoSave: true, defaults: {} });
        storeRef.current = store;
        const saved = (await store.get<StoredConfig>(KEY)) ?? {};
        if (!alive) return;
        // Legacy migration, mirroring Rust's `normalize_config`:
        // copyToClipboard:true kept the old paste-and-copy behavior; anything
        // else becomes the new default review card.
        const {
          copyToClipboard: legacyCopy,
          deliveryMode: storedMode,
          ...rest
        } = saved;
        const merged: Config = {
          ...DEFAULT_CONFIG,
          ...rest,
          deliveryMode: isDeliveryMode(storedMode)
            ? storedMode
            : legacyCopy === true
              ? "paste"
              : DEFAULT_CONFIG.deliveryMode,
          alsoCopy: rest.alsoCopy ?? legacyCopy === true,
        };
        setConfig(merged);
        setLocale(merged.appLocale);
        // Write the normalized shape once so the legacy key disappears and
        // Rust sees the same mode on its next read.
        const needsMigration =
          legacyCopy !== undefined ||
          (storedMode !== undefined && !isDeliveryMode(storedMode));
        if (needsMigration) {
          store
            .set(KEY, merged)
            .then(() => store.save())
            .catch((e) => console.error("config migration failed", e));
        }
      } catch (e) {
        console.error("config load failed", e);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function set<K extends keyof Config>(key: K, value: Config[K], options?: { reloadShortcut?: boolean }) {
    setConfig((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "appLocale") setLocale(value as string);
      const store = storeRef.current;
      if (store) {
        store
          .set(KEY, next)
          .then(() => store.save())
          .then(() => {
            if (options?.reloadShortcut) return reloadConfig().catch(() => {});
          })
          .catch((e) => console.error("config save failed", e));
      }
      return next;
    });
  }

  return <Ctx.Provider value={{ config, ready, set }}>{children}</Ctx.Provider>;
}

export function useConfig(): ConfigCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfig must be used within ConfigProvider");
  return ctx;
}
