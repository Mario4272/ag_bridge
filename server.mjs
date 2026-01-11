import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import crypto from 'crypto';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { spawn } from 'child_process';
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

// --- Poke Logic ---
let pokeInFlight = false;
let lastPokeAt = 0;
let retryTimer = null;
let retryAttempts = 0;

async function runPokeScript() {
    return new Promise((resolve) => {
        const child = spawn('node', ['scripts/poke.mjs'], { cwd: process.cwd(), shell: true });
        let stdout = '';
        child.stdout.on('data', d => stdout += d);
        child.on('close', () => {
            try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: 'parse_error', stdout }); }
        });
        child.on('error', (err) => resolve({ ok: false, error: 'spawn_error', details: err.message }));
    });
}

function stopRetry() {
    if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
    }
    retryAttempts = 0;
}

function startRetry() {
    if (retryTimer) return;
    retryAttempts = 0;
    console.log('[POKE] Agent busy. Starting retry loop...');
    retryTimer = setInterval(async () => {
        retryAttempts++;
        if (retryAttempts > 24) { // 2 minutes
            console.log('[POKE] Retry limit reached. Giving up.');
            stopRetry();
            return;
        }
        await tryPoke(true);
    }, 5000);
}

async function tryPoke(isRetry = false) {
    if (pokeInFlight) return;

    // Throttle 2s
    if (Date.now() - lastPokeAt < 2000) return;

    pokeInFlight = true;
    lastPokeAt = Date.now();

    if (!isRetry) console.log('[POKE] Attempting to wake agent...');
    const res = await runPokeScript();
    pokeInFlight = false;

    if (res.ok) {
        console.log('[POKE] Success:', res.method);
        stopRetry();
    } else if (res.reason && res.reason.includes('busy')) {
        // Agent is busy
        if (!isRetry) console.log('[POKE] Agent busy. Scheduling retries.');
        startRetry();
    } else {
        console.warn('[POKE] Failed/Error:', JSON.stringify(res));
        // Stop retrying on hard errors (like no CDP connection)
        stopRetry();
    }
}

function schedulePoke() {
    if (pokeInFlight) return;
    // If we are already retrying, we don't need to kickstart it, 
    // but effectively the "new message" ensures we keep trying if we were about to expire? 
    // For now, just let the existing loop run or start a new attempt.
    if (retryTimer) return;

    tryPoke(false);
}

// --- State ---
// Persistent State
let STATE = {
    version: 1,
    strictMode: true,
    approvals: [],
    messages: [],
    agent: { state: 'idle', lastSeen: null, task: '', note: '' },
    checkpoints: [],
    tokens: [] // Changed from optional to persisted for UX stability
};

// Ephemeral State
let PAIRING_CODE = generateCode();
let TOKENS = new Set(); // Loaded from STATE.tokens

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
                messages: STATE.messages,
                agent: STATE.agent,
                checkpoints: STATE.checkpoints,
                tokens: Array.from(TOKENS) // Persist tokens
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
        if (Array.isArray(data.messages)) STATE.messages = data.messages;
        if (data.agent) STATE.agent = data.agent;
        if (Array.isArray(data.checkpoints)) STATE.checkpoints = data.checkpoints;
        if (Array.isArray(data.tokens)) {
            STATE.tokens = data.tokens;
            TOKENS = new Set(data.tokens);
        }

        console.log(`[PERSIST] State loaded. ${STATE.approvals.length} approvals, ${TOKENS.size} tokens.`);
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
    // Allow localhost (MCP server) to bypass auth
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
        return next();
    }

    const token = req.headers['x-ag-token'];
    if (!token || !TOKENS.has(token)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

const checkAuth = requireAuth; // Alias for consistency with new endpoints

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
    saveState(); // Save new token
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

// --- New v0.3 Endpoints ---

// POST /messages/send
app.post('/messages/send', checkAuth, (req, res) => {
    const { to, channel, text, from } = req.body;
    if (!to || !text) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const msg = {
        id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        createdAt: new Date().toISOString(),
        from: from || 'user', // 'user' (phone) or 'agent'
        to, // 'agent' or 'user'
        channel: channel || 'general',
        text,
        status: 'new'
    };

    STATE.messages.push(msg);
    // Cap history at 200
    if (STATE.messages.length > 200) STATE.messages.shift();
    saveState();

    broadcast('message_new', msg);

    // Trigger Poke if msg is for agent
    if (to === 'agent') {
        schedulePoke();
    }

    res.json({ ok: true, message: msg });
});

// GET /messages/inbox
app.get('/messages/inbox', checkAuth, (req, res) => {
    const { to, status, limit } = req.query;
    let items = STATE.messages;

    if (to) items = items.filter(m => m.to === to);
    if (status) items = items.filter(m => m.status === status);

    // Sort newest first
    items = [...items].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (limit) items = items.slice(0, parseInt(limit));

    res.json({ ok: true, messages: items });
});

// POST /messages/:id/ack
app.post('/messages/:id/ack', checkAuth, (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'read' or 'done'

    const msg = STATE.messages.find(m => m.id === id);
    if (!msg) return res.status(404).json({ ok: false, error: 'not_found' });

    msg.status = status || 'read';
    saveState();

    broadcast('message_ack', { id, status: msg.status });
    res.json({ ok: true });
});

// POST /agent/heartbeat
app.post('/agent/heartbeat', checkAuth, (req, res) => {
    const { state, task, note } = req.body;

    STATE.agent = {
        ...STATE.agent,
        lastSeen: new Date().toISOString(),
        state: state || STATE.agent.state,
        task: task !== undefined ? task : STATE.agent.task,
        note: note !== undefined ? note : STATE.agent.note
    };
    saveState();

    broadcast('agent_status', STATE.agent);
    res.json({ ok: true, agent: STATE.agent });
});

// GET /agent/status
app.get('/agent/status', checkAuth, (req, res) => {
    res.json({ ok: true, agent: STATE.agent });
});

// POST /checkpoint
app.post('/checkpoint', checkAuth, (req, res) => {
    const cp = {
        id: 'cp_' + Date.now(),
        ts: new Date().toISOString(),
        ...req.body
    };

    STATE.checkpoints.push(cp);
    saveState();

    broadcast('checkpoint_new', cp);
    res.json({ ok: true, checkpoint: cp });
});

// --- Legacy v0.2 Routes ---
app.post('/approvals/request', checkAuth, (req, res) => {
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

app.get('/approvals/:id', checkAuth, (req, res) => {
    const { id } = req.params;
    const approval = STATE.approvals.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, approval });
});

app.get('/approvals/stream/summary', checkAuth, (req, res) => {
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
