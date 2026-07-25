import * as assert from 'assert';
import * as path from 'path';

const Module = require('module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = Module._load;

let fetchResponse: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
} = {
    ok: true,
    status: 200,
    json: async () => ({ entity_id: 'binary-id-1', entity_type: 'file' }),
    text: async () => '',
};

class MockEventEmitter {
    readonly event = () => undefined;
    fire(): void {}
}

class MockFileSystemError extends Error {
    code?: string;
}

Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
        return {
            EventEmitter: MockEventEmitter,
            FileSystemError: MockFileSystemError,
            FileType: { File: 1, Directory: 2 },
            workspace: { fs: {} },
        };
    }
    if (request === '../api/socketio') {
        return { SocketIOAPI: class {} };
    }
    if (request === './ignoreParser') {
        return { IgnoreParser: class {} };
    }
    if (request === 'form-data') {
        return class FormData {
            append(): void {}
        };
    }
    if (request === 'mime-types') {
        return { lookup: () => 'application/octet-stream' };
    }
    if (request === 'node-fetch') {
        return {
            __esModule: true,
            default: async () => fetchResponse,
        };
    }
    return originalLoad(request, parent, isMain);
};

async function run(): Promise<void> {
    const { BaseAPI } = require(path.join('..', 'api', 'base')) as {
        BaseAPI: new (url: string) => {
            setIdentity(identity: unknown): void;
            uploadFile(
                projectId: string,
                folderId: string,
                filename: string,
                content: Uint8Array
            ): Promise<unknown>;
            addDoc(projectId: string, folderId: string, filename: string): Promise<unknown>;
        };
    };
    const { SyncEngine } = require(path.join('..', 'sync', 'syncEngine')) as {
        SyncEngine: new (...args: unknown[]) => object;
    };

    const api = new BaseAPI('https://overleaf.example/');
    api.setIdentity({ cookies: 'cookie', csrfToken: 'csrf' });
    const upload = await api.uploadFile(
        'project',
        'folder',
        'figure.pdf',
        Uint8Array.from([1, 2, 3])
    ) as {
        type: string;
        file?: { _id: string; _type: string; name: string };
    };
    assert.equal(upload.type, 'success');
    assert.deepStrictEqual(upload.file, {
        _id: 'binary-id-1',
        _type: 'file',
        name: 'figure.pdf',
    });

    fetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ doc: { _id: 'doc-id-1', name: 'chapter.tex' } }),
        text: async () => '',
    };
    const documentResult = await api.addDoc('project', 'folder', 'chapter.tex') as {
        type: string;
        doc?: { _id: string; _type: string; name: string };
    };
    assert.deepStrictEqual(documentResult.doc, {
        _id: 'doc-id-1',
        _type: 'doc',
        name: 'chapter.tex',
    });

    const propagation = Object.create(SyncEngine.prototype) as any;
    propagation.fileCache = new Map();
    assert.equal(
        propagation.shouldPropagate('push', '/chapter.tex', Uint8Array.from([1])),
        true
    );
    assert.equal(
        propagation.shouldPropagate('push', '/chapter.tex', Uint8Array.from([2])),
        true,
        'different content inside the debounce window must not be discarded'
    );
    assert.equal(
        propagation.shouldPropagate('push', '/chapter.tex', Uint8Array.from([2])),
        false,
        'identical content should still be treated as an echo'
    );

    const textCreation = Object.create(SyncEngine.prototype) as any;
    textCreation.api = {
        addDoc: async () => ({
            type: 'success',
            doc: { _id: 'created-doc', _type: 'doc', name: 'new.tex' },
        }),
    };
    textCreation.fileTree = new Map();
    textCreation.fileTreeByPath = new Map();
    textCreation.baseContent = new Map();
    textCreation.socket = {};
    let pushedDocument: { id: string; path: string; content: Uint8Array } | undefined;
    textCreation.pushDocumentChanges = async (
        id: string,
        filePath: string,
        content: Uint8Array
    ) => {
        pushedDocument = { id, path: filePath, content };
        return true;
    };
    const textContent = new TextEncoder().encode('Thesis content');
    await textCreation.createTextDocumentWithContent(
        'project',
        'folder',
        '/new.tex',
        'new.tex',
        textContent
    );
    assert.equal(textCreation.fileTreeByPath.get('/new.tex').id, 'created-doc');
    assert.deepStrictEqual(pushedDocument, {
        id: 'created-doc',
        path: '/new.tex',
        content: textContent,
    });

    const binaryReplacement = Object.create(SyncEngine.prototype) as any;
    binaryReplacement.settings = {
        getSettings: () => ({ projectId: 'project' }),
    };
    const replacementOperations: string[] = [];
    binaryReplacement.api = {
        renameEntity: async (
            _projectId: string,
            _type: string,
            _id: string,
            name: string
        ) => {
            replacementOperations.push(`rename:${name}`);
            return { type: 'success' };
        },
        uploadFile: async (
            _projectId: string,
            _parentId: string,
            name: string
        ) => {
            replacementOperations.push(`upload:${name}`);
            return {
                type: 'success',
                file: { _id: 'new-binary-id', _type: 'file', name: 'figure.pdf' },
            };
        },
    };
    const oldBinary = {
        id: 'old-binary-id',
        type: 'file',
        name: 'figure.pdf',
        path: '/figure.pdf',
        parentId: 'folder',
    };
    binaryReplacement.fileTree = new Map([[oldBinary.id, oldBinary]]);
    binaryReplacement.fileTreeByPath = new Map([[oldBinary.path, oldBinary]]);
    binaryReplacement.baseContent = new Map();
    binaryReplacement.fileCache = new Map();
    binaryReplacement.suppressedRemoteRenames = new Map();
    binaryReplacement.deleteRemoteEntry = async (entry: { id: string }) => {
        replacementOperations.push(`delete:${entry.id}`);
    };
    binaryReplacement.refreshProjectFileTree = async () => {
        throw new Error('upload response should make a tree refresh unnecessary');
    };
    await binaryReplacement.replaceRemoteFile(
        oldBinary,
        Uint8Array.from([9, 8, 7])
    );
    assert.equal(
        binaryReplacement.fileTreeByPath.get('/figure.pdf').id,
        'new-binary-id'
    );
    assert.equal(replacementOperations[0].startsWith('rename:figure.pdf.localleaf-'), true);
    assert.deepStrictEqual(replacementOperations.slice(1), [
        'upload:figure.pdf',
        'delete:old-binary-id',
    ]);

    const failedReplacement = Object.create(SyncEngine.prototype) as any;
    failedReplacement.settings = {
        getSettings: () => ({ projectId: 'project' }),
    };
    const failedRenameTargets: string[] = [];
    failedReplacement.api = {
        renameEntity: async (
            _projectId: string,
            _type: string,
            _id: string,
            name: string
        ) => {
            failedRenameTargets.push(name);
            return { type: 'success' };
        },
        uploadFile: async () => ({
            type: 'error',
            message: 'simulated upload failure',
        }),
    };
    failedReplacement.fileTree = new Map([[oldBinary.id, oldBinary]]);
    failedReplacement.fileTreeByPath = new Map([[oldBinary.path, oldBinary]]);
    const oldBinaryContent = Uint8Array.from([1, 2, 3]);
    failedReplacement.baseContent = new Map([[oldBinary.path, oldBinaryContent]]);
    failedReplacement.fileCache = new Map();
    failedReplacement.suppressedRemoteRenames = new Map();
    failedReplacement.deleteRemoteEntry = async () => {
        throw new Error('the original must not be deleted after a failed upload');
    };
    await assert.rejects(
        () => failedReplacement.replaceRemoteFile(
            oldBinary,
            Uint8Array.from([9, 8, 7])
        ),
        /simulated upload failure/
    );
    assert.equal(failedRenameTargets.length, 2);
    assert.equal(failedRenameTargets[0].startsWith('figure.pdf.localleaf-'), true);
    assert.equal(failedRenameTargets[1], 'figure.pdf');
    assert.deepStrictEqual(
        failedReplacement.baseContent.get('/figure.pdf'),
        oldBinaryContent
    );

    const acknowledgement = Object.create(SyncEngine.prototype) as any;
    acknowledgement.fileTree = new Map([
        ['root', { id: 'root', type: 'folder', path: '/' }],
    ]);
    acknowledgement.fileTreeByPath = new Map();
    acknowledgement.shouldSync = () => true;
    acknowledgement.acquireLock = () => false;
    const originalSetTimeout = global.setTimeout;
    let retryScheduled = false;
    global.setTimeout = (() => {
        retryScheduled = true;
        return 1;
    }) as unknown as typeof setTimeout;
    await acknowledgement.handleRemoteFileCreated(
        'root',
        'file',
        { _id: 'socket-id-1', name: 'photo.jpg' }
    );
    global.setTimeout = originalSetTimeout;
    assert.equal(acknowledgement.fileTreeByPath.get('/photo.jpg').id, 'socket-id-1');
    assert.equal(retryScheduled, true);

    const localCreate = Object.create(SyncEngine.prototype) as any;
    localCreate.getRelativePath = () => '/new.tex';
    localCreate.shouldSync = () => true;
    localCreate.acquireLock = () => false;
    retryScheduled = false;
    global.setTimeout = (() => {
        retryScheduled = true;
        return 1;
    }) as unknown as typeof setTimeout;
    await localCreate.handleLocalFileCreate({});
    global.setTimeout = originalSetTimeout;
    assert.equal(retryScheduled, true, 'locked local create events must be retried');

    const cleanup = Object.create(SyncEngine.prototype) as any;
    const ignored = {
        id: 'aux-id',
        type: 'file',
        path: '/thesis.aux',
        name: 'thesis.aux',
    };
    const kept = {
        id: 'tex-id',
        type: 'doc',
        path: '/thesis.tex',
        name: 'thesis.tex',
    };
    const ignoredFolder = {
        id: 'folder-id',
        type: 'folder',
        path: '/build/',
        name: 'build',
    };
    cleanup.fileTree = new Map([
        [ignored.id, ignored],
        [kept.id, kept],
        [ignoredFolder.id, ignoredFolder],
    ]);
    cleanup.fileTreeByPath = new Map([
        [ignored.path, ignored],
        [kept.path, kept],
        [ignoredFolder.path, ignoredFolder],
    ]);
    cleanup.baseContent = new Map();
    cleanup.fileCache = new Map();
    cleanup.ignoreParser = {
        load: async () => undefined,
        shouldIgnore: (candidate: string) =>
            candidate.endsWith('.aux') || candidate.startsWith('/build/'),
    };
    cleanup.refreshProjectFileTree = async () => undefined;
    cleanup.setStatus = () => undefined;
    cleanup.log = () => undefined;
    const deleted: string[] = [];
    cleanup.deleteRemoteEntry = async (entry: { id: string; path: string }) => {
        deleted.push(entry.path);
        cleanup.fileTree.delete(entry.id);
        cleanup.fileTreeByPath.delete(entry.path);
    };

    const ignoredRemote = await cleanup.getIgnoredRemoteFiles();
    assert.deepStrictEqual(ignoredRemote, ['/thesis.aux']);
    const cleanupResult = await cleanup.deleteIgnoredRemoteFiles(ignoredRemote);
    assert.deepStrictEqual(cleanupResult, { deleted: 1, failed: [] });
    assert.deepStrictEqual(deleted, ['/thesis.aux']);
    assert.equal(cleanup.fileTreeByPath.has('/thesis.tex'), true);

    Module._load = originalLoad;
    console.log('LocalLeaf synchronization regression tests passed.');
}

run().catch(error => {
    Module._load = originalLoad;
    console.error(error);
    process.exitCode = 1;
});
