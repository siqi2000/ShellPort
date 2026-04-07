const express = require('express');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// 加载 .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// 认证配置：支持两种模式
//   1) 多问题验证：SHELLPORT_Q1/A1, Q2/A2, ... 全部答对才放行
//   2) 单密码：SHELLPORT_PASSWORD（向后兼容）
const authQuestions = [];
for (let i = 1; i <= 10; i++) {
  const q = process.env[`SHELLPORT_Q${i}`];
  const a = process.env[`SHELLPORT_A${i}`];
  if (q && a) authQuestions.push({ q, a });
}
const PASSWORD = process.env.SHELLPORT_PASSWORD;
const authMode = authQuestions.length > 0 ? 'questions' : (PASSWORD ? 'password' : null);

if (!authMode) {
  console.error('');
  console.error('  ERROR: 没找到认证配置');
  console.error('  请在项目根目录创建 .env 文件,二选一:');
  console.error('');
  console.error('  方式 A — 多问题验证:');
  console.error('    SHELLPORT_Q1=妈妈的名字');
  console.error('    SHELLPORT_A1=xxx');
  console.error('    SHELLPORT_Q2=男朋友的名字');
  console.error('    SHELLPORT_A2=xxx');
  console.error('    SHELLPORT_Q3=密码');
  console.error('    SHELLPORT_A3=xxx');
  console.error('');
  console.error('  方式 B — 单密码:');
  console.error('    SHELLPORT_PASSWORD=你的密码');
  console.error('');
  process.exit(1);
}

function normalizeAnswer(s) {
  return (s || '').trim().toLowerCase();
}
function checkAuth(formData) {
  if (authMode === 'questions') {
    return authQuestions.every((qa, i) =>
      normalizeAnswer(formData[`a${i + 1}`]) === normalizeAnswer(qa.a)
    );
  }
  return formData.password === PASSWORD;
}

// 登录 token (HMAC 签名,无状态,服务器重启后依然有效)
// secret 第一次启动时生成,持久化到 data/.token_secret(gitignored)
// 删掉这个文件 = 使所有 cookie 失效(强制全部重新登录)
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const secretPath = path.join(dataDir, '.token_secret');
let TOKEN_SECRET;
if (fs.existsSync(secretPath)) {
  TOKEN_SECRET = fs.readFileSync(secretPath, 'utf8').trim();
} else {
  TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, TOKEN_SECRET, { mode: 0o600 });
}

function sign(payload) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
}
function newToken() {
  const ts = Date.now().toString();
  return `${ts}.${sign(ts)}`;
}
function isValidToken(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(ts);
  if (sig.length !== expected.length) return false;
  // 用 timingSafeEqual 防止时序攻击
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return false;
  }
  const tsNum = parseInt(ts, 10);
  if (!tsNum || Date.now() - tsNum > TOKEN_TTL_MS) return false;
  return true;
}
function getTokenFromCookie(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|; )shellport_token=([^;]+)/);
  return m ? m[1] : null;
}
function isAuthed(req) {
  return isValidToken(getTokenFromCookie(req));
}

// 日志目录
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// 解析 SHELLPORT_TCP_TARGETS,格式: name1:host:port,name2:host:port
// 这些目标连到一个监听 TCP 的"shell bridge"(home_bridge.js),用于
// 暴露不能跑 sshd 的机器的 shell
function listTcpTargets() {
  const raw = process.env.SHELLPORT_TCP_TARGETS;
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const m = part.trim().match(/^([^:]+):([^:]+):(\d+)$/);
    if (m) out.push({ id: m[1], host: m[2], port: parseInt(m[3], 10) });
  }
  return out;
}

