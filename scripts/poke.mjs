import WebSocket from 'ws';
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
const EXPRESSION_POKE = `(async () => {
  const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy_cancel_visible" };

  const text = "check inbox";
  const editors = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
    .filter(el => el.offsetParent !== null);
  const editor = editors.at(-1);
  if (!editor) return { ok:false, error:"editor_not_found" };

  editor.focus();
  document.execCommand?.("selectAll", false, null);
  document.execCommand?.("delete", false, null);

  let inserted = false;
  try { inserted = !!document.execCommand?.("insertText", false, text); } catch {}
  if (!inserted) {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data:text }));
    editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:text }));
  }

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Prefer arrow-right submit button
  const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
  if (submit && !submit.disabled) {
    submit.click();
    return { ok:true, method:"click_submit" };
  }

  // Enter fallback
  editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
  editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter" }));

  return { ok:true, method:"enter_fallback", submitFound: !!submit, submitDisabled: submit?.disabled ?? null };
})()`;

async function main() {
    let target = null;
    let webSocketDebuggerUrl = null;

    // 1. Find correct port and target
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            // Priority 2: Standard Workbench (Fallback)
            let found = list.find(t => t.url.includes('workbench.html') || (t.title && t.title.includes('workbench')));

            if (found && found.webSocketDebuggerUrl) {
                target = found;
                webSocketDebuggerUrl = found.webSocketDebuggerUrl;
                break;
            }
        } catch (e) { }
    }

    if (!webSocketDebuggerUrl) {
        console.log(JSON.stringify({ ok: false, error: "cdp_not_found", details: "Is VS Code started with --remote-debugging-port=9000?" }));
        process.exit(0);
    }

    // 2. Connect via WS
    const ws = new WebSocket(webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.method === 'Runtime.executionContextCreated') {
            contexts.push(data.params.context);
        }
    });

    try {
        await call("Runtime.enable", {});
        // Wait for contexts to be discovered
        await new Promise(r => setTimeout(r, 500));

        // 3. Loop through contexts
        for (const ctx of contexts) {
            try {
                // Check if this context has the elements we need
                // We use EXPRESSION_BUSY's logic but primarily to check if element exists (even if it returns busy=false)
                // Actually, let's just try to FIND the editor first.
                // We'll modify BUSY logic to return { found: boolean } to save a step.

                const evalBusy = await call("Runtime.evaluate", {
                    expression: EXPRESSION_BUSY,
                    returnByValue: true,
                    contextId: ctx.id
                });

                // If the check threw (e.g. document not found in worker), ignore
                if (!evalBusy.result || !evalBusy.result.value) continue;

                const res = evalBusy.result.value;
                if (res.busy) {
                    console.log(JSON.stringify({ ok: false, reason: "busy" }));
                    process.exit(0);
                }

                // If not busy, try Poking ONLY if we think this is the right context.
                // But we don't know if it's the right context unless we find the editor.
                // So let's run the Poke script which checks for editor.

                const evalPoke = await call("Runtime.evaluate", {
                    expression: EXPRESSION_POKE,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });

                if (evalPoke.result && evalPoke.result.value) {
                    const pokeRes = evalPoke.result.value;
                    if (pokeRes.ok) {
                        console.log(JSON.stringify(pokeRes));
                        process.exit(0);
                    } else if (pokeRes.reason === "busy_cancel_visible") {
                        console.log(JSON.stringify({ ok: false, reason: "busy" }));
                        process.exit(0);
                    }
                    // If error is "editor_not_found", continue to next context
                }
            } catch (ignore) { }
        }

        // If we get here, no context worked
        console.log(JSON.stringify({ ok: false, error: "editor_not_found_in_any_context", contextCount: contexts.length }));

    } catch (err) {
        console.log(JSON.stringify({ ok: false, error: "runtime_error", details: err.message }));
    } finally {
        ws.terminate();
    }
}

main().catch(err => {
    console.log(JSON.stringify({ ok: false, error: "script_error", details: err.message }));
});
