import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';

// Mock fs/promises
vi.mock('fs/promises', () => ({
    mkdir: vi.fn(),
    readFile: vi.fn(() => Promise.resolve('[]')),
    writeFile: vi.fn(),
    rename: vi.fn(),
    appendFile: vi.fn()
}));

// Set env before importing
process.env.NODE_ENV = 'test';

import { app, server } from '../server.mjs';

describe('WebSocket Replay', () => {
    let port;

    beforeAll(async () => {
        await new Promise(resolve => {
            server.listen(0, () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    afterAll(() => {
        server.close();
    });

    it('should receive pending approvals on connection', async () => {
        // 1. Create a pending approval
        const res = await request(app)
            .post('/approvals/request')
            .send({
                kind: 'test',
                details: { info: 'replay me' },
                risk: 'low'
            });
        expect(res.status).toBe(200);
        const approvalId = res.body.approval.id;

        // 2. Connect WS with test token
        const wsUrl = `ws://127.0.0.1:${port}/events?token=test-token`;
        const ws = new WebSocket(wsUrl);

        const messages = [];

        await new Promise((resolve) => {
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                messages.push(msg);

                // We expect 'hello' then 'approval_requested'
                // If we found our approval, we are good.
                if (msg.event === 'approval_requested' && msg.payload.id === approvalId) {
                    ws.close();
                    resolve();
                }
            });
        });

        // Verify
        const replayMsg = messages.find(m => m.event === 'approval_requested' && m.payload.id === approvalId);
        expect(replayMsg).toBeDefined();
        expect(replayMsg.payload.status).toBe('pending');
    });
});
