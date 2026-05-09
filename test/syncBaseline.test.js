const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { SyncBaselineStore } = require('../out/sync/syncBaseline');

async function withTempWorkspace(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localleaf-baseline-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('baseline store persists file metadata and content across instances', async () => {
  await withTempWorkspace(async (workspace) => {
    const store = new SyncBaselineStore(workspace);
    await store.load();

    await store.setEntry('/main.tex', {
      path: '/main.tex',
      entityId: 'doc-1',
      entityType: 'doc',
      hash: 123,
      timestamp: 111,
    }, Buffer.from('remote base'));

    const reloaded = new SyncBaselineStore(workspace);
    const snapshot = await reloaded.load();

    assert.equal(snapshot.entries.length, 1);
    assert.deepEqual(snapshot.entries[0], {
      path: '/main.tex',
      entityId: 'doc-1',
      entityType: 'doc',
      hash: 123,
      timestamp: 111,
    });
    assert.deepEqual(await reloaded.getContent('/main.tex'), Buffer.from('remote base'));
  });
});

test('baseline store moves and deletes path prefixes', async () => {
  await withTempWorkspace(async (workspace) => {
    const store = new SyncBaselineStore(workspace);
    await store.load();
    await store.setEntry('/chapters/a.tex', {
      path: '/chapters/a.tex',
      entityId: 'doc-a',
      entityType: 'doc',
      hash: 1,
      timestamp: 1,
    }, Buffer.from('a'));
    await store.setEntry('/chapters/b.tex', {
      path: '/chapters/b.tex',
      entityId: 'doc-b',
      entityType: 'doc',
      hash: 2,
      timestamp: 2,
    }, Buffer.from('b'));

    await store.movePrefix('/chapters/', '/sections/');
    assert.deepEqual(await store.getContent('/sections/a.tex'), Buffer.from('a'));
    assert.equal(await store.getContent('/chapters/a.tex'), undefined);

    await store.deletePrefix('/sections/');
    const reloaded = new SyncBaselineStore(workspace);
    const snapshot = await reloaded.load();
    assert.deepEqual(snapshot.entries, []);
  });
});

test('baseline store replaces stale entries atomically', async () => {
  await withTempWorkspace(async (workspace) => {
    const store = new SyncBaselineStore(workspace);
    await store.load();
    await store.setEntry('/old.tex', {
      path: '/old.tex',
      entityId: 'old',
      entityType: 'doc',
      hash: 1,
      timestamp: 1,
    }, Buffer.from('old'));

    await store.replaceAll([
      {
        entry: {
          path: '/new.tex',
          entityId: 'new',
          entityType: 'doc',
          hash: 2,
          timestamp: 2,
        },
        content: Buffer.from('new'),
      },
    ]);

    const reloaded = new SyncBaselineStore(workspace);
    const snapshot = await reloaded.load();
    assert.deepEqual(snapshot.entries.map(entry => entry.path), ['/new.tex']);
    assert.equal(await reloaded.getContent('/old.tex'), undefined);
    assert.deepEqual(await reloaded.getContent('/new.tex'), Buffer.from('new'));
  });
});
