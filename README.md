# AG Bridge (v0.2)

AG Bridge is a **LAN-only companion app** that turns your phone into a secure dashboard for approving agent actions.

## Features
- **Mobile-Friendly Dashboard**: Approve/Deny actions from your phone.
- **LAN Only**: No cloud, no external servers. Data stays on your network.
- **Persistence (v00.2)**: Approvals and settings survive server restarts (`data/state.json`).
- **Strict Mode (v0.2)**: "Safe by default" command execution policy (`policy.json`).
- **Request API (v0.2)**: Agents/Scripts can request approvals via HTTP or CLI.
- **PWA Support (v0.2)**: Install as an app on your phone.

## Quick Start
1.  **Install**:
    ```bash
    npm install
    ```
2.  **Start**:
    ```bash
    npm start
    ```
3.  **Pair**:
    - The server prints a **PAIRING CODE** and a local URL (e.g., `http://192.168.1.10:8787`).
    - Open the URL on your phone.
    - Enter the code to pair.
    - **Add to Home Screen** for the best experience.

## New in v0.3 (Comms Pivot)
### Comms Bridge
- **Chat UI**: Talk to your Antigravity agent directly from the dashboard.
- **Agent Status**: See if the agent is "Idle" or "Working".
- **@file Workflow**: Mention `@filename` in chat, and the agent can read it securely using the MCP tool.

### Antigravity Integration (MCP)
To enable the agent to talk to the bridge, add this to your Antigravity **MCP Settings**:

```json
{
  "mcpServers": {
    "ag-bridge": {
      "command": "node",
      "args": [
        "C:/Users/mfadmin/OneDrive - MARIO FIALHO/Documents/source/ag_bridge/mcp-server.mjs"
      ],
      "env": {
        "AG_BRIDGE_URL": "http://127.0.0.1:8787",
        "AG_REPO_ROOT": "C:/Users/mfadmin/OneDrive - MARIO FIALHO/Documents/source/ag_bridge"
      }
    }
  }
}
```

## New in v0.2
### Strict Mode
Enabled by default. Prevents dangerous commands (`rm`, `del`, etc.) and only allows whitelisted commands in `policy.json`.
- **Toggle**: Use the "Strict: ON/OFF" button in the dashboard or API.
- **Configure**: Edit `policy.json` to add your own allowed regex patterns.

### Request Approvals (CLI)
You can request approvals from your own scripts:
```bash
node request-approval.mjs --token <YOUR_TOKEN> --cmd "pnpm test" --risk yellow
```
Or via HTTP POST to `/approvals/request`.

## Troubleshooting
- **Phone can't connect?** Ensure your laptop and phone are on the **same Wi-Fi**. Check Windows Firewall.
- **"Unauthorized"?** You need to pair again or use a valid token.
- **Strict Mode blocking valid commands?** Edit `policy.json` to allow your command pattern.

## Development
- **Structure**:
  - `server.mjs`: Express + WS server.
  - `public/index.html`: Frontend.
- **Debug**:
  - Use the "Create Test Approval" button on the dashboard to verify the flow.
