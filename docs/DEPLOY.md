# 上线方案

这是个**纯静态**站点：没有构建步骤、没有 npm 依赖、没有后端。产物就是仓库根目录下的 `index.html` + `styles.css` + `app.js` + `data/rows.js`。

所以上线 = 把这几个文件放到任何能发静态文件的 HTTP 服务上。四种方案按「上手速度」排：

| 方案 | 成本 | 上手 | 适合 |
|---|---|---|---|
| A · GitHub Pages | 免费（需公开仓或 Pro） | 5 分钟 | 只在能公开 / 有 Pro 时选 |
| B · 自有云服务器 + nginx | 服务器费用（已有） | 30 分钟 | 你已经有云服务器，且要配 HTTPS/域名 |
| C · Docker（nginx 镜像） | 服务器费用（已有） | 20 分钟 | 想一条命令搞定、方便以后换机器 |
| D · 腾讯云 CloudBase 静态托管 | 有免费额度 | 20 分钟 | 你们本来就在腾讯云上 |

> 仓库里**不含任何密钥**。刷新数据依赖本机 `wecom-cli` 的企业微信授权（在钥匙串里，不进仓库）。

---

## A · GitHub Pages（最快，但有个前提）

> ⚠️ **GitHub Pages 免费版只支持公开仓库**。本仓默认 `private`（表里有内部进展与责任人，不适合公开），所以走 Pages 需要满足其一：
> - 把仓库转成 **public**（数据会公开，**内部 HR 内容不建议**）
> - 或账号有 **GitHub Pro / Enterprise**（private 仓库也能开 Pages）
>
> 没有这两条就直接跳到 **B / C / D**——反正你本来就有云服务器，方案 B 更稳。

### 1. 推仓库

```bash
cd /Users/leto/Documents/hr-progress-table
git remote add origin https://github.com/nolifeking0916/hr-progress-table.git
git push -u origin main
```

### 2. 开 Pages

GitHub 仓库 → **Settings** → **Pages** → Source 选 `Deploy from a branch` → branch 选 `main`、目录选 `/ (root)` → Save。

### 3. 拿到地址

`https://nolifeking0916.github.io/hr-progress-table/`

（GitHub 部署约 1–2 分钟。若 404，等一会儿并确认 Pages 设置里的 Source 是 root 而不是 `/docs`。）

### 4. 以后每次更新数据

```bash
./scripts/refresh.sh
git add data/ && git commit -m "chore: 刷新进度表数据" && git push
```

Pages 会自动重新部署。

---

## B · 自有云服务器 + nginx

假设服务器 Ubuntu/Debian，网站根目录用 `/var/www/hr-progress-table`。

### 1. 上传文件

```bash
# 在本地
rsync -av --delete \
  --exclude '.git' --exclude 'docs' --exclude 'scripts' \
  index.html styles.css app.js data/ \
  user@your-server:/var/www/hr-progress-table/
```

### 2. nginx 站点配置

