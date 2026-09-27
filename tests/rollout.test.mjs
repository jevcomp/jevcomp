import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCodexRollout, parseCodexRollout, UnsupportedCodexRolloutError } from '../dist/rollout.js';

test('incomplete rollout rows fail open instead of dropping context', async () => {
  const valid = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'keep this' }] } });
  const partial = `${valid}\n{"type":`;
  assert.throws(() => parseCodexRollout(partial), UnsupportedCodexRolloutError);
  const root = await mkdtemp(join(tmpdir(), 'jev-partial-rollout-'));
  const path = join(root, 'rollout.jsonl');
  await writeFile(path, partial);
  await assert.rejects(loadCodexRollout(path), UnsupportedCodexRolloutError);
});

test('modern compaction without replacement history fails open', () => {
  const row = { type: 'compacted', payload: { window_number: 2, replacement_history: [] } };
  assert.throws(() => parseCodexRollout(JSON.stringify(row)), /missing history/);
});

test('replays compacted replacement_history as the live transcript', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'old prompt' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'old', name: 'read', arguments: '{"path":"old"}' } },
    { type: 'compacted', payload: { replacement_history: [
      { type: 'message', role: 'user', content: [{ text: 'compacted prompt' }] },
      { type: 'function_call', call_id: 'new', name: 'read', arguments: '{"path":"new"}' },
      { type: 'function_call_output', call_id: 'new', output: 'new contents' }
    ] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'after compact' }] } }
  ];
  const messages = parseCodexRollout(rows.map(JSON.stringify).join('\n'));
  assert.equal(messages.some((m) => m.text.includes('old prompt')), false);
  assert.equal(messages.some((m) => m.text.includes('compacted prompt')), true);
  assert.equal(messages.flatMap((m) => m.toolCalls).some((c) => c.id === 'new'), true);
  assert.equal(messages.flatMap((m) => m.toolCalls).some((c) => c.id === 'old'), false);
});

test('structured tool output is preserved when it has no text field', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'tool', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: [{ type: 'json', value: { branch: 'main', clean: true } }] } }
  ];
  const result = parseCodexRollout(rows.map(JSON.stringify).join('\n'));
  assert.match(result.flatMap((m) => m.toolResults ?? [])[0].output, /branch/);
});

test('legacy compaction keeps user prompts and summary instead of erasing history', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'developer constraint' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'constraint' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'old work' }] } },
    { type: 'compacted', payload: { message: 'legacy summary' } }
  ];
  const result = parseCodexRollout(rows.map(JSON.stringify).join('\n'));
  assert.deepEqual(result.map((m) => m.text), ['developer constraint', 'constraint', 'legacy summary']);
});

test('legacy rollback fails open instead of judging the wrong history', () => {
  const rows = [{ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});

test('tail loader uses only a modern bounded checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-rollout-'));
  const path = join(dir, 'rollout.jsonl');
  const old = Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: `old-${i}-${'z'.repeat(80)}` }] } })).join('\n');
  const compacted = JSON.stringify({ type: 'compacted', payload: { window_number: 2, replacement_history: [{ type: 'message', role: 'user', content: [{ text: 'live' }] }] } });
  const tail = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'after' }] } });
  await writeFile(path, `${old}\n${compacted}\n${tail}\n`);
  const messages = await loadCodexRollout(path, 128);
  assert.deepEqual(messages.map((m) => m.text).filter(Boolean), ['live', 'after']);
});

test('tail loader does not stop at a legacy compaction after a modern checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-rollout-legacy-'));
  const path = join(dir, 'rollout.jsonl');
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'root constraint' }] } },
    { type: 'compacted', payload: { window_number: 1, replacement_history: [{ type: 'message', role: 'user', content: [{ text: 'modern live' }] }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'work' }] } },
    { type: 'compacted', payload: { message: 'legacy later summary' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'after legacy' }] } }
  ];
  await writeFile(path, rows.map(JSON.stringify).join('\n'));
  const messages = await loadCodexRollout(path, 64);
  assert.deepEqual(messages.map((m) => m.text).filter(Boolean), ['modern live', 'legacy later summary', 'after legacy']);
});

test('tool_search_output preserves its tools payload', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'tool_search_call', call_id: 'ts1', execution: 'search', arguments: { query: 'calendar' } } },
    { type: 'response_item', payload: { type: 'tool_search_output', call_id: 'ts1', status: 'completed', execution: 'search', tools: [{ name: 'calendar_lookup', description: 'find events' }] } }
  ];
  const result = parseCodexRollout(rows.map(JSON.stringify).join('\n'));
  const output = result.flatMap((m) => m.toolResults ?? []).find((r) => r.callId === 'ts1')?.output ?? '';
  assert.match(output, /calendar_lookup/);
});

