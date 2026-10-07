import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyPath, readHistory } from '../dist/store.js';

test('history older than the retention window is hidden and pruned from disk', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { JEVCOMP_DATA_DIR: dir, JEVCOMP_HISTORY_DAYS: '7' };
  const old = { at: new Date(Date.now() - 8 * 86_400_000).toISOString(), sessionId: 'old', status: 'prepared' };
  const recent = { at: new Date(Date.now() - 86_400_000).toISOString(), sessionId: 'recent', status: 'prepared' };
  await writeFile(historyPath(env), `${JSON.stringify(old)}\nnot json\n${JSON.stringify(recent)}\r\n`);

  const rows = await readHistory(env);
  assert.deepEqual(rows.map((row) => row.sessionId), ['recent']);
  assert.deepEqual((await readFile(historyPath(env), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).sessionId), ['recent']);

  await appendFile(historyPath(env), `${JSON.stringify({ ...recent, sessionId: 'later' })}\n`);
  assert.deepEqual((await readHistory(env)).map((row) => row.sessionId), ['recent', 'later']);
});

test('a half-written last line is picked up once the writer finishes it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-store-partial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { JEVCOMP_DATA_DIR: dir };
  const row = (sessionId) => JSON.stringify({ at: new Date().toISOString(), sessionId, status: 'prepared' });
  await writeFile(historyPath(env), `${row('a')}\n`);
  assert.deepEqual((await readHistory(env)).map((item) => item.sessionId), ['a']);
  const partial = row('b');
  await appendFile(historyPath(env), partial.slice(0, 10));
  assert.deepEqual((await readHistory(env)).map((item) => item.sessionId), ['a']);
  await appendFile(historyPath(env), `${partial.slice(10)}\n`);
  assert.deepEqual((await readHistory(env)).map((item) => item.sessionId), ['a', 'b']);
});
