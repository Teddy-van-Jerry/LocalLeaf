const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {EventEmitter} = require('node:events');

function project(docId = 'main') {
    return {_id: 'project', name: 'Test', rootFolder: [{
        _id: 'root', name: '', folders: [], fileRefs: [],
        docs: [{_id: docId, name: 'main.tex'}],
    }]};
}

function harness() {
    let now = 100000;
    let timerId = 0;
    const timers = new Map();
    const connections = [];
    const writes = [];
    const logs = [];
    const state = {project: project(), text: 'remote', hang: false, selection: items => items};
    const clock = {
        Date: class extends Date {static now() {return now;}},
        setTimeout(fn, delay) {const id = ++timerId; timers.set(id, {fn, at: now + delay}); return id;},
        clearTimeout(id) {timers.delete(id);},
    };
    const load = (file, mocks) => {
        const exports = {};
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out', file), 'utf8'), {
            exports, require: name => mocks[name], ...clock, TextEncoder, TextDecoder, Buffer,
            console: {...console, error() {}},
        });
        return exports;
    };
    const {SocketIOAPI} = load('api/socketio.js', {});
    const api = {
        getUrl: () => 'https://overleaf.example/',
        getProjectDetails() {assert.fail('connected refresh must not scrape an HTML page without ol-rootFolder');},
        initSocket(_identity, query) {
            assert.ok(query.includes('projectId=project'));
            const wire = new EventEmitter();
            wire.closed = false;
            wire.openedAt = now;
            wire.disconnect = () => {wire.closed = true; wire.emit('disconnect');};
            wire.on('joinDoc', (_id, _options, ack) => ack(null, [state.text], 1));
            wire.on('applyOtUpdate', (id, update, ack) => {writes.push({id, update}); ack(null);});
            connections.push(wire);
            if (!state.hang) Promise.resolve().then(() => {
                wire.emit('connect');
                wire.emit('joinProjectResponse', {publicId: 'client', project: structuredClone(state.project)});
            });
            return wire;
        },
    };
    const socket = new SocketIOAPI(api, {}, 'project');
    const folder = {path: '/test', scheme: 'file'};
    const {SyncEngine} = load('sync/syncEngine.js', {
        '../api/socketio': {SocketIOAPI},
        '../consts': {DEBOUNCE_DELAY: 10},
        './ignoreParser': {IgnoreParser: class {async load() {} shouldIgnore() {return false;}}},
        vscode: {
            EventEmitter: class {event = () => {}; fire() {}},
            FileSystemError: class extends Error {},
            FileType: {File: 1, Directory: 2, SymbolicLink: 64},
            Uri: {joinPath: (uri, name) => ({...uri, path: uri.path + '/' + name})},
            workspace: {
                textDocuments: [],
                fs: {readDirectory: async () => [['main.tex', 1]], readFile: async () => Buffer.from('local')},
            },
            window: {showQuickPick: async items => state.selection(items)},
        },
    });
    const engine = new SyncEngine(api, {
        getSettings: () => ({projectId: 'project'}),
        getWorkspaceFolder: () => folder,
        getFilePath: name => ({...folder, path: folder.path + name}),
        updateLastSynced: async () => {},
    }, message => logs.push(message));
    engine.socket = socket;
    const settle = async () => {for (let i = 0; i < 60; i++) await Promise.resolve();};
    const run = async promise => {
        let done = false, result, error;
        promise.then(value => {result = value; done = true;}, err => {error = err; done = true;});
        for (let i = 0; i < 30 && !done; i++) {
            await settle();
            if (done) break;
            assert.ok(timers.size, 'operation must finish or schedule a bounded wait');
            const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            timers.delete(id);
            now = timer.at;
            timer.fn();
        }
        assert.ok(done);
        if (error) throw error;
        return result;
    };
    return {socket, engine, state, connections, writes, logs, run, settle, timers};
}

