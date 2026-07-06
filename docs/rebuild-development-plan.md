# 漾锦贸易订单初审平台：重建开发计划

本文用于新对话交接。当前项目已经回退到健康提交 `f3fc67c Fix production WDT read configuration`，后续开发必须从该基线重新小步推进。核心纪律是：**每个可验证功能都要单独提交 commit**，不得再累积大量未提交改动。

## 1. 当前基线

当前 Git 提交历史：

- `c65d060 Initial project scaffold`
- `250fdd5 Add goods sync status gate to real review`
- `f3fc67c Fix production WDT read configuration`

当前基线已经具备的能力：

- Node/TypeScript monorepo：`apps/api`、`apps/web`、`packages/shared`、`packages/workflow`。
- Fastify API、Vite React Web、SQLite + Drizzle、Vitest、Playwright。
- 登录最小闭环：用户名、密码、session cookie、退出登录。
- 批次基础能力：创建批次、查询批次、读取 review lines。
- mock 初审和真实初审入口。
- 旺店通正式只读配置：正式环境只读，测试 API 只用于契约验证。
- 商品档案同步和同步状态 gate。
- 商品映射相关基础接口和前端面板。
- 审核闭环基础能力：单行审核、批量通过、提交审核。
- 导出基础能力：初审单、确定发货单、做单 Excel 的基础导出、导出历史、下载接口。

当前仍需重建的功能，来自之前讨论和未提交实现：

- 业务 UI 重新整理为 `导入订单 / 审核发货 / 做单` 三个步骤。
- 帮助栏、开发者模式、隐藏 mock/API/debug 字样。
- 角色权限：`admin`、`operator`、`reviewer`。
- 优先处理：管理员/审核人可将订单提前处理。
- 可用仓库设置：主仓、临期仓、次品仓、其他仓的使用规则。
- 做单 Excel 进一步贴合甲方批量做单模板。
- 做单预检查：提前列出缺地址门店。
- 门店发货地址维护：系统内维护地址，优先于地址 Excel。
- 缺地址异常修复：客服/助理可手工填写收货人、电话、地址后重试导出。
- 真实验收报告 CLI。
- 文档更新和手测流程沉淀。

## 2. 工程纪律

默认终端使用 Git Bash，不再用 PowerShell 作为日常开发命令环境。原因是 Git Bash 对 npm 脚本、环境变量、路径和中文输出更稳定。WSL 暂不作为默认选择，除非项目整体迁移到 WSL 文件系统。

乱码处理规则：

- 终端看到乱码时，不立即判断文件损坏。
- 先用 Node 按 UTF-8 读取验证文件内容，例如：
  ```bash
  node -e "const s=require('fs').readFileSync('apps/web/src/App.tsx','utf8'); console.log(s.includes('漾锦贸易订单初审平台'))"
  ```
- 再用浏览器实际查看页面。
- 只有 Node 读取、浏览器渲染、测试输出都异常时，才判断为真实乱码。

提交纪律：

- 每个功能或工程更新必须单独 commit。
- 每个 commit 前必须运行相关测试。
- 不允许把多个产品功能混在一个 commit。
- 不允许提交 `.env`、数据库、`outputs/`、构建产物或临时截图。
- 如果工作树里有与当前任务无关的 dirty 文件，只能暂存本任务文件。

建议 commit 流程：

```bash
git status --short
npm run typecheck
# 按功能选择额外测试
git add <本功能相关文件>
git commit -m "type(scope): message"
git status --short
```

## 3. 分阶段重建计划

### Commit 1：开发纪律和交接文档

建议提交信息：

```bash
git commit -m "docs: add rebuild development plan"
```

内容：

- 新增本文档。
- 明确健康基线、终端约定、乱码判断规则、commit 纪律、重建顺序。

验证：

- `git status --short`
- 文档变更无需跑完整测试，但提交前确认只暂存本文档。

### Commit 2：业务 UI 三步骤重构

建议提交信息：

```bash
git commit -m "feat(web): organize workspace into business tabs"
```

目标：

- 平台名称固定为：`漾锦贸易订单初审平台`。
- 主界面分为三个 tab：`导入订单`、`审核发货`、`做单`。
- 三个 tab 都能选择历史批次。
- 当前批次信息要清晰展示：文件名、批次状态、订单行数、创建时间、更新时间。
- 普通用户界面不展示 `mock`、`production_api`、`API` 等技术词。

不做：

- 本阶段不改权限。
- 本阶段不改导出逻辑。
- 本阶段不新增后端接口。

验证：

- `npm run typecheck`
- `npm run test -w @jy-trade/web`
- `npm run build -w @jy-trade/web`
- 手测登录后 tab 切换、批次选择、审核表仍能显示。

### Commit 3：帮助栏和开发者模式

建议提交信息：

```bash
git commit -m "feat(web): add help panel and developer mode"
```

目标：

