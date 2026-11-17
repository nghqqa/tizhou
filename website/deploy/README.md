# 题舟官网部署说明

官网是纯静态站点（`website/dist/`），部署到自有服务器即可，无需数据库与后端。
本文区分两种上线方式：**裸 IP 临时验证** 与 **域名 + HTTPS 正式对外**。

## 0. 前置条件

```bash
# 本地（Windows Git Bash / Linux 均可）
cd website && npm install
cp deploy/.env.deploy.example deploy/.env.deploy   # 填入真实服务器 IP、端口、账号
```

服务器上安装 Nginx 或 Caddy 二选一（推荐 Caddy：自动 HTTPS 免续期），
并创建站点目录 `/var/www/tizhou-website`（与配置模板中的 root 保持一致）。

## 1. 裸 IP 临时验证（HTTP，快速确认链路）

1. 服务器放行 80 端口（云服务器需同时在控制台安全组放行）。
2. 使用 `nginx.conf.example`（`server_name _;` 即可）或 `Caddyfile.example` 的方式 B。
3. 本地执行发布：

```bash
bash website/deploy/deploy.sh
```

4. 浏览器访问 `http://YOUR_SERVER_IP/`，确认页面、截图、下载按钮全部正常。

> 仅用于验证。正式对外宣传（小红书导流、社区置顶）务必先完成 HTTPS：
> 浏览器对 HTTP 站点的 exe 直链下载更容易触发拦截误报，微信/QQ 内打开 HTTP 站也会提示不安全。

## 2. 域名 + HTTPS 正式对外（推荐）

1. 在域名服务商处添加解析记录（A 记录）：`tizhou` → 服务器 IP，TTL 600 即可。
2. 服务器放行 80 与 443 端口。
3. 配置 Web 服务器：
   - Caddy：把 `Caddyfile.example` 方式 A 的域名改为你的域名，`systemctl reload caddy`，
     证书自动签发续期，无需 certbot。
   - Nginx：把 `nginx.conf.example` 的 `server_name` 改为你的域名，然后：

     ```bash
     certbot --nginx -d tizhou.nghqqa.cn   # 按实际域名修改
     ```

4. 本地再次执行 `bash website/deploy/deploy.sh`（或直接 reload，内容不变则无需重发）。
5. 检查项：
   - `https://域名/` 打开无混合内容告警；
   - 分享到微信/QQ 出现封面卡片（og:image 生效）；
   - 下载按钮跳转 Releases 页正常。

## 3. 日常更新

```bash
bash website/deploy/deploy.sh            # 构建 + 原子替换发布
bash website/deploy/deploy.sh --no-build # 仅发布（dist 已构建好时）
```

发布脚本先上传到 `.incoming` 临时目录再原子替换，失败时线上站点不受影响；
回滚时把 `.old` 目录（如尚在）或任一历史 `dist` 重新上传即可。

## 4. （可选）启用安装包直链镜像

默认下载按钮跳转 CNB / GitHub Releases，安装包流量不经过这台服务器。
日后带宽充足时：

1. 把 `tizhou-setup-X.X.X.exe` 上传到服务器 `/var/www/tizhou-downloads/`；
2. 打开 Nginx/Caddy 配置中预留的 `/downloads/` 段并 reload；
3. 把 `website/src/release.ts` 里 `selfHosted.enabled` 改为 `true`，重新 `npm run build` 并发布。

## 5. 安全底线（务必遵守）

- 服务器 IP、SSH 端口、账号、私钥路径只存在于本地 `.env.deploy`（已被 .gitignore 忽略）；
- 任何提交进仓库的文件（脚本、配置模板、文档）只允许出现 `YOUR_SERVER_IP` 之类占位符；
- 服务器侧建议：`PasswordAuthentication no`、仅密钥登录、fail2ban。
