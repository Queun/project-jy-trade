# 开发说明

本文记录当前可维护主链路。历史 probe 和一次性排查脚本仅在明确需要时使用，不作为新功能入口。

## 文档入口

文档按用途维护，避免同一类计划散落在多个文件中。

- `PRODUCT.md`：稳定的产品边界、用户和界面原则。
- `docs/development.md`：开发入口、目录职责、资源清单、开发流程和迁移清单。
- `docs/project-plan.md`：当前能力、待讨论工作和暂缓范围的唯一计划入口。
- `docs/deployment.md`：腾讯云部署、Nginx、进程管理、备份和发布流程。
- `docs/excel-field-dictionary.md`：Excel 输入、输出和业务字段契约。
- `docs/technical-architecture.md`：当前技术架构、模块边界和关键取舍。
- `docs/archive/wdt-suite-21-code-reference.md`：组合装只读验证和截图转录，仅作历史参考。
- `docs/archive/flow-simulation.md`：早期流程模拟记录，仅作历史参考。
- `docs/archive/rebuild-development-plan.md`：本轮重建历史计划，不再追加新的开发待办。

文档管理规则：

- 新一轮开发计划只更新 `docs/project-plan.md`。
- 稳定的产品边界和界面原则只更新 `PRODUCT.md`。
- 字段口径只更新 `docs/excel-field-dictionary.md`。
- 部署、运维、服务器命令只更新 `docs/deployment.md`。
- 开发环境、目录职责、测试要求只更新本文。
- 非必要不新增文档；确实需要新增时，先说明它替代或补充哪个现有文档。
- 历史探测记录可以保留，但不要让它成为当前开发依据。

## 当前主链路

- API：`apps/api`
- Web：`apps/web`
- 共享类型：`packages/shared`
- 订单、匹配、初审核心逻辑：`packages/workflow`
- 部署配置：`deploy`
- 发布检查：`tools/check-release.mjs`

正式订单处理流程：

1. 后台按管理员设置的 1、2、6 或 24 小时周期，在 `Asia/Shanghai` 自然时间边界同步商品档案和库存快照；操作前也可在设置中手动立即同步。
2. 页面上传订货单并创建正式批次。
3. 后端读取本地商品档案、人工商品映射和最新成功库存快照；订单业务链路不实时调用旺店通库存接口。
4. 商品档案同步不按仓库裁剪；库存任务固定读取同步开始时的仓库启用设置，只持久化这些仓库类别。多仓只调用一次批量接口并本地过滤，单独启用主仓 `001`、临期仓 `LINQI` 或次品仓 `CIPIN` 时可把仓库号传给接口。
5. 快照覆盖范围保存在 `wdt_stock_snapshot_warehouse_coverage`。启用新仓库后，在下一次成功同步前显示范围不匹配并把库存建议视为未验证；保存仓库设置本身不自动触发同步。
4. 后端为每条明细生成单仓发货建议，前端审核最终仓库、发货数量、优先处理和不发货等决策。
5. 做单页面校验最终仓库和门店地址，再生成初审明细、确定发货单、批量做单表格等导出文件。

确定单使用独立入口导入，但与正式订单共用已经验证的库存分配能力。系统以确定单“实际发货数量”作为本轮需求上限，按同一商品共享库存、VIP 优先、同级公平分配和单行单仓规则生成建议数量与建议仓库。导入后批次状态为 `review_generated`，必须由审核人确认最终数量和最终仓库并提交审核，才能进入做单导出。

确定单中的 `主仓` / `临期仓` 列不参与分配，也不与建议结果比较；原值只保留在 `orderRawJson` 中用于追溯。重新校验确定单时，前端必须显式选择 `preserve`（保留最终数量、最终仓库和备注）或 `replace`（以最新建议覆盖最终数量和最终仓库，备注仍保留），两种方式都会把批次恢复为待审核。

## 资源清单

必须随项目版本管理的资源：

- `apps/api/drizzle/`：数据库迁移文件和 Drizzle 元数据。
- `deploy/`：systemd 和 Nginx 示例配置。
- `.env.example`、`.env.production.example`：环境变量模板，不包含真实凭据。
- `examples/`：脱敏 mock 数据。
- `docs/`：项目文档。
- `tools/check-release.mjs`：发布前隐私和产物检查。

本地存在但不提交的资源：

- `.env`：本地开发凭据和配置。
- `data/`：SQLite 数据库、上传文件、导出文件等运行数据。
- `outputs/`：测试 fixture、导出结果、诊断报告、截图和临时输出。
- `inputs/`、`apps/api/inputs/`：上传输入缓存。
- `ole案例文件——发货前/`：私有案例 Excel。
- `旺店通.txt`：本地凭据记录或接口资料。
- `node_modules/`：依赖安装目录。

迁移到新机器或 WSL 时，优先从 Git 重新 clone。只按需复制：

- `.env`
- `data/jy-trade-dev.db`，仅在需要保留本地开发数据时复制。
- 私有案例 Excel，仅在需要人工分析样例时复制。

不要复制：

- `node_modules/`
- `outputs/`
- `data/uploads/` 和 `data/exports/`，除非确实要保留历史上传和导出文件。

## 旧目录状态

- `backend/`：保留历史 probe、诊断脚本和少量回归测试。新业务逻辑优先放入 `packages/workflow` 或 `apps/api`。
- `src/jy_trade/`：早期 Python 实验代码。不要作为新功能依赖。
- `examples/`：脱敏 mock 数据，用于开发演示和测试。
- `outputs/`、`data/`、`inputs/`：运行产物和本地数据，不提交。
- `ole案例文件——发货前/`：本地私有案例文件，不提交，不作为自动测试依赖。

