#!/usr/bin/env bash
# ============================================================
# ClipFlow 一键部署脚本（目标：Linux，systemd）
# 适用：阿里云 ECS / 轻量应用服务器，Ubuntu 22.04+ / Debian 12+ / Alibaba Cloud Linux 3
#
# 用法（在项目根目录执行）：
#   sudo ACCESS_TOKEN='你的登录口令' ./deploy/install.sh
#
# 可选环境变量：
#   APP_DIR=/opt/clipflow        安装目录
#   SERVICE_USER=clipflow        运行用户（自动创建）
#   PORT=8787                    应用监听端口（只对本机，公开访问交给 Nginx）
#   NODE_VERSION=v20.20.2        要装的 Node 版本
#   NODE_MIRROR=...              指定镜像（默认按 阿里云 → npmmirror → 官方 依次尝试）
#   AMK_API_KEY=...              去字幕接口密钥（可稍后改环境文件）
#   PUBLIC_BASE_URL=...          对外访问地址（可稍后改环境文件）
#
# 仅准备文件、不装服务（用于本地演练）：
#   SKIP_PACKAGES=1 SKIP_NODE=1 SKIP_SYSTEMD=1 APP_DIR=/tmp/clipflow SERVICE_USER=$(whoami) ./deploy/install.sh
# ============================================================
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/clipflow}
SERVICE_USER=${SERVICE_USER:-clipflow}
PORT=${PORT:-8787}
NODE_VERSION=${NODE_VERSION:-v20.20.2}
# 优先阿里云内网镜像（ECS 上速度快、不计公网流量），其次 npmmirror，最后官方源
NODE_MIRRORS=${NODE_MIRROR:-"https://mirrors.aliyun.com/nodejs-release https://npmmirror.com/mirrors/node https://nodejs.org/dist"}
SERVICE_NAME=clipflow

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

need_root() {
  [ "$(id -u)" = "0" ] || die "请用 root 执行（sudo $0）"
}

# ---------------------------------------------------------------- 1. 基础工具
install_packages() {
  [ "${SKIP_PACKAGES:-0}" = "1" ] && { log "跳过系统依赖安装（SKIP_PACKAGES=1）"; return; }
  log "安装基础工具（curl / tar / xz）"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y -qq
    apt-get install -y -qq curl tar xz-utils ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl tar xz ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl tar xz ca-certificates
  else
    warn "未识别的包管理器，请自行确保 curl / tar / xz 可用"
  fi
}

# ---------------------------------------------------------------- 2. Node.js
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$v" -ge 18 ] 2>/dev/null
}

install_node() {
  if [ "${SKIP_NODE:-0}" = "1" ]; then
    log "跳过 Node 安装（SKIP_NODE=1），使用现有：$(command -v node || echo '未找到')"
    return
  fi
  if node_ok; then
    log "Node 已就绪：$(node -v)"
    return
  fi

  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac

  local pkg="node-${NODE_VERSION}-linux-${arch}.tar.xz"
  local dir="/usr/local/lib/nodejs/${NODE_VERSION}"
  local url="" mirror
  log "准备安装 Node ${NODE_VERSION}（${arch}）"
  for mirror in $NODE_MIRRORS; do
    mirror="${mirror%/}"
    if curl -fsIL --max-time 15 -o /dev/null "${mirror}/${NODE_VERSION}/${pkg}"; then
      url="${mirror}/${NODE_VERSION}/${pkg}"
      log "使用镜像：${mirror}"
      break
    fi
    warn "镜像不可用，换下一个：${mirror}"
  done
  [ -n "$url" ] || die "所有镜像都取不到 ${pkg}；可用 NODE_MIRROR=... 指定其它源，或用 NODE_VERSION 换版本"

  mkdir -p "$dir"
  local tarball="/tmp/${pkg}"
  curl -fSL --retry 3 --retry-delay 2 "$url" -o "$tarball" || die "下载失败：${url}"
  tar -xJf "$tarball" -C "$dir" --strip-components=1 || die "解压失败"
  rm -f "$tarball"
  ln -sf "$dir/bin/node" /usr/local/bin/node
  ln -sf "$dir/bin/npm"  /usr/local/bin/npm
  ln -sf "$dir/bin/npx"  /usr/local/bin/npx
  log "Node 安装完成：$(node -v)"
}

# ---------------------------------------------------------------- 3. 用户与目录
prepare_user() {
  if [ "${SKIP_SYSTEMD:-0}" = "1" ]; then
    log "跳过创建系统用户（SKIP_SYSTEMD=1），使用当前用户 $(id -un)"
    SERVICE_USER="$(id -un)"
    return
  fi
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "创建运行用户 ${SERVICE_USER}"
    useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$SERVICE_USER" 2>/dev/null \
      || useradd --system --shell /sbin/nologin --home-dir "$APP_DIR" "$SERVICE_USER"
  fi
}

