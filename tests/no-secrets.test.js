import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

function walk(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (file === '.git' || file === 'node_modules' || file === '.logs') continue;
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walk(filePath, fileList);
        } else {
            fileList.push(filePath);
        }
    }
    return fileList;
}

describe('Guard: Secrets Scanner', () => {
    it('should not contain loose secrets in tracked files', () => {
        const files = walk(ROOT);
        const SECRET_PATTERNS = [
            /tskey-[a-zA-Z0-9]+/,
            /ghp_[a-zA-Z0-9]+/,
            /sk-[a-zA-Z0-9]{20,}/
        ];

        let foundSecrets = [];

        for (const file of files) {
            // potential massive files skip?
            if (file.endsWith('.log') || file.endsWith('.lock')) continue;

            const content = fs.readFileSync(file, 'utf-8');
            for (const pattern of SECRET_PATTERNS) {
                if (pattern.test(content)) {
                    // Exclude this test file itself from triggering
                    if (file.includes('no-secrets.test.js')) continue;
                    foundSecrets.push(`Found secret pattern in ${path.relative(ROOT, file)}`);
                }
            }
        }

        expect(foundSecrets).toEqual([]);
    });

    it('data/state.json should be gitignored', () => {
        const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
        expect(gitignore).toContain('data/state.json');
    });
});