// 解析 ~/.ssh/config,返回 Host 别名列表(跳过通配符)
function listSshTargets() {
  const cfgPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(cfgPath)) return [];
  const targets = [];
  for (const raw of fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^Host\s+(.+)$/i);
    if (!m) continue;
    for (const name of m[1].split(/\s+/)) {
      if (name && !name.includes('*') && !name.includes('?')) {
        targets.push(name);
      }
    }
  }
  return targets;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, cb) => {
    if (isAuthed(info.req)) cb(true);
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

app.get('/login', (req, res) => {
  const err = req.query.err ? '<div class="err">答案不正确</div>' : '';
  let fields;
  if (authMode === 'questions') {
    // 问题里包含"密码/password"的才用 type=password,其他用 type=text
    // 因为 password 输入框在很多浏览器/手机上会禁用输入法,中文/日文等打不进去
    fields = authQuestions.map((qa, i) => {
      const isPwd = /密码|password|passwd|pwd/i.test(qa.q);
      const type = isPwd ? 'password' : 'text';
      return `
        <label>${escapeHtml(qa.q)}</label>
        <input type="${type}" name="a${i + 1}" autocomplete="off" autocapitalize="off" spellcheck="false"${i === 0 ? ' autofocus' : ''}>
      `;
    }).join('');
  } else {
    fields = '<input type="password" name="password" placeholder="Password" autofocus>';
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>ShellPort Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#161b22;padding:32px;border-radius:8px;border:1px solid #30363d;min-width:280px;max-width:360px}
h1{color:#58a6ff;margin:0 0 20px;font-size:18px}
label{display:block;font-size:12px;color:#8b949e;margin-bottom:6px;margin-top:12px}
label:first-of-type{margin-top:0}
input{display:block;width:100%;padding:10px;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:4px;font-size:14px;box-sizing:border-box}
input:focus{outline:none;border-color:#58a6ff}
button{width:100%;margin-top:18px;padding:10px;background:#58a6ff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px}
button:hover{opacity:.85}
.err{color:#f85149;font-size:12px;margin-bottom:8px}</style></head>
<body><form method="POST" action="/login"><h1>ShellPort</h1>${err}${fields}
<button>Sign in</button></form></body></html>`);
});

app.post('/login', (req, res) => {
  if (req.body && checkAuth(req.body)) {
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

// API: 获取可用的会话目标(本地 + ~/.ssh/config 里的所有 Host + TCP 目标)
app.get('/api/targets', (req, res) => {
  const localName = process.platform === 'win32' ? 'Local PowerShell' : 'Local Shell';
  const list = [{ id: 'local', name: localName }];
  for (const t of listSshTargets()) {
    list.push({ id: t, name: t });
  }
  for (const t of listTcpTargets()) {
    list.push({ id: t.id, name: t.id });
  }
  res.json(list);
});

// 检查单个 TCP 目标是否可达(简单 connect 测试)
function checkTcpTarget(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let done = false;
    const finish = (status) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(status); } };
    sock.once('connect', () => finish('ok'));
    sock.once('error', () => finish('fail'));
    setTimeout(() => finish('fail'), 3000);
  });
}

// 检查单个 SSH 目标是否可达(BatchMode + 短超时)
function checkSshTarget(target) {
  return new Promise((resolve) => {
    const sshCmd = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
      : 'ssh';
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'LogLevel=ERROR',
      target,
      'exit',
    ];
    let done = false;
    const finish = (status) => { if (!done) { done = true; resolve(status); } };
    let proc;
    try {
      proc = spawn(sshCmd, args, { stdio: 'ignore' });
    } catch {
      return finish('fail');
    }
    proc.on('exit', (code) => finish(code === 0 ? 'ok' : 'fail'));
    proc.on('error', () => finish('fail'));
    // 兜底:6 秒还没完就杀掉
    setTimeout(() => {
      if (!done) {
        try { proc.kill(); } catch {}
        finish('fail');
      }
    }, 6000);
  });
}

// API: 帮助文档(从项目根的 help.md 读取,允许部署方写自定义提示)
app.get('/api/help', (req, res) => {
  for (const name of ['help.md', 'help.txt', 'HELP.md']) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) {
      res.type('text/plain; charset=utf-8').send(fs.readFileSync(p, 'utf8'));
      return;
    }
  }
  // 没有自定义文档时返回一份通用说明
  res.type('text/plain; charset=utf-8').send(
    'No help.md configured.\n\n' +
    'To customize this panel, drop a help.md (or help.txt) into the\n' +
    'ShellPort project root and refresh. Markdown is rendered as plain\n' +
    'text in a monospace block, so any formatting you can express with\n' +
    'whitespace + ASCII will work.\n'
  );
});

// API: 检查所有目标的连接状态(并发,带 10s 缓存)
let statusCache = { time: 0, data: null };
app.get('/api/targets/status', async (req, res) => {
  const now = Date.now();
  if (statusCache.data && now - statusCache.time < 10_000) {
    return res.json(statusCache.data);
  }
  const sshTargets = listSshTargets();
  const tcpTargets = listTcpTargets();
  const results = { local: 'ok' };
  await Promise.all([
    ...sshTargets.map(async (t) => { results[t] = await checkSshTarget(t); }),
    ...tcpTargets.map(async (t) => { results[t.id] = await checkTcpTarget(t.host, t.port); }),
  ]);
  statusCache = { time: Date.now(), data: results };
  res.json(results);
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

// 把一个 TCP socket 包装成 pty 兼容的接口,这样后续 session 代码不用区分
function tcpAsPty(host, port) {
  const sock = net.connect(port, host);
  const dataCbs = [];
  const exitCbs = [];
  let exited = false;

  sock.on('data', (buf) => {
    const s = buf.toString('utf8');
    for (const cb of dataCbs) cb(s);
  });
  const handleEnd = () => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb({ exitCode: 0 });
  };
  sock.on('close', handleEnd);
  sock.on('error', (err) => {
    // 把错误以可读文本送给客户端再关掉
    const msg = `\r\n[bridge] connection error: ${err.message}\r\n`;
    for (const cb of dataCbs) cb(msg);
    handleEnd();
  });

  return {
    write: (data) => { try { sock.write(data); } catch {} },
    resize: (cols, rows) => {
      // 通过自定义控制序列把 resize 通知给 bridge(后者会调 pty.resize)
      try { sock.write(`\x1b]9999;resize;${cols};${rows}\x07`); } catch {}
    },
    kill: () => { try { sock.destroy(); } catch {} },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
}

// 创建新的终端 session
// target: 'local'(默认) | SSH 别名 | TCP 目标 id
function createSession(name, target) {
  const id = nextSessionId++;
  const isLocal = !target || target === 'local';
  const tcpTarget = !isLocal ? listTcpTargets().find(t => t.id === target) : null;
  const isTcp = !!tcpTarget;
  const isSsh = !isLocal && !isTcp;

  let ptyProcess;
  try {
    if (isTcp) {
      ptyProcess = tcpAsPty(tcpTarget.host, tcpTarget.port);
    } else {
      const cmd = isLocal
        ? (process.platform === 'win32' ? 'powershell.exe' : 'bash')
        : (process.platform === 'win32'
            ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
            : 'ssh');
      const args = isLocal ? [] : ['-tt', target];
      ptyProcess = pty.spawn(cmd, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: process.env,
      });
    }
  } catch (err) {
    console.error(`Failed to start session for ${target || 'local'}:`, err.message);
    throw err;
  }

  const defaultName = isLocal
    ? (process.platform === 'win32' ? `PowerShell ${id}` : `Shell ${id}`)
    : target;
  const sessionName = name || defaultName;

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
        let session;
        try {
          session = createSession(msg.name, msg.target);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Failed to create session: ${err.message}` }));
          break;
        }
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
