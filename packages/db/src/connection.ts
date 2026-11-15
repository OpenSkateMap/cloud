import type { ClientConfig } from "pg";

// node-postgres reads `sslrootcert` as a file path, so libpq's `sslrootcert=system` means: trust the runtime's CAs.
export function toClientConfig(connectionString: string): ClientConfig {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslrootcert") !== "system") return { connectionString };

  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true } };
}
