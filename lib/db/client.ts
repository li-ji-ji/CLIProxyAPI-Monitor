import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import { drizzle as neonDrizzle } from "drizzle-orm/neon-serverless";
import { Pool as PgPool } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { WebSocket } from "ws";

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

/**
 * 驱动选择策略：
 *   DATABASE_DRIVER=neon  → 强制使用 Neon 无服务器 WebSocket 驱动
 *   DATABASE_DRIVER=pg    → 强制使用标准 pg TCP 驱动（Aiven、Supabase、RDS 等）
 *   未设置               → 自动检测：URL 含 .neon.tech 则选 Neon，否则默认选 pg
 */
const useNeon =
  process.env.DATABASE_DRIVER === "neon" ||
  (process.env.DATABASE_DRIVER !== "pg" &&
    /\.neon\.tech/.test(connectionString));

const PG_SSL_QUERY_KEYS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslpassword",
  "sslaccept",
  "uselibpqcompat"
];

function parseIntEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < min) return fallback;
  return value;
}

const pgPoolConfig = {
  max: parseIntEnv("DATABASE_POOL_MAX", 5, 1),
  idleTimeoutMillis: parseIntEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 10_000, 0),
  connectionTimeoutMillis: parseIntEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000, 0),
  maxUses: parseIntEnv("DATABASE_POOL_MAX_USES", 7_500, 0)
};

function normalizeEnvMultiline(value: string): string {
  let normalized = value.trim();
  if (
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\\n/g, "\n");
}

function stripPgSslParams(urlString: string): string {
  try {
    const url = new URL(urlString);
    for (const key of PG_SSL_QUERY_KEYS) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return urlString;
  }
}

/**
 * SSL 配置（仅对 pg 驱动生效）：
 *   DATABASE_CA  → CA 证书 PEM 内容（原始 PEM 或 Base64 编码均可）
 *                  例：Aiven sslmode=verify-full 时需要
 */
function getSSLOptions(): object | undefined {
  const ca = process.env.DATABASE_CA;
  if (!ca) return undefined;

  const normalized = normalizeEnvMultiline(ca);

  // 支持原始 PEM（含真实换行或 \n）
  if (normalized.includes("-----BEGIN CERTIFICATE-----")) {
    return { ca: normalized, rejectUnauthorized: true };
  }

  // 支持 Base64 编码 PEM
  const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
  const pem = normalizeEnvMultiline(decoded);
  return { ca: pem, rejectUnauthorized: true };
}

function createDb(): any {
  if (useNeon) {
    neonConfig.webSocketConstructor = WebSocket;
    return neonDrizzle(new NeonPool({ connectionString }));
  }
  const sslOptions = getSSLOptions();
  const pgConnectionString = sslOptions
    ? stripPgSslParams(connectionString)
    : connectionString;

  return pgDrizzle(
    new PgPool({
      connectionString: pgConnectionString,
      ssl: sslOptions,
      ...pgPoolConfig
    })
  );
}

export const db: any = createDb();

