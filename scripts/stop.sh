#!/usr/bin/env bash
# 停止后台服务器。
pkill -f "node server.js" 2>/dev/null || true
echo "stopped"