# Codex catalog Worker

这个仓库保存 Worker 代码和额外模型目录。

```text
catalogs/
  deepseek.json
  glm.json
examples/
  model.catalog.json
codex-catalog-worker/
  src/
  wrangler.jsonc
```

日常维护只需修改 `catalogs/` 中的 JSON。
Worker 读取该目录和子目录中的全部 `.json` 文件。
Worker 把模型追加到官方目录后返回完整 catalog。

额外模型配置说明见 [catalogs/README.md](catalogs/README.md)。
字段模板见 [examples/model.catalog.json](examples/model.catalog.json)。
Worker 部署说明见 [codex-catalog-worker/README.md](codex-catalog-worker/README.md)。

当前第三方目录包含 `glm-5.3`、`glm-5.3-flash`、`deepseek-flash` 和 `deepseek-v4-pro`。
模型 metadata 必须描述网关实际支持的模型。
把模型添加到 catalog 不会为网关增加推理能力。
