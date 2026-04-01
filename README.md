# ShellPort

**[English](#english) | [中文](#中文)**

---

## English

Web-based terminal sharing tool. Run a terminal on your computer, access and control it from any device on the same network -- phone, tablet, or another PC.

### Features

- **Multi-device access** -- open the same terminal session from multiple devices simultaneously
- **Session management** -- create, switch, rename, and close multiple terminal tabs
- **Scrollback replay** -- new clients joining an existing session see the full output history
- **Mobile-friendly** -- bottom toolbar with common keys (Enter, Tab, arrows, Ctrl combos) and a keyboard toggle for smooth scrolling
- **Real-time sync** -- session list updates are broadcast to all connected clients instantly

### Quick Start

```bash
npm install
npm start
```

The server starts on port 3000. Access it at:

- **Local**: http://localhost:3000
- **Other devices**: http://\<your-lan-ip\>:3000 (printed in the console on startup)

### Tech Stack

- **Backend**: Node.js, Express, ws (WebSocket), node-pty
- **Frontend**: xterm.js, vanilla JavaScript

### How It Works

The server spawns a PTY process (PowerShell on Windows, bash on Linux/macOS) for each terminal session. Client browsers connect via WebSocket and render the terminal output using xterm.js. Multiple clients can attach to the same session -- keyboard input from any client is forwarded to the PTY, and output is broadcast to all viewers.

### License

ISC

---

## 中文

基于 Web 的终端共享工具。在电脑上运行终端，局域网内的任何设备（手机、平板、其他电脑）都可以访问和操控。

### 功能特性

- **多设备访问** -- 多个设备可以同时打开并操控同一个终端会话
- **会话管理** -- 创建、切换、重命名、关闭多个终端标签页
- **历史回放** -- 新设备加入已有会话时自动回放之前的输出内容
- **移动端适配** -- 底部工具栏提供常用按键（回车、Tab、方向键、Ctrl 组合键），支持键盘开关以便自由滑动浏览
- **实时同步** -- 会话列表变更会即时推送给所有已连接的客户端

### 快速开始

```bash
npm install
npm start
```

服务器默认运行在 3000 端口，启动后控制台会打印访问地址：

- **本机访问**: http://localhost:3000
- **其他设备**: http://\<局域网IP\>:3000

### 技术栈

- **后端**: Node.js、Express、ws（WebSocket）、node-pty
- **前端**: xterm.js、原生 JavaScript

### 工作原理

服务器为每个终端会话生成一个 PTY 进程（Windows 上为 PowerShell，Linux/macOS 上为 bash）。浏览器通过 WebSocket 连接服务器，使用 xterm.js 渲染终端输出。多个客户端可以连接到同一个会话 -- 任意客户端的键盘输入都会转发到 PTY，输出则广播给所有连接者。

### 许可证

ISC
