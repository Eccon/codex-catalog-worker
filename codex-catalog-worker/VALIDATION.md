# 验证记录

验证日期：2026 年 10 月 14 日。

## 已验证

- `npm test`：20 项测试通过。
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
- GitHub 仓库 `Eccon/codex-catalog-worker` 创建完成，代码和目录模板推送成功。
- GitHub Actions 的 `Check catalogs and Worker` 工作流通过。
- 本地 Worker 从真实 GitHub 仓库读取 `catalogs/deepseek.json` 和 `catalogs/glm.json` 成功。
- 两个文件当前为空，因此本次追加模型数为 0。
- 子目录遍历、新文件发现和非空模型追加通过模拟源测试。
- 重复 `slug` 检查和额外源失败策略通过测试。

## 未验证

- Cloudflare 生产部署和边缘缓存命中。
- 增加额外目录后的 Worker 生产部署。
- 修改目录后的实际模型推理。
- `main` 目录与所有旧版本 Codex 的兼容性。

用户此前部署的 Worker 已返回正确的 500000 上下文值。
本次增加额外目录的代码尚未部署。
