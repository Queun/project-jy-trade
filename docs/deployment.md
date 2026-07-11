# 腾讯云部署指南

本文按当前试运行口径编写：可以直接使用 `root` 部署，运行时数据目录通过环境变量配置，不需要软链接。

## 当前试运行边界

- 服务部署在腾讯云，仅允许已配置的业务 IP 段访问；云安全组或 Nginx IP 白名单是当前主要访问控制。
- 当前订单数据主要是商品和发货数量，按低敏内部业务数据处理。试运行阶段优先保证操作方便，不建设复杂安全体系或网页用户管理模块。
- 管理员账号固定使用 `admin`，允许暂时使用约定密码 `yjmy`。API 启动时会把已有管理员密码同步为环境变量中的值。
- 生产模式只自动维护管理员账号，不自动创建 `operator/operator123` 或 `reviewer/reviewer123` 测试账号；旧数据库中已经存在的测试账号不会自动删除。
- 后续业务范围扩大、开放访问范围或数据敏感度提高时，再统一升级强密码、HTTPS、账号管理、禁用机制和会话管理。

## 必须准备

- 一台腾讯云 CVM。
- 安全组仅向约定 IP 段开放 `22` 和 `80`。正式启用 HTTPS 时再按同一来源范围开放 `443`。
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
mkdir -p data/uploads data/exports /opt/jy-trade/backups
```

`data/uploads`、`data/exports` 和 SQLite 数据库父目录会由应用或迁移命令自动创建；上面的 `mkdir` 只是首次部署时显式预创建，便于检查权限和目录位置。

编辑 `.env`，至少确认：

```env
NODE_ENV=production
API_PORT=3001
TZ=Asia/Shanghai
WDT_AUTO_SYNC_ENABLED=true
WDT_STOCK_SYNC_RETRY_DELAYS_MS=1500
DATABASE_URL=file:data/jy-trade-prod.db
JY_TRADE_UPLOAD_DIR=data/uploads
JY_TRADE_EXPORTS_DIR=data/exports
JY_TRADE_BOOTSTRAP_USERNAME=admin
JY_TRADE_BOOTSTRAP_PASSWORD=yjmy
```

生产环境启动时会确保上面配置的管理员存在，并把该账号密码同步为当前环境变量。当前腾讯云试运行环境允许使用 `yjmy`；修改环境变量后重启 API 即可更新数据库中的管理员密码。开发和自动测试使用的 `operator`、`reviewer` 示例账号不会在新的生产数据库中自动创建，已有数据库中的其他账号也不会被自动删除。

如果暂时只验证页面、登录和地址维护，可以先不填旺店通配置。已有本地商品档案时仍可继续导入和人工审核，只是没有成功库存快照的商品会标记“库存未验证”；全新数据库若没有商品档案，则必须先配置 WDT 并完成一次“商品与库存同步”，才能进行正式新订单初审。

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

## 本次更新：从旧测试库切换到新生产库

本次服务器旧数据均为测试数据，不在原库上逐表清理。发布时保留旧数据库和旧环境文件，通过新的 `DATABASE_URL`、上传目录和导出目录启用全新运行环境。这样不会继承测试映射、测试地址、测试账号或旧设置，也可以随时回退。

### 1. 发布前确认

先确认本地最终代码已经提交并推送，服务器工作区没有临时修改。服务器执行：

```bash
cd /opt/jy-trade/current
git status --short
git rev-parse HEAD
git fetch origin
git log --oneline --decorate -5
```

`git status --short` 应无输出。记录当前 commit，后面用于回退：

```bash
mkdir -p /opt/jy-trade/backups
git rev-parse HEAD > /opt/jy-trade/backups/pre-production-switch.commit
```

确认当前数据库位置，不要打印包含旺店通密钥的完整 `.env`：

```bash
grep -E '^(NODE_ENV|DATABASE_URL|JY_TRADE_UPLOAD_DIR|JY_TRADE_EXPORTS_DIR|TZ|WDT_AUTO_SYNC_ENABLED)=' .env
```

### 2. 停止服务并备份

以下命令假设旧库是 `/opt/jy-trade/current/data/jy-trade-prod.db`。如果上一步显示其他路径，先替换 `OLD_DB`：

```bash
cd /opt/jy-trade/current
systemctl stop jy-trade-api

