import { NextResponse } from "next/server";
import * as nextHeaders from "next/headers";
import * as DrizzleOrm from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { modelPrices, usageRecords } from "@/lib/db/schema";

const { inArray, desc } = DrizzleOrm as any;

export const runtime = "nodejs";

const PASSWORD = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const COOKIE_NAME = "dashboard_auth";
const SYNC_LOCK_TTL_MS = 1 * 60 * 1000;

let syncInFlight = false;
let syncStartedAt = 0;
let modelsDevETag: string | null = null;
let modelsDevLastModified: string | null = null;
let modelsDevHash: string | null = null;
let modelsDevCache: ModelsDevResponse | null = null;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

async function hashString(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 统一价格精度到数据库列精度（numeric(10,4)），避免科学计数法/格式差异导致“假更新”
function normalizePriceForDb(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(num)) return "0.0000";
  const nonNegative = Math.max(0, num);
  return nonNegative.toFixed(4);
}

type ModelsDevModel = {
  id: string;
  cost?: { input?: number; output?: number; cache_read?: number };
};

type ModelsDevProvider = {
  models: Record<string, ModelsDevModel>;
};

type ModelsDevResponse = Record<string, ModelsDevProvider>;
type PriceInfo = { input: number; output: number; cached: number };
type PriceModeCandidate = { count: number; firstSeenOrder: number; price: PriceInfo };

