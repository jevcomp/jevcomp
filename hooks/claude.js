import { applyJevCut, toJevMessages } from '../dist/claude.js';

// The module runs without Node, so the Jev work runs in a node process started from this plugin's own dist/.
function cliPath() {
  const path = decodeURIComponent(new URL('../dist/cli.js', import.meta.url).pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

async function askJev($, e, options) {
  let sessionId;
  try { sessionId = await $.session.id(); } catch {}
  const input = JSON.stringify({ sessionId, agentId: e.agentId, trigger: e.trigger, provider: options.provider, apiKey: options.apiKey, messages: toJevMessages(e.messages) });
  const run = await $.process.run(['node', cliPath(), 'claude-compact'], { stdin: input, timeoutMs: 300_000 });
  if (run.exitCode !== 0) throw new Error(String(run.stderr).trim() || `jevcomp exited with ${run.exitCode}`);
  return JSON.parse(String(run.stdout));
}

function note($, text) {
  $.ui.log(`jevcomp: ${text}`);
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  on('session.compact', async ($, e, next) => {
    // A precomputed summary would be the model-written one this plugin exists to avoid.
    if (e.trigger === 'precompute') return { skip: 'jevcomp compacts when the compaction happens' };
    try {
      const cut = await askJev($, e, options);
      if (!cut.apply) {
        note($, `Claude summary used (${cut.reason})`);
        return next(e);
      }
      note($, `kept what still matters from old tool output (${cut.summary})`);
      return { messages: applyJevCut(e.messages, cut) };
    } catch (error) {
      note($, `Claude summary used (${error instanceof Error ? error.message : String(error)})`);
      return next(e);
    }
  });
};
