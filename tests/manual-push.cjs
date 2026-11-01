const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
    const local = new Map([
        ['/main.tex', Buffer.from('local 日本語')],
        ['/same.tex', Buffer.from('same')],
        ['/fig.png', Buffer.from([255, 0, 1])],
        ['/new/chapter.tex', Buffer.from('new chapter')],
        ['/build/file.aux', Buffer.from('ignored')],
    ]);
    const remote = new Map([
        ['/main.tex', {id: 'main', type: 'doc', content: Buffer.from('remote')}],
        ['/same.tex', {id: 'same', type: 'doc', content: Buffer.from('same')}],
        ['/fig.png', {id: 'fig', type: 'file', content: Buffer.from([0])}],
        ['/remote-only.tex', {id: 'remote-only', type: 'doc', content: Buffer.from('keep me')}],
    ]);
    const uploads = [];
    const offered = [];
    const statuses = [];
    const state = {selection: items => items, autoSync: false, configAutoSync: true, synced: 0, fail: false, joins: 0};
    const root = {path: '/project', scheme: 'file'};
    const relative = uri => uri.path.slice(root.path.length);
    const vscode = {
        EventEmitter: class {event = () => {}; fire(event) {statuses.push(event);}},
        FileSystemError: class extends Error {},
        FileType: {File: 1, Directory: 2, SymbolicLink: 64},
        Uri: {joinPath: (uri, name) => ({path: uri.path + '/' + name, scheme: 'file'})},
        workspace: {
            textDocuments: [],
            getConfiguration: () => ({get: () => state.configAutoSync}),
            fs: {
                readFile: async uri => {
                    const content = local.get(relative(uri));
                    if (!content) throw new Error('ENOENT');
                    return content;
                },
                readDirectory: async uri => {
                    const prefix = relative(uri) + '/';
                    const entries = new Map();
                    for (const file of local.keys()) {
                        if (!file.startsWith(prefix)) continue;
                        const rest = file.slice(prefix.length);
                        entries.set(rest.split('/')[0], rest.includes('/') ? 2 : 1);
                    }
                    return [...entries];
                },
            },
        },
        window: {showQuickPick: async (items, options) => {
            assert.equal(options.canPickMany, true);
            offered.push(items.map(item => item.path));
            return state.selection(items);
        }},
    };
    const mocks = {
        vscode,
        './ignoreParser': {IgnoreParser: class {
            async load() {}
            shouldIgnore(p) {return p.startsWith('/build/');}
        }},
        '../consts': {DEBOUNCE_DELAY: 1},
        '../api/socketio': {},
    };
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/sync/syncEngine.js'), 'utf8'), {
        exports, require: name => mocks[name], TextEncoder, TextDecoder, Buffer, setTimeout, clearTimeout,
        console: {...console, error() {}},
    });
    const engine = new exports.SyncEngine({getFile: async (_project, id) => ({
        type: 'success', content: [...remote.values()].find(file => file.id === id).content,
    })}, {
        getSettings: () => ({projectId: 'project', autoSync: state.autoSync}),
        getWorkspaceFolder: () => root,
        getFilePath: p => ({path: root.path + p, scheme: 'file'}),
        updateLastSynced: async () => {state.synced++;},
    });
    engine.socket = {
        isConnected: true,
        joinDoc: async id => {
            state.joins++;
            if (state.beforeJoin) state.beforeJoin(id);
            const file = [...remote.values()].find(file => file.id === id);
            return {lines: file.content.toString().split('\n'), version: 1};
        },
        applyOtUpdate: async (id, update) => {
            if (state.fail) throw new Error('Socket emit timeout');
            const [p, file] = [...remote].find(([, file]) => file.id === id);
            let content = file.content.toString();
            for (const op of update.op) {
                if (op.d !== undefined) content = content.slice(0, op.p) + content.slice(op.p + op.d.length);
                if (op.i !== undefined) content = content.slice(0, op.p) + op.i + content.slice(op.p);
            }
            file.content = Buffer.from(content);
            uploads.push(p);
        },
    };
    engine.refreshProjectFileTree = async () => {
        engine.fileTreeByPath.clear();
        for (const [p, file] of remote) engine.fileTreeByPath.set(p, {...file, path: p});
    };
    engine.uploadLocalFile = async (p, content) => {
        uploads.push(p);
        remote.set(p, {id: p, type: 'doc', content});
    };
    engine.replaceRemoteFile = async (entry, content) => {
        uploads.push(entry.path);
        remote.get(entry.path).content = content;
    };
    return {engine, local, remote, uploads, offered, state, vscode, statuses};
}

