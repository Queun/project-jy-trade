# 技术架构

## 结论

正式产品使用 Node.js / TypeScript 实现前后端和核心业务逻辑。Python 保留为探索、数据核验、临时脚本，不作为主链路依赖。

当前暂定技术栈：

- Node.js 24 LTS。
- npm workspaces。
- TypeScript。
- 后端：Fastify + Zod。
- 前端：Vite + React + TypeScript。
- UI：Tailwind v4 + shadcn/ui 风格组件。
- 表格：TanStack Table。
- 数据层：SQLite + Drizzle。
- 测试：Vitest + Testing Library + Playwright。

## 选择理由

Node/TypeScript：

- 项目前后端预计都使用 Node，统一运行时能减少部署、日志、权限、环境变量和进程管理复杂度。
- 订货单读取、旺店通签名、API 请求、滚动库存初审这些核心逻辑在 TypeScript 中已经验证可行。
- 订单批量处理规模较小，性能瓶颈更可能来自旺店通 API 请求和人工审核，而不是语言运行时。
- 以 Node 调 Python 并非性能问题，但会引入双运行时、依赖安装、错误处理和部署运维复杂度。除非后续遇到 Node 难以稳定处理的 Excel 模板问题，否则不作为主方案。

Fastify：

- 足够轻量，适合内部低并发业务平台。
- 路由、插件、schema 校验、测试注入能力成熟。
- 后续做登录、审计、文件上传、导出任务时扩展成本低。

Vite + React：

- 初始化和开发反馈快。
- 适合做审核工作台、批次列表、表格操作和导出中心。
- 与 TanStack Table、Testing Library、Playwright 配合成熟。

SQLite + Drizzle：

- 10 多人低并发场景足够。
- 本地开发和部署简单。
- Drizzle schema 让后续迁移 PostgreSQL 有清晰边界。
- 当前已经接入 API 持久化，默认开发库为 `data/jy-trade-dev.db`。

## 分层设计

```text
apps/web
  调用后端 API，不接触旺店通凭据和签名逻辑

apps/api
  Fastify 路由、请求校验、权限预留、批次和审核接口、SQLite 持久化

packages/shared
  Zod schema、DTO、状态枚举

packages/workflow
  订单解析、商品匹配输入输出、库存初审、Excel 导出

backend/src/integrations
  旺店通 API client、环境变量读取
```

核心原则：

- 前端只处理展示和用户操作。
- 后端 API 负责权限、批次状态、审核决策和外部系统编排。
- workflow 包保持纯业务逻辑，尽量不依赖 Web 框架。
- 旺店通细节封装在 integration 层，避免泄露到前端或共享 DTO。

审核闭环数据流：

- 前端加载批次和初审明细后，在本地进行筛选、数量和原因编辑。
- 单行保存通过 `PATCH review-lines/:lineId/decision` 写入 `review_decisions`。
- 批量通过由后端选择 matched 且库存充足/部分满足的行，避免前端误传范围。
- 提交审核只更新 `batches.status=reviewed`，不锁死后续修改。
- 单行审核、批量通过、提交审核都写入 `audit_logs`。

商品匹配与库存查询数据流：

- 后台同步任务从旺店通 `goods.Goods.queryWithSpec` 读取商品档案，保存到本地 SQLite 缓存。
- 货品档案同步默认使用 `page_size=1000`；正式环境只读验证表明该分页可正常返回，适合减少全量同步请求次数。
- 订单上传后，后端先查本地人工映射，再查本地商品缓存的条码、`spec_no`、`goods_no` 精确索引。
- 外部条码查不到时，后端基于本地商品名称和规格候选做打分，只生成候选，不自动确认。
- 条码不同但名称相近的候选必须进入人工确认；确认结果写入商品映射表，后续订单复用。
- 已确认到旺店通 `spec_no` 后，再调用 `wms.StockSpec.search2` 读取所有仓库库存行。
- 库存服务按仓库配置归类主仓、临期仓、次品仓和其他仓，输出给库存初审逻辑。
- 前端审核工作台只展示匹配结果、候选、库存拆分和审核操作，不直接接触旺店通 API。

计划新增的数据模型方向：

- `wdt_goods_specs`：旺店通商品/规格本地缓存。
- `wdt_goods_sync_runs`：商品档案同步任务记录。
- `product_mappings`：外部订货单商品到旺店通规格的人工确认映射。
- `product_match_candidates`：批次内候选匹配快照，便于审核和回查。

## 多用户协作预留

当前先不做正式登录，但数据模型和 API 设计预留：

- `users`
- `sessions`
- `reviewerId`
- `auditLogs`
- `review_decisions`

后续登录方案可从简单账号密码 + session cookie 开始，不需要一开始接入复杂 SSO。审核动作需要落审计日志，包括操作者、时间、原值、新值和原因。

## 当前验证结果

Node 版已跑通：

- 读取样例订货单 `.xls`。
- 输出订单明细统计。
- 按上传时间排序。
- 对重复条码做滚动库存扣减。
- 使用本地 `.env` 调用旺店通测试环境。
- 查询测试仓库、测试商品、测试库存。
- Fastify API 创建批次、运行 mock 初审、获取明细、修改审核决策。
- SQLite 持久化批次、初审明细、审核决定、导出记录和审计日志。
- React 页面运行 mock 批次并展示初审表格。

Python 版已跑通：

- 样表探测。
- 订货单导入。
- 滚动库存初审。
- 旺店通 API 探测。

## 需要重新评估的点

- 如果最终必须输出老式 `.xls` 且要高度保留格式，Node 生态支持会弱一些；届时可评估继续输出 `.xlsx`，或保留 Python/LibreOffice 导出 worker。
- 如果做单模板中存在大量公式、样式、合并单元格和打印格式，导出模块需要单独验证。
- 如果正式旺店通接口存在频控，需要在 Node 后端做队列、缓存和重试。
- 如果并发或数据量显著超过当前预期，再评估 SQLite 到 PostgreSQL 的迁移。
