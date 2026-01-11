# AG Bridge Troubleshooting

## Common Issues

### 1. "Poke Failed: cdp_not_found"
**Symptoms**: The agent doesn't wake up; logs show `cdp_not_found`.
**Cause**: VS Code was started without the remote debugging port.
**Fix**:
1. Close VS Code entirely.
2. Run in terminal: `code --remote-debugging-port=9000`
3. Verify: `curl http://127.0.0.1:9000/json/list` should return JSON.

### 2. "Poke Failed: editor_not_found"
**Symptoms**: Bridge logs show the target was found, but `editor_not_found`.
**Cause**: The script cannot locate the Lexical editor DOM element (possibly due to UI changes or iframe issues).
**Fix**:
1. Ensure the Chat view is **Visible** (not collapsed).
2. Check `scripts/poke.mjs` updates (the "Shotgun" approach usually fixes this).

### 3. "Cannot GET /"
**Symptoms**: The phone UI is 404.
**Cause**: Missing `public/index.html`.
**Fix**: Ensure `public/index.html` exists in the repo root.

### 4. Agent is "Busy" forever
**Symptoms**: You are idle, but logs say "Agent busy".
**Cause**: The "Cancel" button (or its tooltip) is falsely detected.
**Fix**:
1. Manually type something in the chat and clear it.
2. Restart the bridge: `npm start`.

## Debugging

### Check Status
Visit `http://localhost:8787/status` to see real-time health:
- `cdp.connnection`: Should be ok.
- `agent.last_seen`: Should be recent.

### View Logs
Check `.logs/ag-bridge-YYYY-MM-DD.log` for detailed traces.
