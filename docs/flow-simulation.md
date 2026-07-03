# 流程模拟记录

本记录用于说明当前系统如何用旺店通测试环境模拟完整链路。

## 当前模拟链路

```text
订货单 Excel
  -> 读取订单明细
  -> 提取唯一商品条码
  -> 调用 goods.Goods.queryWithSpec 按条码、商品编码、商家编码匹配旺店通规格
  -> 条码/编码无法可靠命中时，从 wms.StockSpec.search2 的库存返回中提取候选并按名称相似度提示
  -> 唯一匹配时调用 wms.StockSpec.search2 查询库存
  -> 按订单上传时间滚动分配库存
  -> 导出发货初审模拟 Excel
```

## 命令

用真实样例订货单跑测试环境：

```powershell
npm run node:simulate -- "ole案例文件——发货前\1订货单\订货通知单 .xls" cjmy003-test outputs\review-simulation-test.xlsx
```

生成测试环境可命中条码的最小订货单：

```powershell
npm run node:make-test-order -- keleVial001
```

用最小测试订货单跑完整链路：

```powershell
npm run node:simulate -- outputs\test-api-order.xlsx cjmy003-test outputs\review-simulation-test-api-hit-kele.xlsx
```

使用 mock 数据跑完整库存分配：

```powershell
npm run node:simulate -- "ole案例文件——发货前\1订货单\订货通知单 .xls" cjmy003-test outputs\review-simulation-mock.xlsx examples\mock_flow_data.json
```

使用混合 mock 数据覆盖多候选和未匹配：

```powershell
npm run node:simulate -- "ole案例文件——发货前\1订货单\订货通知单 .xls" cjmy003-test outputs\review-simulation-mixed.xlsx examples\mock_flow_mixed.json
```

## 已验证结果

### 测试环境真实库存样本

输出文件：`outputs\review-simulation-test-api-real-stock.xlsx`

测试条码：`A11010212`

测试仓库：`YS-02`

结果：

- 订单明细：1 行。
- 唯一条码：1 个。
- 匹配成功条码：1 个。
- 命中旺店通商家编码：`A11010212`。
- `wms.StockSpec.search2` 返回真实库存行。
- 测试仓库 `YS-02` 可发库存：196。
- 初审状态：`库存充足`。

结论：

`订货单 Excel -> 货品档案查询 -> 库存查询2 -> 滚动库存初审 -> 初审 Excel 导出` 已经用测试 API 的真实返回结构跑通，不依赖本地 mock。

命令：

```powershell
npm run node:make-test-order -- A11010212
npm run node:simulate -- outputs\test-api-order.xlsx YS-02 outputs\review-simulation-test-api-real-stock.xlsx
```

### 条码错误但名称接近的边界

输出文件：`outputs\review-simulation-name-fallback.xlsx`

测试方式：

- 基于测试环境真实库存商品 `A11010212` 生成订货单。
- 将订货单条码改为不存在的 `NO_SUCH_BARCODE_001`。
- 保留接近真实库存商品的商品名称：`万益蓝WonderLab 益家小蓝瓶...`。
- 运行模拟流程时使用测试 API 的 `wms.StockSpec.search2` 返回作为候选池，不使用本地 mock。

结果：

- 订单明细：1 行。
- 匹配成功条码：0 个。
- 匹配结果：`ambiguous`。
- 初审状态：`未匹配`。

结论：

名称兜底只用于产生候选和提示人工确认，不会自动形成可发库存。这样可以覆盖条码缺失、条码错误、名称轻微差异的场景，同时避免名称误匹配导致误发货。

### 样例订货单

输出文件：`outputs\review-simulation-test.xlsx`

结果：

- 订单明细：40 行。
- 唯一条码：4 个。
- 匹配成功条码：0 个。
- 匹配结果：4 个条码均为 `not_found`。
- 初审状态：40 行均为 `未匹配`。

原因：

旺店通测试环境没有甲方真实商品数据，所以样例订货单中的真实条码无法命中。这符合预期。

### 测试环境命中条码

输出文件：`outputs\review-simulation-test-api-hit-kele.xlsx`

