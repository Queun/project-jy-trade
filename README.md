# 甲方贸易发货初审与做单辅助系统

本项目用于把订货单导入、旺店通商品/库存查询、库存初审、人工审核和 Excel 做单流程串起来。当前阶段先保留客户现有 Excel 工作习惯，不直接向旺店通或仓库推单。

## 快速开始

要求 Node.js 24 LTS。

```powershell
npm install
npm run db:generate
npm run typecheck
npm run test
```

启动 Web MVP：

```powershell
npm run dev:api
npm run dev:web
```

继续保留的脚本验证入口：

```powershell
npm run node:simulate -- "ole案例文件——发货前\1订货单\订货通知单 .xls" cjmy003-test outputs\review-simulation-mock.xlsx examples\mock_flow_data.json
npm run node:wdt -- warehouse cjmy003-test
```

## 文档入口

- `docs/development.md`：开发者事实来源、目录结构、命令、工程约定。
- `docs/technical-architecture.md`：技术栈、架构取舍、多用户协作预留。
- `docs/api-test-plan.md`：旺店通 API、测试环境、签名和探测记录。
- `docs/excel-field-dictionary.md`：样例 Excel 字段字典。
- `docs/flow-simulation.md`：mock/API 流程模拟记录。

凭据只放本地 `.env`，不要提交真实账号、`sid`、`appkey`、`appsecret`。默认开发数据库位于 `data/jy-trade-dev.db`，该目录已被 Git 忽略。
