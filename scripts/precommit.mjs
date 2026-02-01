import { spawn } from 'child_process';

console.log("Running pre-commit checks...");

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const cmd = spawn(command, args, { stdio: 'inherit', shell: true });
        cmd.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Command ${command} ${args.join(' ')} failed with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

(async () => {
    try {
        console.log("1. Checking Bidi/Lint...");
        await runCommand('npm', ['run', 'check:bidi']);

        console.log("2. Running Unit Tests...");
        await runCommand('npm', ['test']);

        console.log("All checks passed!");
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
})();
