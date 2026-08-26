# TokenTracker 项目长期记忆

## 数据源与 source 标签
- Trae 三变体：ide(国际IDE)→"trae"、solo(国际SOLO)→"trae-solo"、cn(中国版)→"trae"。**cn 与 ide 共用 "trae" 标签**（sync.js:1280），国际版 IDE 与 CN 在统计中无法区分。
- Grok Build（xAI TUI）：source "grok"，模型读 `signals.json.primaryModelId`，缺失时兜底 "grok-build"。具体版本（如 grok-4.5）现已暴露，新记录为具体版本而非 grok-build。
- CodeBuddy：被动文件读取（~/.codebuddy/projects JSONL + IDE 扩展日志），非 hook 取数；hy3 系列有定价，非 hy3 显示 $0。

## 已知缺口/坑
- `curated-overrides.json` **缺 grok-4.5 定价**（有 grok-4 / grok-4-fast / grok-build 估算价）。
- **Grok 进行中 session 漏读**：rollout.js:12773 以 `signals.json||updates.jsonl` 任一存在即纳入；模型仅从 `signals.json.primaryModelId` 读（12771/12857），而 `signals.json` 在 SessionEnd 才生成。`updates.jsonl` 仅含 `{timestamp,method,params{_meta:{totalTokens}}}`、**无 model 字段**。故进行中 session 有用量无 signals → 模型兜底 `grok-build`（非数据缺失，是时序问题；session 结束后重跑 sync 即纠正为 grok-4.5）。修复建议：无 signals 时不强行兜底 grok-build，留 unknown 待回填，避免费用错算。
- Trae CN 同步后明文 SQLite 临时文件残留于 `~/.tokentracker/trae-cache/`（`database_decrypted.db-shm/.wal`），属敏感明文，建议清理。
- Trae CN 用量走本地数据库解密，需 `trae_cn_db_key` 配置或 `trae-db-decrypt` 工具提取密钥。

## 探查要点（本机环境）
- 本机 Grok 实际模型 = grok-4.5（signals.json 实测 primaryModelId）。
- 本机已统计：Trae CN（1232 sessions）、Grok（9 buckets：8×grok-4.5 + 1×grok-build）。那条 grok-build 非历史残留，而是 2026-07-20 16:30（北京，≈35分钟前，08:30Z）产生，与同日 grok-4.5 并存 → 间歇性实时漏读（部分 session signals 未写 primaryModelId）。

## 高效测试与调试约定
- 尽量避免跑全量 `npm test`（含 200+ 个测试文件，耗时较长）。
- 单测试文件快速运行：`node --test test/<name>.test.js`
- 按功能或关键词过滤：`node --test --test-name-pattern="Trae" test/*.test.js`
- 多核并发加速运行：`node --test --test-concurrency=8 test/*.test.js`

