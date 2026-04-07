// home_bridge.js — 在家里的电脑上跑,把本地 powershell 通过 TCP 暴露出来
// 它配合 `ssh -R 2222:localhost:9999 myrelay` 使用(myrelay 是你
// ~/.ssh/config 里中转服务器的别名),这样中转就能通过 127.0.0.1:2222
// 连进来,得到一个完整的 PowerShell 会话。
//
// 用法:
//   node home_bridge.js
//
// 监听 127.0.0.1:9999(只接受本机连接,所以即使端口忘了关也不会被
// 局域网/公网直接访问;唯一进来的路径是已经建好的 SSH 反向隧道)。

const net = require('net');
const pty = require('node-pty');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.HOME_BRIDGE_PORT || '9999', 10);

const server = net.createServer((sock) => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[bridge] connection from ${peer}`);

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const proc = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.env.USERPROFILE || process.env.HOME,
    env: process.env,
  });

  // 每次读到一段数据先看有没有 resize 控制序列
  // 控制序列格式: \x1b]9999;resize;COLS;ROWS\x07
  let inbuf = '';
  sock.on('data', (chunk) => {
    inbuf += chunk.toString('utf8');
    let m;
    while ((m = inbuf.match(/\x1b\]9999;resize;(\d+);(\d+)\x07/))) {
      const cols = parseInt(m[1], 10);
      const rows = parseInt(m[2], 10);
      try { proc.resize(cols, rows); } catch {}
      inbuf = inbuf.slice(0, m.index) + inbuf.slice(m.index + m[0].length);
    }
    if (inbuf) {
      proc.write(inbuf);
      inbuf = '';
    }
  });

  proc.onData((data) => {
    try { sock.write(data); } catch {}
  });

  proc.onExit(() => {
    console.log(`[bridge] shell exited for ${peer}`);
    try { sock.end(); } catch {}
  });

  sock.on('close', () => {
    console.log(`[bridge] disconnect ${peer}`);
    try { proc.kill(); } catch {}
  });

  sock.on('error', () => {
    try { proc.kill(); } catch {}
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  home_bridge 已启动');
  console.log(`  监听:  ${HOST}:${PORT}  (仅本机)`);
  console.log('');
  console.log('  现在另开一个窗口运行反向隧道:');
  console.log(`    ssh -N -R 2222:${HOST}:${PORT} <你的中转别名>`);
  console.log('');
  console.log('  或者直接双击 home_bridge.bat (会同时开 bridge + tunnel)');
  console.log('');
});
