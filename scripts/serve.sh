#!/usr/bin/env bash
# 起后端服务（单进程：静态页 + JSON API，一个端口）。
#
#   ./scripts/serve.sh              # 默认：cli 适配器，读写真表（http://127.0.0.1:8787）
#   ./scripts/serve.sh file         # 只读本地 data/rows_v2.json，写操作返回 501
#   ./scripts/serve.sh mock         # 本地假表 data/mock_sheet.json（测试写路径用）
#   PORT=9000 ./scripts/serve.sh    # 换端口
#
# 上线前必须设置 HPS_SECRET（默认密钥会打印醒目警告）：
#   HPS_SECRET="$(openssl rand -hex 32)" ./scripts/serve.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ADAPTER="${1:-${HPS_SHEET_ADAPTER:-cli}}"
export HPS_SHEET_ADAPTER="$ADAPTER"
export PORT="${PORT:-8787}"
export HPS_HOST="${HPS_HOST:-127.0.0.1}"

echo "适配器=$ADAPTER  地址=http://$HPS_HOST:$PORT"
exec python3 server.py
