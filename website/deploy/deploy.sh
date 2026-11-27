#!/usr/bin/env bash
# 题舟官网静态发布脚本：构建 website/ 并把 dist/ 同步到自有服务器（原子替换）。
#
# 用法（在仓库根目录或任意目录执行，Git Bash / Linux 均可）：
#   1. cp website/deploy/.env.deploy.example website/deploy/.env.deploy，填入真实服务器信息
#   2. bash website/deploy/deploy.sh              # 构建 + 发布
#      bash website/deploy/deploy.sh --no-build   # 跳过构建，直接发布现有 dist/
#
# 安全说明：脚本只读取本目录下未被提交的 .env.deploy；仓库内所有模板仅含占位符。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.deploy"

if [ ! -f "$ENV_FILE" ]; then
  echo "[deploy] 缺少配置文件：$ENV_FILE"
  echo "[deploy] 请先执行：cp .env.deploy.example .env.deploy 并填入真实服务器信息"
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${DEPLOY_HOST:?未配置 DEPLOY_HOST}"
: "${DEPLOY_USER:?未配置 DEPLOY_USER}"
: "${DEPLOY_TARGET:?未配置 DEPLOY_TARGET}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_NGINX_REDIRECTS_FILE="${DEPLOY_NGINX_REDIRECTS_FILE-/etc/nginx/snippets/tizhou-redirects.conf}"

SSH_OPTS=(-p "$DEPLOY_PORT" -o BatchMode=yes -o ConnectTimeout=10)
if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
  SSH_OPTS+=(-i "$DEPLOY_SSH_KEY")
fi

if [ "${1:-}" != "--no-build" ]; then
  echo "[deploy] 构建官网…"
  (cd "$WEBSITE_DIR" && npm run build)
else
  echo "[deploy] 跳过构建，直接发布现有 dist/"
fi

if [ ! -f "$WEBSITE_DIR/dist/index.html" ]; then
  echo "[deploy] 未找到 $WEBSITE_DIR/dist/index.html，请先构建"
  exit 1
fi

echo "[deploy] 发布静态站点到 $DEPLOY_TARGET …"
# 打包上传到临时目录 → 原子替换：失败时线上站点不受影响
ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "rm -rf ${DEPLOY_TARGET}.incoming && mkdir -p ${DEPLOY_TARGET}.incoming"
tar czf - -C "$WEBSITE_DIR/dist" . | ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" \
  "tar xzf - -C ${DEPLOY_TARGET}.incoming"
ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "
  set -e
  if [ -d \"$DEPLOY_TARGET\" ]; then
    rm -rf \"$DEPLOY_TARGET.old\"
    mv \"$DEPLOY_TARGET\" \"$DEPLOY_TARGET.old\"
  fi
  mv \"$DEPLOY_TARGET.incoming\" \"$DEPLOY_TARGET\"
  rm -rf \"$DEPLOY_TARGET.old\"
"

if [ -n "$DEPLOY_NGINX_REDIRECTS_FILE" ] && [ "$DEPLOY_NGINX_REDIRECTS_FILE" != "none" ]; then
  echo "[deploy] 同步 Nginx 302 跳转片段到 $DEPLOY_NGINX_REDIRECTS_FILE …"
  node "$WEBSITE_DIR/scripts/gen-nginx-redirects.mjs" | ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "
    set -e
    TARGET='$DEPLOY_NGINX_REDIRECTS_FILE'
    mkdir -p \"\$(dirname \"\$TARGET\")\"
    cat > \"\${TARGET}.incoming\"
    if [ -f \"\$TARGET\" ]; then
      cp \"\$TARGET\" \"\${TARGET}.bak\"
    fi
    mv \"\${TARGET}.incoming\" \"\$TARGET\"
    if nginx -t; then
      rm -f \"\${TARGET}.bak\"
      systemctl reload nginx
    else
      if [ -f \"\${TARGET}.bak\" ]; then
        mv \"\${TARGET}.bak\" \"\$TARGET\"
      else
        rm -f \"\$TARGET\"
      fi
      exit 1
    fi
  "
  echo "[deploy] Nginx 302 跳转已校验并重载生效"
fi

# 如服务器已安装线上私有看板服务，顺带同步后端与模板并平滑重启
if [ -f "$SCRIPT_DIR/stats-server.py" ] && [ -f "$SCRIPT_DIR/stats-dashboard.html" ]; then
  if ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "[ -d /opt/tizhou-stats ]"; then
    echo "[deploy] 同步线上可视化看板 /opt/tizhou-stats …"
    tar czf - -C "$SCRIPT_DIR" stats-server.py stats-dashboard.html | ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "
      set -e
      tar xzf - -C /opt/tizhou-stats
      chmod 755 /opt/tizhou-stats/stats-server.py
      if systemctl is-enabled tizhou-stats >/dev/null 2>&1; then
        systemctl restart tizhou-stats
      fi
    "
    echo "[deploy] 线上可视化看板已更新并重启"
  fi
fi

echo "[deploy] 发布完成：$DEPLOY_TARGET"
