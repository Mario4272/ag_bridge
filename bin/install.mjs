#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const TARGET_ROOT = process.cwd();

async function copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data' || entry.name === '.logs') continue;
            await copyDir(srcPath, destPath);
        } else {
            await fs.copyFile(srcPath, destPath);
        }
    }
}

async function main() {
    console.log(`\n🌉 AG Bridge Installer\n`);
    console.log(`Scaffolding into: ${TARGET_ROOT}`);

    // Files to copy
    const files = ['server.mjs', 'mcp-server.mjs', 'policy.json', 'README.md', 'package.json'];
    const dirs = ['public', 'scripts'];

    for (const file of files) {
        try {
            await fs.copyFile(path.join(PKG_ROOT, file), path.join(TARGET_ROOT, file));
            console.log(`OK ${file}`);
        } catch (e) {
            console.error(`ERR ${file}: ${e.message}`);
        }
    }

    for (const dir of dirs) {
        try {
            await copyDir(path.join(PKG_ROOT, dir), path.join(TARGET_ROOT, dir));
            console.log(`OK ${dir}/`);
        } catch (e) {
            console.error(`ERR ${dir}: ${e.message}`);
        }
    }

    // Create data/logs
    await fs.mkdir(path.join(TARGET_ROOT, 'data'), { recursive: true });
    await fs.mkdir(path.join(TARGET_ROOT, '.logs'), { recursive: true });

    // Create empty approvals.json
    await fs.writeFile(path.join(TARGET_ROOT, 'data', 'approvals.json'), '[]');

    console.log(`\n✅ Done! To start:\n`);
    console.log(`  npm install`);
    console.log(`  npm start`);
    console.log(`\n`);
}

main().catch(console.error);
