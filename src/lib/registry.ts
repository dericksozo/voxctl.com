// Provider/model registry — mirrored from the Rust side (serde camelCase) and
// read through the backend (`getRegistry`) so the webview never bundles its own
// copy. See src-tauri/registry.json and src-tauri/src/registry.rs.

export type ProviderId = "openai" | "xai" | "gemini";
export type CostUnit = "perMin" | "perHour" | "perToken";
/** Per-provider key status. Invalid keys are rejected at entry, never stored. */
export type KeyStatus = "none" | "validated";

export interface Capabilities {
  wordTimestamps?: boolean;
  diarization?: boolean;
  inverseTextNormalization?: boolean;
  multichannel?: boolean;
}

export interface ProviderRecord {
  id: string;
  label: string;
  keychainAccount: string;
  docsUrl: string;
  defaultModelId: string;
}

export interface ModelRecord {
  id: string;
  provider: string;
  label: string;
  /** Can transcribe a live audio stream (dictation). */
  canLive: boolean;
  /** Can transcribe a saved audio file (re-run / transcribe-on-stop). */
  canFile: boolean;
  costRate: number;
  costUnit: CostUnit;
  /** Honors a language hint (hide the Language control when false). */
  supportsLanguage: boolean;
  /** Honors keyword/vocabulary steering (hide the Keywords field when false). */
  supportsKeywords: boolean;
  /** Teaching metadata for the model picker. */
  accuracy: string;
  speed: string;
  description: string;
  useCase: string;
  capabilities: Capabilities;
  languages?: string[];
}

export interface Registry {
  version: number;
  providers: ProviderRecord[];
  models: ModelRecord[];
}

export interface ProviderStatus {
  openai: KeyStatus;
  xai: KeyStatus;
  gemini: KeyStatus;
}

export const EMPTY_PROVIDER_STATUS: ProviderStatus = {
  openai: "none",
  xai: "none",
  gemini: "none",
};

export const PROVIDER_IDS: ProviderId[] = ["openai", "xai", "gemini"];

export function providerValidated(status: ProviderStatus, id: string): boolean {
  return status[id as ProviderId] === "validated";
}

/** True when at least one provider has a validated key (drives the KEY status). */
export function anyKeyValidated(status: ProviderStatus): boolean {
  return PROVIDER_IDS.some((id) => status[id] === "validated");
}

export function modelsForProvider(reg: Registry, provider: string): ModelRecord[] {
  return reg.models.filter((m) => m.provider === provider);
}

export function modelById(reg: Registry | null, id: string): ModelRecord | undefined {
  return reg?.models.find((m) => m.id === id);
}

/** LIVE / FILE / LIVE · FILE badge text for a model row. */
export function modelBadge(m: ModelRecord): string {
  if (m.canLive && m.canFile) return "LIVE · FILE";
  if (m.canLive) return "LIVE";
  return "FILE";
}

const UNIT_SUFFIX: Record<CostUnit, string> = {
  perMin: "/MIN",
  perHour: "/HR",
  perToken: "/TOK",
};

/** Human cost label, e.g. "~$0.006/MIN". */
export function costLabel(m: ModelRecord): string {
  return `~$${m.costRate}${UNIT_SUFFIX[m.costUnit]}`;
}
