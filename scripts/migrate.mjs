#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/vercel-postgres";
import { createClient } from "@vercel/postgres";
import { migrate } from "drizzle-orm/vercel-postgres/migrator";

const client = createClient({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
});

const db = drizzle(client);

function getMigrationMeta(migrationsFolder) {
  const journalPath = `${migrationsFolder}/meta/_journal.json`;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));

  return journal.entries.map((entry) => {
    const sql = readFileSync(`${migrationsFolder}/${entry.tag}.sql`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");

    return {
      tag: entry.tag,
      hash,
      createdAt: entry.when
    };
  });
}

async function runMigrations() {
  try {
    await client.connect();
    console.log("检查迁移表...");
    
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query(
      "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT)"
    );

    // 获取本地所有迁移元数据
    const allMigrations = getMigrationMeta("./drizzle");
    
    // 检查数据库中已有的迁移记录
    const existingMigrations = await client.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations"
    );
    const existingHashes = new Set(existingMigrations.rows.map((r) => r.hash));

    // 检查 model_prices 表是否存在
    const tableExists = await client.query(
      "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'model_prices' AND c.relkind IN ('r','p') LIMIT 1"
    );

    // 如果表已存在，需要确保对应的迁移已标记
    if (tableExists.rows.length > 0) {
      // 找出 0000 迁移
      const initialMigration = allMigrations.find((m) => m.tag.startsWith("0000_"));
      
      if (initialMigration && !existingHashes.has(initialMigration.hash)) {
        console.log("检测到表已存在但迁移未标记，正在标记...");
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [initialMigration.hash, initialMigration.createdAt]
        );
        console.log("✓ 已标记 0000 迁移");
      }
    }

    console.log("执行数据库迁移...");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✓ 迁移完成");
    
    await client.end();
    process.exit(0);
  } catch (error) {
    console.error("迁移失败:", error);
    // 不阻止构建继续
    process.exit(0);
  }
}

runMigrations();
