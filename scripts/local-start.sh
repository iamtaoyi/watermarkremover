#!/usr/bin/env bash
# 本地启动（与线上同构：默认 80 端口，代码零差异）
# 用法： sudo bash scripts/local-start.sh [端口]
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-80}"
export PORT
export DATA_DIR="${DATA_DIR:-$PWD/data-local}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1}"
export ADMIN_PHONE="${ADMIN_PHONE:-13818808620}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123456}"
echo "  启动 ClipFlow 本地实例：http://127.0.0.1:${PORT}/  数据目录 ${DATA_DIR}"
exec node server.mjs
