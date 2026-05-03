import { NextResponse } from "next/server";
import * as nextHeaders from "next/headers";
import * as DrizzleOrm from "drizzle-orm";
import { config, assertEnv } from "@/lib/config";
import { db } from "@/lib/db/client";
import { authFileMappings, usageRecords } from "@/lib/db/schema";
import { toAuthFileMappings } from "@/lib/auth-files";
import { parseUsagePayload, toUsageRecords } from "@/lib/usage";

const { eq, sql } = DrizzleOrm as any;

export const runtime = "nodejs";

const PASSWORD = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const COOKIE_NAME = "dashboard_auth";
const AUTH_FILES_TIMEOUT_MS = 15_000;

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) return fallback;
  return value;
}

// 可通过 NEXT_PUBLIC_SYNC_TIMEOUT_MS 环境变量调节（毫秒），默认 120 秒
const USAGE_TIMEOUT_MS = toPositiveInt(process.env.NEXT_PUBLIC_SYNC_TIMEOUT_MS, 120_000);
const AUTH_FILES_INSERT_CHUNK_SIZE = toPositiveInt(process.env.AUTH_FILES_INSERT_CHUNK_SIZE, 500);
const USAGE_INSERT_CHUNK_SIZE = toPositiveInt(process.env.USAGE_INSERT_CHUNK_SIZE, 1000);

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function missingPassword() {
  return NextResponse.json({ error: "PASSWORD is missing" }, { status: 501 });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function hashPassword(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthorized(request: Request) {
  // 检查 Bearer token（用于 cron job 等外部调用）
  const allowed = [config.password, config.cronSecret].filter(Boolean).map((v) => `Bearer ${v}`);
  if (allowed.length > 0) {
    const auth = request.headers.get("authorization") || "";
    if (allowed.includes(auth)) return true;
  }
  
  // 检查用户的 dashboard cookie（用于前端调用）
  if (PASSWORD) {
    const cookieStore = await (nextHeaders as any).cookies();
    const authCookie = cookieStore.get(COOKIE_NAME);
    if (authCookie) {
      const expectedToken = await hashPassword(PASSWORD);
      if (authCookie.value === expectedToken) return true;
    }
  }
  
  return false;
}

async function syncAuthFileMappings(pulledAt: Date) {
  const authFilesUrl = `${config.cliproxy.baseUrl.replace(/\/$/, "")}/auth-files`;

  const response = await fetchWithTimeout(authFilesUrl, {
    headers: {
      Authorization: `Bearer ${config.cliproxy.apiKey}`,
      "Content-Type": "application/json"
    },
    cache: "no-store"
  }, AUTH_FILES_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Failed to fetch auth-files: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const rows = toAuthFileMappings(json, pulledAt);
  if (rows.length === 0) return 0;

  for (const chunk of chunkArray(rows, AUTH_FILES_INSERT_CHUNK_SIZE)) {
    await db
      .insert(authFileMappings)
      .values(chunk)
      .onConflictDoUpdate({
        target: authFileMappings.authId,
        set: {
          name: sql`coalesce(nullif(excluded.name, ''), ${authFileMappings.name})`,
          label: sql`coalesce(nullif(excluded.label, ''), ${authFileMappings.label})`,
          provider: sql`coalesce(nullif(excluded.provider, ''), ${authFileMappings.provider})`,
          source: sql`coalesce(nullif(excluded.source, ''), ${authFileMappings.source})`,
          email: sql`coalesce(nullif(excluded.email, ''), ${authFileMappings.email})`,
          updatedAt: sql`coalesce(excluded.updated_at, ${authFileMappings.updatedAt})`,
          syncedAt: pulledAt
        }
      });
  }

  return rows.length;
}

async function performSync(request: Request) {
  if (!config.password && !config.cronSecret && !PASSWORD) return missingPassword();
  if (!(await isAuthorized(request))) return unauthorized();

  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  const usageUrl = `${config.cliproxy.usageBaseUrl.replace(/\/$/, "")}/usage`;
  const pulledAt = new Date();

  let response: Response;
  try {
    response = await fetchWithTimeout(usageUrl, {
      headers: {
        Authorization: `Bearer ${config.cliproxy.apiKey}`,
        "Content-Type": "application/json"
      },
      cache: "no-store"
    }, USAGE_TIMEOUT_MS);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    console.warn("[sync] usage fetch failed", {
      reason: isTimeout ? "timeout" : "error",
      isTimeout,
      message: error instanceof Error ? error.message : String(error)
    });
    return NextResponse.json(
      {
        error: isTimeout ? "Upstream usage request timed out" : "Failed to fetch usage"
      },
      { status: isTimeout ? 504 : 502 }
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: "Failed to fetch usage", statusText: response.statusText },
      { status: response.status }
    );
  }

  let payload;
  try {
    const json = await response.json();
    payload = parseUsagePayload(json);
  } catch (parseError) {
    console.error("/api/sync parse upstream usage failed:", parseError);
    return NextResponse.json(
      { error: "Bad Gateway" },
      { status: 502 }
    );
  }

  const rows = toUsageRecords(payload, pulledAt);

  let authFilesSynced = 0;
  let authFilesWarning: string | undefined;
  try {
    authFilesSynced = await syncAuthFileMappings(pulledAt);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    authFilesWarning = isTimeout ? "auth-files sync timed out" : "auth-files sync failed";
    console.warn("/api/sync auth-files sync failed:", error);
  }

  if (rows.length === 0) {
    return NextResponse.json({
      status: "ok",
      inserted: 0,
      message: "No usage data",
      authFilesSynced,
      ...(authFilesWarning ? { authFilesWarning } : {})
    });
  }

  let inserted = 0;
  try {
    for (const chunk of chunkArray(rows, USAGE_INSERT_CHUNK_SIZE)) {
      const insertedRows = await db
        .insert(usageRecords)
        .values(chunk)
        .onConflictDoNothing({ target: [usageRecords.occurredAt, usageRecords.route, usageRecords.model, usageRecords.source] })
        .returning({ id: usageRecords.id });
      inserted += insertedRows.length;
    }
  } catch (dbError) {
    console.error("/api/sync database insert failed:", dbError);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }

  // Vercel Postgres may return an empty array even when rows are inserted with RETURNING + ON CONFLICT DO NOTHING.
  // Fall back to counting rows synced in this run (identified by the shared pulledAt timestamp) to avoid reporting 0.
  if (inserted === 0 && rows.length > 0) {
    const fallback = await db
      .select({ count: sql<number>`count(*)` })
      .from(usageRecords)
      .where(eq(usageRecords.syncedAt, pulledAt));
    inserted = Number(fallback?.[0]?.count ?? 0);
  }

  return NextResponse.json({
    status: "ok",
    inserted,
    attempted: rows.length,
    authFilesSynced,
    ...(authFilesWarning ? { authFilesWarning } : {})
  });
}

export async function POST(request: Request) {
  return performSync(request);
}

export async function GET(request: Request) {
  return performSync(request);
}