OLD_DB=/opt/jy-trade/current/data/jy-trade-prod.db
STAMP=$(date +%Y%m%d-%H%M%S)
test -f "$OLD_DB"
cp "$OLD_DB" "/opt/jy-trade/backups/jy-trade-test-before-production-$STAMP.db"
cp .env "/opt/jy-trade/backups/jy-trade-env-before-production-$STAMP"
chmod 600 "/opt/jy-trade/backups/jy-trade-env-before-production-$STAMP"
sha256sum "$OLD_DB" "/opt/jy-trade/backups/jy-trade-test-before-production-$STAMP.db"
```

两行校验值应一致。保留终端中输出的 `STAMP`，回退时使用对应环境备份。

### 3. 拉取发布版本

```bash
cd /opt/jy-trade/current
git pull --ff-only
npm ci
git rev-parse HEAD
```

确认输出的 commit 是本次准备发布的 commit。

### 4. 配置全新运行目录

创建独立目录：

```bash
mkdir -p /opt/jy-trade/current/data/production/uploads
mkdir -p /opt/jy-trade/current/data/production/exports
```

编辑 `/opt/jy-trade/current/.env`，保留原有旺店通配置，并确认下面这些值：

```env
NODE_ENV=production
API_PORT=3001
TZ=Asia/Shanghai
WDT_AUTO_SYNC_ENABLED=true
DATABASE_URL=file:/opt/jy-trade/current/data/production/jy-trade-prod.db
JY_TRADE_UPLOAD_DIR=/opt/jy-trade/current/data/production/uploads
JY_TRADE_EXPORTS_DIR=/opt/jy-trade/current/data/production/exports
JY_TRADE_BOOTSTRAP_USERNAME=admin
JY_TRADE_BOOTSTRAP_PASSWORD=yjmy
```

然后执行：

```bash
chmod 600 .env
set -a
. ./.env
set +a

npm run db:migrate
npm run deploy:check
```

`db:migrate` 会创建全新数据库并执行全部迁移，不会修改旧测试数据库。

### 5. 启动和基础验收

```bash
systemctl restart jy-trade-api
systemctl status jy-trade-api --no-pager
curl http://127.0.0.1:3001/api/v1/health
journalctl -u jy-trade-api -n 100 --no-pager
```

预期健康接口返回：

```json
{"ok":true,"service":"jy-trade-api"}
```

浏览器验收：

1. 使用 `admin / yjmy` 登录。
2. 确认历史批次为空，证明已经切到新库。
3. 在设置中核对启用仓库和自动同步周期。
4. 手动执行一次“商品与库存同步”，等待成功快照生成。
5. 导入正式门店地址。
6. 用一个小确定单走完导入、审核、提交和双表导出。
7. 下载 Excel，确认 `Sheet1` 和“不做单表”均可正常打开。

### 6. 回退方案

如果新版本无法完成健康检查或核心流程，先停止服务：

```bash
systemctl stop jy-trade-api
cd /opt/jy-trade/current
```

恢复更新前环境文件，其中 `<STAMP>` 替换为备份时记录的值：

```bash
cp "/opt/jy-trade/backups/jy-trade-env-before-production-<STAMP>" .env
chmod 600 .env
```

切回更新前代码并恢复依赖：

```bash
OLD_COMMIT=$(cat /opt/jy-trade/backups/pre-production-switch.commit)
git switch --detach "$OLD_COMMIT"
npm ci
systemctl restart jy-trade-api
curl http://127.0.0.1:3001/api/v1/health
```

这会重新使用旧环境文件指向的旧测试库。新建的 `data/production/` 不需要删除。问题处理完后，执行 `git switch main` 回到主分支，再重新发布。

旧测试数据库和环境备份至少保留 7 天；确认新生产库稳定后再决定是否归档，不要直接删除。

## 日常发布

发布前建议备份数据库：

```bash
cd /opt/jy-trade/current
mkdir -p /opt/jy-trade/backups
systemctl stop jy-trade-api

set -a
. ./.env
set +a

DB_PATH=${DATABASE_URL#file:}
case "$DB_PATH" in
  /*) ;;
  *) DB_PATH="$PWD/$DB_PATH" ;;
esac
test -f "$DB_PATH"
cp "$DB_PATH" "/opt/jy-trade/backups/jy-trade-prod-$(date +%Y%m%d-%H%M%S).db"
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
systemctl start jy-trade-api
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
- 不填 WDT 配置：可以启动系统、维护地址，并在已有本地商品档案时继续人工审核；不能刷新商品与库存快照。全新数据库没有商品档案时，不能进行正式新订单初审。
- `WDT_AUTO_SYNC_ENABLED=false`：维护或临时开发时可以关闭整点和启动补偿任务，手动同步接口仍需有效 WDT 配置。
- 不配 HTTPS：可以先用 IP + HTTP 测试。正式多人使用建议配置 HTTPS。
- 不做自动备份：可以先手动备份。真实使用后建议每天备份 SQLite。

## 上线后的初始化

1. 使用 `JY_TRADE_BOOTSTRAP_USERNAME` 和 `JY_TRADE_BOOTSTRAP_PASSWORD` 配置的管理员账号登录。
2. 在设置里执行一次“商品与库存同步”，确认出现成功库存快照；之后系统会按管理员选择的 1、2、6 或 24 小时周期，在上海时区自然时间边界自动更新。
3. 在地址维护里导入地址 Excel。
4. 导入真实订单，跑一批完整流程。

私有 Excel、真实订单、数据库、上传文件、导出文件都不要提交到 Git。
