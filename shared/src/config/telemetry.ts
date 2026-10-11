import type { LoadedConfig } from "./config";

const OPT_OUT_ENV_VARS = ["DO_NOT_TRACK", "TERMINAL_BROWSER_NO_TELEMETRY"];

export type TelemetryKind = "telemetry.usage" | "telemetry.crashReports";

export function telemetryOptedOutByEnv(): boolean {
  return OPT_OUT_ENV_VARS.some((name) => {
    const value = process.env[name]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
  });
}

export function telemetryAllowed(loaded: LoadedConfig, kind: TelemetryKind): boolean {
  if (!loaded.settings || loaded.invalidSettings.includes(kind)) return false;
  return loaded.settings[kind] !== "off";
}
