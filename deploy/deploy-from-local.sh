#!/usr/bin/env bash
# ============================================================
# 在本地（Mac）执行：一键把 ClipFlow 部署到阿里云 ECS，并做公网验证
#
# 前置：本机已能用密钥免密登录目标实例
#   ssh-copy-id -i ~/.ssh/clipflow_ecs.pub root@<ECS公网IP>
#
# 用法：
#   ./deploy/deploy-from-local.sh <ECS公网IP> '你的Token'
#   AMK_API_KEY=xxx PUBLIC_BASE_URL=http://<ECS公网IP>:8787 \
#     ./deploy/deploy-from-local.sh <ECS公网IP> '你的Token'
# ============================================================
set -euo pipefail

ECS_IP=${1:?用法: $0 <ECS公网IP> [ACCESS_TOKEN]}
ACCESS_TOKEN=${2:-}
ECS_USER=${ECS_USER:-root}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/clipflow_ecs}
APP_DIR=${APP_DIR:-/opt/clipflow}
PORT=${PORT:-8787}
REMOTE_SRC=${REMOTE_SRC:-/root/clipflow-src}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://${ECS_IP}:${PORT}}

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 -o ServerAliveInterval=15)
SSH=(ssh "${SSH_OPTS[@]}" "${ECS_USER}@${ECS_IP}")

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "找不到部署密钥 ${SSH_KEY}；先执行：ssh-keygen -t ed25519 -N '' -f ${SSH_KEY}"

# ---------------------------------------------------------------- 1. 连通性
log "检查 SSH 登录（${ECS_USER}@${ECS_IP}）"
if ! "${SSH[@]}" -o BatchMode=yes true 2>/dev/null; then
  warn "密钥登录失败。请先把公钥装上（会提示输入一次实例密码）："
  echo
  echo "    ssh-copy-id -i ${SSH_KEY}.pub ${ECS_USER}@${ECS_IP}"
  echo
  die "装好公钥后重新运行本脚本"
fi
"${SSH[@]}" 'echo "  远端: $(cat /etc/os-release | grep -E "^PRETTY_NAME" | cut -d= -f2- | tr -d \")  |  架构 $(uname -m)  |  内存 $(free -h | awk "/Mem:/{print \$2}")"'

# ---------------------------------------------------------------- 2. 上传代码
log "上传代码到 ${ECS_IP}:${REMOTE_SRC}"
# 用 tar 管道而不是 rsync：精简镜像里常常没有 rsync，而 tar 一定有
"${SSH[@]}" "mkdir -p ${REMOTE_SRC} && rm -rf ${REMOTE_SRC}/public ${REMOTE_SRC}/deploy"
tar --exclude='./data' --exclude='./node_modules' --exclude='./.git' \
    -czf - -C "${SRC_DIR}" \
    server.mjs pipeline.mjs media.mjs accounts.mjs ratelimit.mjs package.json README.md public deploy scripts docs test \
  | "${SSH[@]}" "tar -xzf - -C ${REMOTE_SRC}"

# ---------------------------------------------------------------- 3. 安装
log "在服务器上执行安装（Node + systemd）"
REMOTE_ENV="ACCESS_TOKEN=$(printf '%q' "$ACCESS_TOKEN") PORT=${PORT} APP_DIR=${APP_DIR} PUBLIC_BASE_URL=$(printf '%q' "$PUBLIC_BASE_URL")"
[ -n "${AMK_API_KEY:-}" ] && REMOTE_ENV="${REMOTE_ENV} AMK_API_KEY=$(printf '%q' "$AMK_API_KEY")"
"${SSH[@]}" "cd ${REMOTE_SRC} && chmod +x deploy/install.sh && ${REMOTE_ENV} ./deploy/install.sh" \
  || die "远端安装失败，可登录后查看：journalctl -u clipflow -n 50 --no-pager"

# ---------------------------------------------------------------- 4. 远端自检
log "远端自检"
"${SSH[@]}" bash -s <<EOF
set -e
echo "  systemd: \$(systemctl is-active clipflow)"
echo "  本机首页: HTTP \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/)"
echo "  未登录访问业务接口: HTTP \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/api/config)  （期望 401）"
echo "  监听端口: \$(ss -lntp 2>/dev/null | grep ':${PORT}' | head -1 | awk '{print \$4}')"
echo "  配置摘要:"
grep -vE '^\s*#|^\s*$' ${APP_DIR}/clipflow.env | sed 's/^/    /'
EOF

# ---------------------------------------------------------------- 5. 公网验证
echo
log "从本机做公网验证（http://${ECS_IP}:${PORT}）"
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://${ECS_IP}:${PORT}/" || true)
if [ "$code" = "200" ]; then
  echo "  ✅ 公网首页 HTTP 200"
  echo -n "  ✅ 公网登录接口: "
  curl -s -m 8 -X POST "http://${ECS_IP}:${PORT}/api/auth/login" \
    -H 'content-type: application/json' -d "{\"token\":\"${ACCESS_TOKEN}\"}" \
    -o /dev/null -w 'HTTP %{http_code}\n'
  echo -n "  ✅ 未登录访问业务接口（期望 401）: "
  curl -s -o /dev/null -m 8 -w 'HTTP %{http_code}\n' "http://${ECS_IP}:${PORT}/api/config"
else
  warn "公网访问返回 ${code:-无响应}——几乎一定是安全组没放行 ${PORT} 端口。"
  cat <<TIP

  到阿里云控制台加上这条入方向规则（只需加一次）：
    授权策略: 允许 | 优先级: 1
    协议类型: 自定义 TCP
    端口范围: ${PORT}/8787
    授权对象: 0.0.0.0/0      （想更严格就填你们办公网出口 IP）
    描述: ClipFlow

TIP
fi

cat <<EOF

──────────────────────────────────────────────
 部署完成
──────────────────────────────────────────────
 公网地址   http://${ECS_IP}:${PORT}
 登录 Token ${ACCESS_TOKEN}
 安装目录   ${APP_DIR}      配置文件 ${APP_DIR}/clipflow.env
 服务管理   systemctl status clipflow / restart / journalctl -u clipflow -f

EOF

# 根据线上真实配置给出准确的下一步（密钥已配好时不再误导）
if "${SSH[@]}" "grep -q '^AMK_API_KEY=..*' ${APP_DIR}/clipflow.env" 2>/dev/null; then
  echo " 去字幕接口   已配置（AMK_API_KEY + PUBLIC_BASE_URL=${PUBLIC_BASE_URL}），可直接提交任务"
else
  cat <<TIP
 还差一步才能真正去字幕：把去字幕接口的密钥填进配置
   ssh -i ${SSH_KEY} ${ECS_USER}@${ECS_IP}
   vi ${APP_DIR}/clipflow.env     # 填 AMK_API_KEY，PUBLIC_BASE_URL 已是 ${PUBLIC_BASE_URL}
   systemctl restart clipflow
TIP
fi
echo "──────────────────────────────────────────────"