(async () => {
    {
        const h = harness();
        await h.run(h.socket.joinProject());
        h.state.project = project('new-document');
        const fresh = await h.run(h.socket.refreshProject());
        assert.equal(fresh.rootFolder[0].docs[0]._id, 'new-document');
        assert.equal(h.socket.project.rootFolder[0].docs[0]._id, 'main', 'old handshake is not a fresh snapshot');
        assert.equal(h.connections.length, 2);
        assert.equal(h.connections[0].closed, false, 'editing connection stays open');
        assert.equal(h.connections[1].closed, true, 'snapshot connection is always closed');
        assert.equal(h.connections[1].eventNames().length, 0);
        assert.equal(h.timers.size, 0);
    }
    {
        const h = harness();
        await h.run(h.socket.joinProject());
        await h.run(Promise.all([h.socket.refreshProject(), h.socket.refreshProject()]));
        assert.equal(h.connections.length, 3);
        assert.ok(h.connections[2].openedAt - h.connections[1].openedAt >= 5000);
        assert.equal(h.socket.isConnected, true);
    }
    for (const invalid of [{_id: 'other', rootFolder: [{}]}, {_id: 'project'}, {_id: 'project', rootFolder: []}]) {
        const h = harness();
        await h.run(h.socket.joinProject());
        h.state.project = invalid;
        await assert.rejects(h.run(h.socket.refreshProject()), /invalid project folder tree/);
        assert.equal(h.connections[1].closed, true);
        assert.equal(h.socket.isConnected, true);
    }
    {
        const h = harness();
        await h.run(h.socket.joinProject());
        h.state.hang = true;
        await assert.rejects(h.run(h.socket.refreshProject()), /handshake timeout/);
        assert.equal(h.connections[1].closed, true);
        assert.equal(h.timers.size, 0);
        h.state.hang = false;
        assert.equal((await h.run(h.socket.refreshProject()))._id, 'project', 'failed snapshots remain retryable');
        h.socket.disconnect();
        const count = h.connections.length;
        await assert.rejects(h.run(h.socket.refreshProject()), /disconnected/);
        assert.equal(h.connections.length, count, 'no snapshot after the editing connection closes');
    }
    {
        const h = harness();
        await h.run(h.socket.joinProject());
        h.engine.baseContent.set('/main.tex', Buffer.from('saved'));
        h.engine.joinedDocs.add('main');
        await h.run(h.engine.refreshProjectFileTree());
        assert.equal(h.engine.fileTreeByPath.get('/main.tex').id, 'main');
        assert.equal(h.engine.baseContent.get('/main.tex').toString(), 'saved');
        assert.equal(h.engine.joinedDocs.has('main'), true);
        h.state.project = project('replacement');
        await h.run(h.engine.refreshProjectFileTree());
        assert.equal(h.engine.fileTreeByPath.get('/main.tex').id, 'replacement');
        const previous = h.engine.fileTreeByPath.get('/main.tex');
        h.state.hang = true;
        await assert.rejects(h.run(h.engine.refreshProjectFileTree()), /timeout/);
        assert.equal(h.engine.fileTreeByPath.get('/main.tex'), previous);
        assert.ok(h.logs.some(message => /Waiting/.test(message)));
    }
    {
        const h = harness();
        await h.run(h.socket.joinProject());
        const result = await h.run(h.engine.pushAll());
        assert.equal(result.uploaded, 1);
        assert.equal(result.failed.length, 0);
        assert.equal(h.writes.length, 1);
        assert.equal(h.writes[0].id, 'main');
        assert.equal(h.connections.length, 3, 'fresh snapshots before preview and before writes');
        assert.equal(h.connections[0].closed, false);
    }
    {
        const h = harness();
        await h.run(h.socket.joinProject());
        h.state.selection = items => {h.state.project = project('replacement'); return items;};
        const result = await h.run(h.engine.pushAll());
        assert.equal(result.uploaded, 0);
        assert.match(result.failed[0], /Overleaf contents changed/);
        assert.equal(h.writes.length, 0, 'a replaced remote file must never be overwritten');
    }
    console.log('PASS: protocol-v2 fresh trees, snapshot cleanup/throttling, manual push, and remote replacement conflicts');
})().catch(error => {console.error(error); process.exitCode = 1;});
