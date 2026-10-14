# Codex catalog Worker

Worker 按客户端版本读取 GitHub 的 Codex 模型目录。
Worker 在完整目录上修改指定字段。
Worker 读取本仓库 `catalogs/` 中的额外 JSON。
Worker 把额外模型追加到官方目录。
Worker 返回 Codex 原生格式：`{"models":[...]}`。

## 当前覆盖规则

| 条件 | 修改 |
| --- | --- |
| 任意模型的 `use_responses_lite` 为 `true` | 改为 `false` |
| `gpt-6.1-sol` | `context_window = 500000` |
| `gpt-6-astra` | `context_window = 300000` |
| `gpt-5.6-sol` | `context_window = 300000` |

其余字段保留上游原值。
`max_context_window` 保留上游原值。
字段覆盖规则不会新增模型。
额外 JSON 中的模型会追加到目录。

在 `src/patch-rules.js` 编辑规则。
对象递归合并。
数组整体替换。
显式 `null` 覆盖原值。
省略的字段保留原值。

这份目录修改客户端配置。
目录修改不会增加上游模型的实际能力。

## 来源选择

客户端请求示例：

```http
GET /backend-api/codex/models?client_version=0.162.1
```

Worker 依次读取：

1. `https://raw.githubusercontent.com/openai/codex/refs/tags/rust-v0.162.1/codex-rs/models-manager/models.json`
2. 第一个路径返回 404 时，读取同一 tag 的 `codex-rs/core/models.json`。
3. 两个路径都返回 404 时，读取 `main` 的对应目录。

`main` 表示主分支的最新目录。
`main` 不表示最新稳定版。

稳定版通常有 `rust-vX.Y.Z` tag。
预发布客户端只发送 `X.Y.Z`。
因此，预发布版对应的稳定版 tag 可以尚未发布。
自行编译的版本也可以没有对应 tag。
旧 tag 还可以使用不同的文件路径。

需要固定回退版本时，修改 `wrangler.jsonc`：

```json
"FALLBACK_REF": "rust-v0.162.1"
```

需要映射预发布版时，修改 `src/patch-rules.js`：

```js
versionRefs: {
  "0.163.0": "rust-v0.163.0-alpha.1"
}
```

映射示例必须替换为真实存在的 tag。
同一 `X.Y.Z` 的多个预发布版无法仅通过 `client_version` 区分。

GitHub 的临时错误返回 502。
Worker 只对 404 执行来源回退。
上游 JSON 格式错误也返回 502。
所有 GitHub 请求共用 4.5 秒时间预算。
Codex `0.162.1` 的目录请求超时为 5 秒。

## 额外模型目录

默认读取公开仓库 `Eccon/codex-catalog-worker`。
Worker 通过 GitHub Git Trees API 发现 `catalogs/` 中的全部 JSON。
子目录中的 JSON 也会读取。
Worker 按文件路径排序追加模型。
文件内的模型顺序保持不变。

Git Trees 响应包含每个文件的 blob SHA。
Worker 按这些 SHA 读取文件内容。
因此，一次响应使用同一份目录快照。

日常维护流程：

1. 在根目录的 `catalogs/` 中添加或修改 JSON。
2. 执行 `npm run validate:catalogs`。
3. 将修改提交到 GitHub `main` 分支。

无需更新文件列表。
无需重新部署 Worker。
当前 `deepseek.json` 和 `glm.json` 各包含两个实际模型。
模型为 `deepseek-flash`、`deepseek-v4-pro`、`glm-5.3` 和 `glm-5.3-flash`。
完整模型对象模板位于 `../examples/model.catalog.json`。
模板中的容量和能力是示例值，必须按实际网关配置替换。

可配置项位于 `wrangler.jsonc`：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `EXTRA_CATALOG_REPOSITORY` | `Eccon/codex-catalog-worker` | 额外 JSON 所在仓库 |
| `EXTRA_CATALOG_DIRECTORY` | `catalogs` | 递归扫描的目录 |
| `EXTRA_CATALOG_REF` | `main` | 数据分支、tag 或提交 |
| `EXTRA_CATALOG_CACHE_TTL` | `300` | 目录清单缓存秒数 |
| `EXTRA_CATALOG_FAILURE_MODE` | `skip` | 失败时跳过或报错 |

把 `EXTRA_CATALOG_REPOSITORY` 设为空字符串，可以关闭额外目录。
把 `EXTRA_CATALOG_CACHE_TTL` 设为 `0`，可以让清单缓存立即过期。
GitHub 和 Codex 各自的缓存仍会影响更新时机。

`skip` 模式下，目录清单请求失败时只返回官方模型。
单个 JSON 失败时，跳过该文件并返回其他有效模型。
`error` 模式下，额外目录读取失败返回 502。
两个模式下，重复 `slug` 都会返回 502。
Worker 不会静默覆盖官方模型。

每个模型必须提供 Codex 必需字段。
Worker 不会为第三方模型继承官方提示词或工具能力。
额外目录最多支持 32 个 JSON 文件。
最终响应仍受 Codex 的 1 MiB 上限限制。

公开仓库无需 GitHub token。
如遇 GitHub API 限流，可以设置专用 secret：

```bash
npx wrangler secret put EXTRA_GITHUB_TOKEN
```

