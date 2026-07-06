# 腾讯云部署准备

本文记录当前项目部署到腾讯云 CVM 的推荐方式。当前第一版生产部署仍使用 `tsx` 运行 TypeScript API 源码，因此服务器需要安装完整 npm 依赖，不使用 `--omit=dev`。

## 目录约定

建议服务器目录固定为：

```text
/opt/jy-trade/current        # Git 工作目录
/opt/jy-trade/shared/.env    # 生产环境变量，不提交
/opt/jy-trade/shared/data    # SQLite 数据库
/opt/jy-trade/shared/outputs # 导出文件、验收报告
/opt/jy-trade/shared/inputs  # 上传的订货单
/opt/jy-trade/shared/logs    # systemd 日志
/opt/jy-trade/shared/backups # 数据库备份
```

进入项目目录后，用软链接把运行时目录挂到仓库根目录：

```bash
mkdir -p /opt/jy-trade/shared/{data,outputs,inputs,logs,backups}
ln -sfn /opt/jy-trade/shared/data /opt/jy-trade/current/data
ln -sfn /opt/jy-trade/shared/outputs /opt/jy-trade/current/outputs
ln -sfn /opt/jy-trade/shared/inputs /opt/jy-trade/current/apps/api/inputs
```

这样代码更新不会覆盖数据库、上传文件和导出文件。

## 生产数据归属

上线后运行时数据统一放在 `/opt/jy-trade/shared`，不要放在 Git 工作目录的普通文件夹里：

- SQLite 数据库：`/opt/jy-trade/shared/data/jy-trade-prod.db`，由 `DATABASE_URL=file:data/jy-trade-prod.db` 指向。订单批次、审核决定、商品档案缓存、地址簿、用户和审计日志都在这里。
- 用户上传的订货单：`/opt/jy-trade/shared/inputs/uploads`。API 实际写入 `apps/api/inputs/uploads`，生产环境通过软链接落到 shared 目录。
- 系统生成的导出文件：`/opt/jy-trade/shared/outputs/exports`，包括初审单、确定发货单、做单表格等。
- 日志：`/opt/jy-trade/shared/logs`，由 systemd 服务写入。
- 备份：`/opt/jy-trade/shared/backups`，建议至少保存数据库每日备份。

必须纳入备份的目录：

- `shared/data`：最高优先级，丢失后批次、审核记录、地址、商品缓存都会丢失。
- `shared/inputs`：用户原始上传文件，便于追溯和重新生成。
- `shared/outputs`：导出产物，可由数据库和原始文件重新生成，但仍建议随数据库备份。

管理员删除批次时，系统会删除该批次、审核明细、审核决定、商品匹配候选、导出记录，并清理运行时上传目录和导出目录内的相关文件。审计日志保留，用于追溯谁删除了批次。为了避免误删模板或案例文件，批次引用到项目样例目录的源文件不会被删除。

## Git 上传边界

服务器通过 `git pull` 更新代码时，只上传代码、迁移、部署配置示例和必要模板，不上传本地运行时数据：

- 不上传：`data/`、`outputs/`、`inputs/`、`apps/api/inputs/`、`.env`、`.env.*` 私有环境变量、SQLite 数据库和 `*-wal` / `*-shm` / `*-journal` 文件。
- 可以上传：`apps/api/drizzle` 迁移文件、`deploy/*.example`、`.env.production.example`、业务代码、测试代码、文档、Excel 模板和案例文件。
- 提交前运行 `npm run release:check`。如果误把数据库、导出文件、上传订单或私有环境变量纳入 Git，该命令会失败。

生产数据库不建议从本地一起上传。首版上线建议让服务器初始化一份空的 `jy-trade-prod.db`，然后在系统里完成初始化动作：

1. 用 `admin / jymy` 登录。
2. 在“设置”里手动同步商品档案。
3. 在“地址维护”里导入门店地址 Excel。地址数据会写入 `store_addresses` 表，系统维护地址会优先于模板 Excel。
4. 再导入真实订单并生成批次。

如果以后确实需要迁移生产数据，应单独走数据库备份/恢复流程，不通过 Git 提交数据库文件。

## 首次部署

1. 准备服务器安全组：开放 `22`、`80`，如启用 HTTPS 再开放 `443`。
2. 安装运行环境：Node.js 24、npm、Git、Nginx。
3. 创建独立用户：

