# 开发说明

本文记录当前可维护主链路。历史 probe 和一次性排查脚本仅在明确需要时使用，不作为新功能入口。

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

## 旧目录状态

- `backend/`：保留历史 probe、诊断脚本和少量回归测试。新业务逻辑优先放入 `packages/workflow` 或 `apps/api`。
- `src/jy_trade/`：早期 Python 实验代码。不要作为新功能依赖。
- `examples/`：脱敏 mock 数据，用于开发演示和测试。
- `outputs/`、`data/`、`inputs/`：运行产物和本地数据，不提交。
- `ole案例文件——发货前/`：本地私有案例文件，不提交，不作为自动测试依赖。

如需迁移旧 probe，先把可复用逻辑沉淀到 `packages/workflow` 或 `apps/api`，再让 probe 只做命令行包装。

## 常用命令

```bash
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
