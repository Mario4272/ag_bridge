import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import crypto from 'crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'fs/promises';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const LOGS_DIR = join(__dirname, '.logs');
const LOG_FILE = join(LOGS_DIR, `ag-bridge-${new Date().toISOString().split('T')[0]}.log`);
const STATE_FILE = join(DATA_DIR, 'state.json');
const APPROVALS_FILE = join(DATA_DIR, 'approvals.json');
const POLICY_FILE = join(__dirname, 'policy.json');
let POLICY = { version: 2, profiles: { relaxed: { allow: [".*"] }, balanced: { allow: [] } }, globalDeny: [] };

// --- Config ---
const args = process.argv.slice(2);
const getArg = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : null;
};
const hasArg = (name) => args.includes(name);

const PORT = parseInt(getArg('--port') || process.env.PORT || '8787');
const HOST = getArg('--host') || '0.0.0.0';

export const app = express();
export const server = createServer(app);
// Don't bind 'server' here so we can handle upgrade manually for auth
export const wss = new WebSocketServer({ noServer: true });

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
            try {
                const res = JSON.parse(stdout);
                log('POKE', 'Script result', res);
                resolve(res);
            } catch {
                log('POKE', 'Parse error', { stdout });
                resolve({ ok: false, error: 'parse_error', stdout });
            }
        });
        child.on('error', (err) => {
            log('POKE', 'Spawn error', err.message);
            resolve({ ok: false, error: 'spawn_error', details: err.message });
        });
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
    log('POKE', 'Agent busy. Starting retry loop...');
    retryTimer = setInterval(async () => {
        retryAttempts++;
        if (retryAttempts > 24) { // 2 minutes
            log('POKE', 'Retry limit reached. Giving up.');
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

    if (!isRetry) log('POKE', 'Attempting to wake agent...');
    const res = await runPokeScript();
    pokeInFlight = false;

    if (res.ok) {
        log('POKE', 'Success', { method: res.method });
        stopRetry();
    } else if (res.reason && res.reason.includes('busy')) {
        // Agent is busy
        if (!isRetry) log('POKE', 'Agent busy. Scheduling retries.');
        startRetry();
    } else {
        log('POKE', 'Failed/Error', res);
        // Stop retrying on hard errors (like no CDP connection)
        stopRetry();
    }
}

function schedulePoke() {
    if (pokeInFlight) return;

    // Dedupe: If we are already retrying, we don't need to kickstart it.
    // However, if we aren't retrying, and a poke is not in flight, we should try.
    // The throttle in tryPoke handles the "too fast" case.
    if (retryTimer) {
        log('POKE', 'Skipping schedulePoke: Retry loop already active.');
        return;
    }

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
    const results = new Set();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Skip internal (non-127.0.0.1) and non-IPv4
            if (net.family === 'IPv4' && !net.internal) {
                // Filter out Tailscale IPs (100.x.x.x) from the "Local" list
                if (!net.address.startsWith('100.')) {
                    results.add(net.address);
                }
            }
        }
    }
    return Array.from(results);
}

