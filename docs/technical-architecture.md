# 技术架构

本文只描述当前真实架构、模块边界和仍然有效的技术取舍。产品进度和待办以 `docs/project-plan.md` 为准。

## 技术栈

- 运行时：Node.js 24 LTS。
- 工程组织：npm workspaces + TypeScript。
- 后端：Fastify + Zod。
- 前端：Vite + React + TypeScript。
- UI：Tailwind v4、项目内基础组件和 Lucide 图标。
- 表格：TanStack Table。
- 数据层：SQLite/libSQL client + Drizzle ORM。
- Excel：SheetJS `xlsx`。
- 测试：Vitest、Testing Library、Playwright。

Python 只用于历史探索、数据核验和临时脚本，不是正式运行依赖。

## 模块边界

```text
apps/web
  React 业务界面，只调用本项目 API

apps/api
  Fastify 路由、登录与角色校验、SQLite 持久化、旺店通只读编排、文件导出

packages/shared
  Zod schema、DTO、角色、状态和跨 workspace 契约

packages/workflow
  Excel 解析、商品匹配、库存分配和不依赖 Web 框架的业务逻辑

apps/api/src/wdtClientAdapter.ts
  旺店通只读 client 装配和环境变量边界

backend/src/probes
  历史诊断脚本和人工探针，不作为新功能入口

src/jy_trade
  早期 Python 实验代码，不被正式主链路依赖
```

前端不接触旺店通凭据、签名和数据库。API 负责权限、批次状态、外部系统调用和审计；可复用的确定性业务规则优先放入 `packages/workflow`。

## 运行流程

### 登录和权限

- 用户密码以哈希形式保存在 `users`，登录后使用 session cookie。
- 生产环境要求显式配置强管理员密码，并在 API 启动时同步配置管理员的密码；开发/测试示例账号不会自动进入新的生产数据库。
- 后端对受保护接口统一验证 session，并对关键写操作验证 `admin`、`operator`、`reviewer` 角色。
- `admin` 可执行全部操作；`operator` 负责导入、同步、维护和导出；`reviewer` 负责审核决定和优先处理。
- 重要写操作记录 actor、时间和变更内容到 `audit_logs`。

### 正式订单

1. `operator` 上传订货单并创建批次。
2. API 从本地 WDT 商品、组合装和长期映射缓存完成商品匹配。
3. 对已确认的库存组件读取最新成功的本地库存快照；业务操作不调用旺店通库存接口。
4. workflow 按仓库配置、VIP 优先级和同规格库存生成建议发货数量，并为每条明细只建议一个仓库。
5. `reviewer` 调整数量和最终仓库后提交审核；系统建议不覆盖人工决定。
6. `operator` 检查最终仓库、地址和做单字段后生成 Excel。

正式初审要求可用商品档案。`allowStaleCache=true` 只用于人工诊断商品档案缓存，不是正式审核口径；库存快照过期只提醒，不阻断。

### 上游已审核确定单（系统内仍须审核）

1. `operator` 导入确定单，API 固定读取 `订货数量` 和 `实际发货数量`；后者持久化为 `plannedShipQty`。
2. API 使用本地商品缓存和长期映射完成匹配，并通过与正式订单相同的分配器生成 `suggestedShipQty` 和建议仓库。分配需求上限是 `plannedShipQty`。
3. 确定单 `主仓` / `临期仓` 原值只进入 `orderRawJson`，不参与库存分配、最终仓库初始化或差异提示。
4. 系统把建议数量和建议仓库初始化为最终审核结果；`reviewer` 可以修改 `approvedShipQty` 和最终仓库。导入后批次状态为 `review_generated`。
5. 库存查询失败时保留 `库存未验证` 行，建议量为 0、仓库为空，`stockErrorDetail` 保存开发者诊断信息。人工决定正数后，提交审核先返回结构化 `UNVERIFIED_STOCK` 警告，显式确认后可以进入 `reviewed`。
6. 重新校验请求显式携带 `preserve` 或 `replace`：前者合并保留现有最终结果，后者以最新建议覆盖最终数量和仓库；备注、优先标记以及既有审核决定元数据保留。两种策略都把批次恢复为 `review_generated`。
7. 做单导出要求批次已经 `reviewed`，并且只读取最终审核结果，不在导出阶段重新查询库存或分仓。

### 商品匹配和库存

