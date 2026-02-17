
import http from 'http';

// Configuration
const PORTS = [9000, 9001, 9002, 9003];

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Logic: Check if Agent is busy (Cancel button visible)
const EXPRESSION_BUSY = `(() => {
  const el = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  const busy = !!el && el.offsetParent !== null;
  return { found: !!el, busy };
})()`;

// Logic: Inject "check inbox" and submit
const makePokeExpression = (messageContent) => `(async () => {
    // 1. Check for blocking "Cancel" button (Agent is busy)
    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
    if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy_cancel_visible" };

    // Helper: Find editor in a specific root (document or iframe)
    function findInRoot(root) {
        if (!root || !root.querySelectorAll) return null;
        
        // A. Multi-strategy selector
        const selector = '#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"], ' +
                         'div[contenteditable="true"][role="textbox"], ' +
                         '.monaco-editor textarea';
        
        const candidates = [...root.querySelectorAll(selector)];
        // Return the last visible one
        return candidates.filter(el => el.offsetParent !== null).at(-1);
    }

    // 2. Find Editor Strategy (Deep Scan)
    function findEditor() {
        // Try main document
        let found = findInRoot(document);
        if (found) return found;

        // Try Iframes (VS Code Webviews)
        const iframes = document.querySelectorAll('iframe, webview');
        for (const frame of iframes) {
            try {
                // Accessing contentDocument might fail if cross-origin, but often works in Electron/CDP
                const doc = frame.contentDocument;
                if (doc) {
                    found = findInRoot(doc);
                    if (found) return found;
                }
            } catch (e) { /* ignore cross-origin deletion */ }
        }

        return null;
    }

    const editor = findEditor();
    
    // DEBUG: Scan for likely candidates if not found
    if (!editor) {
        const diagnostics = {
            main: [],
            iframes: []
        };
        const selector = 'textarea, [contenteditable="true"], [role="textbox"], .monaco-editor';
        
        // Scan Main
        document.querySelectorAll(selector).forEach(el => {
            diagnostics.main.push({ tag: el.tagName, id: el.id, class: el.className, visible: el.offsetParent !== null });
        });

        // Scan Iframes
        document.querySelectorAll('iframe, webview').forEach((frame, i) => {
            const info = { id: frame.id, src: frame.src, access: false, candidates: [] };
            try {
                const doc = frame.contentDocument;
                if (doc) {
                    info.access = true;
                    doc.querySelectorAll(selector).forEach(el => {
                        info.candidates.push({ tag: el.tagName, id: el.id, class: el.className, visible: el.offsetParent !== null });
                    });
                }
            } catch (e) { info.error = e.message; }
            diagnostics.iframes.push(info);
        });

        return { ok:false, error:"editor_not_found", diagnostics };
    }

    const text = ${JSON.stringify(messageContent)};

    // 3. Clear and Focus
    editor.focus();
    // Try reliable clear methods
    document.execCommand?.("selectAll", false, null);
    document.execCommand?.("delete", false, null);

    // 4. Insert Text
    let inserted = false;
    // Method A: execCommand (Best for contenteditable)
    try { inserted = !!document.execCommand?.("insertText", false, text); } catch {}
    
    // Method B: Direct value/textContent assignment (Fallback)
    if (!inserted) {
        if (editor.tagName === 'TEXTAREA') {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeInputValueSetter?.call(editor, text);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            editor.textContent = text;
            // Notify frameworks (React/Lexical) of the change
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data:text }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:text }));
        }
    }

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // 5. Submit
    // Search in the same root as the editor
    const root = editor.getRootNode(); 
    const submit = (root.querySelector || document.querySelector).call(root, "svg.lucide-arrow-right")?.closest("button") || 
                   (root.querySelector || document.querySelector).call(root, '[aria-label="Send Message"]') ||
                   (root.querySelector || document.querySelector).call(root, '.codicon-send');

    if (submit && !submit.disabled) {
        submit.click();
        return { ok:true, method:"click_submit" };
    }

    // B. Enter fallback
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter", keyCode: 13 }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter", keyCode: 13 }));

    return { ok:true, method:"enter_fallback", submitFound: !!submit, submitDisabled: submit?.disabled ?? null };
})()`;

