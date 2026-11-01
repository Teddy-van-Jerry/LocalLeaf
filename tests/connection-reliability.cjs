const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {EventEmitter} = require('node:events');

function clock() {
    const timers = new Map();
    let id = 0;
    return {
        timers,
        setTimeout(fn, delay) { const key = ++id; timers.set(key, {fn, delay}); return key; },
        clearTimeout(key) { timers.delete(key); },
        fire() {
            const [key, timer] = timers.entries().next().value;
            timers.delete(key);
            timer.fn();
            return timer.delay;
        },
    };
}

function load(file, mocks, globals = {}) {
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out', file), 'utf8'), {
        exports,
        require: name => {
            if (name in mocks) return mocks[name];
            throw new Error(`Unexpected dependency: ${name}`);
        },
        console: {...console, error() {}}, TextEncoder, TextDecoder, Buffer,
        setTimeout, clearTimeout, ...globals,
    }, {filename: file});
    return exports;
}

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

async function syncTests() {
    let content = Buffer.from('offline edit');
    let writes = 0;
    let synced = 0;
    const statuses = [];
    const {SyncEngine} = load('sync/syncEngine.js', {
        vscode: {
            EventEmitter: class {event = () => {}; fire(event) {statuses.push(event);}},
            FileSystemError: class extends Error {},
            workspace: {getConfiguration: () => ({get: () => true}), fs: {
                readFile: async () => content,
                writeFile: async () => {writes++;},
                stat: async () => ({}),
                readDirectory: async () => [],
            }},
        },
        './ignoreParser': {IgnoreParser: class {async load() {} shouldIgnore() {return false;}}},
        '../consts': {DEBOUNCE_DELAY: 10},
        '../api/socketio': {},
    });
    const engine = new SyncEngine({}, {
        getWorkspaceFolder: () => ({path: '/test'}),
        getFilePath: p => ({path: '/test' + p}),
        getSettings: () => ({projectId: 'project'}),
        updateLastSynced: async () => {synced++;},
    });
    const entry = {id: 'doc', type: 'doc', path: '/main.tex'};
    engine.fileTreeByPath.set(entry.path, entry);
    engine.fileTree.set(entry.id, entry);
    engine.baseContent.set(entry.path, Buffer.from('previous synchronized version'));
    engine.socket = {isConnected: true, disconnect() {}};
    let uploads = 0;
    engine.pushDocumentChanges = async () => {
        uploads++;
        if (uploads === 1) throw new Error('Socket emit timeout');
        return true;
    };
    await engine.handleLocalFileChange({path: '/test/main.tex'});
    assert.equal(engine.fileCache.has(entry.path), false, 'failed upload must not be cached');
    await engine.handleLocalFileChange({path: '/test/main.tex'});
    assert.equal(uploads, 2, 'identical failed save must be retried');
    await engine.handleLocalFileChange({path: '/test/main.tex'});
    assert.equal(uploads, 2, 'acknowledged save must not be sent twice');

    engine.socket.isConnected = false;
    content = Buffer.from('new offline edit');
    for (const name of ['handleLocalFileChange', 'handleLocalFileCreate', 'handleLocalFileDelete']) {
        await engine[name]({path: '/test/main.tex'});
    }
    assert.equal(uploads, 2, 'offline watcher events must not send requests');
    assert.equal(engine.baseContent.get(entry.path).toString(), 'offline edit');

    // Remote OT coordinates cannot safely be applied to unsynchronized edits.
    await engine.handleRemoteFileChanged({doc: 'doc', v: 1, op: [{p: 0, d: 'offline edit'}]});
    assert.equal(writes, 0, 'offline edits must survive remote updates');

    engine.project = {_id: 'project'};
    engine.refreshProjectFileTree = async () => {};
    engine.socket = {isConnected: true, joinDoc: async () => {throw new Error('network lost');}};
    await assert.rejects(engine.pullAll(), /network lost/);
    assert.equal(synced, 0, 'failed downloads must not be reported as successful sync');
    await assert.rejects(engine.joinAllDocsForWatching(), /Failed to watch/);

    engine.socket = {isConnected: true, joinDoc: async () => ({lines: ['remote text']}), leaveDoc: async () => {}};
    engine.askConflictResolution = async () => 'skip';
    await engine.pullAll();
    assert.equal(writes, 0, 'skipped reconnect conflicts must preserve local content');
    assert.equal(content.toString(), 'new offline edit');
    engine.socket.disconnect = () => {};
    engine.disconnect();
    await engine.handleLocalFileChange({path: '/test/main.tex'});
    assert.equal(uploads, 2, 'disposed engines must ignore delayed watcher events');
    console.log('PASS: failed-save retry, offline edits, download/watch errors, and conflict preservation');
}

