# Codex Telegram Local Bridge

一个运行在 macOS 本机的单用户 Telegram Bridge，用来远程查看并继续 Codex 会话、收发文件、处理审批，以及在明确确认后从桌面端接管会话。

> Experimental community project. This is not an official OpenAI or Telegram product.

## 能做什么

- 通过 Telegram 私聊查看已授权项目中的本地 Codex 会话。
- 发送文字、图片和单个文档，接收 Codex 生成或修改的文件。
- 在 Telegram 处理命令审批、文件变更审批和 Codex 提问。
- 选择模型与推理强度，切换严格审批或 Codex 原生 `auto_review`。
- 空闲时不恢复会话；收到任务才启动临时 App Server，任务结束立即释放 writer。
- 桌面 writer 冲突时提供高风险二次确认，可温和结束桌面 Codex 后端并由 TG 接管。
- 每个任务只使用一条状态消息：提交后原地更新，成功并释放 worker 30 秒后自动删除；中止和异常状态保留。

Bridge 不开放本地 HTTP 端口，不依赖第三方 npm 包，也不会把整台 Mac 默认交给远程任务。

## 环境要求

- macOS。
- Node.js 22 或更高版本。
- 已安装并登录 Codex/ChatGPT 桌面应用，或有可运行的 `codex` CLI。
- 一个专用 Telegram Bot；不要与 webhook 或其他轮询程序共用。
- 一个或多个明确授权的本地项目目录。

桌面强制接管仅支持能被安全识别的 `ChatGPT.app/Contents/Resources/codex` 后端。使用其他 Codex 可执行文件时，其余功能仍可工作，但接管会安全拒绝。

## 快速开始

```bash
git clone https://github.com/lukakai/codex-telegram-bridge.git
cd codex-telegram-bridge
./start.command
```

若解压工具丢失了可执行权限，可先运行：

```bash
chmod +x start.command
```

如果默认 `node` 不是 22+，可以显式指定可信的 Node：

```bash
CODEX_TELEGRAM_NODE=/absolute/path/to/node ./start.command
```

首次启动会在终端中引导完成：

1. 确认隐私和安全边界。
2. 选择 Codex 可执行文件以及与桌面端一致的 `CODEX_HOME`。
3. 添加允许 Telegram 操作的具体项目目录。
4. 在终端隐藏输入 Bot Token。
5. 把一次性 `/start` 口令发送到 Bot 私聊，并在终端核对 Telegram 用户 ID。

配置保存在 `state/`，文件权限限制为当前 macOS 用户。这里包含明文 Bot Token，因此不要复制、上传或提交该目录。`state/` 已加入 `.gitignore`。

已配置用户再次运行 `./start.command` 即可；只有需要重新配对时才使用：

```bash
./start.command --configure
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/projects` | 选择已授权项目 |
| `/threads [关键词]` | 查看项目及子目录中的会话 |
| `/history [会话ID]` | 只读查看最近对话 |
| `/use <会话ID>` | 选择会话，不立即持有 writer |
| `/new <任务>` | 在当前项目创建持久会话并执行任务 |
| `/model`、`/effort` | 设置后续任务的模型与推理强度 |
| `/approval` | 切换严格审批或原生自动审查 |
| `/allow <绝对目录>` | 二次确认后增加具体目录授权 |
| `/permissions`、`/revoke` | 查看或撤销 TG 新增的目录授权 |
| `/status` | 查看项目、会话、任务、审批及连接状态 |
| `/guide` | 根据当前状态提示下一步；忙碌、待审批、待回答均有引导 |
| `/pending` | 查看运行中收到的文字待办，立即引导、排队或取消 |
| `/answer <编号> <回答>` | 回答 Codex 的补充问题 |
| `/mcp [编号] [yes/no/cancel/JSON]` | 查看或响应外部工具确认请求；简单选项可直接点按钮 |
| `/stop` | 请求中止当前 TG 任务 |
| `/release` | 释放 TG 自己持有的临时 writer |

完整交互说明见 [guide.html](guide.html)。

## 任务运行中纠正方向

v0.4.4：Codex 工作到一半时，可以直接发一条文字，例如“先别改页面，先修测试”。Bridge 会把它保存为待办，出现三个按钮：

- **立即引导**：通过原生 `turn/steer` 追加到正在执行的原任务，不需要先 `/stop`。改变后续执行方向，不自动撤销已完成的操作。
- **下一轮发送**：等当前任务正常完成并释放 worker，再发送。多条已排队文字按收到顺序合并，超过单轮 30000 字符则分轮；也可取消排队。
- **取消**：移除尚未发送的待办。

未选择按钮的待办不会自动执行。原任务已经结束时，“立即引导”保留文字并提示使用“下一轮发送”。任务中止、失败、会话切换或桌面端占用时，自动发送暂停。送达不确定时不会重试，请先核对历史。`/pending` 重新显示按钮，`/status` 显示待办数量。

