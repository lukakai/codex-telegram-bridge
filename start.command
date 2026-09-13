#!/bin/zsh
set -eu
DIR="${0:A:h}"
NODE="${CODEX_TELEGRAM_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  print -r -- "需要 Node.js 22 或更高版本。请先安装 Node.js，或用 CODEX_TELEGRAM_NODE 指定可信的 node 可执行文件。"
  read "REPLY?按回车关闭："
  exit 1
fi
if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  print -r -- "当前 Node 版本过低，需要 22 或更高版本。可用 CODEX_TELEGRAM_NODE 指定其他 node。"
  read "REPLY?按回车关闭："
  exit 1
fi
print -r -- "Codex Telegram Bridge · 本机终端"
print -r -- "请保持 Mac 醒着且联网；不会自动启用开机启动。"
if ! "$NODE" "$DIR/main.mjs" "$@"; then
  print -r -- "程序未完成启动，请查看上面的提示。"
  read "REPLY?按回车关闭："
  exit 1
fi
