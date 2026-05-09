const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('left panel uses status bars for notices and fullscreen modals for choices', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const projectsProvider = fs.readFileSync(path.join(root, 'src/views/projectsWebviewProvider.ts'), 'utf8');
  const combined = `${changesProvider}\n${projectsProvider}`;

  assert.match(combined, /notice-status-bar/);
  assert.match(combined, /choice-modal-backdrop/);
  assert.match(combined, /choice-modal/);
  assert.doesNotMatch(combined, /action-status-bar/);
});

test('ambiguous sync now command is not exposed in the VS Code UI', () => {
  const manifest = require('../package.json');
  const commands = manifest.contributes.commands.map(command => command.command);
  const titleCommands = manifest.contributes.menus['view/title'].map(item => item.command);

  assert.ok(!commands.includes('localleaf.syncNow'));
  assert.ok(!titleCommands.includes('localleaf.syncNow'));
  assert.ok(titleCommands.includes('localleaf.pullFromOverleaf'));
  assert.ok(titleCommands.includes('localleaf.pushToOverleaf'));
});

test('linked localleaf sidebar is a single webview instead of changes tools details foldouts', () => {
  const manifest = require('../package.json');
  const linkedViews = manifest.contributes.views.localleaf.filter(view => view.when === 'localleaf.isLinked');
  const linkedIds = linkedViews.map(view => view.id);
  const titleCommands = manifest.contributes.menus['view/title'];
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');

  assert.deepEqual(linkedIds, ['localleaf.mainView']);
  assert.equal(linkedViews[0].type, 'webview');
  assert.equal(linkedViews[0].name, ' ');
  assert.ok(manifest.activationEvents.includes('onView:localleaf.mainView'));
  assert.ok(!manifest.activationEvents.includes('onView:localleaf.changesView'));
  assert.ok(!linkedIds.includes('localleaf.changesView'));
  assert.ok(!linkedIds.includes('localleaf.toolsView'));
  assert.ok(!linkedIds.includes('localleaf.detailsView'));
  assert.ok(titleCommands.some(item => item.when === 'view == localleaf.mainView'));
  assert.ok(!titleCommands.some(item => item.when && item.when.includes('localleaf.changesView')));
  assert.doesNotMatch(extension, /createTreeView\('localleaf\.toolsView'/);
  assert.doesNotMatch(extension, /createTreeView\('localleaf\.detailsView'/);
});

test('main view activates the extension directly', () => {
  const manifest = require('../package.json');

  assert.ok(manifest.activationEvents.includes('onView:localleaf.mainView'));
});

test('manual startup restores local change rows from disk after skipping auto-pull', () => {
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
  const syncEngine = fs.readFileSync(path.join(root, 'src/sync/syncEngine.ts'), 'utf8');

  assert.match(syncEngine, /async refreshLocalChangesFromDisk\(\)/);
  assert.match(syncEngine, /this\.fileTreeByPath[\s\S]*this\.baseContent\.has\(relativePath\)[\s\S]*await this\.getRemoteContent\(relativePath\)/);
  assert.match(extension, /const restoredLocalCount = syncMode === 'manual'[\s\S]*refreshLocalChangesFromDisk\(\)/);
  assert.match(extension, /shouldAutoPull && !\(syncMode === 'manual' && restoredLocalCount > 0\)/);
});

test('startup auto-pull runs in the background instead of blocking activation', () => {
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');

  assert.match(extension, /void syncEngine\.pullAll\(\)[\s\S]*log\('Auto-pull complete'\)/);
  assert.doesNotMatch(extension, /await syncEngine\.pullAll\(\);\n\s*log\('Auto-pull complete'\)/);
});

test('ignore file changes reload patterns and prune pending changes before sidebar state', () => {
  const syncEngine = fs.readFileSync(path.join(root, 'src/sync/syncEngine.ts'), 'utf8');

  assert.match(syncEngine, /import \{ IgnoreParser, createIgnoreWatcher \} from '\.\/ignoreParser'/);
  assert.match(syncEngine, /private ignoreWatcher\?: vscode\.FileSystemWatcher/);
  assert.match(syncEngine, /private setupIgnoreWatcher\(\): void/);
  assert.match(syncEngine, /createIgnoreWatcher\([\s\S]*\(\) => void this\.reloadIgnorePatternsAndPruneChanges\(\)/);
  assert.match(syncEngine, /private async reloadIgnorePatternsAndPruneChanges\(\): Promise<void> \{[\s\S]*await this\.ignoreParser\.load\(\)[\s\S]*this\.pruneIgnoredTrackedChanges\(\)/);
  assert.match(syncEngine, /private pruneIgnoredTrackedChanges\(\): number \{[\s\S]*this\._changeTracker\.getLocalChanges\(\)[\s\S]*!this\.shouldSync\(change\.path\)[\s\S]*this\._changeTracker\.clearLocal\(change\.path\)/);
  assert.match(syncEngine, /this\._changeTracker\.getRemoteChanges\(\)[\s\S]*!this\.shouldSync\(change\.path\)[\s\S]*this\._changeTracker\.clearRemote\(change\.path\)/);
});

test('manual push asks for force when Overleaf reports file already exists', () => {
  const syncEngine = fs.readFileSync(path.join(root, 'src/sync/syncEngine.ts'), 'utf8');

  assert.match(syncEngine, /function isFileAlreadyExistsError\(error: unknown\): boolean/);
  assert.match(syncEngine, /isFileAlreadyExistsError\(error\)[\s\S]*Force Push/);
  assert.match(syncEngine, /await this\.refreshProjectFileTree\(\)/);
  assert.match(syncEngine, /await this\.pushChanges\(\{ \.\.\.options, force: true, fileExistsRetry: true \}\)/);
  assert.match(syncEngine, /private async forcePushCreatedChange\(/);
  assert.match(syncEngine, /if \(options\?\.force && existingRemoteEntry\) \{[\s\S]*await this\.forcePushCreatedChange/);
});

test('manual pull confirms cloud overwrite and applies remote as authoritative', () => {
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
  const syncEngine = fs.readFileSync(path.join(root, 'src/sync/syncEngine.ts'), 'utf8');

  assert.match(extension, /Pull from Overleaf will overwrite local unpushed changes/);
  assert.match(extension, /await syncEngine!\.pullAll\(\{ remoteWins \}\)/);

  assert.match(syncEngine, /interface PullAllOptions \{[\s\S]*remoteWins\?: boolean/);
  assert.match(syncEngine, /async pullAll\(options: PullAllOptions = \{\}\): Promise<void>/);
  assert.match(syncEngine, /if \(options\.remoteWins\) \{[\s\S]*this\._changeTracker\.clearLocal\(entry\.path\)/);
  assert.match(syncEngine, /if \(hasConflict && !options\.remoteWins\) \{[\s\S]*this\.tryAutoMergeTextConflict/);
  assert.match(syncEngine, /if \(options\.remoteWins\) \{[\s\S]*vscode\.workspace\.fs\.delete\(localUri, \{ recursive: true/);
});

test('clicking a change row opens a diff instead of the plain local file', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.ok(!changesProvider.includes("const openCmd = groupType === 'conflict' ? 'viewDiff' : 'openFile'"));
  assert.match(changesProvider, /enableCommandUris:\s*true/);
  assert.match(changesProvider, /root\.addEventListener\('click'/);
  assert.match(changesProvider, /data-command':'viewDiff'/);
  assert.match(changesProvider, /data-path':item\.path/);
});

test('virtual diff documents use safe internal URIs instead of encoded file paths', () => {
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');

  assert.doesNotMatch(extension, /Uri\.parse\(`\$\{scheme\}:\/\$\{encodeURIComponent\(label\)\}`\)/);
  assert.match(extension, /vscode\.Uri\.from\(\{\s*scheme,\s*path:\s*'\/content'/);
});

test('change rows open diffs directly without a visible diff button', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.doesNotMatch(changesProvider, /diff-btn/);
  assert.doesNotMatch(changesProvider, /title:'View Diff'/);
  assert.match(changesProvider, /className:'change-item'[\s\S]*'data-command':'viewDiff'/);
});

test('change rows do not render trailing change type labels', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.doesNotMatch(changesProvider, /className:'desc'/);
  assert.doesNotMatch(changesProvider, /\.change-item \.desc/);
  assert.doesNotMatch(changesProvider, /h\('span', \{className:'desc'\}, item\.type\)/);
});

test('local changes expose revert actions from row context menu and group header', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
  const syncEngine = fs.readFileSync(path.join(root, 'src/sync/syncEngine.ts'), 'utf8');

  assert.match(changesProvider, /root\.addEventListener\('contextmenu'/);
  assert.match(changesProvider, /\.change-item\[data-group="local"\]/);
  assert.match(changesProvider, /showChangeContextMenu\(event\.clientX,\s*event\.clientY,\s*item\.dataset\.path\)/);
  assert.match(changesProvider, /Revert Change/);
  assert.match(changesProvider, /Revert All/);
  assert.match(changesProvider, /command:'discardAllLocalChanges'[\s\S]*paths:items\.map\(item => item\.path\)/);
  assert.doesNotMatch(changesProvider, /title:'Discard', 'data-command':'discardChange'/);

  assert.match(extension, /COMMANDS\.DISCARD_ALL_LOCAL_CHANGES/);
  assert.match(extension, /await syncEngine\.revertLocalChange\(filePath\)/);
  assert.match(extension, /await syncEngine\.revertLocalChanges\(targetPaths\)/);

  assert.match(syncEngine, /async revertLocalChange\(relativePath: string\): Promise<boolean>/);
  assert.match(syncEngine, /case 'created':[\s\S]*vscode\.workspace\.fs\.delete\(localUri, \{ recursive: true/);
  assert.match(syncEngine, /case 'modified':[\s\S]*case 'deleted':[\s\S]*vscode\.workspace\.fs\.writeFile\(localUri, baseContent\)/);
  assert.match(syncEngine, /async revertLocalChanges\(paths: string\[\]\): Promise<number>/);
});

test('main webview owns changes tools and details tab content', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.match(changesProvider, /function renderChangesContent\(\)/);
  assert.match(changesProvider, /function renderToolsContent\(\)/);
  assert.match(changesProvider, /function renderDetailsContent\(\)/);
  assert.match(changesProvider, /removeComments/);
  assert.match(changesProvider, /state\.details/);
});

test('main webview presents changes tools and details as top tabs', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.match(changesProvider, /let activeTab = null/);
  assert.match(changesProvider, /function getAvailableTabs\(\)/);
  assert.match(changesProvider, /function renderTabBar\(tabs\)/);
  assert.match(changesProvider, /className:'tab-bar'/);
  assert.match(changesProvider, /role:'tablist'/);
  assert.match(changesProvider, /'data-tab':tab\.id/);
  assert.match(changesProvider, /function renderTabContent\(\)/);
  assert.doesNotMatch(changesProvider, /bottom-sections/);
});

test('realtime mode removes the changes tab while keeping tools and details tabs', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.match(changesProvider, /if \(state\.syncMode !== 'realtime'\) \{[\s\S]*id:'changes'/);
  assert.match(changesProvider, /id:'tools'/);
  assert.match(changesProvider, /id:'details'/);
  assert.match(changesProvider, /if \(!tabs\.some\(tab => tab\.id === activeTab\)\) \{[\s\S]*activeTab = tabs\[0\]\.id/);
  assert.doesNotMatch(changesProvider, /const changesEl = renderChangesSection\(\)/);
});

test('main webview tabs use restrained native styling instead of blue section headers', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.match(changesProvider, /#root\{[\s\S]*overflow:\s*hidden/);
  assert.match(changesProvider, /\.tab-bar\{[\s\S]*display:\s*flex/);
  assert.match(changesProvider, /\.tab-button\.active\{[\s\S]*border-bottom-color/);
  assert.match(changesProvider, /\.tab-content\{[\s\S]*overflow-y:\s*auto/);
  assert.doesNotMatch(changesProvider, /background:\s*#007acc/);
  assert.doesNotMatch(changesProvider, /panel-section-header/);
});

test('main webview puts the realtime switch at the top left instead of a localleaf title', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const manifest = require('../package.json');
  const mainView = manifest.contributes.views.localleaf.find(view => view.id === 'localleaf.mainView');
  const localleafContainer = manifest.contributes.viewsContainers.activitybar.find(container => container.id === 'localleaf');
  const realtimeIndex = changesProvider.indexOf("className:'realtime-control'");
  const statusIndex = changesProvider.indexOf("className:'status-left'");

  assert.equal(localleafContainer.title, ' ');
  assert.equal(mainView.name, ' ');
  assert.match(changesProvider, /\.status-strip\{[\s\S]*justify-content:\s*flex-start/);
  assert.match(changesProvider, /\.realtime-control\{[\s\S]*display:\s*flex/);
  assert.ok(realtimeIndex > -1);
  assert.ok(statusIndex > -1);
  assert.ok(realtimeIndex < statusIndex);
});

test('left panel status region is sticky at the top', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const projectsProvider = fs.readFileSync(path.join(root, 'src/views/projectsWebviewProvider.ts'), 'utf8');

  for (const source of [changesProvider, projectsProvider]) {
    assert.match(source, /top-status-region/);
    assert.match(source, /\.top-status-region\{[\s\S]*position:\s*sticky/);
  }
  assert.match(changesProvider, /root\.appendChild\(renderTopStatusRegion\(\)\)/);
  assert.match(changesProvider, /renderPrimaryStatusBar/);
  assert.match(projectsProvider, /id="top-status-region"/);
});

test('changes panel primary status bar is default and not dismissible', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.match(changesProvider, /status-left/);
  assert.match(changesProvider, /state\.statusText/);
  assert.doesNotMatch(changesProvider, /className:'notice-dismiss'/);
  assert.doesNotMatch(changesProvider, /command:'dismissNotice'/);
});

test('panel notices do not auto-dismiss through timers', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const projectsProvider = fs.readFileSync(path.join(root, 'src/views/projectsWebviewProvider.ts'), 'utf8');
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');

  assert.doesNotMatch(changesProvider, /this\.notifications\.dismissNotice\(id, revision\)/);
  assert.doesNotMatch(projectsProvider, /this\.notifications\.dismissNotice\(id, revision\)/);
  assert.doesNotMatch(extension, /setTimeout\(\(\) => dismissPanelNotice\(token\), autoDismissMs\)/);
});

test('pdf viewer uses continuous anchored wheel zoom for mac trackpad gestures', () => {
  const pdfViewer = fs.readFileSync(path.join(root, 'media/pdfViewer.js'), 'utf8');

  assert.doesNotMatch(pdfViewer, /e\.deltaY > 0 \? -0\.1 : 0\.1/);
  assert.match(pdfViewer, /function getWheelDeltaPixels\(e\)/);
  assert.match(pdfViewer, /Math\.exp\(-wheelDelta \* 0\.0025\)/);
  assert.match(pdfViewer, /function captureZoomAnchor\(clientX, clientY\)/);
  assert.match(pdfViewer, /restoreZoomAnchor\(anchor, oldZoom, newZoom\)/);
  assert.match(pdfViewer, /viewerContainer\.scrollLeft/);
});

test('pdf viewer preserves viewport anchor when compiled PDF updates', () => {
  const pdfViewer = fs.readFileSync(path.join(root, 'media/pdfViewer.js'), 'utf8');

  assert.match(pdfViewer, /function capturePdfViewAnchor\(\)/);
  assert.match(pdfViewer, /function restorePdfViewAnchor\(anchor\)/);
  assert.match(pdfViewer, /let pendingRenderAnchor = null/);
  assert.match(pdfViewer, /async function openPdfData\(data, restoreAnchor\)/);
  assert.match(pdfViewer, /await renderAllPages\(restoreAnchor\)/);
  assert.match(pdfViewer, /var anchor = capturePdfViewAnchor\(\);[\s\S]*await openPdfData\(bytes\.buffer, anchor\)/);
  assert.match(pdfViewer, /restorePdfViewAnchor\(restoreAnchor\)/);
  assert.doesNotMatch(pdfViewer, /viewerContainer\.scrollTop = scrollPosition/);
});
