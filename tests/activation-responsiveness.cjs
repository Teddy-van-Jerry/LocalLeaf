const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Expected operation did not start');
}

(async () => {
    const connection = deferred();
    const pull = deferred();
    const handlers = new Map();
    const menus = [];
    const statusItems = [];
    const messages = [];
    const errors = [];
    const opened = [];
    const engines = [];
    let outputShown = 0;
    let pushes = 0;
    let selection;
    let pullStarted = false;
    const folder = { fsPath: '/test/thesis/tex', path: '/test/thesis/tex' };
    const settings = {
        getSettings: () => ({serverUrl: 'https://www.overleaf.com', projectId: 'test', projectName: 'Test thesis'}),
        getWorkspaceFolder: () => folder,
        isLinked: async () => true,
        load: async () => {},
    };
    const credentials = {
        getDefaultServer: () => 'https://www.overleaf.com',
        getCredential: async () => ({identity: {}, userEmail: 'test@example.invalid'}),
    };
    const output = { appendLine() {}, show() { outputShown++; }, dispose() {} };
    const vscode = {
        ProgressLocation: {Notification: 1},
        window: {
            withProgress: async (_options, task) => task(),
            createOutputChannel: () => output,
            createStatusBarItem: () => {
                const item = {visible: false, show() {this.visible = true;}, hide() {this.visible = false;}, dispose() {}};
                statusItems.push(item);
                return item;
            },
            showQuickPick: async items => {
                menus.push(items);
                const selected = selection;
                selection = undefined;
                return selected;
            },
            showErrorMessage: message => { errors.push(message); },
            showWarningMessage: async () => undefined,
            showInformationMessage: message => { messages.push(message); },
            showTextDocument: async file => { opened.push(file); },
        },
        commands: {registerCommand: (name, handler) => {
            handlers.set(name, handler);
            return {dispose() {}};
        }},
        StatusBarAlignment: {Left: 1},
        QuickPickItemKind: {Separator: -1},
        Uri: {joinPath: (base, ...parts) => path.join(base.fsPath, ...parts)},
        MarkdownString: class { constructor(value) { this.value = value; } },
        ThemeColor: class {},
    };
    class SyncEngine {
        constructor() { this.status = 'syncing'; this.disconnected = false; engines.push(this); }
        onStatusChange(callback) {this.statusChanged = callback;}
        async connect() { await connection.promise; this.status = 'idle'; this.statusChanged({status: 'idle'}); }
        getSocket() { return {isConnected: true}; }
        startLocalWatcher() {}
        async detectMainDocument() {}
        async pullAll() { pullStarted = true; this.status = 'pulling'; await pull.promise; this.status = 'idle'; }
        async joinAllDocsForWatching() {}
        async pushAll() {pushes++; return {uploaded: 2, failed: [], cancelled: false};}
        disconnect() { this.disconnected = true; }
    }
    const mocks = {
        vscode,
        './consts': require('../out/consts.js'),
        './utils/credentialManager': {CredentialManager: {initialize: () => credentials}},
        './utils/settingsManager': {SettingsManager: {getInstance: () => settings}, createSettingsWatcher: () => ({dispose() {}})},
        './utils/syncFolderManager': {SyncFolderManager: class {
            getFolder() { return folder; }
            async validateFolder() {}
        }},
        './api/base': {BaseAPI: class {setIdentity() {}}},
        './sync/syncEngine': {SyncEngine},
        './sync/ignoreParser': {},
        './collaboration/cursorTracker': {CursorTracker: class {async initialize() {} dispose() {} getOnlineUsers() {return [];} getUserCount() {return 0;} }},
        './api/socketio': {setOutputChannel() {}},
    };
    const exports = {};
    const sandbox = {
        exports,
        require: name => { assert.ok(name in mocks, name); return mocks[name]; },
        console, setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8'), sandbox);
    try {
        let activated = false;
        const activation = exports.activate({globalState: {}, subscriptions: []}).then(() => { activated = true; });
        await waitFor(() => activated);
        await activation;
        await waitFor(() => engines.length === 1);
        assert.ok(handlers.has('localleaf.showSyncStatus'));
        await handlers.get('localleaf.showSyncStatus')();
        assert.ok(menus.at(-1).some(item => item.label.includes('Sync operation in progress')));

        // Normal mutation commands wait; diagnostics do not wait on startup.
        const configuration = handlers.get('localleaf.configure')();
        await handlers.get('localleaf.showSyncStatus')();
        assert.equal(opened.length, 0);
        selection = {label: '$(output) Show LocalLeaf Output'};
        await handlers.get('localleaf.showSyncStatus')();
        assert.equal(outputShown, 1);

        connection.resolve();
        await waitFor(() => pullStarted);
        await handlers.get('localleaf.showSyncStatus')();
        assert.ok(menus.at(-1).some(item => item.description === 'pulling'));

        // Reconnect selected from the nonblocking status menu must still wait
        // for the old pull before disposing its engine or creating another one.
        engines[0].status = 'disconnected';
        selection = {label: '$(debug-disconnect) Reconnect'};
        const reconnect = handlers.get('localleaf.showSyncStatus')();
        await waitFor(() => messages.some(message => message.includes('queued behind')));
        assert.equal(engines.length, 1);
        assert.equal(engines[0].disconnected, false);
        assert.equal(opened.length, 0);

        pull.resolve();
        await configuration;
        await reconnect;
        assert.equal(opened.length, 1);
        assert.equal(engines.length, 2);
        assert.equal(engines[0].disconnected, true);
        const pushButton = statusItems.find(item => item.name === 'LocalLeaf Push to Overleaf');
        assert.ok(pushButton.visible);
        assert.equal(pushButton.text, '$(cloud-upload) Push to Overleaf');
        assert.equal(pushButton.command, 'localleaf.pushToOverleaf');
        await handlers.get(pushButton.command)();
        assert.equal(pushes, 1);
        selection = {label: '$(cloud-upload) Push local changes to Overleaf'};
        await handlers.get('localleaf.showSyncStatus')();
        assert.equal(pushes, 2, 'status menu performs the same manual push');
        assert.ok(messages.some(message => message.includes('Pushed 2 file(s)')));
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('PASS: activation and status are responsive during blocked connection and pull; sync actions remain serialized.');
    } finally {
        connection.resolve();
        pull.resolve();
        exports.deactivate();
        assert.equal(statusItems.find(item => item.name === 'LocalLeaf Push to Overleaf').visible, false);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
