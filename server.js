const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 加载 .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PASSWORD = process.env.SHELLPORT_PASSWORD;
if (!PASSWORD) {
  console.error('');
  console.error('  ERROR: 没找到密码配置');
  console.error('  请在项目根目录创建 .env 文件，内容例如:');
  console.error('    SHELLPORT_PASSWORD=你的密码');
  console.error('');
  process.exit(1);
}

// 登录 token（内存存储，重启后失效，需要重新登录）
const validTokens = new Set();
function newToken() {
  const t = crypto.randomBytes(32).toString('hex');
  validTokens.add(t);
  return t;
}
function getTokenFromCookie(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|; )shellport_token=([^;]+)/);
  return m ? m[1] : null;
}
function isAuthed(req) {
  const t = getTokenFromCookie(req);
  return !!(t && validTokens.has(t));
}

// 日志目录
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, cb) => {
    const cookie = info.req.headers.cookie || '';
    const m = cookie.match(/(?:^|; )shellport_token=([^;]+)/);
    if (m && validTokens.has(m[1])) cb(true);
    else cb(false, 401, 'Unauthorized');
  },
});

// 存储所有终端 session
const sessions = new Map();
let nextSessionId = 1;

// 禁用缓存，确保客户端总是加载最新代码
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// 登录页 + 处理
app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
  const err = req.query.err ? '<div class="err">密码错误</div>' : '';
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>ShellPort Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#161b22;padding:32px;border-radius:8px;border:1px solid #30363d;min-width:260px}
h1{color:#58a6ff;margin:0 0 16px;font-size:18px}
input{display:block;width:100%;padding:10px;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:4px;margin-bottom:12px;font-size:14px;box-sizing:border-box}
button{width:100%;padding:10px;background:#58a6ff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px}
.err{color:#f85149;font-size:12px;margin-bottom:8px}</style></head>
<body><form method="POST" action="/login"><h1>ShellPort</h1>${err}
<input type="password" name="password" placeholder="Password" autofocus>
<button>Sign in</button></form></body></html>`);
});

app.post('/login', (req, res) => {
  if (req.body && req.body.password === PASSWORD) {
    const t = newToken();
    res.setHeader('Set-Cookie',
      `shellport_token=${t}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
    res.redirect('/');
  } else {
    res.redirect('/login?err=1');
  }
});

// 认证守卫：除了登录页和 favicon，其他全部要求登录
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/favicon.svg') return next();
  if (!isAuthed(req)) return res.redirect('/login');
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

  const sessionName = name || `PowerShell ${id}`;

  // 按日期建子目录，保存终端输出日志
  const today = new Date().toISOString().slice(0, 10); // 2026-04-02
  const dayDir = path.join(logsDir, today);
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir);
  const logFile = path.join(dayDir, `${sessionName.replace(/\s+/g, '')}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const session = {
    id,
    name: sessionName,
    pty: ptyProcess,
    created: new Date().toISOString(),
    clients: new Set(),
    scrollback: '',
    logStream,
  };

  // 终端输出 → 广播给所有连接的客户端 + 写入日志
  ptyProcess.onData((data) => {
    // 写入日志文件
    session.logStream.write(data);
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
    session.logStream.end();
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
          session.logStream.end();
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
