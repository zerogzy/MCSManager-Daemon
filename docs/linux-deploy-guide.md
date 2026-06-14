# MCSManager 商城版 Linux 源码部署教程

本文档介绍如何在 Linux 服务器上从源码编译并部署带商城系统的 MCSManager。

---

## 环境要求

| 依赖 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Node.js | 18.x | 20.x LTS |
| npm | 9.x | 10.x |
| Git | 2.x | 最新 |
| 内存 | ≥ 1GB | ≥ 2GB |
| 磁盘 | ≥ 2GB | ≥ 5GB |

> **注意**：Node.js 16 已停止维护，请使用 Node.js 18+。推荐使用 [nvm](https://github.com/nvm-sh/nvm) 管理 Node.js 版本。

---

## 一、安装基础依赖

```bash
# CentOS / RHEL / Rocky Linux
sudo yum install -y git curl tar

# Ubuntu / Debian
sudo apt update && sudo apt install -y git curl tar

# 安装 nvm（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# 验证
node -v   # 应显示 v20.x.x
npm -v    # 应显示 10.x.x
```

---

## 二、获取源码

```bash
# 将源码上传到服务器（或通过 git clone）
# 方式一：直接上传源码压缩包
scp -r MCSM/ root@your-server:/opt/mcsm

# 方式二：如果是 git 仓库
cd /opt
sudo git clone <你的仓库地址> mcsm
cd mcsm/MCSM
```

---

## 三、安装依赖

```bash
cd /opt/mcsm/MCSM

# 1. 安装根目录依赖
npm install

# 2. 编译公共模块
npm run preview-build

# 3. 安装 Daemon 依赖
cd daemon
npm install
cd ..

# 4. 安装 Panel 依赖
cd panel
npm install
cd ..

# 5. 安装 Frontend 依赖
cd frontend
npm install
cd ..
```

---

## 四、编译项目

```bash
cd /opt/mcsm/MCSM

# 编译 Daemon（输出到 daemon/production/app.js）
cd daemon
npm run build
cd ..

# 编译 Panel（输出到 panel/production/app.js）
cd panel
npm run build
cd ..

# 编译 Frontend（输出到 frontend/dist/）
cd frontend
npm run build
cd ..
```

> **首次编译可能需要 3-5 分钟**，主要时间消耗在 Frontend 的 Vite 构建上。

---

## 五、组织生产目录

推荐将编译产物整理到独立目录，方便管理和启动：

```bash
cd /opt/mcsm/MCSM

# 创建生产目录
mkdir -p production-code/daemon
mkdir -p production-code/web/public

# 复制 Daemon 编译产物
cp daemon/production/app.js production-code/daemon/
cp daemon/production/app.js.map production-code/daemon/
cp daemon/package.json production-code/daemon/
cp daemon/package-lock.json production-code/daemon/

# 复制 Panel 编译产物
cp panel/production/app.js production-code/web/
cp panel/production/app.js.map production-code/web/
cp panel/package.json production-code/web/
cp panel/package-lock.json production-code/web/

# 复制 Frontend 编译产物
cp -r frontend/dist/* production-code/web/public/

# 安装生产环境依赖（仅生产依赖，不含 devDependencies）
cd production-code/daemon
npm install --production --no-fund --no-audit
cd ../web
npm install --production --no-fund --no-audit
cd /opt/mcsm/MCSM
```

---

## 六、启动服务

### 6.1 前台启动（调试用）

```bash
cd /opt/mcsm/MCSM/production-code

# 启动 Daemon（守护进程，默认端口 24444）
cd daemon
node --max-old-space-size=8192 --enable-source-maps app.js
```

```bash
# 新开终端，启动 Web Panel（面板，默认端口 23333）
cd /opt/mcsm/MCSM/production-code/web
node --max-old-space-size=8192 --enable-source-maps app.js
```

### 6.2 后台启动（生产推荐）

```bash
cd /opt/mcsm/MCSM/production-code

# 启动 Daemon
cd daemon
nohup node --max-old-space-size=8192 --enable-source-maps app.js > /dev/null 2>&1 &

# 启动 Web Panel
cd ../web
nohup node --max-old-space-size=8192 --enable-source-maps app.js > /dev/null 2>&1 &
```

### 6.3 使用 systemd 管理服务（推荐）

创建 Daemon 服务文件：

```bash
sudo cat > /etc/systemd/system/mcsm-daemon.service << 'EOF'
[Unit]
Description=MCSManager Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mcsm/MCSM/production-code/daemon
ExecStart=/usr/bin/node --max-old-space-size=8192 --enable-source-maps app.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
```

创建 Panel 服务文件：

```bash
sudo cat > /etc/systemd/system/mcsm-panel.service << 'EOF'
[Unit]
Description=MCSManager Web Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mcsm/MCSM/production-code/web
ExecStart=/usr/bin/node --max-old-space-size=8192 --enable-source-maps app.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
```

> **注意**：如果你的 Node.js 通过 nvm 安装，`ExecStart` 路径需要改为 nvm 对应的 node 路径，可通过 `which node` 查询。

启用并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable mcsm-daemon mcsm-panel
sudo systemctl start mcsm-daemon mcsm-panel

# 查看状态
sudo systemctl status mcsm-daemon
sudo systemctl status mcsm-panel

# 查看日志
sudo journalctl -u mcsm-daemon -f
sudo journalctl -u mcsm-panel -f
```

---

## 七、配置商城支付

### 7.1 访问面板

浏览器打开 `http://你的IP:23333`，首次访问会引导创建管理员账号。

### 7.2 配置支付参数

1. 以管理员登录面板
2. 进入 **设置** → **支付设置** 选项卡
3. 填写以下配置：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| APP ID | 虎皮椒应用 ID | `20250xxx` |
| APP Secret | 虎皮椒密钥 | `xxxxxxxxxxxxxxxx` |
| 支付网关 URL | 虎皮椒支付网关 | `https://api.xunhupay.com/payment/do.html` |
| 备用网关 URL | 虎皮椒备用网关 | `https://api.dpweixin.com/payment/do.html` |
| 回调通知 URL | 支付成功后虎皮椒回调地址 | `https://your-domain.com/api/shop/notify` |

> **回调通知 URL** 必须是虎皮椒服务器能访问到的外网地址。如果面板没有公网 IP，需要通过反向代理或内网穿透暴露。

### 7.3 设置实例价格

1. 进入 **商城** 页面
2. 在用户管理的实例列表中，点击 ⚙️ 设置按钮
3. 配置月付基础价格、季付折扣、年付折扣

---

## 八、防火墙配置

```bash
# CentOS / RHEL / Rocky Linux (firewalld)
sudo firewall-cmd --permanent --add-port=23333/tcp
sudo firewall-cmd --permanent --add-port=24444/tcp
sudo firewall-cmd --reload

# Ubuntu / Debian (ufw)
sudo ufw allow 23333/tcp
sudo ufw allow 24444/tcp
sudo ufw reload
```

| 端口 | 服务 | 说明 |
|------|------|------|
| 23333 | Web Panel | 面板 HTTP 服务 |
| 24444 | Daemon | 守护进程通信 |

---

## 九、Nginx 反向代理（可选）

如果你需要 HTTPS 或自定义域名，推荐使用 Nginx 反向代理：

```nginx
server {
    listen 80;
    listen 443 ssl http2;
    server_name mc.example.com;

    # SSL 证书（如果使用 HTTPS）
    ssl_certificate     /etc/nginx/ssl/mc.example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/mc.example.com.key;

    # Web Panel
    location / {
        proxy_pass http://127.0.0.1:23333;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket 支持（面板与守护进程通信需要）
    location /socket.io/ {
        proxy_pass http://127.0.0.1:23333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> 使用反向代理后，回调通知 URL 可填写：`https://mc.example.com/api/shop/notify`

---

## 十、更新升级

```bash
cd /opt/mcsm/MCSM

# 1. 停止服务
sudo systemctl stop mcsm-panel mcsm-daemon

# 2. 更新源码
git pull  # 或重新上传源码

# 3. 重新安装依赖
npm install
npm run preview-build
cd daemon && npm install && cd ..
cd panel && npm install && cd ..
cd frontend && npm install && cd ..

# 4. 重新编译
cd daemon && npm run build && cd ..
cd panel && npm run build && cd ..
cd frontend && npm run build && cd ..

# 5. 更新生产目录
rm -rf production-code
mkdir -p production-code/daemon production-code/web/public

cp daemon/production/app.js daemon/production/app.js.map production-code/daemon/
cp daemon/package.json daemon/package-lock.json production-code/daemon/

cp panel/production/app.js panel/production/app.js.map production-code/web/
cp panel/package.json panel/package-lock.json production-code/web/

cp -r frontend/dist/* production-code/web/public/

cd production-code/daemon && npm install --production --no-fund --no-audit && cd ../..
cd production-code/web && npm install --production --no-fund --no-audit && cd ../..

# 6. 启动服务
sudo systemctl start mcsm-daemon mcsm-panel
```

---

## 十一、常见问题

### Q1: 编译 Frontend 时内存不足 (OOM)

```bash
# 增加 Node.js 内存限制
export NODE_OPTIONS="--max-old-space-size=4096"
cd frontend && npm run build
```

### Q2: 启动 Panel 报 `shop.db` 相关错误

商城数据库会在 Panel 首次启动时自动创建在 `production-code/web/data/shop.db`。如果报错，请确认 `data` 目录有写权限：

```bash
chmod 755 production-code/web/
```

### Q3: 支付回调无法到达

1. 确认回调 URL 是外网可访问的完整地址
2. 确认防火墙/安全组已放行对应端口
3. 确认 Nginx（如有）正确转发 `/api/shop/notify` 路径
4. 在浏览器中直接访问回调 URL，如果返回 `success` 说明网络可达

### Q4: 实例续费后 endTime 未更新

检查日志中是否有 `RENEW_PENDING` 相关记录。如果 Daemon 不可用，订单会被标记为 `renew_pending` 状态，系统会每 5 分钟自动重试。当 Daemon 恢复后，续费会自动完成。

### Q5: 如何查看商城订单

管理员在面板 **商城** → **用户管理** → **订单管理** 选项卡中可查看所有订单，支持按用户名和状态筛选。

---

## 十二、目录结构说明

生产环境部署后的目录结构：

```
production-code/
├── daemon/                    # 守护进程
│   ├── app.js                 # 编译后的 Daemon 主程序
│   ├── app.js.map             # Source Map
│   ├── package.json
│   ├── package-lock.json
│   └── node_modules/          # 生产依赖
└── web/                       # Web 面板
    ├── app.js                 # 编译后的 Panel 主程序
    ├── app.js.map             # Source Map
    ├── package.json
    ├── package-lock.json
    ├── node_modules/          # 生产依赖
    ├── public/                # 前端静态文件
    │   ├── index.html
    │   ├── favicon.ico
    │   └── assets/            # JS/CSS/图片等
    ├── data/                  # 运行时数据（自动创建）
    │   ├── shop.db            # 商城数据库
    │   ├── SystemConfig/      # 系统配置
    │   ├── User/              # 用户数据
    │   └── ...
    └── logs/                  # 运行日志（自动创建）
```

---

## 十三、安全建议

1. **不要以 root 用户运行服务** — 创建专用用户：
   ```bash
   sudo useradd -r -s /sbin/nologin mcsm
   sudo chown -R mcsm:mcsm /opt/mcsm
   # 在 systemd service 文件中添加 User=mcsm
   ```

2. **启用 HTTPS** — 使用 Nginx + Let's Encrypt 证书

3. **修改默认端口** — 在面板设置中修改 Panel 和 Daemon 的默认端口

4. **限制回调来源** — 如果虎皮椒提供了固定回调 IP，在 Nginx 中限制 `/api/shop/notify` 的访问来源

5. **定期备份数据** — 备份 `data/` 目录下的所有文件：
   ```bash
   # 定时备份示例（crontab）
   0 3 * * * tar czf /backup/mcsm-data-$(date +\%F).tar.gz /opt/mcsm/MCSM/production-code/web/data/
   ```
