import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAgyPayload, createAgyCompactionState } from '../dist/agy-compact.js';

function payload(result = 'middle '.repeat(1000), prompt = 'Fix the failing checkout test') {
  return {
    project: 'project',
    model: 'gemini-test',
    requestId: 'request-1',
    request: {
      sessionId: 'session-1',
      systemInstruction: { parts: [{ text: 'system stays exact' }] },
      contents: [
        { role: 'user', parts: [{ text: prompt }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'shell', args: { command: 'npm test' } }, thoughtSignature: 'sig-keep-me' }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'shell', response: { result, metadata: 'keep' } } }] },
        { role: 'model', parts: [{ text: 'I inspected the failure.' }] },
      ],
    },
  };
}

function askerFor(drop, truncate, counter = { calls: 0 }) {
  return {
    counter,
    async ask(_state, questions) {
      counter.calls++;
      return {
        answers: Object.fromEntries(Object.keys(questions).map((key) => [
          key,
          { noul: key.startsWith('drop_') ? drop : truncate },
        ])),
      };
    },
  };
}

test('Antigravity truncation edits only the paired string result and preserves Gemini metadata', async () => {
  const original = payload('HEAD\n' + 'noise '.repeat(1000) + '\nTAIL ERROR exit 1');
  const asker = askerFor(0.9, 0.1);
  const result = await compactAgyPayload(original, asker, createAgyCompactionState(), {
    preserveRecentMessages: 0,
    truncateHeadChars: 80,
    truncateTailChars: 80,
    minEligibleChars: 0,
    minReductionRatio: 0,
  });

  assert.equal(result.changed, true);
  assert.equal(asker.counter.calls, 1);
  const beforeCall = original.request.contents[1].parts[0];
  const afterCall = result.payload.request.contents[1].parts[0];
  assert.deepEqual(afterCall, beforeCall);
  assert.equal(afterCall.thoughtSignature, 'sig-keep-me');
  const response = result.payload.request.contents[2].parts[0].functionResponse;
  assert.equal(response.response.metadata, 'keep');
  assert.match(response.response.result, /^HEAD/);
  assert.match(response.response.result, /TAIL ERROR exit 1$/);
  assert.match(response.response.result, /jevcomp omitted/);
});

test('a Jev drop decision keeps the Gemini call/signature and omits only its result', async () => {
  const original = payload('valuable '.repeat(1000));
  const result = await compactAgyPayload(original, askerFor(0.1, 0.1), createAgyCompactionState(), {
    preserveRecentMessages: 0,
    minEligibleChars: 0,
    minReductionRatio: 0,
  });

  assert.equal(result.changed, true);
  assert.equal(result.payload.request.contents[1].parts[0].functionCall.id, 'call_1');
  assert.equal(result.payload.request.contents[1].parts[0].thoughtSignature, 'sig-keep-me');
  const response = result.payload.request.contents[2].parts[0].functionResponse.response.result;
  assert.match(response, /^\[jevcomp omitted \d+ chars; rerun tool if needed\]$/);
  assert.equal(result.decisions[0].action, 'truncate_result');
  assert.equal(result.stats.callsDropped, 0);
  assert.equal(result.stats.resultsTruncated, 1);
});

test('ambiguous id-less parallel calls fail open instead of guessing a pair', async () => {
  const input = payload();
  input.request.contents = [
    { role: 'user', parts: [{ text: 'task' }] },
    { role: 'model', parts: [
      { functionCall: { name: 'read', args: { path: 'a' } } },
      { functionCall: { name: 'read', args: { path: 'b' } } },
    ] },
    { role: 'user', parts: [{ functionResponse: { name: 'read', response: { result: 'x'.repeat(5000) } } }] },
  ];
  const asker = askerFor(0.1, 0.1);
  const result = await compactAgyPayload(input, asker, createAgyCompactionState(), {
    preserveRecentMessages: 0,
    minEligibleChars: 0,
    minReductionRatio: 0,
  });
  assert.equal(result, undefined);
  assert.equal(asker.counter.calls, 0);
});

test('complex or non-string function responses are never candidates', async () => {
  const input = payload();
  input.request.contents[2].parts[0].functionResponse.response.result = { binary: 'opaque' };
  const asker = askerFor(0.1, 0.1);
  const result = await compactAgyPayload(input, asker, createAgyCompactionState(), {
    preserveRecentMessages: 0,
    minEligibleChars: 0,
    minReductionRatio: 0,
  });
  assert.equal(result, undefined);
  assert.equal(asker.counter.calls, 0);
});

test('Antigravity reuses exact decisions only while semantic user/model context is unchanged', async () => {
  const state = createAgyCompactionState();
  const asker = askerFor(0.9, 0.1);
  const options = {
    preserveRecentMessages: 0,
    minEligibleChars: 0,
    minReductionRatio: 0,
    truncateHeadChars: 100,
    truncateTailChars: 50,
  };

  const first = await compactAgyPayload(payload(), asker, state, options);
  const second = await compactAgyPayload(payload(), asker, state, options);
  assert.equal(first.changed, true);
  assert.equal(second.changed, true);
  assert.equal(asker.counter.calls, 1);
  assert.equal(
    first.payload.request.contents[2].parts[0].functionResponse.response.result,
    second.payload.request.contents[2].parts[0].functionResponse.response.result,
  );

  const changedProgressInput = payload();
  changedProgressInput.request.contents[3].parts[0].text = 'The first hypothesis was wrong; inspect the raw output again.';
  const changedProgress = await compactAgyPayload(changedProgressInput, asker, state, options);
  assert.equal(changedProgress.changed, true);
  assert.equal(asker.counter.calls, 2);

  const changedGoal = await compactAgyPayload(payload(undefined, 'Now diagnose a different production failure'), asker, state, options);
  assert.equal(changedGoal.changed, true);
  assert.equal(asker.counter.calls, 3);
});

test('Antigravity avoids a Jev request when new eligible output cannot meet the configured reduction', async () => {
  const input = payload('small output');
  input.request.contents[0].parts[0].text = 'u'.repeat(20_000);
  const asker = askerFor(0.1, 0.1);
  const result = await compactAgyPayload(input, asker, createAgyCompactionState(), {
    preserveRecentMessages: 0,
    minEligibleChars: 0,
    minReductionRatio: 0.15,
  });
  assert.equal(result.changed, false);
  assert.equal(result.providerAsked, false);
  assert.equal(asker.counter.calls, 0);
});
