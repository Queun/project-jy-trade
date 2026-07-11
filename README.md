# 甲方贸易发货初审与做单辅助系统

本项目把订货单导入、旺店通商品与库存快照同步、库存初审、人工审核和 Excel 做单流程串起来。当前保留客户现有 Excel 工作习惯，不直接向旺店通或仓库推单。

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

## 文档入口

- `PRODUCT.md`：稳定的产品边界、用户和界面原则。
- `docs/project-plan.md`：当前能力、待讨论工作和暂缓范围。
- `docs/excel-field-dictionary.md`：Excel 输入、输出和业务字段契约。
- `docs/technical-architecture.md`：当前技术架构、模块边界和关键取舍。
- `docs/development.md`：目录职责、开发命令、测试要求和提交规则。
- `docs/deployment.md`：腾讯云部署、升级、备份和上线初始化。
- `docs/archive/`：历史验证和重建记录，不作为当前开发依据。

代码实现与文档发生冲突时，先核对当前测试和实际业务规则，再同步修正文档；不要继续复制已经过期的描述。

凭据只放本地 `.env`，不要提交真实账号、`sid`、`appkey`、`appsecret`。默认开发数据库位于 `data/jy-trade-dev.db`，该目录已被 Git 忽略。
