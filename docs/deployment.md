# 腾讯云部署指南

本文按当前试运行口径编写：可以直接使用 `root` 部署，运行时数据目录通过环境变量配置，不需要软链接。

## 必须准备

- 一台腾讯云 CVM。
- 安全组开放 `22` 和 `80`。正式启用 HTTPS 时再开放 `443`。
- 服务器安装 Node.js、npm、Git、Nginx。
- GitHub 仓库可从服务器拉取。

## 目录约定

推荐目录：

```text
/opt/jy-trade/current          # Git 工作目录
/opt/jy-trade/current/data     # SQLite、上传文件、导出文件
/opt/jy-trade/backups          # 数据库备份
```

这次不强制创建独立 Linux 用户，也不要求软链接。运行数据目录由 `.env` 控制：

```env
DATABASE_URL=file:data/jy-trade-prod.db
JY_TRADE_UPLOAD_DIR=data/uploads
JY_TRADE_EXPORTS_DIR=data/exports
```

相对路径会按项目根目录解析；如果要更明确，也可以写绝对路径，例如：

```env
DATABASE_URL=file:/opt/jy-trade/current/data/jy-trade-prod.db
JY_TRADE_UPLOAD_DIR=/opt/jy-trade/current/data/uploads
JY_TRADE_EXPORTS_DIR=/opt/jy-trade/current/data/exports
```

## 首次部署

```bash
mkdir -p /opt/jy-trade
git clone https://github.com/Queun/project-jy-trade.git /opt/jy-trade/current
cd /opt/jy-trade/current
npm ci
```

创建生产环境配置：

```bash
cp .env.production.example .env
chmod 600 .env
mkdir -p data/uploads data/exports backups
```

`data/uploads`、`data/exports` 和 SQLite 数据库父目录会由应用或迁移命令自动创建；上面的 `mkdir` 只是首次部署时显式预创建，便于检查权限和目录位置。

编辑 `.env`，至少确认：

```env
NODE_ENV=production
API_PORT=3001
DATABASE_URL=file:data/jy-trade-prod.db
JY_TRADE_UPLOAD_DIR=data/uploads
JY_TRADE_EXPORTS_DIR=data/exports
JY_TRADE_BOOTSTRAP_USERNAME=admin
JY_TRADE_BOOTSTRAP_PASSWORD=jymy
```

如果暂时只验证页面、登录、订单导入、地址维护，可以先不填旺店通配置。真实商品同步、真实初审和库存查询需要填写 WDT 配置。

初始化数据库并检查构建：

```bash
set -a
. ./.env
set +a

npm run db:migrate
npm run deploy:check
```

## systemd 服务

复制示例服务：

```bash
cp deploy/jy-trade-api.service.example /etc/systemd/system/jy-trade-api.service
systemctl daemon-reload
systemctl enable --now jy-trade-api
systemctl status jy-trade-api --no-pager
curl http://127.0.0.1:3001/api/v1/health
```

如果使用 root 运行，确认 `/etc/systemd/system/jy-trade-api.service` 中：

```ini
User=root
Group=root
WorkingDirectory=/opt/jy-trade/current
EnvironmentFile=/opt/jy-trade/current/.env
```

## Nginx

```bash
cp deploy/nginx-jy-trade.conf.example /etc/nginx/conf.d/jy-trade.conf
nginx -t
systemctl reload nginx
```

然后访问服务器公网 IP。

## 日常发布

发布前建议备份数据库：

```bash
cd /opt/jy-trade/current
mkdir -p /opt/jy-trade/backups
cp data/jy-trade-prod.db "/opt/jy-trade/backups/jy-trade-prod-$(date +%Y%m%d-%H%M%S).db"
```

更新代码：

```bash
cd /opt/jy-trade/current
git pull --ff-only
npm ci

set -a
. ./.env
set +a

npm run db:migrate
npm run deploy:check
systemctl restart jy-trade-api
systemctl reload nginx
```

验收：

```bash
curl http://127.0.0.1:3001/api/v1/health
systemctl status jy-trade-api --no-pager
tail -n 100 data/logs/api-error.log
```

如果没有配置日志文件，也可以看 systemd 日志：

```bash
journalctl -u jy-trade-api -n 100 --no-pager
```

## 哪些步骤可以暂时不做

- 不创建 `jytrade` 用户：可以，试运行可用 `root`。正式长期运行再考虑降权。
- 不做软链接：可以。现在通过 `DATABASE_URL`、`JY_TRADE_UPLOAD_DIR`、`JY_TRADE_EXPORTS_DIR` 配置目录；相对路径统一按项目根目录解析，并会自动创建需要的父目录。
- 不填 WDT 配置：可以启动系统，但不能做真实商品同步、真实初审和库存查询。
- 不配 HTTPS：可以先用 IP + HTTP 测试。正式多人使用建议配置 HTTPS。
- 不做自动备份：可以先手动备份。真实使用后建议每天备份 SQLite。

## 上线后的初始化

1. 用 `admin / jymy` 登录。
2. 在设置里手动同步商品档案。
3. 在地址维护里导入地址 Excel。
4. 导入真实订单，跑一批完整流程。

私有 Excel、真实订单、数据库、上传文件、导出文件都不要提交到 Git。
