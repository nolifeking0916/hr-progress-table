#!/usr/bin/env bash
# 从企业微信在线表格重新抽取数据 → 展开成长表 → 生成网页用的 data/rows.js
# 前置：已授权 wecom-cli（企业微信机器人身份）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/3 抽取在线表格《集团人力近期重点工作进度表》"
python3 scripts/extract_online_sheet.py

echo "==> 2/3 展开为长表（事项 × 分项 × 日期）"
python3 scripts/build_rows.py

echo "==> 3/3 生成 data/rows.js（网页直接读这个）"
python3 scripts/build_data_js.py

echo "==> 完成。预览：python3 -m http.server 8000  然后打开 http://127.0.0.1:8000"