这个 token 只用于 `api.github.com` 请求。
Worker 不使用客户端的 Bearer token 访问 GitHub。

## 本地运行

使用 Node.js 22 或更新版本。

```bash
cd /private/tmp/sub2api/codex-catalog-worker
npm ci
npm test
npm run dev
```

请求本地目录：

```bash
curl --get 'http://localhost:8787/backend-api/codex/models' \
  --data-urlencode 'client_version=0.162.1' \
  --dump-header /tmp/codex-catalog.headers \
  --output /tmp/codex-catalog.json
```

检查三个模型：

```bash
jq '.models[] | select(.slug == "gpt-6.1-sol" or .slug == "gpt-6-astra" or .slug == "gpt-5.6-sol") | {slug, context_window, max_context_window, use_responses_lite}' /tmp/codex-catalog.json
```

检查剩余的 lite 模型：

```bash
jq '[.models[] | select(.use_responses_lite == true)] | length' /tmp/codex-catalog.json
```

预期结果为 `0`。

## 部署

```bash
npx wrangler login
npm run deploy
```

配置关闭了 `workers.dev` 和预览域名。
部署后，使用你添加的域名路由。

### 拦截已有域名的路径

域名必须属于你的 Cloudflare zone。
该域名的 DNS 记录必须开启 Cloudflare 代理。

可以在 Cloudflare 控制台添加路由。
配置保留了注释中的路由示例。
如果使用控制台管理路由，保持 `routes` 配置为注释。

也可以在 `wrangler.jsonc` 启用路由：

```json
"routes": [
  {
    "pattern": "https://gateway.example.com/backend-api/codex/models*",
    "zone_name": "example.com"
  }
]
```

末尾 `*` 用于匹配查询参数。
Worker 内部仍检查精确路径 `/backend-api/codex/models`。
这个 route 不匹配 `/v1/responses`。

需要把同一路由范围内的其他路径交回源站时，设置：

```json
"PASSTHROUGH_OTHER_PATHS": "true"
```

仅在有源站的 Workers Route 上使用此设置。

## Codex 配置

```toml
model_provider = "custom"

[features]
api_key_model_discovery = true

[model_providers.custom]
name = "custom"
base_url = "https://gateway.example.com/v1"
model_catalog_url = "https://gateway.example.com/backend-api/codex/models"
env_key = "CUSTOM_API_KEY"
wire_api = "responses"
```

拦截网关域名时，`model_catalog_url` 可以使用网关域名。
这里的 `model_catalog_url` 是完整 URL。
Codex 自动附加 `client_version`。
不得同时配置 `model_catalog_json`。
本地静态目录配置会阻止远程目录发现。

Worker 默认提供公开的模型 metadata。
Worker 不使用入站凭据访问 GitHub。
Worker 也不把入站凭据转发给 GitHub。

需要限制访问时，设置 Worker secret：

```bash
npx wrangler secret put CATALOG_BEARER_TOKEN
```

这个 secret 必须匹配 Codex 所选 provider 发出的 Bearer token。
Codex 没有独立的 catalog token 配置项。
在本地测试 secret 时，将值写入忽略提交的 `.dev.vars`。

## 缓存和诊断

Worker 使用 Cloudflare `fetch` 缓存 GitHub 原始响应。
tag 响应默认缓存 24 小时。
`main` 响应默认缓存 5 分钟。
额外目录清单默认缓存 5 分钟。
额外文件按 blob SHA 缓存 24 小时。
文件内容修改后，SHA 会变化。
新目录清单会引用新的 SHA。
404 默认缓存 60 秒。
其他失败响应不缓存。
每次请求都应用当前 Worker 的字段规则。

Cloudflare 的缓存效果必须在部署后验证。
本地运行不能证明 Cloudflare 边缘缓存命中。

响应头说明实际来源：

| 响应头 | 含义 |
| --- | --- |
| `X-Catalog-Client-Version` | 规范化后的客户端版本 |
| `X-Catalog-Source-Ref` | 实际读取的 tag 或 `main` |
| `X-Catalog-Source-Path` | 实际读取的文件路径 |
| `X-Catalog-Fallback` | 是否使用回退来源 |
| `X-Catalog-Patched-Models` | 修改过的模型 |
| `X-Catalog-Extras-Status` | `disabled`、`ok`、`partial` 或 `failed` |
| `X-Catalog-Extra-Files` | 本次成功读取的额外文件数量 |
| `X-Catalog-Extra-Models` | 本次追加的模型数量 |
| `X-Catalog-Extra-Revision` | 额外目录的 Git tree SHA |
| `ETag` | 修改后 JSON 的 SHA-256 标识 |

Worker 记录版本、来源和修改过的模型。
Worker 不记录 Authorization 或 Cookie。

`main` 回退不能保证旧客户端兼容。
Worker 保留上游未知字段，但不重写各版本的协议。
优先使用对应 tag。
需要稳定行为时，固定回退 tag 或配置版本映射。

## 验证范围

`npm test` 检查版本选择、旧路径、回退和字段合并。
测试还检查鉴权隔离和 1 MiB 响应上限。
额外目录测试覆盖子目录、新文件发现、重复检查和失败策略。

`npm run check:deploy` 检查 Worker 构建。
这个命令不会发布 Worker。

2026 年 10 月 14 日的验证结果见 `VALIDATION.md`。
