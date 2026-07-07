# 甲方贸易发货初审与做单辅助系统

本项目用于把订货单导入、旺店通商品/库存查询、库存初审、人工审核和 Excel 做单流程串起来。当前阶段先保留客户现有 Excel 工作习惯，不直接向旺店通或仓库推单。

## 快速开始

要求 Node.js 24 LTS。推荐在 WSL/Linux 文件系统中开发。

```bash
npm ci
npm run db:migrate
npm run test
npm run deploy:check
```

启动本地服务：

```bash
npm run dev:api
npm run dev:web
```

旧诊断脚本仍保留，但不是新功能入口。使用前先阅读 `docs/development.md` 中的旧目录说明。

## 开发入口

- `docs/development.md`：开发入口、目录职责、资源清单、迁移清单和开发流程。
- `docs/project-plan.md`：当前产品和开发计划。
- `docs/deployment.md`：腾讯云部署、Nginx、进程管理、备份和发布流程。
- `docs/excel-field-dictionary.md`：Excel 字段字典。
- `docs/technical-architecture.md`：技术架构和关键取舍。

凭据只放本地 `.env`，不要提交真实账号、`sid`、`appkey`、`appsecret`。默认开发数据库位于 `data/jy-trade-dev.db`，该目录已被 Git 忽略。
