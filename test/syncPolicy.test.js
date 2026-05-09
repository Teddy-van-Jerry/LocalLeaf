const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getManualPushPlan,
  shouldAutoPullOnProjectLoad,
  shouldTrackLocalDelete,
  shouldTrackLocalModification,
  shouldPushAfterManualPull,
  getManualSyncCompletionState,
  getLocalCreateChangeType,
  getRestoredLocalChangeType,
} = require('../out/sync/syncPolicy');

test('manual startup skips auto-pull when a persisted baseline exists', () => {
  assert.equal(shouldAutoPullOnProjectLoad({
    syncMode: 'manual',
    hasBaseContent: true,
    lastSynced: '2026-05-01T12:00:00.000Z',
  }), false);
});

test('manual startup skips auto-pull for upgraded projects with lastSynced but no loaded baseline', () => {
  assert.equal(shouldAutoPullOnProjectLoad({
    syncMode: 'manual',
    hasBaseContent: false,
    lastSynced: '2026-05-01T12:00:00.000Z',
  }), false);
});

test('manual startup auto-pulls only for a never-synced project', () => {
  assert.equal(shouldAutoPullOnProjectLoad({
    syncMode: 'manual',
    hasBaseContent: false,
  }), true);
});

test('realtime startup auto-pulls to catch up with remote changes', () => {
  assert.equal(shouldAutoPullOnProjectLoad({
    syncMode: 'realtime',
    hasBaseContent: true,
    lastSynced: '2026-05-01T12:00:00.000Z',
  }), true);
});

test('manual sync does not push after pull when conflicts remain', () => {
  assert.equal(shouldPushAfterManualPull({
    localChangeCount: 3,
    remoteChangeCount: 2,
    conflictCount: 2,
  }), false);
});

test('manual sync pushes after pull only when only local changes remain', () => {
  assert.equal(shouldPushAfterManualPull({
    localChangeCount: 3,
    remoteChangeCount: 0,
    conflictCount: 0,
  }), true);
});

test('manual sync completion is blocked by unresolved remote changes', () => {
  assert.deepEqual(getManualSyncCompletionState({
    localChangeCount: 0,
    remoteChangeCount: 1,
    conflictCount: 0,
  }), {
    canComplete: false,
    reason: 'remote',
  });
});

test('manual push without conflicts does not use force', () => {
  assert.deepEqual(getManualPushPlan({
    conflictCount: 0,
  }), {
    action: 'push',
    force: false,
  });
});

test('manual push uses force only after explicit force choice', () => {
  assert.deepEqual(getManualPushPlan({
    conflictCount: 2,
    conflictChoice: 'force',
  }), {
    action: 'push',
    force: true,
  });
});

test('manual push pull-first choice does not push in the same step', () => {
  assert.deepEqual(getManualPushPlan({
    conflictCount: 2,
    conflictChoice: 'pull',
  }), {
    action: 'pull',
    force: false,
  });
});

test('local delete is tracked for migrated projects with lastSynced but no loaded baseline', () => {
  assert.equal(shouldTrackLocalDelete({
    hasRemoteEntry: true,
    hasBaseContent: false,
    lastSynced: '2026-05-01T12:00:00.000Z',
  }), true);
});

test('local delete is not tracked for unknown never-synced files', () => {
  assert.equal(shouldTrackLocalDelete({
    hasRemoteEntry: false,
    hasBaseContent: false,
  }), false);
});

test('manual local modification is not tracked after content is reverted to baseline', () => {
  assert.equal(shouldTrackLocalModification({
    currentContent: Buffer.from('same'),
    baseContent: Buffer.from('same'),
  }), false);
});

test('manual local modification is tracked when current content differs from baseline', () => {
  assert.equal(shouldTrackLocalModification({
    currentContent: Buffer.from('changed'),
    baseContent: Buffer.from('same'),
  }), true);
});

test('manual create events for known remote files are restored as modifications', () => {
  assert.equal(getLocalCreateChangeType({
    hasRemoteEntry: true,
    hasBaseContent: false,
    currentContent: Buffer.from('remote plus local edit'),
    remoteContent: Buffer.from('remote'),
  }), 'modified');

  assert.equal(getLocalCreateChangeType({
    hasRemoteEntry: true,
    hasBaseContent: false,
    currentContent: Buffer.from('remote'),
    remoteContent: Buffer.from('remote'),
  }), undefined);

  assert.equal(getLocalCreateChangeType({
    hasRemoteEntry: false,
    hasBaseContent: false,
    currentContent: Buffer.from('new local file'),
  }), 'created');
});

test('manual startup restores local changes from persisted baseline state', () => {
  assert.equal(getRestoredLocalChangeType({
    currentExists: true,
    hasRemoteEntry: true,
    hasBaseContent: true,
    currentContent: Buffer.from('same plus a'),
    baseContent: Buffer.from('same'),
  }), 'modified');

  assert.equal(getRestoredLocalChangeType({
    currentExists: true,
    hasRemoteEntry: false,
    hasBaseContent: false,
    currentContent: Buffer.from('new local file'),
  }), 'created');

  assert.equal(getRestoredLocalChangeType({
    currentExists: false,
    hasRemoteEntry: true,
    hasBaseContent: true,
  }), 'deleted');

  assert.equal(getRestoredLocalChangeType({
    currentExists: true,
    hasRemoteEntry: true,
    hasBaseContent: true,
    currentContent: Buffer.from('same'),
    baseContent: Buffer.from('same'),
  }), undefined);
});

test('manual startup restores modified files by comparing remote content when baseline is missing', () => {
  assert.equal(getRestoredLocalChangeType({
    currentExists: true,
    hasRemoteEntry: true,
    hasBaseContent: false,
    currentContent: Buffer.from('remote plus local edit'),
    remoteContent: Buffer.from('remote'),
  }), 'modified');

  assert.equal(getRestoredLocalChangeType({
    currentExists: true,
    hasRemoteEntry: true,
    hasBaseContent: false,
    currentContent: Buffer.from('remote'),
    remoteContent: Buffer.from('remote'),
  }), undefined);
});