- 首次进入默认显示帮助栏，用户可关闭。
- 右上角提供帮助入口，可随时重新打开。
- 用户关闭帮助栏后用 `localStorage` 记住选择。
- 开发者模式开关只影响调试区域展示。
- mock 初审、商品同步状态、调试说明只在开发者模式显示。

验证：

- `npm run typecheck`
- `npm run test -w @jy-trade/web`
- 手测帮助栏关闭、刷新后仍关闭、右上角可重新打开。

### Commit 4：角色权限

建议提交信息：

```bash
git commit -m "feat(auth): enforce role permissions"
```

角色规则：

- `admin`：全部权限。
- `operator`：导入订单、处理异常、导出 Excel、做单地址修复。
- `reviewer`：审核发货、批量通过、提交审核、优先处理。

前端规则：

- 无权限按钮禁用，并显示业务化提示。
- 不用技术错误提示吓用户。

后端规则：

- 关键写操作必须校验权限，不能只靠前端禁用。
- 审计日志记录 actor。

验证：

- `npm run typecheck`
- `npm run test -w @jy-trade/api`
- `npm run test -w @jy-trade/web`
- 手测三类账号权限差异。

### Commit 5：优先处理订单

建议提交信息：

```bash
git commit -m "feat(review): support priority review lines"
```

目标：

- 审核人/admin 可将某行设为优先处理。
- 设为优先处理必须填写原因。
- 优先处理行在审核表排序靠前。
- 可取消优先处理。
- 审计日志记录设置/取消动作。

后端：

- `review_lines` 增加优先处理字段。
- 新增接口：`PATCH /api/v1/batches/:batchId/review-lines/:lineId/priority`。
- 新增共享 DTO：`UpdateReviewLinePriorityRequest`。

前端：

- 审核表显示优先标记。
- 提供设置/取消优先处理入口。
- 筛选项增加“优先处理”。

验证：

- API 测试：缺原因返回 400；设置成功；取消成功；排序正确。
- 前端测试：点击设置优先后行显示标记。
- `npm run typecheck`
- `npm run test`

### Commit 6：可用仓库设置

建议提交信息：

```bash
git commit -m "feat(settings): configure warehouse usage"
```

目标：

- 管理员可设置哪些仓库参与建议发货。
- 默认主仓 `001`、临期仓 `LINQI` 启用。
- 次品仓和其他仓默认不参与建议发货，只展示参考。
- 设置变更后提示“重新运行初审后生效”。

后端：

- 使用 `app_settings` 或同等配置表保存设置。
- 新增接口：
  - `GET /api/v1/settings/warehouse-usage`
  - `PATCH /api/v1/settings/warehouse-usage`
- 新增共享 DTO：
  - `WarehouseUsageSettingsDto`
  - `UpdateWarehouseUsageSettingsRequest`

前端：

- 管理员可打开仓库设置面板。
- operator/reviewer 不可修改。

验证：

- API 测试：默认值、保存、权限、库存建议计算。
- 前端测试：保存设置后显示成功提示。
- `npm run typecheck`
- `npm run test`

### Commit 7：做单 Excel 打磨

建议提交信息：

```bash
git commit -m "feat(exports): refine make-order excel"
```

目标：

- 内部类型继续用 `wdt_import`，对外显示“做单 Excel”。
- 输出 sheet 固定为 `导入表`。
- 表头严格保持甲方 `批量导入模板.xls` 的 49 列顺序。
- 只导出 `decision=ship && approvedShipQty>0` 的行。
- 做单成功后批次状态可更新为 `exported`。
- 不做旺店通推单，不创建销售单，不写库存。

关键字段：

- `店铺名称=KA运营B组`
- `原始单号=orderNoticeNo`
- `收件人/手机/地址` 来自地址匹配
- `网名=M7Z2OLE超市`
- `发货条件=挂账`
- `仓库名称=主仓`
- `物流公司=加密-京东`
- `客服备注=审核原因`
- `打印备注=orderNoticeNo`
- `发票类型=电子普通发票`
- `发票抬头=润家商业(深圳)有限公司`
- `商家编码=wdtSpecNo`
- `货品数量=approvedShipQty`
- `平台货品名称=externalGoodsName`
- `平台规格名称=specName`

验证：

- API 测试：未 reviewed 阻断；只导出审核发货行；sheet 名和 49 列表头正确。
- 读取生成 Excel 校验关键字段。
- `npm run typecheck`
- `npm run test`

### Commit 8：做单预检查

建议提交信息：

```bash
git commit -m "feat(make-order): add readiness precheck"
```

目标：

- 做单前显示可做单行数和缺地址门店。
- 有缺地址门店时，页面提前提示。
- 实际导出仍保持失败保护，不生成脏文件。

后端：

- 新增接口：`GET /api/v1/batches/:batchId/make-order-readiness`。
- 新增共享 DTO：
  - `MakeOrderReadinessDto`
  - `MissingMakeOrderStoreDto`

