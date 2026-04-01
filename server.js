const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 存储所有终端 session
const sessions = new Map();
let nextSessionId = 1;

// 禁用缓存，确保客户端总是加载最新代码
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));
// 提供 xterm 本地资源
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/xterm-addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));

// API: 获取所有 session 列表
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({ id, name: session.name, created: session.created });
  }
  res.json(list);
});

// 获取本机局域网 IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// 创建新的终端 session
function createSession(name) {
  const id = nextSessionId++;
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: process.env,
  });

  const session = {
    id,
    name: name || `PowerShell ${id}`,
    pty: ptyProcess,
    created: new Date().toISOString(),
    clients: new Set(),    // 连接到此 session 的 WebSocket 客户端
    scrollback: '',        // 保留输出历史，新客户端连接时回放
  };

  // 终端输出 → 广播给所有连接的客户端
  ptyProcess.onData((data) => {
    // 保留最近的输出（限制大小防止内存溢出）
    session.scrollback += data;
    if (session.scrollback.length > 100000) {
      session.scrollback = session.scrollback.slice(-50000);
    }
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', sessionId: session.id, data }));
      }
    }
  });

  ptyProcess.onExit(() => {
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', sessionId: id }));
      }
    }
    sessions.delete(id);
  });

  sessions.set(id, session);
  return session;
}

// WebSocket 连接处理
wss.on('connection', (ws) => {
  let currentSession = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // 创建新终端
      case 'create': {
        const session = createSession(msg.name);
        ws.send(JSON.stringify({
          type: 'created',
          sessionId: session.id,
          name: session.name,
        }));
        // 广播 session 列表更新给所有 WebSocket 客户端
        broadcastSessionList();
        break;
      }

      // 连接到已有终端
      case 'attach': {
        const session = sessions.get(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          return;
        }
        // 从旧 session 断开
        if (currentSession) {
          currentSession.clients.delete(ws);
        }
        currentSession = session;
        session.clients.add(ws);
        // 回放历史输出
        if (session.scrollback) {
          ws.send(JSON.stringify({ type: 'output', data: session.scrollback }));
        }
        ws.send(JSON.stringify({
          type: 'attached',
          sessionId: session.id,
          name: session.name,
        }));
        break;
      }

      // 键盘输入
      case 'input': {
        if (currentSession) {
          currentSession.pty.write(msg.data);
        }
        break;
      }

      // 调整终端大小
      case 'resize': {
        if (currentSession && msg.cols && msg.rows) {
          ws._termSize = { cols: msg.cols, rows: msg.rows };
          // 只有当 session 仅有一个客户端时才 resize PTY
          // 防止第二个设备（如手机）的小屏 resize 导致第一个设备清屏
          if (currentSession.clients.size <= 1) {
            currentSession.pty.resize(msg.cols, msg.rows);
          }
        }
        break;
      }

      // 关闭终端
      case 'kill': {
        const session = sessions.get(msg.sessionId);
        if (session) {
          session.pty.kill();
          sessions.delete(msg.sessionId);
          if (currentSession && currentSession.id === msg.sessionId) {
            currentSession = null;
          }
          broadcastSessionList();
        }
        break;
      }

      // 重命名终端
      case 'rename': {
        const session = sessions.get(msg.sessionId);
        if (session && msg.name) {
          session.name = msg.name;
          broadcastSessionList();
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentSession) {
      currentSession.clients.delete(ws);
      // 当只剩一个客户端时，把 PTY 调整为该客户端的尺寸
      if (currentSession.clients.size === 1) {
        const remaining = [...currentSession.clients][0];
        if (remaining._termSize) {
          currentSession.pty.resize(remaining._termSize.cols, remaining._termSize.rows);
        }
      }
    }
  });
});

// 广播 session 列表给所有客户端
function broadcastSessionList() {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({ id, name: session.name, created: session.created });
  }
  const msg = JSON.stringify({ type: 'sessions', list });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  ShellPort 已启动!');
  console.log('');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  手机访问:   http://${ip}:${PORT}`);
  console.log('');
});
