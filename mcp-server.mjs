#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from 'fs/promises';
import path from 'path';

// --- Configuration ---
const AG_BRIDGE_URL = process.env.AG_BRIDGE_URL || "http://127.0.0.1:8787";
const AG_BRIDGE_TOKEN = process.env.AG_BRIDGE_TOKEN || ""; // Optional
const AG_REPO_ROOT = process.env.AG_REPO_ROOT ? path.resolve(process.env.AG_REPO_ROOT) : process.cwd();

// --- Helpers ---
async function api(method, endpoint, body) {
    const headers = { "Content-Type": "application/json" };
    if (AG_BRIDGE_TOKEN) headers["x-ag-token"] = AG_BRIDGE_TOKEN;

    try {
        const res = await fetch(`${AG_BRIDGE_URL}${endpoint}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`API ${endpoint} failed: ${res.status} ${txt}`);
        }
        return await res.json();
    } catch (err) {
        // Log to stderr so it doesn't break JSON-RPC
        console.error(`[MCP] API Error: ${err.message}`);
        throw err;
    }
}

// --- Tools ---
const TOOLS = {
    messages_inbox: {
        schema: z.object({
            to: z.enum(["agent", "user"]),
            status: z.enum(["new", "all"]).optional(),
            limit: z.number().optional()
        }),
        handler: async (args) => {
            const q = new URLSearchParams({ to: args.to });
            if (args.status) q.append("status", args.status);
            if (args.limit) q.append("limit", args.limit.toString());

            const res = await api("GET", `/messages/inbox?${q.toString()}`);
            return { content: [{ type: "text", text: JSON.stringify(res.messages, null, 2) }] };
        }
    },

    messages_send: {
        schema: z.object({
            to: z.enum(["agent", "user"]),
            channel: z.enum(["work", "qa", "status"]).optional(),
            text: z.string()
        }),
        handler: async (args) => {
            const res = await api("POST", "/messages/send", {
                to: args.to,
                channel: args.channel,
                text: args.text,
                from: "agent"
            });
            return { content: [{ type: "text", text: `Sent message ${res.message.id}` }] };
        }
    },

    messages_ack: {
        schema: z.object({
            id: z.string(),
            status: z.enum(["read", "done"])
        }),
        handler: async (args) => {
            await api("POST", `/messages/${args.id}/ack`, { status: args.status });
            return { content: [{ type: "text", text: `Acked ${args.id} as ${args.status}` }] };
        }
    },

    agent_heartbeat: {
        schema: z.object({
            state: z.enum(["idle", "working", "waiting", "error"]),
            task: z.string().optional(),
            note: z.string().optional()
        }),
        handler: async (args) => {
            await api("POST", "/agent/heartbeat", args);
            return { content: [{ type: "text", text: `Status updated to ${args.state}` }] };
        }
    },

    checkpoint_post: {
        schema: z.object({
            n: z.number().optional(),
            N: z.number().optional(),
            risk: z.enum(["low", "yellow", "red"]).optional(),
            changedFiles: z.array(z.string()).optional(),
            verifyCmds: z.array(z.string()).optional(),
            next: z.string().optional()
        }),
        handler: async (args) => {
            const res = await api("POST", "/checkpoint", args);
            return { content: [{ type: "text", text: `Checkpoint ${res.checkpoint.id} created` }] };
        }
    },

    repo_read_file: {
        schema: z.object({
            path: z.string(),
            mode: z.enum(["full", "head", "tail"]).optional(),
            maxBytes: z.number().optional()
        }),
        handler: async (args) => {
            // Security: Prevent traversal
            const targetPath = path.resolve(AG_REPO_ROOT, args.path);
            if (!targetPath.startsWith(AG_REPO_ROOT)) {
                throw new Error("Access denied: Path outside repo root");
            }

            try {
                const stats = await fs.stat(targetPath);
                if (!stats.isFile()) throw new Error("Not a file");

                let content = "";
                const limit = args.maxBytes || 200000; // 200KB default

                if (args.mode === 'tail') {
                    // Read last N bytes
                    const fh = await fs.open(targetPath, 'r');
                    try {
                        const readLen = Math.min(stats.size, limit);
                        const pos = stats.size - readLen;
                        const buf = Buffer.alloc(readLen);
                        await fh.read(buf, 0, readLen, pos);
                        content = buf.toString('utf8');
                    } finally {
                        await fh.close();
                    }
                } else if (args.mode === 'head') {
                    const fh = await fs.open(targetPath, 'r');
                    try {
                        const readLen = Math.min(stats.size, limit);
                        const buf = Buffer.alloc(readLen);
                        await fh.read(buf, 0, readLen, 0);
                        content = buf.toString('utf8');
                    } finally {
                        await fh.close();
                    }
                } else {
                    // Full read (bounded)
                    if (stats.size > limit) throw new Error(`File too large (${stats.size} > ${limit}). Use mode='tail' or 'head'.`);
                    content = await fs.readFile(targetPath, 'utf8');
                }

                return { content: [{ type: "text", text: content }] };
            } catch (err) {
                return { content: [{ type: "text", text: `Error reading file: ${err.message}` }], isError: true };
            }
        }
    },

    repo_list: {
        schema: z.object({
            pattern: z.string().optional(),
            limit: z.number().optional()
        }),
        handler: async (args) => {
            // Simple recursive list up to limit
            const limit = args.limit || 50;
            let count = 0;
            const files = [];

            async function walk(dir) {
                if (count >= limit) return;
                const list = await fs.readdir(dir, { withFileTypes: true });
                for (const dirent of list) {
                    if (count >= limit) return;
                    const res = path.resolve(dir, dirent.name);
                    if (dirent.isDirectory()) {
                        if (dirent.name === 'node_modules' || dirent.name === '.git') continue;
                        await walk(res);
                    } else {
                        // Simple filter
                        if (args.pattern && !res.includes(args.pattern)) continue;
                        files.push(path.relative(AG_REPO_ROOT, res));
                        count++;
                    }
                }
            }

            await walk(AG_REPO_ROOT);
            return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
        }
    }
};

// --- Server Setup ---
const server = new Server(
    {
        name: "ag-bridge-mcp",
        version: "0.3.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: Object.entries(TOOLS).map(([name, tool]) => ({
            name,
            inputSchema: { type: "object", ...z.object({}).shape, ...tool.schema }, // Quick hacks to make it JSON schema compatible-ish
            // Actually zod-to-json-schema is better but keeping it raw for now
            // The SDK handles zod objects well usually? 
            // Wait, the SDK expects JSON Schema. 
            // Let's use a simpler approach or zod-to-json-schema if installed.
            // For now, I'll rely on the fact that I passed Zod objects and hope the SDK likes it
            // OR I will construct simple JSON schema manually for safety.
        }))
    };
});

// Since we didn't install zod-to-json-schema, let's redefine ListTools to return valid JSON schemas manually
// to ensure compatibility without extra huge deps.
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "messages_inbox",
                description: "Get messages for agent or user",
                inputSchema: {
                    type: "object",
                    properties: {
                        to: { type: "string", enum: ["agent", "user"] },
                        status: { type: "string", enum: ["new", "all"] },
                        limit: { type: "number" }
                    },
                    required: ["to"]
                }
            },
            {
                name: "messages_send",
                description: "Send a message to agent or user",
                inputSchema: {
                    type: "object",
                    properties: {
                        to: { type: "string", enum: ["agent", "user"] },
                        channel: { type: "string", enum: ["work", "qa", "status"] },
                        text: { type: "string" }
                    },
                    required: ["to", "text"]
                }
            },
            {
                name: "messages_ack",
                description: "Acknowledge a message",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        status: { type: "string", enum: ["read", "done"] }
                    },
                    required: ["id", "status"]
                }
            },
            {
                name: "agent_heartbeat",
                description: "Update agent status",
                inputSchema: {
                    type: "object",
                    properties: {
                        state: { type: "string", enum: ["idle", "working", "waiting", "error"] },
                        task: { type: "string" },
                        note: { type: "string" }
                    },
                    required: ["state"]
                }
            },
            {
                name: "checkpoint_post",
                description: "Log a checkpoint",
                inputSchema: {
                    type: "object",
                    properties: {
                        n: { type: "number" },
                        N: { type: "number" },
                        risk: { type: "string", enum: ["low", "yellow", "red"] },
                        changedFiles: { type: "array", items: { type: "string" } },
                        verifyCmds: { type: "array", items: { type: "string" } },
                        next: { type: "string" }
                    }
                }
            },
            {
                name: "repo_read_file",
                description: "Read file from repo securely",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        mode: { type: "string", enum: ["full", "head", "tail"] },
                        maxBytes: { type: "number" }
                    },
                    required: ["path"]
                }
            },
            {
                name: "repo_list",
                description: "List files in repo",
                inputSchema: {
                    type: "object",
                    properties: {
                        pattern: { type: "string" },
                        limit: { type: "number" }
                    }
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS[request.params.name];
    if (!tool) {
        throw new Error("Tool not found");
    }
    // Validate args
    const args = tool.schema.parse(request.params.arguments);
    return tool.handler(args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
