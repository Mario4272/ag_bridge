import { fetch } from 'undici'; // Built-in fetch in newer Node, or minimal dep. Actually recent Node has fetch global.
// Usage: node request-approval.mjs --host http://localhost:8787 --token <TOKEN> --cmd "echo hello"

const args = process.argv.slice(2);
const getConfig = (key) => {
    const idx = args.indexOf(`--${key}`);
    return idx !== -1 ? args[idx + 1] : null;
};

const host = getConfig('host') || 'http://127.0.0.1:8787';
const token = getConfig('token');
const cmd = getConfig('cmd') || 'echo "Hello from CLI"';
const cwd = getConfig('cwd') || '.';
const risk = getConfig('risk') || 'low';

if (!token) {
    console.error("Error: --token <TOKEN> is required.");
    process.exit(1);
}

async function run() {
    try {
        const res = await fetch(`${host}/approvals/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-ag-token': token
            },
            body: JSON.stringify({
                kind: 'command',
                details: { cmd, cwd, risk },
                risk,
                clientTag: 'cli_helper'
            })
        });

        if (!res.ok) {
            console.error(`Request failed: ${res.status} ${res.statusText}`);
            const txt = await res.text();
            console.error(txt);
            process.exit(1);
        }

        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error("Network error:", err.message);
        process.exit(1);
    }
}

run();
