# AG Bridge (Antigravity Bridge)

**A lightweight Mobile Interface for the Antigravity Agent.**
Chat with your AI agent from your couch, verify tasks, and "poke" it to wake up—all from your phone.

## Features
- 📱 **Mobile Chat UI**: Full chat interface with history.
- 🩸 **The Poke**: Remotely wakes up the Agent in Antigravity (no manual typing needed!).
- 🔒 **LAN Only**: Your data stays on your network. No cloud databases.
- 🔌 **MCP Integration**: Agent can read messages and report status directly.

## Architecture
`Phone` <-> `Bridge Server` <-> `Antigravity (Agent)`
(See [Architecture](docs/architecture.md) for details).

## Requirements
- **Node.js**: v18+
- **Antigravity**: Launched with `--remote-debugging-port=9000` via terminal.
- **Network**: Both PC and Phone on same Wi-Fi.

## Quick Start

### 1. Start AG (Critical)
You **must** start AG from a terminal to enable the Poke:
```bash
antigravity.exe . --remote-debugging-port=9000
```
*(If the Agent doesn't "wake up", this is usually why.)*

### 2. Install & Start Bridge
```bash
npm install
npm start
```
You will see a **Pairing Code** and **IP Address** in the console.

### 3. Open on Phone
1. Go to `http://<YOUR_IP>:8787` on your phone.
2. Enter the Pairing Code.
3. Chat away!

## Documentation
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)

## License
MIT. Built for the Antigravity community.
