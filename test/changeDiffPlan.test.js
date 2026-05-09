const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanChangePath,
  createChangeDiffPlan,
  getChangePathCandidates,
} = require('../out/views/changeDiffPlan');

test('change paths used for local diff URIs are relative', () => {
  assert.equal(cleanChangePath('/main.tex'), 'main.tex');
  assert.equal(cleanChangePath('sections/intro.tex'), 'sections/intro.tex');
});

test('change path candidates cover webview and sync-engine path shapes', () => {
  assert.deepEqual(getChangePathCandidates('sections/conclusion.tex'), [
    'sections/conclusion.tex',
    '/sections/conclusion.tex',
  ]);
  assert.deepEqual(getChangePathCandidates('/sections/conclusion.tex'), [
    '/sections/conclusion.tex',
    'sections/conclusion.tex',
  ]);
});

test('local-only changes open a base-to-local diff without fetching remote content', () => {
  const plan = createChangeDiffPlan({
    localChangeType: 'modified',
    remoteChangeType: undefined,
    hasRemoteContent: false,
    hasBaseContent: true,
  });

  assert.equal(plan.left, 'base');
  assert.equal(plan.right, 'local');
  assert.equal(plan.titleKind, 'Base ↔ Local');
  assert.equal(plan.requiresRemoteContent, false);
});

test('local-only modified changes fetch remote content when the synced baseline is missing', () => {
  assert.equal(createChangeDiffPlan({
    localChangeType: 'modified',
    remoteChangeType: undefined,
    hasRemoteContent: false,
    hasBaseContent: false,
  }).requiresRemoteContent, true);

  assert.equal(createChangeDiffPlan({
    localChangeType: 'created',
    remoteChangeType: undefined,
    hasRemoteContent: false,
    hasBaseContent: false,
  }).requiresRemoteContent, false);
});

test('remote-only modifications fetch remote content only when it is not already present', () => {
  assert.equal(createChangeDiffPlan({
    localChangeType: undefined,
    remoteChangeType: 'modified',
    hasRemoteContent: false,
  }).requiresRemoteContent, true);

  assert.equal(createChangeDiffPlan({
    localChangeType: undefined,
    remoteChangeType: 'modified',
    hasRemoteContent: true,
  }).requiresRemoteContent, false);
});

test('deleted sides render as empty virtual documents', () => {
  assert.deepEqual(createChangeDiffPlan({
    localChangeType: 'deleted',
    remoteChangeType: undefined,
    hasRemoteContent: false,
  }), {
    left: 'base',
    right: 'empty',
    titleKind: 'Base ↔ Local',
    requiresRemoteContent: false,
  });

  assert.deepEqual(createChangeDiffPlan({
    localChangeType: undefined,
    remoteChangeType: 'deleted',
    hasRemoteContent: false,
  }), {
    left: 'local',
    right: 'empty',
    titleKind: 'Local ↔ Remote',
    requiresRemoteContent: false,
  });
});