```bash
sudo tee /etc/nginx/sites-available/hr-progress-table >/dev/null <<'NGINX'
server {
    listen 80;
    server_name your-domain.com;        # 有域名就填；只有 IP 就删掉这行

    root /var/www/hr-progress-table;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # data/ 下的 json 不用长期缓存，刷新数据后立刻能看到
    location /data/ {
        add_header Cache-Control "no-store";
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/hr-progress-table /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 3. HTTPS（Let\'s Encrypt）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 4. 防火墙

云服务器安全组要放行 80/443；系统防火墙 `sudo ufw allow 80,443/tcp`。

### 5. 数据自动更新（可选）

在服务器上装 `wecom-cli` 并完成机器人授权后，用 cron 每天拉一次：

```cron
30 7 * * * cd /opt/hr-progress-table && ./scripts/refresh.sh >> /var/log/hr-refresh.log 2>&1
```

> 注意：**服务器上的企业微信授权与本机是两套**。若走 GitHub Actions 自动刷新，需要把企业微信的凭据放进仓库 Secrets——**不要**写进代码或提交进仓库。

---

## B2 · 带后端的正式部署（多用户 / 写入必需）

页面加了多用户与写入能力后，**光有静态文件不够**：身份判定、写权限、写入源表、进度面板聚合都在服务端。
所以正式部署是「Python 服务 + nginx 反代」：

### 1. 拉代码与初始化

```bash
sudo mkdir -p /opt/hr-progress-table && sudo chown $USER /opt/hr-progress-table
cd /opt/hr-progress-table
git clone https://github.com/nolifeking0916/hr-progress-table.git .
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt      # 本项目只用标准库，通常是空的
./scripts/refresh.sh                  # 首次拉取源表数据 → data/rows.js
```

### 2. 环境变量（**不要写进仓库**）

```bash
cat > /opt/hr-progress-table/.env <<'ENV'
HPS_SECRET=换成随机长字符串      # openssl rand -hex 32
PORT=8787
HPS_SHEET_ADAPTER=cli           # 用 wecom-cli 读写企微在线表格
HPS_WECOM_DOCID=e3_ARsADAagAHQCNea2Y2u1wSA00hrX0
HPS_WECOM_SHEET_TITLE=重点工作进度 v2
ENV
chmod 600 /opt/hr-progress-table/.env
```

### 3. systemd 常驻

```ini
# /etc/systemd/system/hr-progress-table.service
[Unit]
Description=HR Progress Table
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/hr-progress-table
EnvironmentFile=/opt/hr-progress-table/.env
ExecStart=/opt/hr-progress-table/.venv/bin/python server.py
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hr-progress-table
sudo systemctl status hr-progress-table
```

### 4. nginx 反代

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /var/www/html;                 # 静态资源放这里（或直接让 python 服务伺服）
    index index.html;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 5. 源表写入的凭据

`HPS_SHEET_ADAPTER=cli` 依赖本机的 `wecom-cli` 已完成企业微信机器人授权（凭据在钥匙串里，不进仓库）。
服务器上需要单独装一次并授权；**不要**把凭据写进代码或提交。

### 6. 定时刷新数据（可选）

```cron
30 7 * * * cd /opt/hr-progress-table && . .venv/bin/activate && ./scripts/refresh.sh >> /var/log/hr-refresh.log 2>&1
```

---

## C · Docker

```dockerfile
# Dockerfile
FROM nginx:alpine
COPY index.html styles.css app.js /usr/share/nginx/html/
COPY data /usr/share/nginx/html/data
EXPOSE 80
```

```yaml
# docker-compose.yml
services:
  web:
    build: .
    ports:
      - "80:80"
    restart: unless-stopped
```

```bash
docker compose up -d --build
```

反向代理与 HTTPS 交给宿主机已有的 nginx / Caddy，或给容器挂证书。

---

## D · 腾讯云 CloudBase 静态托管

适合你们本来就在腾讯云上的情况（仓库里也有 `cloudbase` 技能可查）。

```bash
# 1. 在环境根目录放 cloudbaserc，声明 hosting 项；构建命令留空（纯静态）
# 2. 预演
npm i -g @cloudbase/cli   # 如未安装
tcb hosting deploy ./ -e <envId>
```

或用 MCP 工具 `manageHosting(action="upload", localPath=".", cloudPath="/")`。
域名绑定走 `manageGateway(createRoute, upstreamResourceType="STATIC_STORE")`。

---

## 怎么验收上线结果

1. 打开域名，**三个视图都要能切**：事项视图（展开看逐日）、明细视图（167 行长表）、甘特视图
2. 筛选能联动：点模块 chip → 计数变 → 三个视图同时收敛
3. 「数据截至 YYYY-MM-DD」显示的是最新进展日期
4. **导出 CSV** 出来的文件用 Excel 打开不乱码（已加 UTF-8 BOM）
5. 手机宽度（375px）下事项视图自动转成卡片
6. 打印预览是干净的表格

## 数据多久更新一次

网页本身不主动拉数据，靠仓库里的 `data/rows.js`。所以：

- **GitHub Pages**：每次刷新数据要 commit + push
- **自有服务器**：可以挂 cron 直接改服务器上的文件（连 git 都不用推）
- 想让网页自己拉最新数据，需要给页面加一个后端/边缘函数去调企业微信表格 API（凭据不能进前端）——这一步等确定服务器和域名后再定。