export async function POST(request: Request) {
  try {
    // 🔒 鉴权检查
    if (!(await isAuthorized(request))) {
      return unauthorized();
    }

    // 并发锁：避免重复同步
    const now = Date.now();
    if (syncInFlight && now - syncStartedAt < SYNC_LOCK_TTL_MS) {
      return NextResponse.json({ error: "同步正在进行中，请稍后再试" }, { status: 429 });
    }
    syncInFlight = true;
    syncStartedAt = now;

    if (!config.cliproxy.baseUrl) {
      return NextResponse.json({ error: "服务端未配置 CLIPROXY_API_BASE_URL" }, { status: 500 });
    }

    if (!config.postgresUrl) {
      return NextResponse.json({ error: "服务端未配置 DATABASE_URL" }, { status: 500 });
    }

    // 从数据库获取最新的 route 值作为 API Key
    const latestRecord = await db
      .select({ route: usageRecords.route })
      .from(usageRecords)
      .orderBy(desc(usageRecords.id))
      .limit(1);
    
    if (!latestRecord.length || !latestRecord[0].route) {
      return NextResponse.json({ error: "数据库中没有可用的 API Key 记录" }, { status: 500 });
    }
    
    const apiKey = latestRecord[0].route;

    // 1. 从 models.dev 获取价格数据
    const modelsDevHeaders: Record<string, string> = { "Accept": "application/json" };
    if (modelsDevETag) modelsDevHeaders["If-None-Match"] = modelsDevETag;
    if (modelsDevLastModified) modelsDevHeaders["If-Modified-Since"] = modelsDevLastModified;

    const modelsDevRes = await fetch("https://models.dev/api.json", {
      headers: modelsDevHeaders,
      cache: "no-store"
    });

    // 处理 304 Not Modified 响应
    if (modelsDevRes.status === 304) {
      if (!modelsDevCache) {
        return NextResponse.json({ error: "models.dev 返回未修改且无本地缓存" }, { status: 502 });
      }
      // 304 且有缓存，继续使用缓存数据
    } else if (!modelsDevRes.ok) {
      // 其他非 2xx 状态视为错误
      return NextResponse.json({ error: `无法获取 models.dev 数据: ${modelsDevRes.status}` }, { status: 502 });
    }

    const modelsDevData: ModelsDevResponse = modelsDevRes.status === 304
      ? modelsDevCache as ModelsDevResponse
      : await modelsDevRes.json();
    const etag = modelsDevRes.headers.get("etag");
    const lastModified = modelsDevRes.headers.get("last-modified");
    if (etag) modelsDevETag = etag;
    if (lastModified) modelsDevLastModified = lastModified;

    const currentHash = await hashString(JSON.stringify(modelsDevData));
    if (!modelsDevHash || modelsDevHash !== currentHash) {
      modelsDevHash = currentHash;
      modelsDevCache = modelsDevData;
    }

    // 2. 构建模型ID到价格的映射（同名用“众数”策略；并列众数取首次出现）
    const priceModeBuckets = new Map<string, Map<string, PriceModeCandidate>>();
    let seenOrder = 0;

    for (const provider of Object.values(modelsDevData)) {
      if (!provider.models) continue;
      for (const model of Object.values(provider.models)) {
        // 允许免费模型入库
        if (model.cost && (model.cost.input !== undefined || model.cost.output !== undefined)) {
          const priceInfo: PriceInfo = {
            input: model.cost.input ?? 0,
            output: model.cost.output ?? 0,
            cached: model.cost.cache_read ?? 0
          };

          // 以数据库精度归一后作为“价格组合”签名，避免格式差异影响众数统计
          const signature = [
            normalizePriceForDb(priceInfo.input),
            normalizePriceForDb(priceInfo.cached),
            normalizePriceForDb(priceInfo.output)
          ].join("|");

          const modelBucket = priceModeBuckets.get(model.id) ?? new Map<string, PriceModeCandidate>();
          const existingCandidate = modelBucket.get(signature);

          if (existingCandidate) {
            existingCandidate.count += 1;
          } else {
            modelBucket.set(signature, {
              count: 1,
              firstSeenOrder: seenOrder,
              price: priceInfo
            });
          }

          priceModeBuckets.set(model.id, modelBucket);
          seenOrder += 1;
        }
      }
    }

    const priceMap = new Map<string, PriceInfo>();
    for (const [modelId, candidates] of priceModeBuckets.entries()) {
      let selected: PriceModeCandidate | null = null;

      for (const candidate of candidates.values()) {
        if (!selected) {
          selected = candidate;
          continue;
        }

        if (
          candidate.count > selected.count ||
          (candidate.count === selected.count && candidate.firstSeenOrder < selected.firstSeenOrder)
        ) {
          selected = candidate;
        }
      }

      if (selected) {
        priceMap.set(modelId, selected.price);
      }
    }

    // 3. 从 CLIProxyAPI 获取当前模型列表
    // 使用 OpenAI 兼容的 /v1/models 端点而非管理 API
    const baseUrlWithoutManagement = config.cliproxy.baseUrl.replace(/\/v0\/management\/?$/, "");
    const modelsUrl = `${baseUrlWithoutManagement}/v1/models`;
    const cliproxyRes = await fetch(modelsUrl, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      cache: "no-store"
    });

    if (!cliproxyRes.ok) {
      return NextResponse.json({ error: `无法获取模型列表: ${cliproxyRes.status}` }, { status: 502 });
    }

    const cliproxyData = await cliproxyRes.json();
    const models: { id: string }[] = cliproxyData.data || [];

    // 4. 匹配并收集要更新的价格
    let skippedCount = 0;
    let failedCount = 0;
    const details: { model: string; status: string; matchedWith?: string; reason?: string }[] = [];
    const priceUpdates: { model: string; priceInfo: PriceInfo; matchedKey: string }[] = [];

    for (const { id: modelId } of models) {
      let priceInfo = priceMap.get(modelId);
      let matchedKey = modelId;

      // 去掉最后一个 - 后的内容，进行最长匹配
      if (!priceInfo) {
        const lastDashIndex = modelId.lastIndexOf("-");
        if (lastDashIndex > 0) {
          const baseNameWithoutSuffix = modelId.substring(0, lastDashIndex);
          let bestMatch: { key: string; value: PriceInfo; matchLength: number } | null = null;
          
          for (const [key, value] of priceMap.entries()) {
            if (key.startsWith(baseNameWithoutSuffix) || baseNameWithoutSuffix.startsWith(key)) {
              const matchLength = Math.min(key.length, baseNameWithoutSuffix.length);
              if (!bestMatch || matchLength > bestMatch.matchLength) {
                bestMatch = { key, value, matchLength };
              }
            }
          }
          
          if (bestMatch) {
            priceInfo = bestMatch.value;
            matchedKey = bestMatch.key;
          }
        }
      }

      // 尝试去掉前缀匹配
      if (!priceInfo) {
        const simpleName = modelId.split("/").pop() || modelId;
        priceInfo = priceMap.get(simpleName);
        if (priceInfo) matchedKey = simpleName;
      }

      // 模糊匹配
      if (!priceInfo) {
        const baseModelName = modelId.replace(/-\d{4,}.*$/, "").replace(/@.*$/, "");
        let bestMatch: { key: string; value: PriceInfo; matchLength: number } | null = null;
        
        for (const [key, value] of priceMap.entries()) {
          if (key.includes(baseModelName)) {
            const matchLength = baseModelName.length;
            if (!bestMatch || matchLength > bestMatch.matchLength) {
              bestMatch = { key, value, matchLength };
            }
          } else if (baseModelName.includes(key)) {
            const matchLength = key.length;
            if (!bestMatch || matchLength > bestMatch.matchLength) {
              bestMatch = { key, value, matchLength };
            }
          }
        }
        
        if (bestMatch) {
          priceInfo = bestMatch.value;
          matchedKey = bestMatch.key;
        }
      }

      if (!priceInfo) {
        skippedCount++;
        details.push({ model: modelId, status: "skipped", reason: "未找到价格信息" });
        continue;
      }

      priceUpdates.push({ model: modelId, priceInfo, matchedKey });
      details.push({ model: modelId, status: "pending", matchedWith: matchedKey });
    }

    // 5. 差异化更新（仅更新变化的价格）
    const modelIds = priceUpdates.map((u) => u.model);
    const existingRows: Array<{
      model: string;
      input: unknown;
      cached: unknown;
      output: unknown;
    }> = modelIds.length
      ? await db
          .select({
            model: modelPrices.model,
            input: modelPrices.inputPricePer1M,
            cached: modelPrices.cachedInputPricePer1M,
            output: modelPrices.outputPricePer1M
          })
          .from(modelPrices)
          .where(inArray(modelPrices.model, modelIds))
      : [];

    const existingMap = new Map(
      existingRows.map((row) => [
        row.model,
        {
          input: normalizePriceForDb(row.input),
          cached: normalizePriceForDb(row.cached),
          output: normalizePriceForDb(row.output)
        }
      ])
    );

    // 6. 批量更新数据库（仅更新变化项）
    let updatedCount = 0;
    for (const { model: modelId, priceInfo } of priceUpdates) {
      const nextInput = normalizePriceForDb(priceInfo.input);
      const nextCached = normalizePriceForDb(priceInfo.cached);
      const nextOutput = normalizePriceForDb(priceInfo.output);
      const existing = existingMap.get(modelId);

      if (existing && existing.input === nextInput && existing.cached === nextCached && existing.output === nextOutput) {
        skippedCount++;
        const detailIndex = details.findIndex((d) => d.model === modelId);
        if (detailIndex !== -1) {
          const prev = details[detailIndex];
          details[detailIndex] = { model: modelId, status: "skipped", reason: "价格未变化", matchedWith: prev.matchedWith };
        }
        continue;
      }

      try {
        await db.insert(modelPrices).values({
          model: modelId,
          inputPricePer1M: nextInput,
          cachedInputPricePer1M: nextCached,
          outputPricePer1M: nextOutput
        }).onConflictDoUpdate({
          target: modelPrices.model,
          set: {
            inputPricePer1M: nextInput,
            cachedInputPricePer1M: nextCached,
            outputPricePer1M: nextOutput
          }
        });
        updatedCount++;
        const detailIndex = details.findIndex((d) => d.model === modelId);
        if (detailIndex !== -1) {
          const prev = details[detailIndex];
          details[detailIndex] = { model: modelId, status: "updated", matchedWith: prev.matchedWith };
        }
      } catch (err) {
        failedCount++;
        const detailIndex = details.findIndex((d) => d.model === modelId);
        if (detailIndex !== -1) {
          const prev = details[detailIndex];
          details[detailIndex] = {
            model: modelId,
            status: "failed",
            reason: err instanceof Error ? err.message : "数据库写入失败",
            matchedWith: prev.matchedWith
          };
        }
      }
    }

    return NextResponse.json({
      success: true,
      summary: { total: models.length, updated: updatedCount, skipped: skippedCount, failed: failedCount },
      details
    });

  } catch (error) {
    console.error("/api/sync-model-prices POST failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "内部服务器错误" }, { status: 500 });
  } finally {
    syncInFlight = false;
  }
}
