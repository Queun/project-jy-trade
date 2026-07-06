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

## 1.1 当前恢复状态核对

本段记录 2026-07-06 重新规划时看到的事实，后续新对话必须先核对，不能默认工作区干净：

- 当前 `HEAD` 已在 `193d355 docs: add rebuild development plan`，说明本文档的初版已经单独提交。
- 当前工作区仍有未提交文件：`apps/web/src/App.test.tsx`。
- 该测试文件内存在合并冲突标记和上一轮未提交功能痕迹，包括优先处理、仓库设置、做单预检查、门店地址维护等测试片段。
- 该文件不能直接混入后续任何功能提交；开始功能重建前必须先“隔离或修复”它。
- 由于该文件可能包含上一轮丢失功能的线索，不能直接删除或回滚，除非人工确认这些线索已经被记录并且不再需要。

恢复前置检查命令：

```bash
git status --short --branch
rg -n "^(<<<<<<<|=======|>>>>>>>)" apps docs packages backend
npm run typecheck
```

如果 `rg` 仍能找到冲突标记，禁止进入任何产品功能开发。

## 1.2 防止再次回溯丢功能的机制

后续开发必须把“功能是否存在”变成可验证事实，而不是依赖对话记忆：

- 每个功能开始前，在本文档对应 commit 段落下补齐“范围、接口/数据结构、测试、手测验收、不得包含的内容”。
- 每个功能结束时，只提交本功能文件，并在提交信息或提交说明里写明验证命令。
- 每次提交前必须运行冲突扫描：`rg -n "^(<<<<<<<|=======|>>>>>>>)" apps docs packages backend`。
- 每次提交前必须确认未混入产物：`.env`、`data/`、`outputs/`、`node_modules/`、截图、临时 Excel。
- 涉及数据库 schema 的功能必须同一 commit 包含：Drizzle schema、migration、DTO、API 测试、必要文档。
- 涉及前端业务流的功能必须同一 commit 包含：组件/页面、组件测试，必要时补 Playwright。
- 涉及导出 Excel 的功能必须用程序读取生成文件，校验 sheet 名、表头、关键字段，不只看页面提示。
- 正式旺店通环境仍只允许只读接口；任何写入、推单、建单、改库存都不属于本轮重建范围。

建议每个 commit 完成后记录一行验收日志，例如：

```text
Commit N 完成：<commit hash>；验证：typecheck / api test / web test / build / 手测项。
```

## 1.3 重建依赖顺序

后续功能按以下依赖推进，不要为了赶进度跨层混做：

1. 工作区卫生：先完成 Commit 1A，确保没有冲突标记、测试基线可运行。
2. 前端信息架构：Commit 2 和 Commit 3 只重排现有能力，不改后端业务规则。
3. 权限基座：Commit 4 先把角色权限在前后端打牢，再做依赖权限的业务功能。
4. 审核增强：Commit 5 优先处理依赖权限和 review line schema。
5. 库存策略：Commit 6 可用仓库设置依赖权限，并影响真实初审和建议发货计算。
6. 做单导出：Commit 7 先把 Excel 模板打准，再做预检查和地址修复。
7. 做单异常闭环：Commit 8、9、10 依次完成预检查、地址维护、在线修复。
8. 异常定位和验收：Commit 11、12、13 用于提升试用可解释性和沉淀文档。

每一层完成前，不要提前提交下一层功能测试。可以先在本文档补需求，但代码必须跟对应功能一起提交。

## 1.3.1 产品和 UI 设计原则

本项目是给内部运营、客服、审核人员反复使用的工作台，不是营销页。后续 UI 重建必须以清晰、稳定、高效为主：

- 第一屏直接进入业务工作台，不做宣传式 landing page。
- 信息架构按真实流程组织：`导入订单 -> 审核发货 -> 做单`。
- 页面视觉要简洁、美观、易用、合理，减少装饰性元素，优先让用户快速判断状态和下一步动作。
- 布局应适合高频办公：紧凑但不拥挤，表格、筛选、批次信息和操作按钮位置稳定。
- 普通用户界面隐藏 `mock`、`API`、`production_api`、debug 等技术词；技术状态只在开发者模式显示。
- 按钮文案使用业务语言，例如“导入新订单”“提交审核完成”“生成做单 Excel”，避免“run real review”这类实现语言。
- 关键状态使用一致的颜色和徽标：待处理、可发货、异常、已完成、失败。
- 不使用大面积渐变、装饰卡片堆叠或花哨背景；后台工作台应保持克制。
- 移动端不作为主场景，但窄屏不能出现文字重叠、按钮溢出、表格控制不可用。
- 每次 UI 改动必须至少验证：登录页、批次列表、三个业务 tab、审核表、导出区在桌面宽度下不重叠、不跳动。

后续如果 UI 方案和业务效率冲突，优先业务效率；如果美观和信息密度冲突，优先清晰的信息层级。

## 1.3.2 讨论版重建路线

当前讨论确认的路线分为五层：

1. 止血和证据留存：先处理 `apps/web/src/App.test.tsx` 冲突，提取上一轮功能线索，恢复干净测试基线。
2. 可用工作台骨架：恢复三步骤业务 UI、帮助栏、开发者模式，让普通用户看到的是业务流程而不是技术调试台。
3. 权限和审核增强：固定 `admin/operator/reviewer` 三角色，后端校验关键写操作，再恢复优先处理等审核功能。
4. 仓库策略和做单闭环：恢复可用仓库设置、甲方做单 Excel、做单预检查、门店地址维护和缺地址在线修复。
5. 验收和文档沉淀：补真实验收报告 CLI，更新文档和手测流程，确保后续不靠对话记忆交接。