test('inter-agent communication is included in Jev-visible transcript', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'delegate research' }] } },
    { type: 'inter_agent_communication', payload: { author: 'agent/researcher', recipient: 'agent/root', other_recipients: [], content: 'Important finding from subagent', trigger_turn: false } }
  ];
  const result = parseCodexRollout(rows.map(JSON.stringify).join('\n'));
  assert.equal(result.at(-1).role, 'assistant');
  assert.match(result.at(-1).text, /Important finding/);
});

test('encrypted inter-agent communication fails open', () => {
  const rows = [{ type: 'inter_agent_communication', payload: { author: 'a', recipient: 'b', content: '', encrypted_content: 'ciphertext', trigger_turn: false } }];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});

test('encrypted agent_message in replacement history fails open', () => {
  const rows = [{ type: 'compacted', payload: { replacement_history: [{ type: 'agent_message', author: 'a', recipient: 'b', content: [{ type: 'encrypted_content', encrypted_content: 'cipher' }] }] } }];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});

test('preserves developer and system messages from Codex history', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'Never edit generated files.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'system', content: [{ text: 'System context' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Fix login' }] } }
  ];
  const result = parseCodexRollout(rows.map(JSON.stringify).join('\n'));
  assert.deepEqual(result.map((m) => [m.role, m.text]), [
    ['developer', 'Never edit generated files.'],
    ['system', 'System context'],
    ['user', 'Fix login'],
  ]);
});

test('tail loader handles a giant JSONL record crossing many chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-rollout-giant-'));
  const path = join(dir, 'rollout.jsonl');
  const rows = [
    { type: 'compacted', payload: { window_number: 7, replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'live constraint' }] }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `huge-${'x'.repeat(120_000)}` }] } },
  ];
  await writeFile(path, `${rows.map(JSON.stringify).join('\n')}\n`);
  const messages = await loadCodexRollout(path, 127);
  assert.equal(messages[0].text, 'live constraint');
  assert.match(messages[1].text, /^huge-x+/);
});

test('non-text message content fails open instead of hiding context from Jev', () => {
  const rows = [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }] } }];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});

test('mixed plaintext and encrypted agent content still fails open', () => {
  const rows = [{ type: 'response_item', payload: { type: 'agent_message', author: 'a', recipient: 'b', content: [{ type: 'input_text', text: 'visible' }, { type: 'encrypted_content', encrypted_content: 'cipher' }] } }];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});

test('non-text tool results fail open instead of being semantically judged blind', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'function_call', call_id: 'img', name: 'view_image', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'img', output: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }] } },
  ];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});


test('multiple Codex text content items retain their boundary', () => {
  const rows = [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }, { type: 'input_text', text: 'second' }] } }];
  const result = parseCodexRollout(rows.map(JSON.stringify).join('\n'));
  assert.equal(result[0].text, 'first\nsecond');
});

test('encrypted function arguments fail open instead of judging incomplete tool input', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'function_call', call_id: 'secret-call', name: 'private_tool', arguments: '{}', encrypted_function_args: ['cipher'] } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'secret-call', output: 'ok' } },
  ];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});

test('image generation context fails open because Jev is text-only', () => {
  const rows = [{ type: 'response_item', payload: { type: 'image_generation_call', id: 'ig_1', status: 'completed', revised_prompt: 'diagram', result: 'base64-image' } }];
  assert.throws(() => parseCodexRollout(rows.map(JSON.stringify).join('\n')), UnsupportedCodexRolloutError);
});


test('unknown future response items fail open instead of silently hiding context from Jev', () => {
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'future_model_visible_item', content: [{ type: 'input_text', text: 'important future context' }] } });
  assert.throws(() => parseCodexRollout(line), /unknown Codex response item type/);
});

test('unknown future rollout records fail open while current metadata remains ignorable', () => {
  const known = [
    { type: 'session_meta', payload: { id: 's' } },
    { type: 'world_state', payload: { full: true, value: {} } },
    { type: 'turn_context', payload: { turn_id: 't' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
  ].map(JSON.stringify).join('\n');
  assert.equal(parseCodexRollout(known).at(-1).text, 'hello');
  assert.throws(() => parseCodexRollout(JSON.stringify({ type: 'future_rollout_fact', payload: { important: true } })), /unknown Codex rollout item type/);
});

test('realtime rollout content fails open instead of being invisibly omitted', () => {
  assert.throws(() => parseCodexRollout(JSON.stringify({ type: 'realtime_item', payload: { audio: 'opaque' } })), /realtime Codex history/);
});

test('bounded rollout loading starts from the newest safe compaction checkpoint', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadCodexRollout } = await import('../dist/rollout.js');
  const root = await mkdtemp(join(tmpdir(), 'jev-snapshot-offset-'));
  const path = join(root, 'rollout.jsonl');
  const prefix = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] } })}\n`;
  const checkpoint = `${JSON.stringify({ type: 'compacted', payload: { window_number: 4, replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new' }] }] } })}\n`;
  await writeFile(path, prefix + checkpoint);
  const messages = await loadCodexRollout(path, 17);
  assert.equal(messages.at(-1).text, 'new');
});