(async () => {
    {
        const h = harness();
        const result = await h.engine.pushAll();
        assert.equal(result.uploaded, 3);
        assert.equal(result.failed.length, 0);
        assert.deepEqual([...h.offered[0]], ['/fig.png', '/main.tex', '/new/chapter.tex']);
        assert.equal(h.remote.get('/main.tex').content.toString(), 'local 日本語');
        assert.deepEqual([...h.remote.get('/fig.png').content], [255, 0, 1]);
        assert.equal(h.remote.get('/remote-only.tex').content.toString(), 'keep me');
        assert.equal(h.state.synced, 1);
        assert.equal((await h.engine.pushAll()).uploaded, 0);
        assert.equal(h.offered.length, 1, 'no prompt when everything matches');
    }
    {
        const h = harness();
        h.state.selection = () => undefined;
        assert.equal((await h.engine.pushAll()).cancelled, true);
        assert.equal(h.uploads.length, 0);
        h.state.selection = items => items.filter(item => item.path === '/main.tex');
        assert.equal((await h.engine.pushAll()).uploaded, 1);
        assert.deepEqual(h.uploads, ['/main.tex']);
    }
    for (const side of ['local', 'remote']) {
        const h = harness();
        h.state.selection = items => {
            if (side === 'local') h.local.set('/main.tex', Buffer.from('changed after preview'));
            else h.remote.get('/main.tex').content = Buffer.from('collaborator change');
            return items.filter(item => item.path === '/main.tex');
        };
        const result = await h.engine.pushAll();
        assert.equal(result.failed.length, 1);
        assert.equal(result.uploaded, 0, side + ' changed during preview');
    }
    {
        const h = harness();
        h.state.selection = items => items.filter(item => item.path === '/main.tex');
        h.state.fail = true;
        assert.equal((await h.engine.pushAll()).failed.length, 1);
        assert.equal(h.engine.fileCache.has('/main.tex'), false);
        h.state.fail = false;
        assert.equal((await h.engine.pushAll()).uploaded, 1, 'failed contents remain retryable');
        assert.equal(h.engine.syncLock.size, 0);
    }
    {
        const h = harness();
        h.state.selection = items => items.filter(item => item.path === '/main.tex');
        let mainJoins = 0;
        h.state.beforeJoin = id => {
            if (id === 'main' && ++mainJoins === 3) h.remote.get('/main.tex').content = Buffer.from('last-second edit');
        };
        assert.equal((await h.engine.pushAll()).failed.length, 1);
        assert.equal(h.uploads.length, 0, 'recheck remote text at the OT version used for the write');
    }
    {
        const h = harness();
        h.engine.socket.isConnected = false;
        await assert.rejects(h.engine.pushAll(), /Not connected/);
        h.engine.socket.isConnected = true;
        h.vscode.workspace.textDocuments.push({isDirty: true, uri: {scheme: 'file', path: '/project/main.tex'}});
        await assert.rejects(h.engine.pushAll(), /Save \/main.tex/);
        assert.equal(h.engine.manualPushInProgress, false);
        assert.equal(h.uploads.length, 0);
    }
    {
        const h = harness();
        await h.engine.refreshProjectFileTree();
        const uri = {path: '/project/main.tex'};
        await h.engine.handleLocalFileChange(uri);
        assert.equal(h.uploads.length, 0, 'project autoSync=false disables automatic uploads');
        h.state.autoSync = true;
        h.state.configAutoSync = false;
        await h.engine.handleLocalFileChange(uri);
        assert.equal(h.uploads.length, 0, 'VS Code autoSync=false disables automatic uploads');
        assert.equal((await h.engine.pushAll()).uploaded, 3, 'explicit pushes still work when automatic uploads are disabled');
    }
    console.log('PASS: manual text/binary/new-file push, selection/cancel, ignore rules, changed-content checks, retry, and manual-only mode');
})().catch(error => {console.error(error); process.exitCode = 1;});