```bash
sudo useradd --system --create-home --shell /bin/bash jytrade
sudo mkdir -p /opt/jy-trade
sudo chown -R jytrade:jytrade /opt/jy-trade
```

4. 拉取代码并安装依赖：

```bash
sudo -iu jytrade
git clone <repo-url> /opt/jy-trade/current
cd /opt/jy-trade/current
npm ci
```

5. 创建生产环境变量：

```bash
mkdir -p /opt/jy-trade/shared
cp .env.production.example /opt/jy-trade/shared/.env
chmod 600 /opt/jy-trade/shared/.env
```

必须修改 `/opt/jy-trade/shared/.env`：

- `WDT_PROD_SID`
- `WDT_PROD_APPKEY`
- `WDT_PROD_APPSECRET`
- `DATABASE_URL=file:data/jy-trade-prod.db`

默认引导管理员为 `admin / jymy`。`JY_TRADE_BOOTSTRAP_PASSWORD` 只在用户表里还没有该账号时生效；如果生产数据库里已经存在 `admin`，修改 `.env` 不会自动覆盖旧密码。

6. 创建运行时目录和软链接，执行数据库迁移：

```bash
mkdir -p /opt/jy-trade/shared/{data,outputs,inputs,logs,backups}
ln -sfn /opt/jy-trade/shared/data /opt/jy-trade/current/data
ln -sfn /opt/jy-trade/shared/outputs /opt/jy-trade/current/outputs
ln -sfn /opt/jy-trade/shared/inputs /opt/jy-trade/current/apps/api/inputs
set -a
. /opt/jy-trade/shared/.env
set +a
npm run db:migrate
```

7. 构建前端并做部署前检查：

```bash
npm run deploy:check
```

8. 安装 systemd 服务：

```bash
sudo cp deploy/jy-trade-api.service.example /etc/systemd/system/jy-trade-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now jy-trade-api
sudo systemctl status jy-trade-api
curl http://127.0.0.1:3001/api/v1/health
```

9. 安装 Nginx 配置：

```bash
sudo cp deploy/nginx-jy-trade.conf.example /etc/nginx/conf.d/jy-trade.conf
sudo nginx -t
sudo systemctl reload nginx
```

浏览器访问服务器公网 IP，确认登录页可打开。

## 日常发布

发布前先备份 SQLite：

```bash
sudo -iu jytrade
cd /opt/jy-trade/current
mkdir -p /opt/jy-trade/shared/backups
cp /opt/jy-trade/shared/data/jy-trade-prod.db "/opt/jy-trade/shared/backups/jy-trade-prod-$(date +%Y%m%d-%H%M%S).db"
```

更新代码并重启：

```bash
git pull --ff-only
npm ci
set -a
. /opt/jy-trade/shared/.env
set +a
npm run db:migrate
npm run deploy:check
sudo systemctl restart jy-trade-api
sudo systemctl reload nginx
```

验收：

```bash
curl http://127.0.0.1:3001/api/v1/health
systemctl status jy-trade-api --no-pager
tail -n 100 /opt/jy-trade/shared/logs/api-error.log
```

## 当前目录说明

部署时真正需要关注的目录：

- `apps/api`：后端 API、数据库 schema、迁移、导出生成。
- `apps/web`：前端工作台，构建产物在 `apps/web/dist`。
- `packages/shared`：前后端共享 DTO。
- `packages/workflow`：订单解析、匹配、初审计算。
- `backend/src/integrations`：旺店通签名和只读 API 客户端。
- `data`、`outputs`、`inputs`：运行时目录，不提交 Git，生产上必须备份。

私有案例 Excel、真实订单、地址表和导出产物都不要提交 Git。做单导出始终使用代码内置表头生成，门店地址通过上线后的地址维护页面导入并保存在数据库。

## 风险点

- 当前 API 运行依赖 `tsx`，所以生产服务器需要完整依赖。后续可以单独做“编译后运行”改造。
- SQLite 是单机文件数据库，必须纳入服务器快照和文件备份。
- 旺店通正式环境只允许只读接口；本项目当前不推单、不写库存。
- 商品档案同步不等于库存同步；真实初审时会额外调用库存接口查询可发库存。
