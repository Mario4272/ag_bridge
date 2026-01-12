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
3. Enter the Pairing Code.
4. Chat away!

## Remote Access (Optional) ☁️
AG Bridge is designed as a **LAN-first** tool. It binds to `0.0.0.0` to be accessible on your local Wi-Fi.

**For remote access (outside your home):**
- **Recommended**: Use **Tailscale** (or wireguard) to create a secure mesh network.
- **Warning**: Do NOT forward port 8787 directly to the open internet. The token auth is robust, but the server is not hardened for public exposure.
- **Note**: Using a VPN/Tailscale does NOT bypass authentication; you will still need to pair your device.

## Testing & CI 🧪
To run the test suite locally:
```bash
npm test
```
(Runs unit tests and smoke tests via Vitest)

To scan for repo hygiene issues:
```bash
npm run check:bidi
```
(Scans for hidden Unicode characters)

**CI**: GitHub Actions automatically runs these tests on every Pull Request.


## Documentation
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)

## License
MIT. Built for the Antigravity community.
