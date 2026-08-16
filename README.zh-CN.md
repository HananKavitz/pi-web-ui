# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) | **简体中文**

[pi 编码智能体](https://pi.dev) 的 Web 聊天界面 —— 智能体通过 pi SDK 在服务端进程内运行，
事件经 WebSocket 流式推送到浏览器。支持思考块与工具调用、附件与图片问答、内置终端、
模型管理，以及设置面板（自定义系统提示词、技能/插件开关、设置预设一键应用）等功能。
需要 Node.js ≥ 22.19 及配置好的 pi 环境。

## 界面截图

![pi-web-ui 主界面](https://cdn.jsdelivr.net/gh/xing-shuyin/pi-web-ui@main/assets/shot.jpeg)

## 安装

```bash
npm i -g pi-web-ui            # 全局安装（推荐）
npx pi-web-ui                 # 或免安装直接跑（拉取最新版，启动在 :8787）
npm i -g .                    # 或安装本地 checkout
```

**npm ≥ 12？** npm 12+ 默认阻止依赖安装脚本（会看到 `npm warn install-scripts … blocked` 警告）。
node-pty 是原生模块，需要放行其脚本（其余两个包只是 no-op/纯提示，一并放行可消除警告）：

```bash
npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```

## 启动

```bash
pi-web-ui                                           # 前台，http://localhost:8787
PORT=9000 PI_WEB_CWD=/path/to/project pi-web-ui     # 自定义端口 / 工作目录
```

## 停止

- **前台**：在运行它的终端里按 `Ctrl+C`。
- **作为服务**：`pi-web-ui server stop`（停止实例；开机自启保留，直到 `server uninstall`）。

## 更新

```bash
npm i -g pi-web-ui@latest     # 升级到最新发布版本
pi-web-ui server restart      # 重启服务使新版本生效（前台运行则手动重启）
```

## 卸载

```bash
npm uninstall -g pi-web-ui
```

卸载**不会**删除你的聊天记录 —— 会话数据存放在 `<cwd>/.pi-web`（或 `PI_WEB_DATA_DIR`），
卸载/升级后依然保留。

## 作为系统服务（开机自启）

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project   # 安装 + 启动
pi-web-ui server status                     # 运行中？开机自启？
pi-web-ui server restart                    # 重启（应用配置/版本变更）
pi-web-ui server stop                       # 停止（开机自启保留）
pi-web-ui server start                      # 再次启动
pi-web-ui server uninstall                  # 彻底移除服务
pi-web-ui server shortcut                   # 桌面一键启动图标
pi-web-ui server quiesce                    # 排空：拒绝新的对话/消息，存量运行继续跑完
pi-web-ui server unquiesce                  # 解除排空，恢复接收新工作
```

`server status` 还会经本地控制 socket 显示实时状态（版本、PID、排空状态、
浏览器连接数、运行中对话数）——`quiesce`/`unquiesce` 也走同一个 socket。

## 安全

- **默认只绑 loopback** —— 服务器只监听 `127.0.0.1`，不暴露到网络；需要局域网访问或
  Docker 端口映射时显式设置 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置）。
- **WebSocket Origin 校验** —— 浏览器页面连 `/ws` 时其 Origin 的 hostname **和端口**
  必须与请求 Host 一致，跨源页面直接 403；无 Origin 的非浏览器客户端不受影响。
  反向代理场景可用 `PI_WEB_ALLOW_ORIGINS=http://你的域名:端口` 放行。
- **Quiesce 排空** —— `server quiesce` 后拒绝新的 prompt/编辑重问/会话恢复，存量运行
  跑完为止（升级/备份前用）；`server unquiesce` 恢复。
- **凭据不下发浏览器** —— provider 的 `headers`（可能含 Authorization / API key）
  永不发给浏览器；模型管理 UI 编辑其他字段，服务端自动保留 headers。

- **macOS** → launchd 代理（无需 sudo），日志 `/tmp/pi-web-ui.log` / `.err`
- **Linux** → systemd unit（`systemctl enable --now`），日志 `journalctl -u pi-web-ui -f`
- **Windows** → 计划任务（登录自启，隐藏 PowerShell 窗口，无黑窗）

选项：`--port`（默认 8787）、`--cwd`（工作目录）、`--data-dir`（会话目录）、
`--name`（自定义服务名）。重复执行 `server install` 并传入新选项即可重新生成配置
并重启服务 —— 这就是修改已装服务端口/工作目录的方式。

## License

MIT
