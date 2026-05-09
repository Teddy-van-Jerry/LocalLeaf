const test = require('node:test');
const assert = require('node:assert/strict');

const { SyncOperationGate } = require('../out/sync/syncOperationGate');

test('sync operation gate rejects a second operation while busy', async () => {
  const gate = new SyncOperationGate();
  let releaseFirst;

  const first = gate.tryRun('pull', async () => {
    await new Promise(resolve => {
      releaseFirst = resolve;
    });
    return 'first';
  });

  const second = await gate.tryRun('push', async () => 'second');

  assert.deepEqual(second, {
    started: false,
    activeOperation: 'pull',
  });

  releaseFirst();
  assert.deepEqual(await first, {
    started: true,
    result: 'first',
  });
});

test('sync operation gate allows a new operation after the first finishes', async () => {
  const gate = new SyncOperationGate();

  assert.deepEqual(await gate.tryRun('pull', async () => 'pulled'), {
    started: true,
    result: 'pulled',
  });
  assert.deepEqual(await gate.tryRun('push', async () => 'pushed'), {
    started: true,
    result: 'pushed',
  });
});
