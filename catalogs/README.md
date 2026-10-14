# 额外模型目录

把第三方模型的 catalog JSON 放在这里。
Worker 读取这个目录和子目录中的所有 `.json` 文件。
Worker 忽略 Markdown 文件。

每个 JSON 文件使用同一种结构：

```json
{
  "models": []
}
```

`deepseek.json` 和 `glm.json` 当前为空。
把实际模型对象放入 `models` 数组。
模板在 `../examples/model.catalog.json`。
模板中的模型名、能力和容量必须替换为真实配置。

每个模型必须提供完整的必需字段。
`slug` 必须与推理网关接受的模型名一致。
所有文件中的 `slug` 不得重复。
`slug` 也不得与官方目录中的模型重复。

Worker 按文件路径排序追加模型。
文件内的模型顺序保持不变。
Codex 的模型选择界面还会按 `priority` 排序。

提交 JSON 修改到 GitHub `main` 分支后，无需重新部署 Worker。
Worker 的目录清单缓存默认有效 5 分钟。
Codex 后端还有自己的刷新周期。
更新不保证在提交后立即显示。

本地检查命令：

```bash
cd codex-catalog-worker
npm run validate:catalogs
```

本目录中的 JSON 会公开发布。
JSON 中不得放 API Key、Cookie 或访问令牌。