# ---------------------------------------------------------------- 4. 拷贝应用
copy_app() {
  log "拷贝应用文件到 ${APP_DIR}"
  mkdir -p "$APP_DIR"
  for f in server.mjs pipeline.mjs package.json README.md; do
    [ -f "$SRC_DIR/$f" ] && cp -f "$SRC_DIR/$f" "$APP_DIR/"
  done
  rm -rf "$APP_DIR/public"
  cp -R "$SRC_DIR/public" "$APP_DIR/public"
  [ -d "$SRC_DIR/deploy" ] && { rm -rf "$APP_DIR/deploy"; cp -R "$SRC_DIR/deploy" "$APP_DIR/deploy"; }
  # 构建号：精确到分钟的部署时间，页面底部展示（如 build202610141950）
  local build_id="${BUILD_ID:-build$(date +%Y%m%d%H%M)}"
  printf '%s\n' "$build_id" > "$APP_DIR/BUILD"
  log "构建号 ${build_id}"
  mkdir -p "$APP_DIR/data"
}

# ---------------------------------------------------------------- 5. 环境文件
write_env() {
  local env_file="$APP_DIR/clipflow.env"
  if [ -f "$env_file" ]; then
    log "环境文件已存在，保留原有配置：${env_file}"
    # 仅补齐缺失项
    grep -q '^PORT=' "$env_file" || echo "PORT=${PORT}" >> "$env_file"
    return
  fi
  log "生成环境文件 ${env_file}"
  local token="${ACCESS_TOKEN:-}"
  if [ -z "$token" ]; then
    token="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
    warn "未提供 ACCESS_TOKEN，已随机生成：${token}"
  fi
  cat > "$env_file" <<EOF
# ClipFlow 运行配置（修改后：systemctl restart ${SERVICE_NAME}）
PORT=${PORT}
# 直接对外暴露就用 0.0.0.0；若前置了 Nginx，可改成 127.0.0.1 只允许本机访问
HOST=0.0.0.0
DATA_DIR=${APP_DIR}/data

# 登录口令（内部使用，建议足够复杂）
ACCESS_TOKEN=${token}

# 去字幕接口：密钥 + 对外可访问地址
# PUBLIC_BASE_URL 必须是公网能匿名访问到本服务的地址，去字幕接口靠它拉取源文件
AMK_API_KEY=${AMK_API_KEY:-}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}

# 源文件与产物的存活时间（小时）
UPLOAD_TTL_HOURS=12
EOF
  chmod 600 "$env_file"
}

# ---------------------------------------------------------------- 6. systemd
install_service() {
  if [ "${SKIP_SYSTEMD:-0}" = "1" ]; then
    log "跳过 systemd 注册（SKIP_SYSTEMD=1）"
    return
  fi
  command -v systemctl >/dev/null 2>&1 || die "系统没有 systemd，无法注册服务；可手动运行 node ${APP_DIR}/server.mjs"
  local node_bin; node_bin="$(command -v node)"
  log "注册 systemd 服务 ${SERVICE_NAME}"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ClipFlow - 全自动视频去字幕
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/clipflow.env
ExecStart=${node_bin} ${APP_DIR}/server.mjs
Restart=always
RestartSec=3
# 上传大文件时不要被 systemd 的默认限制打断
LimitNOFILE=65535
# 基本加固
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
  systemctl restart "${SERVICE_NAME}"
  sleep 2
  systemctl is-active --quiet "${SERVICE_NAME}" \
    && log "服务已启动" \
    || { warn "服务未处于运行状态，最近日志："; journalctl -u "${SERVICE_NAME}" -n 30 --no-pager || true; }
}

# ---------------------------------------------------------------- 7. 权限与收尾
fix_perms() {
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" 2>/dev/null || true
  chmod 600 "$APP_DIR/clipflow.env" 2>/dev/null || true
}

public_ip() {
  # 阿里云 ECS 元数据服务；失败则退回公网出口 IP
  curl -fsS --max-time 2 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
    || curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' \
    || echo "<你的服务器公网IP>"
}

summary() {
  local ip; ip="$(public_ip)"
  cat <<EOF

──────────────────────────────────────────────
 ClipFlow 已部署
──────────────────────────────────────────────
 安装目录   ${APP_DIR}
 配置文件   ${APP_DIR}/clipflow.env
 数据目录   ${APP_DIR}/data（上传文件与产物，12 小时自动清理）
 本机地址   http://127.0.0.1:${PORT}
 公网地址   http://${ip}:${PORT}   （需在安全组放行 ${PORT}）

 常用命令
   systemctl status ${SERVICE_NAME}
   systemctl restart ${SERVICE_NAME}
   journalctl -u ${SERVICE_NAME} -f

 下一步
   1. 在阿里云安全组放行端口（建议只放行 80/443，由 Nginx 反代到 ${PORT}）
   2. 编辑 ${APP_DIR}/clipflow.env 填好 AMK_API_KEY 与 PUBLIC_BASE_URL
      PUBLIC_BASE_URL 填公网可访问地址，例如 https://你的域名 或 http://${ip}:${PORT}
   3. 改完执行 systemctl restart ${SERVICE_NAME}
──────────────────────────────────────────────
EOF
}

main() {
  log "开始部署 ClipFlow 到 ${APP_DIR}"
  if [ "${SKIP_PACKAGES:-0}" != "1" ] || [ "${SKIP_SYSTEMD:-0}" != "1" ]; then
    need_root
  fi
  install_packages
  install_node
  prepare_user
  copy_app
  write_env
  fix_perms
  install_service
  if [ "${SKIP_SYSTEMD:-0}" = "1" ]; then
    log "演练模式：启动命令 → cd ${APP_DIR} && set -a && . ./clipflow.env && node server.mjs"
  fi
  summary
}

main "$@"