本版运行中追加仅支持文字；图片和文件仍在任务空闲时发送。待办仅保存在当前 Bridge 内存，30 分钟过期，最多 20 条、总共 60000 字符；重启/断线后清空。`/guide` 仍是操作说明，“立即引导”按钮才是向当前任务追加指令。

## 浏览器与工具确认

v0.4.3 支持 App Server 的 `mcpServer/elicitation/request`，按[官方 App Server 协议](https://learn.chatgpt.com/docs/app-server)回传表单确认。Chrome/Computer Use 发来的基础表单请求会显示确认按钮；需要填写时使用 `/mcp`，缺少必填值时不会自动猜测。请求超时、任务结束或连接断开后，旧确认失效。

URL 流程只显示域名和路径，隐藏查询参数/片段。先在 Mac 使用服务提供的原始链接完成登录等操作，再点击“已在 Mac 完成”；Telegram 按钮不会代替网页登录。敏感输入、嵌套表单或暂不支持的规则需要在 Mac 处理。工具已有的 API Key 鉴权限制、macOS 辅助功能/屏幕录制权限仍由对应服务或系统决定，Bridge 的确认不能绕过它们。

看到“操作未完成”时，发送 `/guide` 获取当前状态对应的下一步。运行中发来的普通文字进入待办；`/new`、切换模型等操作仍需等待任务结束。待审批或提问需使用对应按钮或 `/answer` 处理。

## 文件和图片

- TG → Codex 图片使用 App Server 的 `localImage` 输入。
- TG → Codex 普通文档会保存到所选项目内的私有随机目录，再把安全路径交给模型。App Server 目前没有公开的通用文档附件输入类型，因此桌面端会看到文件路径，而不是原生附件卡片。
- Codex → TG 图片在 10 MB 内通过 `sendPhoto` 发送。
- Codex → TG 其他文件通过 `sendDocument` 作为原生 Telegram 文档上传，单个文件上限 50 MB。
- 输入文件名、扩展名、符号链接、硬链接、路径范围、文件身份和大小都会校验；隐藏或敏感路径默认拒绝导出。

## 安全边界

- 仅接受首次配对的 Telegram 数字用户 ID，且只接受一对一私聊。
- Bot 对话经过 Telegram 云端，并非端到端加密。任务、回复、审批内容和历史摘要可能进入 Telegram。
- 默认保留 `workspace-write` 沙箱；不会启用 `danger-full-access` 或 `never`。
- 新配置默认没有受信任网络域名。只有 `state/config.json` 中明确列出的精确小写 HTTPS 主机，且 App Server 主动提出对应策略修订时，Bridge 才应用该单项规则。
- 目录授权限制会话入口和文件边界，但不是任意 shell 命令的完整行为防火墙。批准沙箱外命令前仍需检查完整命令。
- 消息先保存 Telegram offset 再执行，崩溃后不自动重放，以降低重复执行风险；极端情况下需人工确认后重发。

### 桌面接管风险

Codex App Server 没有释放其他客户端 writer 的公开接口。点击 TG 中的“确认释放桌面并由 TG 接管”时，Bridge 会验证当前用户、可执行路径、父进程关系和目标唯一性，然后只发送 `SIGTERM`，不会使用 `SIGKILL`，也不会退出 ChatGPT 窗口。

这个操作会重启桌面 Codex 后端，可能中断桌面端所有正在执行的 Codex 任务、审批和终端，而不只当前会话。已经发生的文件修改或外部操作不会回滚。接管不会自动重发失败任务；两分钟未开始任务会自动释放。

## 可选网络与图片服务

仓库不包含、安装或预设任何第三方图片服务、API Key 或 Python 环境。若 Codex 任务需要网络或图片生成，每位用户应自行配置可信服务和本地技能，并把所需精确域名加入自己的 `state/config.json`。不要提交该文件，也不要在 Telegram 中发送凭据。

## 检查与测试

```bash
npm test
node verify.mjs
./start.command --doctor
```

`npm test` 和 `node verify.mjs` 使用离线模拟，不发送 Telegram 消息、不执行真实 Codex 任务，也不会做真实桌面接管。`--doctor` 会联网检查 Bot 并与本机 Codex 完成初始化握手。

## 当前限制

- App Server 协议包含实验性接口，Codex 更新后可能需要同步适配。
- 同一时刻只运行一个由该 TG Bridge 发起的任务。
- Telegram 文档输入不能显示成桌面端原生附件卡片。
- 桌面强制接管目前仅针对 macOS ChatGPT 内置 Codex 后端，并且仍需在无重要桌面任务时谨慎验证。
- 这是个人远程控制原型，尚未经过独立生产安全审计。

## License

[MIT](LICENSE)
