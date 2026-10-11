#!/usr/bin/env bash
# 以脱离终端的后台进程方式启动服务器。
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/opencode/qwen-proxy.log
mkdir -p /tmp/opencode
if pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "server already running"
else
  (cd "$DIR" && setsid nohup node server.js >"$LOG" 2>&1 < /dev/null &)
  echo "started, log: $LOG"
fi
