# 开发说明

本文记录当前可维护主链路。历史 probe 和一次性排查脚本仅在明确需要时使用，不作为新功能入口。

## 文档入口

文档按用途维护，避免同一类计划散落在多个文件中。

- `docs/development.md`：开发入口、目录职责、资源清单、开发流程和迁移清单。
- `docs/project-plan.md`：当前产品和开发计划的唯一入口。
- `docs/deployment.md`：腾讯云部署、Nginx、进程管理、备份和发布流程。
- `docs/excel-field-dictionary.md`：Excel 样例字段字典，后续导出字段对照也应沉淀到这里。
- `docs/technical-architecture.md`：技术架构和关键取舍。
- `docs/archive/api-test-plan.md`：旺店通 API 探测记录和接口验证背景，仅作历史参考。
- `docs/archive/flow-simulation.md`：早期流程模拟记录，仅作历史参考。
- `docs/archive/rebuild-development-plan.md`：本轮重建历史计划，不再追加新的开发待办。

文档管理规则：

- 新一轮开发计划只更新 `docs/project-plan.md`。
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

1. 设置中手动同步商品档案。
2. 页面上传订货单并创建正式批次。
3. 后端读取本地商品档案缓存、人工商品映射，并只读查询旺店通库存。
4. 前端审核发货数量、优先处理、不发货等决策。
5. 做单页面生成初审明细、确定发货单、批量做单表格等导出文件。

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

```bash
npm ci
npm run dev:api
npm run dev:web
npm test
npm run deploy:check
npm run db:migrate
```

提交前至少运行：

```bash
npm run deploy:check
```

涉及旧 `backend/` 诊断脚本时，同时运行：

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
- `allowStaleCache=true` 只用于临时排查，正式初审必须要求最近一次商品档案同步成功。

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
- 普通用户界面避免展示 `mock`、`API`、`production_api` 等技术词；开发者模式可以展示调试入口。
- 商品名称相似匹配只作为候选提示，正式映射需要人工确认。
- SQLite 目前适合本项目规模，最多 3 人同时使用时不需要优先迁移数据库。
