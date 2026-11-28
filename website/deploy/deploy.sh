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

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 仅在 SSH 握手/连接中断（退出码 255）时重试，远端命令本身报错立即失败
ssh_retry_file() {
  local input_file="$1"
  local remote_cmd="$2"
  local attempt=1
  local max_attempts=5
  local rc=0
  while [ "$attempt" -le "$max_attempts" ]; do
    set +e
    ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$remote_cmd" < "$input_file"
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    if [ "$rc" -ne 255 ]; then
      return "$rc"
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "[deploy] SSH 连接被远端断开（255），2s 后重试（${attempt}/${max_attempts}）…" >&2
      sleep 2
    fi
    attempt=$((attempt + 1))
  done
  return "$rc"
}

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
# 提前打包本地归档并在单次 SSH 会话内完成解压 + 原子替换，支持 255 断连幂等重试
tar czf "$TMP_DIR/site.tar.gz" -C "$WEBSITE_DIR/dist" .
ssh_retry_file "$TMP_DIR/site.tar.gz" "
  set -e
  TARGET='$DEPLOY_TARGET'
  rm -rf \"\${TARGET}.incoming\"
  mkdir -p \"\${TARGET}.incoming\"
  tar xzf - -C \"\${TARGET}.incoming\"
  if [ -d \"\$TARGET\" ]; then
    rm -rf \"\${TARGET}.old\"
    mv \"\$TARGET\" \"\${TARGET}.old\"
  fi
  mv \"\${TARGET}.incoming\" \"\$TARGET\"
  rm -rf \"\${TARGET}.old\"
"

if [ -n "$DEPLOY_NGINX_REDIRECTS_FILE" ] && [ "$DEPLOY_NGINX_REDIRECTS_FILE" != "none" ]; then
  echo "[deploy] 同步 Nginx 302 跳转片段到 $DEPLOY_NGINX_REDIRECTS_FILE …"
  node "$WEBSITE_DIR/scripts/gen-nginx-redirects.mjs" > "$TMP_DIR/redirects.conf"
  ssh_retry_file "$TMP_DIR/redirects.conf" "
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

# 如服务器已安装线上私有看板服务，在单次 SSH 会话内同步后端与模板并平滑重启
if [ -f "$SCRIPT_DIR/stats-server.py" ] && [ -f "$SCRIPT_DIR/stats-dashboard.html" ]; then
  tar czf "$TMP_DIR/stats.tar.gz" -C "$SCRIPT_DIR" stats-server.py stats-dashboard.html
  ssh_retry_file "$TMP_DIR/stats.tar.gz" '
    set -e
    if [ ! -d /opt/tizhou-stats ]; then
      cat >/dev/null
      exit 0
    fi
    echo "[deploy] 同步线上可视化看板 /opt/tizhou-stats …"
    tar xzf - -C /opt/tizhou-stats
    chmod 755 /opt/tizhou-stats/stats-server.py
    if systemctl is-enabled tizhou-stats >/dev/null 2>&1; then
      systemctl restart tizhou-stats
    fi
    echo "[deploy] 线上可视化看板已更新并重启"
  '
fi

echo "[deploy] 发布完成：$DEPLOY_TARGET"
