const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const local = new Map();
    const remote = new Map();
    const directories = new Set(['/']);
    const operations = [];
    const timers = new Map();
    let timerId = 0;
    const state = {synced: 0, uploads: 0, refreshes: 0, warnings: [], infos: [], warningChoice: undefined, infoChoice: undefined};
    const documents = [];
    const rel = uri => uri.path.slice('/project'.length) || '/';
    const missing = () => {throw new Error('ENOENT');};
    const folderPath = p => p.endsWith('/') ? p : p + '/';
    const readDirectory = async uri => {
        const prefix = folderPath(rel(uri));
        if (!directories.has(prefix)) return missing();
        const children = new Map();
        for (const key of [...directories, ...local.keys()]) {
            if (!key.startsWith(prefix) || key === prefix) continue;
            const tail = key.slice(prefix.length);
            children.set(tail.split('/')[0], tail.includes('/') ? 2 : 1);
        }
        return [...children];
    };
    const vscode = {
        EventEmitter: class {event = () => {}; fire() {}}, FileSystemError: class extends Error {},
        FileType: {File: 1, Directory: 2, SymbolicLink: 64},
        Uri: {joinPath: (uri, name) => ({...uri, path: uri.path.replace(/\/$/, '') + '/' + name})},
        window: {
            showWarningMessage: async message => {state.warnings.push(message); state.onWarning?.(); return state.warningChoice;},
            showInformationMessage: async message => {state.infos.push(message); return state.infoChoice;},
        },
        workspace: {textDocuments: documents, getConfiguration: () => ({get: () => true}), fs: {
            readFile: async uri => local.has(rel(uri)) ? Buffer.from(local.get(rel(uri))) : missing(),
            readDirectory,
            stat: async uri => state.symlink === rel(uri) ? {type: 65} : local.has(rel(uri)) ? {type: 1} : directories.has(folderPath(rel(uri))) ? {type: 2} : missing(),
            createDirectory: async uri => {directories.add(folderPath(rel(uri))); operations.push(['mkdir', rel(uri)]);},
            writeFile: async (uri, data) => {local.set(rel(uri), Buffer.from(data)); operations.push(['write', rel(uri)]); state.onWrite?.(uri);},
            rename: async (from, to, opts) => {
                assert.equal(opts.overwrite, false);
                const old = rel(from), next = rel(to);
                if (local.has(next) || directories.has(folderPath(next))) throw new Error('FileExists');
                for (const [key, bytes] of [...local]) if (key === old || (old.endsWith('/') && key.startsWith(old))) {
                    local.delete(key); local.set(next + key.slice(old.length), bytes);
                }
                for (const key of [...directories]) if (key === old || (old.endsWith('/') && key.startsWith(old))) {
                    directories.delete(key); directories.add(next + key.slice(old.length));
                }
                operations.push(['rename', old, next]);
            },
            delete: async (uri, options) => {
                const p = rel(uri);
                assert.equal(options.recursive, false, 'remote folder deletion must never remove untracked children recursively');
                if (directories.has(p)) {
                    if ((await readDirectory(uri)).length) throw new Error('DirectoryNotEmpty');
                    directories.delete(p);
                } else local.delete(p);
                operations.push(['delete', p]);
            },
        }},
    };
    const api = {
        getFile: async (_project, id) => state.downloadError ? {type: 'error', message: '500 download failed'} : {type: 'success', content: remote.get(id)},
        getDocContent: () => assert.fail('new documents must use the supported real-time API'),
        deleteEntity: async () => {state.uploads++; return {type: 'success'};},
    };
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/sync/syncEngine.js'), 'utf8'), {
        exports, TextEncoder, TextDecoder, Buffer, console: {...console, error() {}},
        setTimeout: (fn, delay) => {const id = ++timerId; timers.set(id, {fn, delay}); return id;},
        clearTimeout: id => timers.delete(id),
        require: name => ({vscode, '../api/socketio': {}, '../consts': {DEBOUNCE_DELAY: 10},
            './ignoreParser': {IgnoreParser: class {async load() {} shouldIgnore(p) {return p.startsWith('/build/');}}},
        })[name],
    });
    const engine = new exports.SyncEngine(api, {
        getSettings: () => ({projectId: 'project', autoSync: true}),
        getWorkspaceFolder: () => ({path: '/project', scheme: 'file'}),
        getFilePath: p => ({path: '/project' + p, scheme: 'file'}),
        updateLastSynced: async () => {state.synced++;},
    });
    engine.socket = {
        isConnected: true, disconnect() {},
        joinDoc: async id => ({lines: remote.get(id).toString().split('\n'), version: 1}),
        applyOtUpdate: async () => {state.uploads++;},
    };
    engine.project = {_id: 'project', rootFolder: [{_id: 'root'}]};
    engine.refreshProjectFileTree = async () => {state.refreshes++;};
    const add = (id, p, type = 'doc', baseline, disk = baseline, parentId = 'root') => {
        const entry = {id, path: p, type, name: p.replace(/\/$/, '').split('/').pop(), parentId};
        engine.fileTree.set(id, entry); engine.fileTreeByPath.set(p, entry);
        if (type === 'folder') directories.add(p);
        if (baseline !== undefined) {engine.baseContent.set(p, Buffer.from(baseline)); remote.set(id, Buffer.from(baseline));}
        if (type !== 'folder' && disk !== undefined) local.set(p, Buffer.from(disk));
        return entry;
    };
    add('root', '/', 'folder');
    const settle = async () => {for (let i = 0; i < 60; i++) await Promise.resolve();};
    const fire = async () => {const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await settle();};
    return {engine, state, local, remote, directories, operations, documents, timers, add, settle, fire};
}

