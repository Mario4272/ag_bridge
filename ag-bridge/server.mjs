import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import crypto from 'crypto';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const STATE_FILE = join(DATA_DIR, 'state.json');
const POLICY_FILE = join(__dirname, 'policy.json');
let POLICY = { allow: [], deny: [] };

const PORT = 8787;
const app = express();
const server = createServer(app);
// Don't bind 'server' here so we can handle upgrade manually for auth
const wss = new WebSocketServer({ noServer: true });

// --- State ---
// Persistent State
let STATE = {
    version: 1,
    strictMode: true,
    approvals: [], // Array of { id, createdAt, kind, details, status, decidedAt }
    // pairingCode and tokens could be persisted but v0.2 spec says tokens optional, code ephemeral fine.
    // We'll keep them in memory for now to keep it simple, or sync if needed.
    // actually spec says: "Persisting TOKENS is optional... pairingCode can remain ephemeral"
};

// Ephemeral State
let PAIRING_CODE = generateCode();
const TOKENS = new Set(); // If we wanted to persist, we'd load this from STATE.tokens

// --- Helpers ---
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

function getLocalIPs() {
    const nets = networkInterfaces();
    const results = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                results.push(net.address);
            }
        }
    }
    return results;
}

function broadcast(event, payload) {
    const msg = JSON.stringify({
        event,
        payload,
        ts: new Date().toISOString()
    });
    for (const client of wss.clients) {
        if (client.readyState === 1) { // OPEN
            client.send(msg);
        }
    }
}

// --- Persistence ---
let saveTimeout = null;
async function saveState() {
    if (saveTimeout) clearTimeout(saveTimeout);

    saveTimeout = setTimeout(async () => {
        try {
            const data = {
                version: STATE.version,
                strictMode: STATE.strictMode,
                approvals: STATE.approvals,
                // syncing tokens is optional, let's skip for v0.2 simplicity as per instructions
            };
            const tempFile = `${STATE_FILE}.tmp`;
            await writeFile(tempFile, JSON.stringify(data, null, 2));
            await rename(tempFile, STATE_FILE);
            console.log('[PERSIST] State saved.');
        } catch (err) {
            console.error('[PERSIST] Failed to save state:', err);
        }
    }, 250); // Debounce 250ms
}

async function loadPolicy() {
    try {
        const raw = await readFile(POLICY_FILE, 'utf-8');
        POLICY = JSON.parse(raw);
        console.log('[POLICY] Loaded policy.json');
    } catch (err) {
        console.warn('[POLICY] policy.json not found or invalid. Using defaults.');
    }
}

async function loadState() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const raw = await readFile(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);

        if (data.version) STATE.version = data.version;
        if (typeof data.strictMode === 'boolean') STATE.strictMode = data.strictMode;
        if (Array.isArray(data.approvals)) STATE.approvals = data.approvals;

        console.log(`[PERSIST] State loaded. ${STATE.approvals.length} approvals. Strict: ${STATE.strictMode}`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log('[PERSIST] No state file found. Starting fresh.');
            await saveState();
        } else {
            console.error('[PERSIST] Failed to load state:', err);
            // Logic to rename bad file could go here, but simple logging is fine for v0.2
            const badFile = `${STATE_FILE}.bad.${Date.now()}`;
            try {
                await rename(STATE_FILE, badFile);
                console.warn(`[PERSIST] Corrupt state file renamed to ${badFile}`);
            } catch (e) { /* ignore */ }
        }
    }
}

function checkPolicy(cmd) {
    if (!cmd) return { allowed: false, error: 'missing_command' };

    // Deny list (Always wins)
    for (const pattern of POLICY.deny || []) {
        if (new RegExp(pattern).test(cmd)) {
            return { allowed: false, error: 'command_denied' };
        }
    }

    // Allow list (Only if strictMode)
    if (STATE.strictMode) {
        let matched = false;
        for (const pattern of POLICY.allow || []) {
            if (new RegExp(pattern).test(cmd)) {
                matched = true;
                break;
            }
        }
        if (!matched) {
            return { allowed: false, error: 'command_not_allowlisted' };
        }
    }

    return { allowed: true };
}

// --- Middleware ---
app.use(express.json());
app.use(express.static('public'));