测试条码：`keleVial001`

结果：

- 订单明细：1 行。
- 唯一条码：1 个。
- 匹配成功条码：1 个。
- 命中旺店通商家编码：`kele001`。
- 命中规格名称：`小瓶`。
- 测试仓库库存：0。
- 初审状态：`库存不足`。

结论：

`条码匹配 -> 规格确认 -> 库存查询 -> 初审结果 -> Excel 导出` 的成功链路已跑通。

## 重要发现

测试条码 `test001` 和 `TEST001` 在测试环境会返回多个候选规格，系统会标记为 `ambiguous`，不自动匹配。

这说明真实环境中也必须保留“多候选人工确认”机制。条码查询不能只看接口是否返回商品，而要精确检查规格层的 `barcode` 和 `barcode_list`。如果仍然存在多个候选，必须交给审核人或商品维护人员确认。

当前匹配优先级：

1. 唯一条码命中：自动 `matched`。
2. 唯一商品编码/商家编码命中：自动 `matched`。
3. 多个条码或编码候选：`ambiguous`。
4. 仅名称相似：`ambiguous`，等待人工确认。
5. 无可靠候选：`not_found`。

`goods.Goods.queryWithSpec` 的 `goods_name` / `spec_name` 查询在测试环境中要求 `start_time`、`end_time`，且查询跨度不能超过 30 天；实测按名称查询会返回大量不相关商品，不能作为实时精确搜索入口。当前流程不把实时名称查询作为主召回方式，而是使用库存接口或未来商品档案缓存形成候选池，再用名称相似度排序。

## 真实 API 到位后的微调点

- 配置正式主仓和临期仓的 `warehouse_no`。
- 用甲方真实条码验证 `goods.Goods.queryWithSpec` 的命中情况。
- 确认多候选比例，以及是否需要维护人工商品映射表。
- 确认 `available_send_stock` 是否作为可发库存主字段。
- 如果临期仓是独立仓库，需要对主仓、临期仓分别查库存并合并到初审行。
- 将当前模拟 Excel 调整为客户最终审核表格式。

## 2026-07-02 正式 API 样例验证补充

当前样例订货单在正式只读 API 下验证结果：

- 输出文件：`outputs/review-simulation-prod-matching-warehouses.xlsx`。
- 样例订货单 40 行，唯一外部条码 4 个。
- 其中 3 个条码可通过 `goods.Goods.queryWithSpec` 直接按条码命中，并继续用 `wms.StockSpec.search2` 查询库存。
- `2153722460015` 不能按条码命中；用近期商品档案候选池打分时，可找到名称高度接近的候选 `3282770392869 / 雅漾专研保湿修护面膜 / 25ml*5`，但因外部条码和旺店通条码不同，系统必须标记为 `ambiguous`，交由人工确认映射，不能自动作为可发货品。
- `goods.Goods.queryWithSpec` 的 `goods_name` 查询需要 `start_time` / `end_time`，且实测 `goods_name=雅漾` 返回大量无关商品，不能作为实时精确搜索入口。

当前库存策略已经调整为：对已匹配 SKU 调用 `wms.StockSpec.search2` 时不指定 `warehouse_no`，先读取全仓库存，再按仓库号分组：

- 主仓：默认 `001`，也包含命令传入的主仓号。
- 临期仓：默认 `LINQI`。
- 次品仓：默认 `CIPIN`，或接口行 `defect=true`。
- 其他仓：除以上分组外的实体仓、代销仓、门店仓等。

导出的 `review_simulation` sheet 增加 `defectAvailableBefore`、`otherAvailableBefore`、`warehouseBreakdown`；`match_candidates` sheet 记录匹配候选、分数和命中依据。

工程结论：名称模糊匹配不能依赖每次上传订单时实时全量扫描旺店通 API。正式产品应增加“旺店通商品档案缓存/同步任务”和“人工映射表”：外部条码/外部名称/规格 -> 旺店通 `spec_no`。订单流程优先使用人工确认过的映射，其次条码/编码精确查询，最后使用缓存候选池给出 `ambiguous` 候选。
