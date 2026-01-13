# AG Bridge Security Model (v0.x)

**Current Status**: Alpha / Experimental.
**Scope**: LAN Only.

## Core Assumptions
1. **Local Network Trust**: We assume your home Wi-Fi is secure. Anyone on the LAN can access the bridge if they have the IP working pair code/token.
2. **No Cloud**: Data never leaves your local network (except what you explicitly ask the Agent to do).
3. **Tailscale Note**: If using Tailscale for remote access, connections are end-to-end encrypted. In some network conditions, Tailscale may route traffic through [DERP relays](https://tailscale.com/kb/1232/derp-servers) for NAT traversal—this is still encrypted and Tailscale cannot see your data.

## Authentication
- **Pairing**: A 6-digit `PAIRING_CODE` is printed in the server console on startup.
- **Token**: The phone exchanges the code for a long-lived `x-ag-token`.
- **Persistence**: Tokens are stored in `data/state.json`.

## Strict Mode (Policy)
To prevent the Mobile UI from doing dangerous things, `server.mjs` implements a `checkPolicy()` function backed by `policy.json`.
- **Allowed**: Whitelisted commands (e.g., `git status`, `ls`).
- **Denied**: `rm -rf`, sensitive system commands.

## Roadmap (v1.0 Goals)
- [ ] TLS Support (HTTPS).
- [ ] Multi-User Auth.
- [ ] Cloudflare Tunnel support (optional for secure remote access).