function getTailscaleInfo() {
    try {
        const stdout = execSync('tailscale status --json', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const status = JSON.parse(stdout);
        if (status.BackendState === 'Running') {
            const dnsName = status.Self.DNSName;
            const name = dnsName ? dnsName.replace(/\.$/, '') : null;
            const ips = status.TailscaleIPs || [];
            return { name, ips };
        }
    } catch (e) {
        return null;
    }
    return null;
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

// --- Logging ---
async function log(component, message, data = null) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${component}] ${message} ${data ? JSON.stringify(data) : ''}`;
    console.log(line);
    try {
        await appendFile(LOG_FILE, line + '\n');
    } catch (e) { /* ignore log errors */ }
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
                // approvals: STATE.approvals, // Scoped to approvals.json now
                messages: STATE.messages,
                agent: STATE.agent,
                checkpoints: STATE.checkpoints,
                tokens: Array.from(TOKENS)
            };
            const tempFile = `${STATE_FILE}.tmp`;
            await writeFile(tempFile, JSON.stringify(data, null, 2));
            await rename(tempFile, STATE_FILE);
            log('PERSIST', 'State saved (config/msgs).');
        } catch (err) {
            log('PERSIST', 'Failed to save state:', err.message);
        }
    }, 250);
}

async function saveApprovals() {
    try {
        const tempFile = `${APPROVALS_FILE}.tmp`;
        await writeFile(tempFile, JSON.stringify(STATE.approvals, null, 2));
        await rename(tempFile, APPROVALS_FILE);
        log('PERSIST', `Approvals saved (${STATE.approvals.length}).`);
    } catch (err) {
        log('PERSIST', 'Failed to save approvals:', err.message);
    }
}

async function loadPolicy() {
    try {
        const raw = await readFile(POLICY_FILE, 'utf-8');
        POLICY = JSON.parse(raw);
        log('POLICY', 'Loaded policy.json');
    } catch (err) {
        log('POLICY', 'policy.json not found or invalid. Using defaults.');
    }
}

async function loadState() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const raw = await readFile(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);

        if (data.version) STATE.version = data.version;
        if (typeof data.strictMode === 'boolean') STATE.strictMode = data.strictMode;
        // if (Array.isArray(data.approvals)) STATE.approvals = data.approvals; // Legacy load
        if (Array.isArray(data.messages)) STATE.messages = data.messages;
        if (data.agent) STATE.agent = data.agent;
        if (Array.isArray(data.checkpoints)) STATE.checkpoints = data.checkpoints;
        if (Array.isArray(data.tokens)) {
            STATE.tokens = data.tokens;
            TOKENS = new Set(data.tokens);
        }

        // Load Approvals (Separate File)
        try {
            const rawApprovals = await readFile(APPROVALS_FILE, 'utf-8');
            const approvalsData = JSON.parse(rawApprovals);
            if (Array.isArray(approvalsData)) {
                STATE.approvals = approvalsData;
            }
        } catch (e) {
            if (e.code === 'ENOENT') {
                // Migration: Check if state.json had approvals
                if (Array.isArray(data.approvals) && data.approvals.length > 0) {
                    log('PERSIST', 'Migrating approvals from state.json to approvals.json');
                    STATE.approvals = data.approvals;
                    await saveApprovals();
                }
            } else {
                log('PERSIST', 'Failed to load approvals.json', e.message);
            }
        }

        console.log(`[PERSIST] State loaded. ${STATE.approvals.length} approvals, ${TOKENS.size} tokens.`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            log('PERSIST', 'No state file found. Starting fresh.');
            await saveState();
        } else {
            log('PERSIST', 'Failed to load state:', err.message);
            // Logic to rename bad file could go here, but simple logging is fine for v0.2
            const badFile = `${STATE_FILE}.bad.${Date.now()}`;
            try {
                await rename(STATE_FILE, badFile);
                log('PERSIST', `Corrupt state file renamed to ${badFile}`);
            } catch (e) { /* ignore */ }
        }
    }
}

function checkPolicy(cmd) {
    if (!cmd) return { allowed: false, error: 'missing_command' };

    // 1. Global Deny (Always wins)
    for (const pattern of POLICY.globalDeny || []) {
        if (new RegExp(pattern).test(cmd)) {
            return { allowed: false, error: 'global_denied' };
        }
    }

    // 2. Determine Profile (Map v0.5 boolean to v0.6 profiles)
    // strictMode=true -> 'balanced', strictMode=false -> 'relaxed'
    // Future: STATE.securityProfile could hold 'paranoid' etc.
    const profileName = STATE.strictMode ? 'balanced' : 'relaxed';
    const profile = POLICY.profiles?.[profileName];

    if (!profile) {
        // Fallback safety: if profile invalid, BLOCK ALL unless relaxed was intended?
        // Better to be safe.
        return { allowed: false, error: 'invalid_policy_profile' };
    }

    // 3. Profile Deny
    for (const pattern of profile.deny || []) {
        if (new RegExp(pattern).test(cmd)) {
            return { allowed: false, error: 'profile_denied' };
        }
    }

    // 4. Profile Allow
    for (const pattern of profile.allow || []) {
        if (new RegExp(pattern).test(cmd)) {
            return { allowed: true };
        }
    }

    return { allowed: false, error: 'command_not_allowlisted' };
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
    res.json({ ok: true, name: "ag_bridge", version: "0.5.0", ts: new Date().toISOString() });
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

// Migrated to usage of single /status endpoint below
// app.get('/status', requireAuth, ...);

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
    saveApprovals();

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
    saveApprovals();

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
    saveApprovals();
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

// GET /status (Observability)
app.get('/status', requireAuth, (req, res) => {
    const pending = STATE.approvals.filter(a => a.status === 'pending').length;
    res.json({
        ok: true,
        version: "0.4.1",
        ts: new Date().toISOString(),
        pendingApprovals: pending,
        totalApprovals: STATE.approvals.length,
        strictMode: STATE.strictMode,
        cdp: {
            enabled: true, // v0.x assumption
            poke_in_flight: pokeInFlight,
            retry_active: !!retryTimer
        },
        agent: {
            state: STATE.agent.state,
            last_seen: STATE.agent.lastSeen
        },
        server: {
            uptime: process.uptime(),
            clients: wss.clients.size
        }
    });
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
    saveApprovals(); // Changed from saveState()
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

    // Allow test token in test environment
    if (process.env.NODE_ENV === 'test' && token === 'test-token') {
        // Allow
    } else if (!token || !TOKENS.has(token)) {
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

    // Replay pending approvals
    const pending = STATE.approvals.filter(a => a.status === 'pending');
    for (const approval of pending) {
        ws.send(JSON.stringify({
            event: 'approval_requested',
            payload: approval,
            ts: new Date().toISOString()
        }));
    }
});

// --- Start ---
// Load state then start
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    Promise.all([loadState(), loadPolicy()]).then(() => {
        server.listen(PORT, HOST, () => {
            const ips = getLocalIPs();
            const ts = getTailscaleInfo();

            console.log('='.repeat(50));
            console.log(` AG Bridge v${STATE?.version || '1'} running on port ${PORT}`);
            console.log('='.repeat(50));
            console.log(` PAIRING CODE: [ ${PAIRING_CODE} ]`);
            console.log('-'.repeat(50));

            console.log(' Local (same Wi-Fi):');
            if (ips.length > 0) {
                ips.forEach(ip => {
                    console.log(` http://${ip}:${PORT}`);
                });
            } else {
                console.log(' (No local LAN IP found)');
            }

            if (ts) {
                console.log('\n Remote (Tailscale Active):');
                if (ts.name) {
                    console.log(` http://${ts.name}:${PORT}`);
                }
                ts.ips.forEach(ip => {
                    console.log(` http://${ip}:${PORT}`);
                });
            } else {
                console.log('\n Remote (Tailscale Inactive):');
                console.log(' Install Tailscale for access anywhere: https://tailscale.com');
            }

            console.log('='.repeat(50));
        });
    });
}