- `goods.Goods.queryWithSpec` 同步普通商品规格到 `wdt_goods_specs`。
- `goods.Suite.search` 同步组合装和明细到 `wdt_suites`、`wdt_suite_components`。
- 精确条码/编码和已确认长期映射可以自动命中；名称相似只写入候选快照，不能自动确认。
- 单组件组合装的库存目标是组件 `spec_no`，做单目标是组合装 `suite_no`。
- `wms.StockSpec.search2` 返回的 `available_send_stock` 是库存初审主字段。
- 每次组合同步在库存阶段开始前固定当前仓库启用范围；商品档案仍全局增量同步，库存行只保留启用仓库。多仓范围使用一次批量查询后本地过滤，单个已知仓库可传 `warehouse_no`。
- `wdt_stock_snapshot_warehouse_coverage` 明确记录成功快照覆盖的仓库类别。读取快照时把它和当前仓库设置比较；缺少任何已启用类别时，不把缺失范围当作零库存，而是将本次建议降级为库存未验证。
- 后台组合任务按 40 个 SKU 一批、至少 1.1 秒请求间隔同步库存；频控或并发错误按 `WDT_STOCK_SYNC_RETRY_DELAYS_MS` 重试。商品增量和所有库存批次完整成功后，才把任务状态原子更新为 `success`。
- 业务查询始终选择最新成功任务。库存同步失败会删除本次临时库存快照并保留旧库存快照；已经成功写入的商品档案增量不回滚，新商品在旧库存快照未覆盖时标记“库存未验证”。最近两份成功库存快照明细用于回退。
- `wdt_stock_snapshot_specs` 区分“本次已核验为 0”和“快照未覆盖”，`wdt_stock_snapshot_rows` 保存分仓可发库存和原始响应。
- 自动调度固定使用 `Asia/Shanghai`，按管理员选择的 1、2、6 或 24 小时自然时间边界执行；无快照或启动时快照超过所选周期会排队补跑，同一时间只允许一个组合任务，修改周期后无需重启。
- 库存行先按仓库用途分类，只有启用的仓库参与建议发货。
- 自动建议遵守单行单仓：有仓库可完整满足时选择满足仓，否则选择可发库存更多的仓，并列优先主仓。一条订单明细不会拆成多个仓库行。

### Excel 导出

- 初审单和确定发货单输出 `.xlsx`。
- 旺店通做单文件按现有模板输出 BIFF8 `.xls`，Sheet 为 `Sheet1`。
- 做单行只来自已决定发货且最终数量大于 0 的审核行。
- 做单导出是审核结果的纯投影，不查询库存、不重新分配数量或仓库。
- `原始单号` 按“门店 + 最终仓库”分组生成并重复到组内各商品行；不同门店或不同仓库使用不同编号，相同批次重复导出保持稳定。
- 同一门店的通知单号汇总到 `客服备注`。
- `商家编码` 使用 `wdtMakeOrderCode`，缺少时回退到 `wdtSpecNo`。

字段和模板细节以 `docs/excel-field-dictionary.md` 为准，并应由导出测试保护。

## 数据模型

当前 SQLite 持久化模型分为：

- 账号与审计：`users`、`sessions`、`audit_logs`。
- 批次与审核：`batches`、`review_lines`、`review_decisions`。`batches` 保存本次建议所用的 `stockSnapshotRunId` / `stockSnapshotAt`；`review_lines` 保存 `orderQty`、`plannedShipQty`、系统建议数量、建议仓库和库存诊断；`review_decisions` 保存 `approvedShipQty`、最终发货仓库、用户备注和审核元数据。
- 导出与地址：`exports`、`store_addresses`。
- 仓库策略：`warehouse_usage_settings`。
- WDT 缓存：`wdt_goods_specs`、`wdt_goods_sync_runs`、`wdt_suites`、`wdt_suite_components`、`wdt_suite_sync_runs`、`wdt_sync_runs`、`wdt_stock_snapshot_specs`、`wdt_stock_snapshot_rows`。
- 商品维护：`product_mappings`、`product_match_candidates`、`external_products`、`external_product_components`。

Drizzle schema、migration、DTO、API 测试和相关文档必须在同一功能变更中保持一致。

`0016_confirmed_order_planned_ship_qty.sql` 为历史数据增加 `planned_ship_qty`：旧确定单从原 `suggested_ship_qty` 回填，旧普通订单从 `order_qty` 回填。兼容性启动检查也会补列并回填，迁移不会删除批次、审核决定或测试数据。兼容检查只覆盖 `0016`，不替代部署和升级时执行 `npm run db:migrate`。

## 运行数据边界

- `.env` 保存本地或服务器凭据，不提交。
- `data/` 保存 SQLite、上传和导出等运行数据，不提交。
- `outputs/` 保存测试产物、诊断结果和截图，不提交。
- 自动测试不得依赖私有 Excel、生产数据库或真实旺店通写操作。
- 旺店通正式环境只允许读取；任何写接口都不在当前系统边界内。

## 关键取舍

### TypeScript 主链路

前后端统一 TypeScript 可以减少双运行时部署、错误传递和依赖维护成本。除非后续出现 Node 无法稳定处理的 Excel 格式要求，不增加 Python/LibreOffice worker。

### SQLite

当前是低并发内部工具，瓶颈主要来自外部 API 和人工审核。SQLite 部署、备份和迁移成本低，现阶段不为未出现的并发问题迁移 PostgreSQL。

### 本地商品缓存

旺店通名称查询召回不稳定且存在时间窗口、分页和频控约束。正式流程先同步本地缓存，再做确定性匹配和候选排序，避免订单上传时实时扫描全量商品。

### 增量 UI

当前操作路径已经被用户熟悉。前端继续在现有工作台上增量优化，不以大规模重构换取纯视觉变化。

## 重新评估条件

- 并发写入或数据量使 SQLite 出现可复现的锁竞争或性能问题。
- 最终模板要求高度保留 `.xls` 公式、样式、合并单元格或打印设置，SheetJS 无法稳定满足。
- 旺店通频控要求持久化任务队列、跨进程限流或更复杂的失败重试。
- 业务正式要求写入旺店通；届时必须单独设计权限、幂等、审计、回滚和灰度边界。