async function main() {
    // 0. Get Message
    const messageContent = process.env.AG_POKE_MESSAGE || "check inbox";
    const expression = makePokeExpression(messageContent);

    let target = null;
    let webSocketDebuggerUrl = null;

    // 1. Find correct port and target
    console.warn("[BRIDGE] Scanning ports for Antigravity Agent...");

    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            // DEBUG: Log all found targets
            console.warn(`[BRIDGE] Port ${port} targets:`);
            list.forEach(t => console.warn(` - ${t.url} (${t.title})`));

            // Priority 0: User Override (AG_CDP_TARGET_FILTER)
            const filter = process.env.AG_CDP_TARGET_FILTER;
            let found = null;
            if (filter) {
                console.warn(`[BRIDGE] Applying filter: "${filter}"`);
                found = list.find(t => (t.url && t.url.includes(filter)) || (t.title && t.title.includes(filter)));
            }

            // Priority 1: Standard Workbench (Main Window)
            if (!found) {
                found = list.find(t => t.url.includes('workbench.html') || (t.title && t.title.includes('workbench')));
            }

            // Priority 2: Fallback to agent specific
            if (!found) {
                found = list.find(t => t.url.includes('workbench-jetski-agent.html'));
            }

            if (found && found.webSocketDebuggerUrl) {
                target = found;
                webSocketDebuggerUrl = found.webSocketDebuggerUrl;
                console.warn(`[BRIDGE] Selected target: ${found.url} "${found.title}"`);
                break;
            }
            if (found && !found.webSocketDebuggerUrl) {
                console.warn(`[BRIDGE] Found target but no WebSocket URL (Node?): ${found.url}`);
            }
        } catch (e) { }
    }

    if (!webSocketDebuggerUrl) {
        console.log(JSON.stringify({ ok: false, error: "cdp_not_found", details: "Is VS Code started with --remote-debugging-port=9000?" }));
        process.exit(0);
    }

    // 2. Connect via WS
    // Node.js v22 has global WebSocket. Fallback to 'ws' package if needed.
    let WebSocketClass = global.WebSocket;
    if (!WebSocketClass) {
        try {
            const wsModule = await import('ws');
            WebSocketClass = wsModule.default;
        } catch (e) {
            console.log(JSON.stringify({ ok: false, error: "ws_module_missing", details: e.message }));
            process.exit(1);
        }
    }
    const ws = new WebSocketClass(webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg.data); // WS native event.data
            if (data.id === id) {
                ws.removeEventListener('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.addEventListener('message', handler);
        // Add a timeout to reject if no response comes
        setTimeout(() => {
            ws.removeEventListener('message', handler);
            reject(new Error("RPC Timeout"));
        }, 3000);

        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.addEventListener('message', (msg) => {
        try {
            const data = JSON.parse(msg.data);
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            }
        } catch { }
    });

    try {
        await call("Runtime.enable", {});
        // Wait for contexts to be discovered
        await new Promise(r => setTimeout(r, 800)); // Slightly longer wait for contexts

        let pokeResult = null;
        let diagnosticData = [];

        // 3. Loop through contexts to find one that works
        for (const ctx of contexts) {
            try {
                // Try Poking. The script itself now checks for editor presence safely.
                const evalPoke = await call("Runtime.evaluate", {
                    expression: expression,
                    returnByValue: true,
                    awaitPromise: true, // Important for async script
                    contextId: ctx.id
                });

                if (evalPoke.result && evalPoke.result.value) {
                    const res = evalPoke.result.value;

                    if (res.ok) {
                        pokeResult = res;
                        break; // Success!
                    }
                    else if (res.reason === "busy_cancel_visible") {
                        pokeResult = { ok: false, reason: "busy" };
                        break; // Busy is a definitive state
                    }
                    // Capture diagnostics from failed attempts
                    if (res.diagnostics) {
                        diagnosticData.push({ contextId: ctx.id, diagnostics: res.diagnostics });
                    }
                }
            } catch (ignore) { }
        }

        if (pokeResult) {
            console.log(JSON.stringify(pokeResult));
        } else {
            // If we get here, no context worked
            console.log(JSON.stringify({
                ok: false,
                error: "editor_not_found_in_any_context",
                contextCount: contexts.length,
                diagnostics: diagnosticData,
                scannedConfigs: {
                    port: webSocketDebuggerUrl ? "found" : "missing",
                    target: target ? target.url : "unknown"
                }
            }));
        }

    } catch (err) {
        console.log(JSON.stringify({ ok: false, error: "runtime_error", details: err.message }));
    } finally {
        ws.close();
    }
}

main().catch(err => {
    console.log(JSON.stringify({ ok: false, error: "script_error", details: err.message }));
    process.exit(1);
});