async function socketTests() {
    const time = clock();
    const wire = new EventEmitter();
    wire.disconnect = () => wire.emit('disconnect');
    const {SocketIOAPI} = load('api/socketio.js', {}, time);
    const socket = new SocketIOAPI({initSocket: () => wire}, {}, 'test');
    let disconnects = 0;
    socket.registerHandlers({onDisconnected() {disconnects++;}});
    const project = socket.joinProject();
    wire.emit('connect');
    wire.emit('joinProjectResponse', {publicId: 'client', project: {_id: 'test'}});
    await project;
    assert.equal(time.timers.size, 0, 'successful handshake must clear timers');
    wire.on('joinDoc', (_id, _opts, ack) => ack(null, ['text'], 1));
    await socket.joinDoc('doc');
    assert.equal(time.timers.size, 0, 'successful emit must clear its timer');

    // Optional collaborator information must not tear down document sync.
    const userTimeout = assert.rejects(socket.getConnectedUsers(), /timeout/);
    time.fire();
    await userTimeout;
    assert.equal(socket.isConnected, true);

    wire.removeAllListeners('joinDoc');
    const interrupted = assert.rejects(socket.joinDoc('doc'), /disconnected/);
    wire.emit('disconnect');
    await interrupted;
    assert.equal(time.timers.size, 0, 'disconnect must reject pending emits immediately');
    await assert.rejects(socket.joinDoc('doc'), /disconnected/);
    assert.equal(time.timers.size, 0, 'offline emits must not be buffered');

    wire.emit('connect');
    const timedOut = assert.rejects(socket.joinDoc('doc'), /timeout: joinDoc/);
    time.fire();
    await timedOut;
    assert.equal(socket.isConnected, false, 'lost acknowledgement must trigger reconnection');
    assert.ok(disconnects >= 2);
    assert.equal(wire.eventNames().length, 0, 'discarded sockets must detach listeners');
    console.log('PASS: socket disconnect, lost acknowledgement, stale listeners, and timer cleanup');
}

