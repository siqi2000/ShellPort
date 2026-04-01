# ShellPort

Web-based terminal sharing tool. Run a terminal on your computer, access and control it from any device on the same network -- phone, tablet, or another PC.

## Features

- **Multi-device access** -- open the same terminal session from multiple devices simultaneously
- **Session management** -- create, switch, rename, and close multiple terminal tabs
- **Scrollback replay** -- new clients joining an existing session see the full output history
- **Mobile-friendly** -- bottom toolbar with common keys (Enter, Tab, arrows, Ctrl combos) and a keyboard toggle for smooth scrolling
- **Real-time sync** -- session list updates are broadcast to all connected clients instantly

## Quick Start

```bash
npm install
npm start
```

The server starts on port 3000. Access it at:

- **Local**: http://localhost:3000
- **Other devices**: http://\<your-lan-ip\>:3000 (printed in the console on startup)

## Tech Stack

- **Backend**: Node.js, Express, ws (WebSocket), node-pty
- **Frontend**: xterm.js, vanilla JavaScript

## How It Works

The server spawns a PTY process (PowerShell on Windows, bash on Linux/macOS) for each terminal session. Client browsers connect via WebSocket and render the terminal output using xterm.js. Multiple clients can attach to the same session -- keyboard input from any client is forwarded to the PTY, and output is broadcast to all viewers.

## License

ISC
