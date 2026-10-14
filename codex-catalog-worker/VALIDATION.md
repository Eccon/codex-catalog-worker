# 验证记录

验证日期：2026 年 10 月 14 日。

## 已验证

- `npm test`：12 项测试通过。
- `npm run check:deploy`：Wrangler 构建通过。
- 本地 `wrangler dev`：真实请求 GitHub 成功。
- `client_version=0.162.1`：使用 `rust-v0.162.1` 的 `models-manager/models.json`。
- `client_version=0.100.0`：使用 `rust-v0.100.0` 的 `core/models.json`。
- `client_version=0.999.0`：找不到对应 tag，回退到 `main`。
- 三个 HTTP 请求均返回 200。
- 三个响应均只包含指定的字段修改。
- 本机 Codex CLI `0.162.1` 通过本地 Worker 读取远程目录成功。
- Codex `model/list` 返回 11 个模型。
- Codex 缓存中没有 `use_responses_lite: true`。
- Codex 缓存中 `gpt-6.1-sol.context_window` 为 `500000`。
- Codex 缓存中 `gpt-6-astra.context_window` 为 `300000`。
- Codex 缓存中 `gpt-5.6-sol.context_window` 为 `300000`。

## 未验证

- Cloudflare 生产部署和边缘缓存命中。
- 修改目录后的实际模型推理。
- `main` 目录与所有旧版本 Codex 的兼容性。

Worker 尚未部署。
