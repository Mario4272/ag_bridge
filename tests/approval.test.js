import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Hoist mocks so they can be referenced in the factory
const mocks = vi.hoisted(() => {
    return {
        mkdir: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        rename: vi.fn(),
        appendFile: vi.fn(),
    };
});

// Mock fs/promises
vi.mock('fs/promises', () => ({
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    rename: mocks.rename,
    appendFile: mocks.appendFile
}));

// Import app AFTER mocking
// Note: We need to use dynamic import or ensure server.mjs doesn't run side-effects that break if mocked late.
// Since we used vi.mock above, it should be fine.
import { app } from '../server.mjs';

describe('Approval Workflow', () => {

    let approvalId;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        // Default readFile behavior: return empty array for JSON files
        mocks.readFile.mockResolvedValue('[]');
    });

    it('should create a new approval request and persist it', async () => {
        const res = await request(app)
            .post('/approvals/request')
            .send({
                kind: 'test',
                details: { info: 'test persistence' },
                risk: 'low'
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        approvalId = res.body.approval.id;

        // Verify persistence (writeFile -> rename)
        expect(mocks.writeFile).toHaveBeenCalled();
        expect(mocks.rename).toHaveBeenCalled();

        // Check content of the write
        const calls = mocks.writeFile.mock.calls;
        const lastCall = calls[calls.length - 1]; // Last write
        const content = JSON.parse(lastCall[1]);

        expect(Array.isArray(content)).toBe(true);
        const persisted = content.find(a => a.id === approvalId);
        expect(persisted).toBeDefined();
        expect(persisted.details.info).toBe('test persistence');
    });

    it('should show the approval in list', async () => {
        const res = await request(app).get('/approvals');
        expect(res.status).toBe(200);
        const found = res.body.approvals.find(a => a.id === approvalId);
        // Note: In this memory-only test, the server 'STATE' variable holds the data.
        // The mock verifies DISC writes, but the app reads from RAM after startup.
        expect(found).toBeDefined();
        expect(found.status).toBe('pending');
    });

    it('should approve the request and update disk', async () => {
        const res = await request(app).post(`/approvals/${approvalId}/approve`);
        expect(res.status).toBe(200);
        expect(res.body.approval.status).toBe('approved');

        // Verify it touched the disk again
        expect(mocks.writeFile).toHaveBeenCalled();
        const calls = mocks.writeFile.mock.calls;
        const lastWrite = calls[calls.length - 1];
        const content = JSON.parse(lastWrite[1]);
        const updated = content.find(a => a.id === approvalId);
        expect(updated.status).toBe('approved');
    });

    it('should be idempotent (cannot approve again)', async () => {
        const res = await request(app).post(`/approvals/${approvalId}/approve`);
        expect(res.status).toBe(409); // Conflict
        expect(res.body.error).toBe('already_decided');
    });

    it('should not allow denying an approved request', async () => {
        const res = await request(app).post(`/approvals/${approvalId}/deny`);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('already_decided');
    });
});
