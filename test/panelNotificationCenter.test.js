const test = require('node:test');
const assert = require('node:assert/strict');

const { PanelNotificationCenter } = require('../out/views/panelNotificationCenter');

test('panel notification center coalesces repeated notices into one stable item', () => {
  const center = new PanelNotificationCenter();

  const firstId = center.showNotice('Network error', 'error');
  const secondId = center.showNotice('Network error', 'error');
  const state = center.getState();

  assert.equal(firstId, secondId);
  assert.equal(state.notice.message, 'Network error');
  assert.equal(state.notice.count, 2);
  assert.deepEqual(state.notice.history, ['Network error']);
});

test('panel notification center keeps a single notice when many messages arrive', () => {
  const center = new PanelNotificationCenter();

  center.showNotice('First warning', 'warning');
  center.showNotice('Second warning', 'warning');
  center.showNotice('Third error', 'error');
  const state = center.getState();

  assert.equal(state.notice.message, 'Third error');
  assert.equal(state.notice.type, 'error');
  assert.equal(state.notice.count, 3);
  assert.deepEqual(state.notice.history, ['First warning', 'Second warning', 'Third error']);
});

test('panel notification center ignores stale dismiss requests after notice updates', () => {
  const center = new PanelNotificationCenter();

  const id = center.showNotice('Compiling...', 'info');
  const staleRevision = center.getState().notice.revision;
  center.showNotice('Compilation failed', 'error');

  center.dismissNotice(id, staleRevision);
  assert.equal(center.getState().notice.message, 'Compilation failed');

  center.dismissNotice(id, center.getState().notice.revision);
  assert.equal(center.getState().notice, null);
});

test('panel notification center resolves modal responses', async () => {
  const center = new PanelNotificationCenter();

  const pending = center.showModal({
    message: 'Overwrite remote?',
    type: 'warning',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Force Push', value: 'force', danger: true },
    ],
  });
  const modal = center.getState().modal;
  assert.equal(modal.message, 'Overwrite remote?');

  center.respondToModal(modal.id, 'force');
  assert.equal(await pending, 'force');
  assert.equal(center.getState().modal, null);
});
