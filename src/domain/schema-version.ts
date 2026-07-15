export const CURRENT_SCHEMA_VERSION = 1 as const;

export type SupportedSchemaVersion = typeof CURRENT_SCHEMA_VERSION;

export function requireSupportedSchemaVersion(value: unknown): SupportedSchemaVersion {
  if (value !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${String(value)}`);
  }

  return CURRENT_SCHEMA_VERSION;
}