当前倾向：

- `App.test.tsx` 冲突内容先整理成需求证据，再清理文件。
- 权限先做固定三角色，不做完整用户管理界面。
- 做单 Excel 优先保证 49 列模板、业务字段和可导入性；复杂样式可在字段正确后再打磨。

仍可继续讨论的问题：

- 是否需要在 `docs/` 新增单独的“恢复证据清单”，还是全部沉淀在本文档。
- UI 是否维持当前 Tailwind/shadcn 风格，还是趁重构时建立更明确的页面组件分层。
- 做单 Excel 样式是否必须第一版就完全贴近甲方模板，还是先通过导入校验。

## 1.4 每轮开工检查清单

每次从新对话或新工作日继续时，先执行：

```bash
git status --short --branch
git log --oneline --decorate --max-count=8
rg -n "^(<<<<<<<|=======|>>>>>>>)" apps docs packages backend
```

判断规则：

- 有未提交文件：先确认是否属于当前任务；不属于则不要暂存。
- 有冲突标记：先做 Commit 1A 或对应冲突修复，不进入功能开发。
- `HEAD` 不在预期 commit：先停止并说明当前提交位置，不要盲目继续。
- 发现上一轮未提交功能痕迹：先沉淀到本文档，再决定是否实现。

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
rg -n "^(<<<<<<<|=======|>>>>>>>)" apps docs packages backend
npm run typecheck
# 按功能选择额外测试
git add <本功能相关文件>
git commit -m "type(scope): message"
git status --short
```

## 3. 分阶段重建计划

### Commit 1：开发纪律和交接文档（已完成）

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

当前状态：

- 已提交：`193d355 docs: add rebuild development plan`。
- 后续不要重复做这个 commit；如需调整计划，使用新的 docs commit。

### Commit 1A：工作区冲突隔离和重建证据留存

建议提交信息：

```bash
git commit -m "chore: clean rebuild worktree baseline"
```

目标：

- 处理 `apps/web/src/App.test.tsx` 的冲突标记。
- 从该文件中提取上一轮未提交功能线索，确保已对应到本文档的后续 commit。
- 恢复测试文件到可解析、可运行状态；如果暂不实现那些功能测试，则只保留当前基线已有功能的测试。
- 不在本 commit 实现任何产品功能。

处理原则：

- 不能直接提交带 `<<<<<<<`、`=======`、`>>>>>>>` 的文件。
- 不能把上一轮“功能测试片段”留在当前基线测试里，除非对应功能已经在本 commit 真实实现。
- 如果某段测试代表未来功能，把需求沉淀到本文档；代码测试等到对应功能 commit 再加入。
- 如果需要保留原始冲突内容作为参考，只能放到不参与构建、不提交的本地临时记录，或整理成本文档中的需求条目。

验证：

- `git status --short`
- `rg -n "^(<<<<<<<|=======|>>>>>>>)" apps docs packages backend` 无结果。
- `npm run typecheck`
- `npm run test -w @jy-trade/web`
- 如只改测试文件，不运行完整 E2E；但必须保证后续功能 commit 可以从干净基线开始。

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
- 布局采用“顶部状态栏 + 左侧/上方批次选择 + 主工作区”的稳定结构，避免多个大卡片互相嵌套。
- `导入订单` tab 聚焦创建批次、运行初审、商品同步状态；不要把审核表和导出历史挤在同一屏。
- `审核发货` tab 聚焦统计、筛选、审核表、批量通过、提交审核。
- `做单` tab 聚焦导出类型、做单 Excel、导出历史；后续预检查和地址修复都挂在这里。
- 操作按钮应按主次分层：主操作明显，次要操作收敛；危险/失败状态要有清晰反馈。
- 页面宽度、表格、筛选区、按钮区要有稳定尺寸，切换 tab 或筛选时不应明显跳动。

不做：

- 本阶段不改权限。
- 本阶段不改导出逻辑。
- 本阶段不新增后端接口。
- 本阶段不引入新的设计系统或大规模组件库迁移。
- 本阶段不做营销风格 hero、装饰背景或无业务价值的视觉元素。

验证：

- `npm run typecheck`
- `npm run test -w @jy-trade/web`
- `npm run build -w @jy-trade/web`
- 手测登录后 tab 切换、批次选择、审核表仍能显示。
- 手测普通用户视角不出现 `mock`、`API`、`production_api` 等技术词。
- 手测桌面宽度下顶部状态、批次列表、三个 tab、审核表和导出区没有文字重叠或按钮溢出。

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
请读取 docs/rebuild-development-plan.md，先执行“每轮开工检查清单”，然后从 Commit 1A「工作区冲突隔离和重建证据留存」开始。要求每个功能完成后单独 git commit；提交前运行冲突扫描和对应测试；不要累积未提交改动。当前默认终端使用 Git Bash。旺店通正式环境只读，不允许任何写入、推单、创建订单或修改库存。
```

如果 Commit 1A 已完成，且工作区确认干净，可以从某一步继续，例如 UI 三步骤：

```text
请读取 docs/rebuild-development-plan.md，先执行“每轮开工检查清单”。确认无冲突标记、无无关 dirty 文件后，从 Commit 2「业务 UI 三步骤重构」开始执行。完成后运行前端测试和 build，并只提交本功能相关文件。
```