const requireAuth = (req, res, next) => {
    const token = req.headers['x-ag-token'];
    if (!token || !TOKENS.has(token)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// --- HTTP Endpoints ---

// Public
app.get('/health', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

app.post('/pair/claim', (req, res) => {
    const { code } = req.body;
    if (!code || code !== PAIRING_CODE) {
        return res.status(403).json({ error: 'invalid_code' });
    }
    const token = generateToken();
    TOKENS.add(token);
    console.log(`[AUTH] New device paired. Token created.`);
    res.json({ token });
});

// Protected
app.get('/config', requireAuth, (req, res) => {
    res.json({ ok: true, strictMode: STATE.strictMode, ts: new Date().toISOString() });
});

app.post('/config/strict-mode', requireAuth, (req, res) => {
    const { strictMode } = req.body;
    if (typeof strictMode !== 'boolean') {
        return res.status(400).json({ error: 'invalid_input' });
    }
    STATE.strictMode = strictMode;
    saveState();
    console.log(`[CONFIG] Strict Mode set to ${strictMode}`);
    broadcast('config_changed', { strictMode });
    res.json({ ok: true, strictMode });
});

app.get('/status', requireAuth, (req, res) => {
    const pending = STATE.approvals.filter(a => a.status === 'pending').length;
    res.json({
        ok: true,
        ts: new Date().toISOString(),
        pendingApprovals: pending,
        totalApprovals: STATE.approvals.length,
        strictMode: STATE.strictMode
    });
});

app.get('/approvals', requireAuth, (req, res) => {
    const sorted = [...STATE.approvals].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ approvals: sorted });
});

app.post('/approvals/:id/approve', requireAuth, (req, res) => {
    const { id } = req.params;
    const approval = STATE.approvals.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'not_found' });

    if (approval.status !== 'pending') {
        return res.status(409).json({ error: 'already_decided', approval });
    }

    approval.status = 'approved';
    approval.decidedAt = new Date().toISOString();
    saveState();

    console.log(`[APPROVAL] ${id} APPROVED`);
    broadcast('approval_decided', { id, status: 'approved' });
    res.json({ ok: true, approval });
});

app.post('/approvals/:id/deny', requireAuth, (req, res) => {
    const { id } = req.params;
    const approval = STATE.approvals.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'not_found' });

    if (approval.status !== 'pending') {
        return res.status(409).json({ error: 'already_decided', approval });
    }

    approval.status = 'denied';
    approval.decidedAt = new Date().toISOString();
    saveState();

    console.log(`[APPROVAL] ${id} DENIED`);
    broadcast('approval_decided', { id, status: 'denied' });
    res.json({ ok: true, approval });
});

app.post('/debug/create-approval', requireAuth, (req, res) => {
    const { kind, details } = req.body;
    const newApproval = {
        id: `appr_${crypto.randomBytes(4).toString('hex')}`,
        createdAt: new Date().toISOString(),
        kind: kind || 'command',
        details: details || { cmd: 'echo "Hello World"', risk: 'low' },
        status: 'pending',
        decidedAt: null
    };

    STATE.approvals.push(newApproval);
    saveState();
    console.log(`[DEBUG] Created test approval ${newApproval.id}`);
    broadcast('approval_requested', newApproval);
    res.json(newApproval);
});

app.post('/approvals/request', requireAuth, (req, res) => {
    const { kind, details, risk, clientTag } = req.body;

    // Policy Check for commands
    if (kind === 'command') {
        const cmd = details?.cmd;
        const check = checkPolicy(cmd);
        if (!check.allowed) {
            console.warn(`[POLICY] Blocked command: "${cmd}" Reason: ${check.error}`);
            return res.status(403).json({ error: check.error });
        }
    }

    const newApproval = {
        id: `appr_${crypto.randomBytes(4).toString('hex')}`,
        createdAt: new Date().toISOString(),
        kind: kind || 'unknown',
        details: details || {},
        status: 'pending',
        decidedAt: null,
        meta: {
            risk: risk || 'unknown',
            clientTag: clientTag || null
        }
    };

    STATE.approvals.push(newApproval);
    saveState();
    console.log(`[REQUEST] Approval requested: ${newApproval.id} (${kind})`);
    broadcast('approval_requested', newApproval);
    res.json({ ok: true, approval: newApproval });
});

app.get('/approvals/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const approval = STATE.approvals.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, approval });
});

app.get('/approvals/stream/summary', requireAuth, (req, res) => {
    const pending = STATE.approvals.filter(a => a.status === 'pending').length;
    const approved = STATE.approvals.filter(a => a.status === 'approved').length;
    const denied = STATE.approvals.filter(a => a.status === 'denied').length;
    res.json({
        ok: true,
        ts: new Date().toISOString(),
        pending,
        approved,
        denied,
        total: STATE.approvals.length
    });
});

// --- WebSocket Handling ---
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');
    const pathname = url.pathname;

    if (pathname !== '/events') {
        socket.destroy();
        return;
    }

    if (!token || !TOKENS.has(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ event: 'hello', payload: { ts: new Date().toISOString() } }));
});

// --- Start ---
// Load state then start
Promise.all([loadState(), loadPolicy()]).then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        const ips = getLocalIPs();
        console.log('='.repeat(50));
        console.log(` AG Bridge v1 running on port ${PORT}`);
        console.log('='.repeat(50));
        console.log(` PAIRING CODE: [ ${PAIRING_CODE} ]`);
        console.log('-'.repeat(50));
        console.log(' Open on your phone:');
        ips.forEach(ip => {
            console.log(` http://${ip}:${PORT}`);
        });
        console.log('='.repeat(50));
    });
});