async function reconnectTests() {
    const time = clock();
    const engines = [];
    const warnings = [];
    const errors = [];
    const commands = new Map();
    let failConnect = false;
    let httpOnly = false;
    let failPull = false;
    let holdPull;
    const settings = {
        getSettings: () => ({serverUrl: 'https://example.invalid', projectId: 'test'}),
        isLinked: async () => true,
        load: async () => {},
    };
    class Engine {
        constructor() {this.socket = {isConnected: true}; engines.push(this);}
        onStatusChange(callback) {this.callback = callback;}
        event(status, authError = false) {this.status = status; void this.callback({status, authError});}
        async connect() {
            if (failConnect) throw new Error('connection reset');
            if (httpOnly) this.socket = undefined;
            this.event('idle');
        }
        getSocket() {return this.socket;}
        async detectMainDocument() {}
        async pullAll() {
            this.pulling = true;
            if (holdPull) await holdPull;
            if (failPull) throw new Error('download failed');
            this.pulled = true;
        }
        async joinAllDocsForWatching() {this.joined = true;}
        startLocalWatcher() {
            assert.ok(this.pulled && this.joined, 'watcher must wait for conflict resolution and subscriptions');
            this.watching = true;
        }
        disconnect() {this.disposed = true; this.event('disconnected');}
    }
    const ext = load('extension.js', {
        vscode: {
            window: {
                createOutputChannel: () => ({appendLine() {}, dispose() {}}),
                createStatusBarItem: () => ({show() {}, hide() {}, dispose() {}}),
                showWarningMessage: async message => {warnings.push(message);},
                showErrorMessage: message => {errors.push(message);},
                showInformationMessage() {},
            },
            commands: {registerCommand(name, handler) {commands.set(name, handler); return {dispose() {}};}},
            StatusBarAlignment: {Left: 1}, MarkdownString: class {}, ThemeColor: class {},
        },
        './consts': require('../out/consts.js'),
        './utils/credentialManager': {CredentialManager: {initialize: () => ({
            getDefaultServer: () => 'https://example.invalid',
            getCredential: async () => ({identity: {}}),
        })}},
        './utils/settingsManager': {SettingsManager: {getInstance: () => settings}, createSettingsWatcher: () => ({dispose() {}})},
        './utils/syncFolderManager': {SyncFolderManager: class {
            getFolder() {return {};}
            async validateFolder() {}
        }},
        './api/base': {BaseAPI: class {setIdentity() {}}},
        './sync/syncEngine': {SyncEngine: Engine},
        './sync/ignoreParser': {},
        './api/socketio': {setOutputChannel() {}},
        './collaboration/cursorTracker': {CursorTracker: class {async initialize() {} dispose() {}}},
    }, {...time, setInterval: () => 1, clearInterval() {}});
    const activate = async () => {await ext.activate({globalState: {}, subscriptions: []}); await settle();};
    try {
        await activate();
        assert.ok(engines[0].watching);
        engines[0].event('disconnected');
        engines[0].event('disconnected');
        assert.equal(time.timers.size, 1, 'duplicate disconnects must schedule just one retry');
        failConnect = true;
        assert.equal(time.fire(), 2000);
        await settle();
        assert.ok(engines[0].disposed);
        assert.equal(errors.length, 0, 'background retries must not flood error notifications');
        for (const delay of [4000, 8000, 16000, 32000, 60000, 60000]) {
            assert.equal(time.fire(), delay);
            await settle();
        }
        failConnect = false;
        time.fire();
        await settle();
        assert.ok(engines.at(-1).watching);
        assert.equal(time.timers.size, 0, 'successful resync must stop retries');
        engines[0].event('disconnected');
        assert.equal(time.timers.size, 0, 'old engines must not restart reconnection');

        engines.at(-1).event('disconnected');
        assert.equal(time.fire(), 2000, 'successful recovery must reset backoff');
        await settle();
        engines.at(-1).event('error', true);
        engines.at(-1).event('disconnected');
        await settle();
        assert.equal(time.timers.size, 0, 'auth rejection followed by disconnect must require login');
        assert.equal(warnings.filter(s => s.includes('expired')).length, 1);
        ext.deactivate();

        httpOnly = true;
        await activate();
        assert.equal(time.timers.size, 1, 'HTTP fallback must retry the real-time connection');
        assert.ok(!engines.at(-1).watching);
        ext.deactivate();
        assert.equal(time.timers.size, 0, 'deactivation must cancel retries');

        httpOnly = false;
        failPull = true;
        await activate();
        assert.equal(time.timers.size, 1, 'partial startup sync must be retried');
        assert.ok(!engines.at(-1).watching);
        ext.deactivate();

        failPull = false;
        let release;
        holdPull = new Promise(resolve => {release = resolve;});
        await activate();
        const lastEngine = engines.at(-1);
        const count = engines.length;
        assert.ok(lastEngine.pulling && !lastEngine.watching);
        lastEngine.event('disconnected');
        time.fire();
        await settle();
        assert.equal(engines.length, count, 'retry must wait for the active pull');
        ext.deactivate();
        release();
        await settle();
        assert.equal(engines.length, count, 'cancelled queued retry must not recreate an engine');
    } finally {ext.deactivate();}
    console.log('PASS: serialized reconnect, exponential backoff, HTTP fallback, auth expiry, and cancellation');
}

(async () => {
    await syncTests();
    await socketTests();
    await reconnectTests();
})().catch(error => {console.error(error); process.exitCode = 1;});