(async () => {
    {
        const h = harness();
        assert.equal(h.engine.acquireLock('/chapters'), true, 'watcher folder paths may omit the trailing slash');
        assert.equal(h.engine.acquireLock('/chapters/'), false);
        assert.equal(h.engine.acquireLock('/chapters/main.tex'), false);
        assert.equal(h.engine.acquireLock('/chapters-other/main.tex'), true);
        h.engine.releaseLock('/chapters');
        assert.equal(h.engine.acquireLock('/chapters/main.tex'), true);
        assert.equal(h.engine.acquireLock('/chapters/'), false);
    }
    {
        const h = harness();
        h.add('new', '/new.tex', 'doc'); h.remote.set('new', Buffer.from('new'));
        h.add('existing', '/existing.tex', 'doc', 'remote', 'local changes');
        h.state.infoChoice = 'Download All New';
        await h.engine.pullAll();
        assert.equal(h.state.refreshes, 1, 'pull must fetch a current tree');
        assert.equal(h.local.get('/new.tex').toString(), 'new');
        assert.equal(h.state.warnings.length, 1, 'download-all-new does not resolve existing conflicts');
        assert.equal(h.local.get('/existing.tex').toString(), 'local changes');
    }
    {
        const h = harness(); h.add('main', '/main.tex', 'doc', 'remote', 'local');
        h.state.warningChoice = 'Remote';
        h.state.onWarning = () => h.local.set('/main.tex', Buffer.from('edit during prompt'));
        await assert.rejects(h.engine.pullAll(), /Local contents changed/);
        assert.equal(h.local.get('/main.tex').toString(), 'edit during prompt');
        assert.equal(h.state.synced, 0);
        assert.equal(h.engine.manualPullInProgress, false);
    }
    {
        const h = harness(); h.add('pdf', '/figure.pdf', 'file', 'old PDF'); h.state.downloadError = true;
        await assert.rejects(h.engine.pullAll(), /500 download failed/);
        assert.equal(h.local.get('/figure.pdf').toString(), 'old PDF');
        assert.equal(h.state.synced, 0);
    }
    {
        const h = harness(); h.add('main', '/main.tex', 'doc', 'old'); h.remote.set('main', Buffer.from('new'));
        h.state.warningChoice = 'Remote';
        h.state.onWrite = uri => {void h.engine.handleLocalFileChange(uri);};
        await h.engine.pullAll(); await h.settle();
        assert.equal(h.state.uploads, 0, 'pull writes do not echo back to Overleaf');
        assert.equal(h.local.get('/main.tex').toString(), 'new');
    }
    for (const unsaved of [false, true]) {
        const h = harness(); h.add('main', '/main.tex', 'doc', 'base', unsaved ? 'base' : 'local edit');
        if (unsaved) h.documents.push({isDirty: true, uri: {path: '/project/main.tex', scheme: 'file'}});
        await h.engine.handleRemoteFileRemoved('main');
        assert.ok(h.local.has('/main.tex'), 'remote deletion preserves both saved local edits and dirty editor buffers');
        assert.equal(h.engine.fileTree.has('main'), false, 'remote tree still records the deletion');
    }
    {
        const h = harness(); h.add('folder', '/chapters/', 'folder', ''); h.add('doc', '/chapters/main.tex', 'doc', 'text', 'text', 'folder');
        await h.engine.handleRemoteFileRenamed('folder', 'renamed');
        assert.equal(h.engine.fileTreeByPath.get('/renamed/main.tex').id, 'doc');
        assert.equal(h.engine.baseContent.get('/renamed/main.tex').toString(), 'text');
        assert.equal(h.engine.fileTreeByPath.has('/chapters/main.tex'), false);
        h.add('dest', '/destination/', 'folder');
        await h.engine.handleRemoteFileMoved('folder', 'dest');
        assert.equal(h.engine.fileTreeByPath.get('/destination/renamed/main.tex').id, 'doc');
        assert.equal(h.local.get('/destination/renamed/main.tex').toString(), 'text');
        await h.engine.handleRemoteFileRemoved('folder');
        assert.equal(h.local.has('/destination/renamed/main.tex'), false);
        assert.equal(h.engine.fileTree.has('doc'), false);
    }
    {
        const h = harness(); h.add('folder', '/chapters/', 'folder', ''); h.add('doc', '/chapters/main.tex', 'doc', 'text', 'text', 'folder');
        h.local.set('/chapters/untracked.txt', Buffer.from('keep'));
        await h.engine.handleRemoteFileRemoved('folder');
        assert.equal(h.local.get('/chapters/untracked.txt').toString(), 'keep');
        assert.equal(h.operations.some(op => op[0] === 'delete'), false);
    }
    {
        const h = harness(); h.add('main', '/main.tex', 'doc', 'old'); h.remote.set('main', Buffer.from('latest'));
        h.engine.syncLock.add('/main.tex');
        await h.engine.handleRemoteFileChanged({doc: 'main', op: [{p: 0, i: 'stale'}]});
        await h.engine.handleRemoteFileChanged({doc: 'main', op: [{p: 0, i: 'duplicate'}]});
        assert.equal(h.timers.size, 1, 'busy remote notifications are coalesced, not dropped');
        h.engine.syncLock.clear(); await h.fire();
        assert.equal(h.local.get('/main.tex').toString(), 'latest');
        await h.engine.handleRemoteFileChanged({doc: 'main', op: [{p: 0, i: 'duplicate'}]});
        assert.equal(h.local.get('/main.tex').toString(), 'latest', 'duplicate OT offsets cannot corrupt a file');
        h.documents.push({isDirty: true, uri: {path: '/project/main.tex', scheme: 'file'}});
        h.remote.set('main', Buffer.from('newer'));
        await h.engine.handleRemoteFileChanged({doc: 'main'});
        assert.equal(h.local.get('/main.tex').toString(), 'latest', 'unsaved editor buffers are preserved');
        h.engine.disconnect();
        await h.engine.handleRemoteFileRemoved('main');
        assert.ok(h.local.has('/main.tex'), 'late callbacks from disposed engines cannot delete files');
    }
    {
        const h = harness(); h.remote.set('new', Buffer.from('new text')); h.state.infoChoice = 'Download';
        await h.engine.handleRemoteFileCreated('root', 'doc', {_id: 'new', name: 'new.tex'});
        assert.equal(h.local.get('/new.tex').toString(), 'new text');
    }
    {
        const h = harness(); h.add('old', '/figure.pdf', 'file', 'old binary');
        h.remote.set('replacement', Buffer.from('new binary'));
        await h.engine.handleRemoteFileCreated('root', 'file', {_id: 'replacement', name: 'figure.pdf'});
        assert.equal(h.local.get('/figure.pdf').toString(), 'new binary', 'a remote replacement is not a local upload echo');
    }
    {
        const h = harness(); h.add('main', '/main.tex', 'doc', 'base');
        await h.engine.handleLocalFileDelete({path: '/project/main.tex', scheme: 'file'});
        assert.equal(h.state.uploads, 0, 'atomic save deletion event does not delete a recreated file');
        h.local.delete('/main.tex'); h.remote.set('main', Buffer.from('collaborator edit'));
        await h.engine.handleLocalFileDelete({path: '/project/main.tex', scheme: 'file'});
        assert.equal(h.state.uploads, 0, 'automatic deletion must not discard collaborator edits');
    }
    {
        const h = harness(); h.add('pdf', '/figure.pdf', 'file', 'Aa', 'BB');
        h.engine.fileCache.set('/figure.pdf', {hash: 2112}); // Aa and BB collide under the old hash.
        h.engine.replaceRemoteFile = async () => {h.state.uploads++;};
        await h.engine.handleLocalFileChange({path: '/project/figure.pdf', scheme: 'file'});
        assert.equal(h.state.uploads, 1, 'equal hashes do not imply equal bytes');
    }
    {
        const h = harness(); h.state.infoChoice = 'Upload All';
        h.engine.uploadLocalFile = async () => {throw new Error('upload failed');};
        await assert.rejects(h.engine.handleLocalOnlyFiles(['/new.tex']), /upload failed/);
    }
    {
        const h = harness(); h.local.set('/new.pdf', Buffer.from('local PDF'));
        h.engine.api.uploadFile = async () => ({type: 'error', message: 'upload failed'});
        await assert.rejects(h.engine.uploadLocalFile('/new.pdf'), /upload failed/);
        assert.equal(h.engine.baseContent.has('/new.pdf'), false, 'failed uploads must not establish a synchronized baseline');
    }
    {
        const h = harness(); h.local.set('/new.tex', Buffer.from('local manuscript'));
        h.remote.set('new-doc', Buffer.from(''));
        h.engine.api.addDoc = async () => ({type: 'success', doc: {_id: 'new-doc', name: 'new.tex'}});
        h.engine.socket.applyOtUpdate = async () => {throw new Error('acknowledgement lost');};
        await h.engine.handleLocalFileCreate({path: '/project/new.tex', scheme: 'file'});
        assert.equal(h.engine.baseContent.has('/new.tex'), false);
        await h.engine.handleRemoteFileCreated('root', 'doc', {_id: 'new-doc', name: 'new.tex'});
        assert.equal(h.local.get('/new.tex').toString(), 'local manuscript', 'an empty create acknowledgement cannot erase an unconfirmed upload');
        assert.equal(h.state.warnings.length, 1);
    }
    {
        const h = harness(); h.local.set('/new.tex', Buffer.from('local manuscript'));
        h.remote.set('new-doc', Buffer.from(''));
        h.engine.manualPullInProgress = true;
        await h.engine.handleRemoteFileCreated('root', 'doc', {_id: 'new-doc', name: 'new.tex'});
        assert.equal(h.local.get('/new.tex').toString(), 'local manuscript');
        assert.equal(h.timers.size, 1, 'create acknowledgements wait for a manual upload to finish');
        h.remote.set('new-doc', Buffer.from('local manuscript'));
        h.engine.baseContent.set('/new.tex', Buffer.from('local manuscript'));
        h.engine.manualPullInProgress = false;
        await h.fire();
        assert.equal(h.state.warnings.length, 0);
        assert.equal(h.local.get('/new.tex').toString(), 'local manuscript');
    }
    {
        const h = harness(); h.add('main', '/main.tex', 'doc', 'old');
        h.state.symlink = '/main.tex';
        await assert.rejects(h.engine.writeLocalSnapshot('/main.tex', Buffer.from('old'), Buffer.from('new')), /symbolic link/);
        assert.equal(h.local.get('/main.tex').toString(), 'old', 'pull must not follow links out of the sync folder');
    }
    {
        const load = (file, mocks) => {
            const exports = {};
            vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out', file), 'utf8'), {
                exports, TextEncoder, TextDecoder, require: name => mocks[name] || require(name),
            });
            return exports;
        };
        const constants = require('../out/consts.js');
        const uri = {path: '/project', scheme: 'file', toString: () => 'file:///project'};
        const vscode = {Uri: {joinPath: (root, ...parts) => ({...root, path: path.posix.join(root.path, ...parts)})},
            workspace: {fs: {readFile: async () => Buffer.from('build/\n')}}};
        const {SettingsManager} = load('utils/settingsManager.js', {vscode, '../consts': constants});
        const settings = SettingsManager.getInstance(uri);
        for (const invalid of ['/../outside.tex', '/nested/../../outside.tex', '/nested\\outside.tex']) {
            assert.throws(() => settings.getFilePath(invalid), /Invalid path/);
        }
        assert.equal(settings.getRelativePath({path: '/project-other/main.tex', scheme: 'file'}), undefined);
        const {IgnoreParser} = load('sync/ignoreParser.js', {vscode, '../consts': constants});
        const ignore = new IgnoreParser(uri);
        await ignore.load();
        assert.equal(ignore.shouldIgnore('/build/nested/main.tex'), true);
        assert.equal(ignore.shouldIgnore('/.localleaf/settings.json'), true);
        assert.equal(ignore.shouldIgnore('/.git/config'), true);
        assert.equal(ignore.shouldIgnore('/sections/main.tex'), false);
    }
    console.log('PASS: conflict isolation, dirty buffers, deletion/move safety, latest document snapshots, pull echoes, and hash collisions');
})().catch(error => {console.error(error); process.exitCode = 1;});
