import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Bidi control characters
// U+202A..U+202E (Embeddings/Overrides)
// U+2066..U+2069 (Isolates)
// U+200E, U+200F (Marks)
// U+061C (ALM)
const BIDI_REGEX = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;

function walk(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (file === '.git' || file === 'node_modules' || file === '.logs' || file === 'dist' || file === '.venv' || file === '.valkyrie') continue;
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

console.log('🔍 Scanning for bidirectional Unicode characters...');
const files = walk(ROOT);
let exitCode = 0;

for (const file of files) {
    try {
        // Skip binary checks roughly
        if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.ico')) continue;

        const content = fs.readFileSync(file, 'utf-8');
        const match = content.match(BIDI_REGEX);
        if (match) {
            console.error(`⚠️  Bidi character found in: ${path.relative(ROOT, file)}`);
            console.error(`   Char: \\u${match[0].codePointAt(0).toString(16).toUpperCase()}`);
            exitCode = 1;
        }
    } catch (e) {
        // ignore read errors (permissions etc)
    }
}

if (exitCode === 0) {
    console.log('✅ No bidi characters found.');
} else {
    console.error('❌ Bidi Check Failed.');
}

process.exit(exitCode);
