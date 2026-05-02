> [!CAUTION]
> #### 注：CPA 上游已于 [v6.10.0](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v6.10.0) 正式去除 `/usage` 接口，若继续使用本项目追踪使用数据，请一并配置 [adapter.js](#cpa-近端适配器adapterjs) 。
> 或者回退 v6.9.49 或更早版本。


# CLIProxyAPI 数据看板

基于 Next.js App Router + Drizzle + Postgres 的数据看板，用于自动拉取上游 CLIProxyAPI 使用数据，**持久化到数据库**，并进行数据可视化。

## 功能
- `/api/sync` 拉取上游用量数据并去重入库（支持 GET/POST，有鉴权）
- 前端表单可配置模型单价，亦支持从 models.dev 自动拉取价格信息（ [#17 @ZIC143](https://github.com/sxjeru/CLIProxyAPI-Monitor/pull/17) ）
- 前端图表：日粒度折线图、小时粒度柱状图、模型费用列表等，支持时间范围、模型、Key、凭证筛选
- 访问密码保护

## 部署到 Vercel
1. Fork 本仓库，创建 Vercel 项目并关联
2. 在 Vercel 环境变量中填写：

	| 环境变量 | 说明 | 备注 |
	|---|---|---|
	| CLIPROXY_SECRET_KEY | 登录 CLIProxyAPI 后台管理界面的密钥 | 无 |
	| CLIPROXY_API_BASE_URL | 自部署的 CLIProxyAPI 根地址 | 如 `https://your-domain.com/` |
	| USAGE_API_BASE_URL | usage 数据源接口 | 可选；不填时沿用 `CLIPROXY_API_BASE_URL`，接 adapter 时可单独指向 |
	| DATABASE_URL | 数据库连接串（仅支持 Postgres） | 可直接使用 Neon |
	| DATABASE_DRIVER | `pg` 或 `neon` | 可选；默认自动检测 |
	| DATABASE_CA | DB 服务端 CA 证书 | 可选；PEM 原始内容或 Base64 编码均可 |
	| PASSWORD | 访问密码，同时用于调用 `/api/sync` | 可选；留空默认使用 `CLIPROXY_SECRET_KEY` |
	| CRON_SECRET | 使用 Vercel Cron 时需填写 | 任意字符串均可；建议长度 ≥ 16 |

3. 部署后，可通过以下方式自动同步上游使用数据：

	- 默认启用 Vercel Cron（ Pro 可设每小时，Hobby 每天同步一次，请见 [vercel.json](https://github.com/sxjeru/CLIProxyAPI-Monitor/blob/main/vercel.json) ）
	- Cloudflare Worker / 其他定时器定期请求同步：可见 [cf-worker-sync.js](https://github.com/sxjeru/CLIProxyAPI-Monitor/blob/main/cf-worker-sync.js)

## 预览

|   |   |
| --- | --- |
| <img width="2186" height="1114" alt="image" src="https://github.com/user-attachments/assets/939424fb-1caa-4e80-a9a8-921d1770eb9f" /> | <img width="2112" height="1117" alt="image" src="https://github.com/user-attachments/assets/e5338679-7808-4f37-9753-41b559a3cee6" /> |
<img width="2133" height="1098" alt="image" src="https://github.com/user-attachments/assets/99858753-f80f-4cd6-9331-087af35b21b3" />
<img width="2166" height="973" alt="image" src="https://github.com/user-attachments/assets/6097da38-9dcc-46c0-a515-5904b81203d6" />

## 数据库高级配置

| 环境变量 | 说明 | 默认值 | 备注 |
|---|---|---|---|
| `DATABASE_POOL_MAX` | 连接池最大连接数 | `5` | 最小为 1 |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | 空闲连接超时时间 (毫秒) | `10000` | 超过此时间未使用的连接将被释放 |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | 获取连接超时时间 (毫秒) | `5000` | 等待连接空闲的最长时间 |
| `DATABASE_POOL_MAX_USES` | 连接最大使用次数 | `7500` | 单个连接在关闭前可执行的最大查询数 |
| `AUTH_FILES_INSERT_CHUNK_SIZE` | `auth_file_mappings` 批量插入块大小 | `500` | 大数据量时避免单条 SQL 过长 |
| `USAGE_INSERT_CHUNK_SIZE` | `usage_records` 批量插入块大小 | `1000` | 大数据量时避免单条 SQL 过长 |
| `NEXT_PUBLIC_SYNC_TIMEOUT_MS` | 数据同步超时时间 (毫秒) | `120000` | 前后端共享 |

## Local DEV
1. 安装依赖：`pnpm install`
2. 修改环境变量：`cp .env.example .env`
3. 创建表结构：`pnpm run db:push`
4. 同步数据：GET/POST `/api/sync`（可选）
5. 启动开发：`pnpm dev`

---

## CPA 近端适配器（adapter.js）

由于 CPA 新版已移除 `/usage` 接口，可将 [adapter.js](adapter.js) 部署在 CPA 近端，实现从 CPA Redis 队列聚合 usage，还原接口功能，再自动提供给本项目的 `/api/sync` 拉取。

迁移时可在看板配置 `USAGE_API_BASE_URL=http://adapter-host:36871` 以正常使用看板的同步功能，同时保持对原管理接口的访问。

`adapter-host` 一般为 CPA 部署服务器 IP 。

```
curl -L -o adapter.js https://github.com/sxjeru/CLIProxyAPI-Monitor/raw/refs/heads/main/adapter.js
npm install ioredis
node adapter.js

# 推荐使用 PM2 
npm install -g pm2
pm2 start adapter.js --name cpa-adapter
```

### 环境变量

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `CPA_REDIS_HOST` | CPA Redis 主机 | `127.0.0.1` |
| `CPA_REDIS_PORT` | CPA Redis 端口 | `8317` |
| `CPA_SECRET_KEY` | CPA Redis 访问密钥，即前述 `CLIPROXY_SECRET_KEY` | 空 |
| `CPA_REDIS_KEY` | usage 队列 key | `queue` |
| `ADAPTER_PORT` | adapter 监听端口 | `36871` |
| `POLL_INTERVAL` | 从 Redis 拉取间隔（毫秒） | `15000` |
| `MAX_BUFFER_SIZE` | 内存缓冲上限 | `50000` |
| `BATCH_SIZE` | 每次拉取条数 | `500` |
| `CLEAR_BUFFER_ON_READ` | 读取 `/usage` 后是否清空缓冲 | `false` |
| `USAGE_AUTH_MAX_ATTEMPTS` | usage 鉴权最大连续失败次数 | `10` |
| `USAGE_AUTH_LOCKOUT_MS` | usage 鉴权失败后的锁定时长（毫秒） | `1800000` |
| `USAGE_AUTH_CLEANUP_MS` | 失败记录清理窗口（毫秒） | `3600000` |


### 定时 sync 环境变量

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `ENABLE_PERIODIC_SYNC` | 是否启用内置定时 sync | `false` |
| `DASHBOARD_URL` | 远端看板地址，如 `https://your-domain.com` | 空 |
| `SYNC_TOKEN` | 远端看板 `/api/sync` 的 Bearer token，建议填看板的 `CRON_SECRET` 或 `PASSWORD` | 空 |
| `SYNC_INTERVAL` | 定时触发 `/api/sync` 的间隔（毫秒） | `600000` |
| `SYNC_TIMEOUT_MS` | 单次 sync 超时（毫秒） | `300000` |
| `SYNC_ON_START` | 启动后是否立即触发一次 sync | `false` |

### 工作方式

1. `adapter.js` 定时从 CPA Redis 队列拉取 usage 记录
2. 聚合后通过本地 `/usage` 或 `/v0/management/usage` 暴露给外部
3. 若开启 `ENABLE_PERIODIC_SYNC=true`，adapter 会定时请求远端看板 `/api/sync`
4. 看板 `/api/sync` 再回拉 adapter 的 `/usage`，并写入数据库

----

### 鸣谢
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [Linux.DO](https://linux.do/)
- [Vercel](https://vercel.com/)