`backend/` 不是线上后端。线上 API 在 `apps/api`，`backend/` 只作为 legacy probe 和诊断工具保留。

如需迁移旧 probe，先把可复用逻辑沉淀到 `packages/workflow` 或 `apps/api`，再让 probe 只做命令行包装。

## WSL 开发建议

推荐在 WSL 的 Linux 文件系统中开发，不建议长期在 `/mnt/d/...` 目录中运行 Node 项目。

推荐路径：

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/Queun/project-jy-trade.git
cd project-jy-trade
npm ci
cp .env.example .env
npm run db:migrate
npm test
npm run deploy:check
```

从 Windows 复制必要本地配置：

```bash
cp /mnt/d/Projects/project-jy-trade/.env ~/projects/project-jy-trade/.env
```

如需复制本地开发数据库：

```bash
mkdir -p ~/projects/project-jy-trade/data
cp /mnt/d/Projects/project-jy-trade/data/jy-trade-dev.db ~/projects/project-jy-trade/data/
```

如需复制私有样例文件：

```bash
cp -r /mnt/d/Projects/project-jy-trade/ole案例文件——发货前 ~/projects/project-jy-trade/
```

## 常用命令

主链路命令：

```bash
npm ci
npm run dev:api
npm run dev:web
npm test
npm run deploy:check
npm run db:migrate
```

诊断 probe 命令：

```bash
npm run probe:wdt -- warehouse
npm run probe:wdt:sync-goods -- full
npm run probe:diagnose-order -- <order-file> <output-file>
npm run probe:confirm-mapping -- --external-barcode <barcode> --wdt-spec-no <spec-no>
```

历史 `node:*` 脚本暂时保留为兼容入口，新文档和新流程优先使用 `probe:*`。

提交前至少运行：

```bash
npm run deploy:check
```

涉及 legacy probe 或 `backend/` 诊断脚本时，同时运行：

```bash
npm test
```

## 开发流程

每轮开发建议按以下顺序执行：

1. `git status --short --branch`，确认工作区是否干净。
2. 阅读 `docs/development.md` 和本轮相关业务文档。
3. 明确本轮只改哪些模块，不顺手改无关目录。
4. 实现功能或清理项。
5. 运行对应测试；涉及主链路时运行 `npm run deploy:check`。
6. 检查 `git diff --check` 和 `git status --short`。
7. 提交时只包含本轮相关文件。

文档变更要求：

- 业务规则变更同步更新当前计划或字段字典。
- 部署步骤变更同步更新部署文档。
- 新增命令或目录职责变更同步更新本文。
- 不把临时想法随手写进历史计划文档。

## 测试规则

- 单元测试不得依赖私有 Excel、桌面路径或生产数据库。
- 需要订单 Excel 时，测试应生成脱敏 fixture 到 `outputs/fixtures/`。
- Vitest 根配置会排除 `outputs/`、`data/`、`inputs/`、私有案例目录和构建产物，避免运行产物污染测试发现。
- 真实旺店通接口只做手动集成验证；自动测试使用 mock client 或本地缓存 fixture。
- `allowStaleCache=true` 只用于临时排查商品档案缓存；库存快照即使超过当前自动同步周期仍可使用并明确提醒，不阻断导入和审核。
- 自动测试默认关闭整点同步，不能调用真实旺店通；需要显式验证调度时注入 mock client 和测试时钟。
- 开发环境热更新时可用 `WDT_AUTO_SYNC_ENABLED=false npm run dev:api`，避免在本地无成功快照或快照超过所选周期的情况下，API 重载触发启动补偿同步。

## 数据和隐私

不要提交以下内容：

- `.env` 和任何真实凭据。
- SQLite 数据库和 WAL/SHM 文件。
- 上传订单、导出 Excel、截图、临时产物。
- 私有案例文件、旺店通凭据记录。

发布前检查：

```bash
npm run release:check
```

该命令会阻止已跟踪或未正确忽略的运行数据、私有配置和数据库文件。

## 开发约定

- 新功能优先走当前主链路，不在旧 probe 中另起一套业务规则。
- 涉及数据库 schema 时，同步更新 Drizzle schema、migration、测试和文档。
- 涉及审核、映射、库存、导出字段时，补 API 测试；有前端交互时补 Web 测试。
- 除后台组合同步外，新订单、确定单导入/重算、商品搜索和映射候选不得调用旺店通库存 API，只能读取最新成功的本地快照。
- 确定单数量字段必须保持四种语义独立：`orderQty` 是订货数量，`plannedShipQty` 是源文件实际发货数量，`suggestedShipQty` 是系统库存建议，`approvedShipQty` 是用户最终确认数量。
- 库存查询失败的确定单行必须保留在审核中；普通界面展示业务提示，技术错误只在开发者模式展示。人工填写正数后，提交审核需要整批确认，不能静默通过。
- 普通用户界面避免展示 `mock`、`API`、`production_api` 等技术词；开发者模式可以展示调试入口。
- 商品名称相似匹配只作为候选提示，正式映射需要人工确认。
- SQLite 目前适合低并发内部使用场景，不需要为尚未出现的并发问题优先迁移数据库。
- UI 改动保留用户已经熟悉的核心操作路径和布局，以局部增量优化为主；具体原则见 `PRODUCT.md`。