返回字段：

- `batchId`
- `canExport`
- `shippableLineCount`
- `missingAddressCount`
- `missingStores`

验证：

- API 测试：地址完整可导出；地址缺失列出门店；`pending`、`do_not_ship`、`approvedShipQty=0` 不计入预检查。
- 前端测试：做单 tab 显示预检查结果。
- `npm run typecheck`
- `npm run test`

### Commit 9：门店发货地址维护

建议提交信息：

```bash
git commit -m "feat(addresses): maintain store shipping addresses"
```

目标：

- 系统内维护“门店 -> 发货地址”。
- 系统维护地址优先于地址匹配 Excel。
- 地址匹配 Excel 作为 fallback，读取多个 sheet。
- 地址异常可以通过系统修复，不需要直接改 Excel。

后端：

- 新增 `store_addresses` 表。
- 新增接口：
  - `GET /api/v1/store-addresses?query=...`
  - `POST /api/v1/store-addresses`
- 新增共享 DTO：
  - `StoreAddressDto`
  - `UpsertStoreAddressRequest`
- `POST` 只允许 `admin/operator`。

匹配规则：

- 门店编码精确匹配优先。
- 门店名称规范化精确匹配其次。
- 包含关系兜底，但只用于提示和 fallback，不做复杂智能猜测。

验证：

- API 测试：保存地址、更新地址、查询地址、权限、系统地址覆盖 Excel fallback。
- 做单导出使用系统维护地址。
- `npm run typecheck`
- `npm run test`
- `npm run db:generate`
- `npm run db:migrate`

### Commit 10：缺地址异常在线修复

建议提交信息：

```bash
git commit -m "feat(web): repair missing make-order addresses"
```

目标：

- 做单 tab 中列出缺地址门店。
- operator/admin 可填写收货人、电话、地址并保存。
- 保存后自动刷新预检查。
- reviewer 只能查看，不能修复。
- failed 导出历史显示清楚失败原因。

验证：

- 前端测试：缺地址显示修复表单；保存后调用 `/store-addresses`；预检查刷新为可做单。
- 权限测试：reviewer 看得到但不能保存。
- E2E：缺地址 -> 修复地址 -> 重新生成做单 Excel。
- `npm run typecheck`
- `npm run test`
- `npm run test:e2e -w @jy-trade/web`

### Commit 11：商品与订单异常定位优化

建议提交信息：

```bash
git commit -m "feat(web): improve review exception handling"
```

目标：

- 审核页顶部显示匹配统计：已匹配、需确认、未找到、库存异常。
- 显示审核统计：待审核、发货、不发、超建议数。
- 快速筛选缺货、商品异常、待审核、已发货、不发货、超建议数。
- 商品异常行可以跳转/聚焦商品映射面板。
- 确认映射后提示“重新运行真实初审后生效”。

验证：

- 前端测试：统计显示正确；筛选正确；异常行可定位候选面板。
- `npm run typecheck`
- `npm run test -w @jy-trade/web`

### Commit 12：真实验收报告

建议提交信息：

```bash
git commit -m "feat(reports): add trial acceptance report"
```

目标：

- 新增 CLI：
  ```bash
  npm run node:trial-acceptance -- --batch-id <batchId> --output outputs/trial-acceptance-real.xlsx --require-production-api
  ```
- 报告包含批次信息、匹配统计、审核统计、做单预检查、导出历史和失败原因。
- `--require-production-api` 时拒绝 mock 批次。

验证：

- 单元测试：拒绝 mock、输出 workbook、统计字段正确。
- 手动对真实只读批次生成报告。
- `npm run typecheck`
- `npm run test`

### Commit 13：最终文档和试用验收流程

建议提交信息：

```bash
git commit -m "docs: update trial workflow documentation"
```

目标：

- 更新 `docs/development.md`、`docs/project-plan.md`、`docs/excel-field-dictionary.md`。
- 记录最终业务定位：赋能甲方 Excel 工作流，不做旺店通推单。
- 记录角色权限、做单地址维护、异常修复、验收流程。
- 删除或修正已不准确的历史表述。

验证：

- `npm run typecheck`
- `git status --short --ignored`

## 4. 新对话建议启动语

新开对话时可以直接发：

```text
请读取 docs/rebuild-development-plan.md，并从 Commit 1 开始执行。要求每个功能完成后单独 git commit；提交前运行对应测试；不要累积未提交改动。当前默认终端使用 Git Bash。旺店通正式环境只读，不允许任何写入、推单、创建订单或修改库存。
```

如果新对话只想从某一步继续，例如 UI 三步骤：

```text
请读取 docs/rebuild-development-plan.md，从 Commit 2「业务 UI 三步骤重构」开始执行。完成后运行前端测试和 build，并只提交本功能相关文件。
```

