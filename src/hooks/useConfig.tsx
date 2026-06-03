// App-wide settings, persisted with tauri-plugin-store (settings.json). The
// same store file is read by Rust (single source of truth for non-secret
// config). Secrets (the OpenAI key) are NOT stored here — see ipc.setApiKey.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { DEFAULT_CONFIG, type Config } from "../lib/types";
import { setLocale } from "../i18n";
import { reloadConfig } from "../lib/ipc";

const STORE_FILE = "settings.json";
const KEY = "config";

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
        const saved = (await store.get<Partial<Config>>(KEY)) ?? {};
        if (!alive) return;
        const merged = { ...DEFAULT_CONFIG, ...saved };
        setConfig(merged);
        setLocale(merged.appLocale);
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
