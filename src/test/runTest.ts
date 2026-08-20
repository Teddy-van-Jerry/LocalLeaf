import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const Module = require('module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = Module._load;

function readInstalledPackageVersion(...packagePath: string[]): string {
    const packageJson = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'node_modules', ...packagePath, 'package.json'),
        'utf8',
    )) as { version?: string };
    assert.equal(typeof packageJson.version, 'string');
    return packageJson.version as string;
}

async function verifyWebSocketCompatibility(): Promise<void> {
    const WebSocket = require('ws') as any;

    await new Promise<void>((resolve, reject) => {
        const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
        let client: any;
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;

        const finish = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            client?.terminate();
            for (const connection of server.clients) {
                connection.terminate();
            }
            server.close(() => error ? reject(error) : resolve());
        };

        timeout = setTimeout(() => finish(new Error('WebSocket smoke test timed out')), 5000);

        server.once('error', (error: Error) => finish(error));
        server.once('connection', (connection: any, request: any) => {
            try {
                assert.equal(request.headers.cookie, 'localleaf-test=1');
            } catch (error) {
                finish(error as Error);
                return;
            }
            connection.once('message', (message: unknown) => connection.send(message));
        });
        server.once('listening', () => {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
                headers: { Cookie: 'localleaf-test=1' },
            });
            client.onopen = () => client.send('localleaf-ws-smoke');
            client.onmessage = (event: { data: unknown }) => {
                try {
                    assert.equal(String(event.data), 'localleaf-ws-smoke');
                    finish();
                } catch (error) {
                    finish(error as Error);
                }
            };
            client.onerror = () => finish(new Error('WebSocket client connection failed'));
        });
    });
}

let fetchResponse: {
    ok: boolean;
    status: number;
    statusText?: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    buffer?: () => Promise<Buffer>;
    headers?: {
        get(name: string): string | null;
        raw?(): Record<string, string[]>;
    };
    body?: { once(event: string, listener: () => void): void; resume?(): void };
} = {
    ok: true,
    status: 200,
    json: async () => ({ entity_id: 'binary-id-1', entity_type: 'file' }),
    text: async () => '',
};
let fetchImplementation = async (_url?: unknown, _options?: unknown): Promise<typeof fetchResponse> => fetchResponse;

let executeCommandImpl: (...args: unknown[]) => Promise<unknown> = async () => undefined;

interface MockUri {
    scheme: string;
    authority?: string;
    path: string;
    fsPath: string;
    toString(): string;
}

interface MockFileEntry {
    type: number;
    content?: string;
}

let mockWorkspaceFolders: Array<{ uri: MockUri }> | undefined;
let mockFileEntries = new Map<string, MockFileEntry>();

function mockFileUri(fsPath: string): MockUri {
    const normalizedFsPath = path.win32.normalize(fsPath);
    const uriPath = `/${normalizedFsPath.replace(/\\/g, '/')}`;
    return {
        scheme: 'file',
        authority: '',
        path: uriPath,
        fsPath: normalizedFsPath,
        toString: () => `file://${uriPath}`,
    };
}

function mockUriKey(uri: MockUri | string): string {
    return path.win32.normalize(typeof uri === 'string' ? uri : uri.fsPath);
}

function resetMockWorkspace(
    folders?: MockUri[],
    entries: Array<[string, MockFileEntry]> = [],
): void {
    mockWorkspaceFolders = folders?.map(uri => ({ uri }));
    mockFileEntries = new Map(entries.map(([entryPath, entry]) => [
        path.win32.normalize(entryPath),
        entry,
    ]));
}

const mockWorkspaceFs = {
    async readFile(uri: MockUri | string): Promise<Uint8Array> {
        const entry = mockFileEntries.get(mockUriKey(uri));
        if (!entry || entry.type !== 1) throw new MockFileSystemError('File not found');
        return new TextEncoder().encode(entry.content ?? '');
    },
    async stat(uri: MockUri | string): Promise<{ type: number }> {
        const entry = mockFileEntries.get(mockUriKey(uri));
        if (!entry) throw new MockFileSystemError('File not found');
        return { type: entry.type };
    },
    async readDirectory(uri: MockUri | string): Promise<Array<[string, number]>> {
        const directoryPath = mockUriKey(uri);
        const directory = mockFileEntries.get(directoryPath);
        if (!directory || directory.type !== 2) throw new MockFileSystemError('Directory not found');
        const children: Array<[string, number]> = [];
        for (const [entryPath, entry] of mockFileEntries) {
            if (entryPath !== directoryPath && path.win32.dirname(entryPath) === directoryPath) {
                children.push([path.win32.basename(entryPath), entry.type]);
            }
        }
        return children;
    },
    async createDirectory(): Promise<void> {},
    async writeFile(): Promise<void> {},
    async delete(): Promise<void> {},
};

class MockEventEmitter {
    readonly event = () => undefined;
    fire(): void {}
    dispose(): void {}
}

class MockFileSystemError extends Error {
    code?: string;
}

Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
        return {
            EventEmitter: MockEventEmitter,
            FileSystemError: MockFileSystemError,
            FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
            Uri: {
                joinPath: (
                    base: MockUri | string,
                    ...segments: string[]
                ): MockUri | string => typeof base === 'string'
                    ? [base, ...segments].join('/')
                    : mockFileUri(path.win32.join(base.fsPath, ...segments)),
                from: (components: { scheme: string; path: string }): MockUri => ({
                    scheme: components.scheme,
                    path: components.path,
                    fsPath: components.path,
                    toString: () => `${components.scheme}:${components.path}`,
                }),
            },
            commands: {
                executeCommand: (...args: unknown[]) => executeCommandImpl(...args),
            },
            workspace: {
                get workspaceFolders() { return mockWorkspaceFolders; },
                fs: mockWorkspaceFs,
            },
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
            default: (url?: unknown, options?: unknown) => fetchImplementation(url, options),
        };
    }
    return originalLoad(request, parent, isMain);
};

async function run(): Promise<void> {
    const { BaseAPI } = require(path.join('..', 'api', 'base')) as {
        BaseAPI: new (url: string) => {
            setIdentity(identity: unknown): void;
            dispose(): void;
            uploadFile(
                projectId: string,
                folderId: string,
                filename: string,
                content: Uint8Array
            ): Promise<unknown>;
            addDoc(projectId: string, folderId: string, filename: string): Promise<unknown>;
            getFile(projectId: string, fileId: string): Promise<unknown>;
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
    await assert.rejects(
        () => api.addDoc('project', 'folder', '../outside.tex'),
        /Unsafe Overleaf entity name/,
        'entity names must be validated again at the HTTP boundary',
    );
    await assert.rejects(
        () => (api as any).deleteEntity('project', '../../logout', 'entity'),
        /entity type/,
    );

    const rangeHeaders: Array<string | undefined> = [];
    const downloadUrls: string[] = [];
    const partialResponses = [
        { range: 'bytes 0-1/4', bytes: [1, 2] },
        { range: 'bytes 2-3/4', bytes: [3, 4] },
    ];
    fetchImplementation = async (url, options) => {
        downloadUrls.push(String(url));
        const request = options as { headers?: Record<string, string> };
        rangeHeaders.push(request.headers?.Range);
        const partial = partialResponses.shift();
        assert.ok(partial, 'partial download requested too many chunks');
        return {
            ok: true,
            status: 206,
            json: async () => ({}),
            text: async () => '',
            buffer: async () => Buffer.from(partial.bytes),
            headers: { get: name => name.toLowerCase() === 'content-range' ? partial.range : null },
        };
    };
    const partialDownload = await api.getFile('project/../../other', 'partial?file') as {
        type: string;
        content?: Uint8Array;
    };
    assert.equal(partialDownload.type, 'success');
    assert.deepStrictEqual([...partialDownload.content!], [1, 2, 3, 4]);
    assert.deepStrictEqual(rangeHeaders, [undefined, 'bytes=2-']);
    assert.ok(
        downloadUrls.every(url => url.includes('project/project%2F..%2F..%2Fother/file/partial%3Ffile')),
        'opaque IDs must remain encoded inside their URL segments',
    );

    fetchImplementation = async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({}),
        text: async () => 'Forbidden',
        buffer: async () => Buffer.alloc(0),
        headers: { get: () => null },
    });
    const deniedDownload = await api.getFile('project', 'denied-file') as {
        type: string;
        authError?: string;
        content?: Uint8Array;
    };
    assert.equal(deniedDownload.type, 'error');
    assert.equal(deniedDownload.authError, 'session_expired');
    assert.equal(deniedDownload.content, undefined, 'HTTP errors must never become empty successful files');
    fetchImplementation = async () => fetchResponse;
    api.dispose();

    const propagation = Object.create(SyncEngine.prototype) as any;
    propagation.fileCache = new Map();
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([1])),
        true
    );
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([2])),
        true,
        'different content inside the debounce window must not be discarded'
    );
    assert.equal(
        propagation.shouldPropagate('/chapter.tex', Uint8Array.from([2])),
        false,
        'identical content should still be treated as an echo'
    );
    assert.equal(
        propagation.shouldPropagate('/binary.dat', Uint8Array.from([0xff])),
        true,
    );
    assert.equal(
        propagation.shouldPropagate('/binary.dat', Uint8Array.from([0xfe])),
        true,
        'different invalid UTF-8 byte sequences must not collide in the synchronization cache',
    );

    assert.deepEqual(
        propagation.calculateOps('hello world', 'hello brave world'),
        [{ p: 6, i: 'brave ' }],
        'OT updates should insert only the changed range',
    );
    assert.deepEqual(
        propagation.calculateOps('abcXYZdef', 'abc123def'),
        [{ p: 3, d: 'XYZ' }, { p: 3, i: '123' }],
        'OT updates should retain the common prefix and suffix',
    );
    assert.deepEqual(
        propagation.calculateOps('unchanged', 'unchanged'),
        [],
        'unchanged documents should not generate operations',
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

    const folderRebase = Object.create(SyncEngine.prototype) as any;
    const folderEntry = { id: 'folder', type: 'folder', name: 'old', path: '/old/' };
    const childEntry = { id: 'child', type: 'doc', name: 'child.tex', path: '/old/child.tex' };
    const nestedEntry = { id: 'nested', type: 'file', name: 'image.png', path: '/old/assets/image.png' };
    folderRebase.fileTree = new Map([
        [folderEntry.id, folderEntry],
        [childEntry.id, childEntry],
        [nestedEntry.id, nestedEntry],
    ]);
    folderRebase.fileTreeByPath = new Map([
        [folderEntry.path, folderEntry],
        [childEntry.path, childEntry],
        [nestedEntry.path, nestedEntry],
    ]);
    folderRebase.baseContent = new Map([[childEntry.path, Uint8Array.from([1])]]);
    folderRebase.fileCache = new Map([[nestedEntry.path, 'hash']]);
    folderRebase.rebaseFileTree('/old/', '/renamed/');
    assert.equal(childEntry.path, '/renamed/child.tex');
    assert.equal(nestedEntry.path, '/renamed/assets/image.png');
    assert.ok(folderRebase.fileTreeByPath.has('/renamed/child.tex'));
    assert.ok(folderRebase.baseContent.has('/renamed/child.tex'));
    assert.ok(folderRebase.fileCache.has('/renamed/assets/image.png'));
    assert.equal(folderRebase.fileTreeByPath.has('/old/child.tex'), false);

    const subtreeRemoval = Object.create(SyncEngine.prototype) as any;
    const subtreeFolder = { id: 'folder', type: 'folder', name: 'folder', path: '/folder/' };
    const subtreeChild = { id: 'child', type: 'doc', name: 'child.tex', path: '/folder/child.tex' };
    subtreeRemoval.fileTree = new Map([['folder', subtreeFolder], ['child', subtreeChild]]);
    subtreeRemoval.fileTreeByPath = new Map([
        ['/folder/', subtreeFolder],
        ['/folder/child.tex', subtreeChild],
    ]);
    subtreeRemoval.baseContent = new Map([
        ['/folder/', new Uint8Array()],
        ['/folder/child.tex', Uint8Array.from([1])],
    ]);
    subtreeRemoval.fileCache = new Map([['/folder/child.tex', 'hash']]);
    subtreeRemoval.joinedDocs = new Set(['child']);
    subtreeRemoval.removeTrackedSubtree('/folder/');
    assert.equal(subtreeRemoval.fileTree.size, 0, 'folder removal must clear every descendant identity');
    assert.equal(subtreeRemoval.fileTreeByPath.size, 0);
    assert.equal(subtreeRemoval.baseContent.size, 0);
    assert.equal(subtreeRemoval.fileCache.size, 0);
    assert.equal(subtreeRemoval.joinedDocs.size, 0);

    const acknowledgement = Object.create(SyncEngine.prototype) as any;
    acknowledgement.fileTree = new Map([
        ['root', { id: 'root', type: 'folder', path: '/' }],
    ]);
    acknowledgement.fileTreeByPath = new Map();
    acknowledgement.shouldSync = () => true;
    acknowledgement.acquireLockWhenAvailable = async () => false;
    await acknowledgement.handleRemoteFileCreated(
        'root',
        'file',
        { _id: 'socket-id-1', name: 'photo.jpg' }
    );
    assert.equal(acknowledgement.fileTreeByPath.get('/photo.jpg').id, 'socket-id-1');

    const localCreate = Object.create(SyncEngine.prototype) as any;
    localCreate.disposed = false;
    localCreate.getRelativePath = () => '/new.tex';
    localCreate.shouldSync = () => true;
    let waitedForLock = false;
    localCreate.acquireLockWhenAvailable = async () => {
        waitedForLock = true;
        return false;
    };
    await localCreate.handleLocalFileCreate({});
    assert.equal(waitedForLock, true, 'locked local create events must wait instead of being discarded');

    const orderedRemoteEvents = Object.create(SyncEngine.prototype) as any;
    orderedRemoteEvents.disposed = false;
    orderedRemoteEvents.remoteEventQueue = Promise.resolve();
    const eventOrder: string[] = [];
    let releaseFirstEvent: (() => void) | undefined;
    orderedRemoteEvents.enqueueRemoteEvent(async () => {
        eventOrder.push('first-start');
        await new Promise<void>(resolve => { releaseFirstEvent = resolve; });
        eventOrder.push('first-end');
    });
    orderedRemoteEvents.enqueueRemoteEvent(async () => { eventOrder.push('second'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(eventOrder, ['first-start']);
    releaseFirstEvent?.();
    await orderedRemoteEvents.remoteEventQueue;
    assert.deepStrictEqual(eventOrder, ['first-start', 'first-end', 'second']);

    const ownDocumentEcho = Object.create(SyncEngine.prototype) as any;
    ownDocumentEcho.socket = { publicId: 'this-client' };
    ownDocumentEcho.suppressedRemoteDocumentUpdates = new Map();
    ownDocumentEcho.fileTree = new Map();
    await ownDocumentEcho.handleRemoteFileChanged({
        doc: 'doc',
        v: 1,
        op: [{ p: 0, i: 'content' }],
        meta: { source: 'this-client', ts: Date.now(), user_id: 'user' },
    });

    const remoteOt = Object.create(SyncEngine.prototype) as any;
    const remoteOtUri = mockFileUri('D:\\ot-workspace\\chapter.tex');
    resetMockWorkspace([mockFileUri('D:\\ot-workspace')], [
        ['D:\\ot-workspace', { type: 2 }],
        ['D:\\ot-workspace\\chapter.tex', { type: 1, content: 'local edit' }],
    ]);
    remoteOt.disposed = false;
    remoteOt.socket = { publicId: 'this-client' };
    remoteOt.suppressedRemoteDocumentUpdates = new Map();
    remoteOt.fileTree = new Map([[
        'doc',
        { id: 'doc', type: 'doc', name: 'chapter.tex', path: '/chapter.tex' },
    ]]);
    remoteOt.baseContent = new Map([[
        '/chapter.tex',
        new TextEncoder().encode('server'),
    ]]);
    remoteOt.fileCache = new Map();
    remoteOt.settings = {
        getFilePath: () => remoteOtUri,
        getSettings: () => ({ projectId: 'project' }),
    };
    remoteOt.api = {};
    remoteOt.shouldSync = () => true;
    remoteOt.acquireLockWhenAvailable = async () => true;
    remoteOt.releaseLock = () => undefined;
    remoteOt.assertNoSymbolicLinks = async () => undefined;
    remoteOt.askConflictResolution = async () => 'skip';
    remoteOt.setStatus = () => undefined;
    await remoteOt.handleRemoteFileChanged({
        doc: 'doc',
        v: 2,
        op: [{ p: 6, i: '!' }],
        meta: { source: 'other-client', ts: Date.now(), user_id: 'other' },
    });
    assert.equal(
        new TextDecoder().decode(remoteOt.baseContent.get('/chapter.tex')),
        'server!',
        'remote operations must be applied to the known server base, not an unsaved local edit',
    );

    const protectedPaths = Object.create(SyncEngine.prototype) as any;
    protectedPaths.ignoreParser = { shouldIgnore: () => false };
    assert.equal(protectedPaths.shouldSync('/.git/config'), false);
    assert.equal(protectedPaths.shouldSync('/.vscode/settings.json'), false);
    assert.equal(protectedPaths.shouldSync('/.localleaf/settings.json'), false);
    assert.equal(protectedPaths.shouldSync('/chapter.tex'), true);

    const cancellableLock = Object.create(SyncEngine.prototype) as any;
    cancellableLock.disposed = false;
    cancellableLock.syncLock = new Set(['/busy.tex']);
    cancellableLock.pendingWaits = new Map();
    cancellableLock.disposables = [];
    cancellableLock.api = { dispose: () => undefined };
    cancellableLock._onStatusChange = new MockEventEmitter();
    cancellableLock.suppressedRemoteDeletes = new Set();
    cancellableLock.suppressedRemoteRenames = new Map();
    cancellableLock.suppressedRemoteDocumentUpdates = new Map();
    cancellableLock.remoteDiffContents = new Map();
    cancellableLock.fileTree = new Map();
    cancellableLock.fileTreeByPath = new Map();
    cancellableLock.fileCache = new Map();
    cancellableLock.baseContent = new Map();
    cancellableLock.joinedDocs = new Set();
    const pendingLock = cancellableLock.acquireLockWhenAvailable('/busy.tex');
    cancellableLock.disconnect();
    assert.equal(await pendingLock, false, 'disconnect must cancel lock waits immediately');

    const rootDeletion = Object.create(SyncEngine.prototype) as any;
    rootDeletion.suppressedRemoteDeletes = new Set();
    rootDeletion.fileTree = new Map([['root', { id: 'root', type: 'folder', path: '/' }]]);
    await assert.rejects(
        () => rootDeletion.handleRemoteFileRemoved('root'),
        /project root/,
    );

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

    const selfHostedRefresh = Object.create(SyncEngine.prototype) as any;
    const liveEntry = {
        id: 'live-id',
        type: 'file',
        path: '/thesis.aux',
        name: 'thesis.aux',
    };
    selfHostedRefresh.settings = { getSettings: () => ({ projectId: 'project' }) };
    selfHostedRefresh.api = {
        getProjectDetails: async () => ({
            type: 'success',
            projectData: { projectId: 'project' },
        }),
    };
    selfHostedRefresh.fileTree = new Map([[liveEntry.id, liveEntry]]);
    selfHostedRefresh.fileTreeByPath = new Map([[liveEntry.path, liveEntry]]);
    await selfHostedRefresh.refreshProjectFileTree();
    assert.equal(selfHostedRefresh.fileTreeByPath.get(liveEntry.path), liveEntry,
        'a self-hosted server without HTTP folder metadata must retain the live Socket.IO tree');

    const unavailableRefresh = Object.create(SyncEngine.prototype) as any;
    unavailableRefresh.settings = selfHostedRefresh.settings;
    unavailableRefresh.api = selfHostedRefresh.api;
    unavailableRefresh.fileTree = new Map();
    unavailableRefresh.fileTreeByPath = new Map();
    await assert.rejects(
        () => unavailableRefresh.refreshProjectFileTree(),
        /Overleaf returned no folder tree/,
        'missing HTTP metadata must still fail when no live project tree is available',
    );

    const viewsDirectory = path.join(__dirname, '..', 'views');
    const webviewFiles = [
        'projectsWebviewProvider.js',
        'mainWebviewProvider.js',
        'accountPanel.js',
    ];
    for (const filename of webviewFiles) {
        const source = fs.readFileSync(path.join(viewsDirectory, filename), 'utf8');
        assert.match(source, /Content-Security-Policy/, `${filename} must define a CSP`);
        assert.match(source, /script-src 'nonce-\$\{nonce\}'/, `${filename} must use a script nonce`);
        assert.doesNotMatch(source, /enableCommandUris/, `${filename} must not enable command URIs`);
        assert.doesNotMatch(source, /\.innerHTML\s*=/, `${filename} must render untrusted data with DOM APIs`);
    }

    const mockWebview = {
        cspSource: 'vscode-webview-test:',
        asWebviewUri: () => 'vscode-webview-test:/icon.svg',
    };
    const { ProjectsWebviewProvider } = require(path.join('..', 'views', 'projectsWebviewProvider')) as {
        ProjectsWebviewProvider: any;
    };
    const projectsProvider = Object.create(ProjectsWebviewProvider.prototype) as any;
    projectsProvider.extensionUri = 'extension';
    const projectsHtml = projectsProvider.getHtml(mockWebview);
    assert.match(projectsHtml, /split\(\/\\s\+\/\)/, 'project initials must split on whitespace');
    assert.match(projectsHtml, /openLocalProject/, 'detected local projects must be openable from the panel');
    assert.match(projectsHtml, /ArrowDown/, 'project lists must support keyboard navigation');
    assert.match(projectsHtml, /aria-label', 'Detected LocalLeaf projects'/,
        'the detected-project list must have an accessible name');
    assert.match(projectsHtml, /state\.workspaceKind === 'invalid-config'/,
        'invalid LocalLeaf configuration must have a dedicated warning state');

    let finishOpenProject: (() => void) | undefined;
    let openProjectCalls = 0;
    executeCommandImpl = async () => {
        openProjectCalls++;
        await new Promise<void>(resolve => { finishOpenProject = resolve; });
    };
    const project = { id: 'project-id', name: 'Project' };
    projectsProvider.projects = [project];
    projectsProvider.state = { status: 'ready', projects: [project] };
    const firstOpen = projectsProvider.handleMessage({ type: 'openProject', projectId: project.id });
    const duplicateOpen = projectsProvider.handleMessage({ type: 'openProject', projectId: project.id });
    await Promise.resolve();
    assert.equal(openProjectCalls, 1, 'the projects view must suppress duplicate link actions');
    finishOpenProject?.();
    await Promise.all([firstOpen, duplicateOpen]);
    assert.equal(projectsProvider.state.openingProjectId, undefined, 'the project action must unlock after completion');
    executeCommandImpl = async () => undefined;

    const { MainWebviewProvider, statusDescription, shouldShowChangesTab } = require(
        path.join('..', 'views', 'mainWebviewProvider')
    ) as {
        MainWebviewProvider: any;
        statusDescription(status: string): string;
        shouldShowChangesTab(syncMode: 'realtime' | 'manual'): boolean;
    };
    const mainProvider = Object.create(MainWebviewProvider.prototype) as any;
    mainProvider.extensionUri = 'extension';
    const mainHtml = mainProvider.getHtml(mockWebview);
    assert.match(mainHtml, /split\(\/\\s\+\/\)/, 'collaborator initials must split on whitespace');
    assert.match(mainHtml, /role="tablist"/, 'main navigation must expose ARIA tab semantics');
    assert.match(mainHtml, /ArrowRight/, 'main tabs must support keyboard navigation');
    assert.match(mainHtml, /aria-modal', 'true'/, 'dangerous actions must use an accessible modal dialog');
    assert.match(mainHtml, /event\.key === 'Escape'/, 'confirmation dialogs must support Escape');
    assert.equal(shouldShowChangesTab('realtime'), false,
        'the placeholder Changes tab must stay hidden during real-time synchronization');
    assert.equal(shouldShowChangesTab('manual'), true,
        'manual synchronization can expose the Changes surface later');
    assert.deepStrictEqual(
        ['disconnected', 'connecting', 'idle', 'syncing', 'pulling', 'pushing', 'error']
            .map(status => statusDescription(status)),
        [
            'Disconnected',
            'Connecting\u2026',
            'Up to date',
            'Synchronizing\u2026',
            'Pulling from Overleaf\u2026',
            'Pushing to Overleaf\u2026',
            'Synchronization error',
        ],
        'every synchronization state must have user-facing text',
    );

    const noticeProvider = Object.create(MainWebviewProvider.prototype) as any;
    noticeProvider.syncStatus = 'idle';
    noticeProvider.onlineUsers = [];
    noticeProvider.state = {
        linked: true,
        syncStatus: 'idle',
        statusText: 'Up to date',
        syncMode: 'realtime',
        showChanges: false,
        details: [],
        onlineUsers: [],
        signedIn: true,
        mainDocumentSelected: true,
    };
    noticeProvider.setSyncStatus('connecting', 'Connecting to Overleaf...');
    assert.deepStrictEqual(noticeProvider.state.notice, {
        kind: 'info',
        message: 'Connecting to Overleaf...',
    });
    noticeProvider.setSyncStatus('error', 'Connection failed');
    assert.equal(noticeProvider.state.notice.actionLabel, 'Retry sync',
        'authenticated sync failures should offer a retry instead of an unrelated login action');

    const confirmedCommands: string[] = [];
    const confirmedCommandProvider = new MainWebviewProvider(
        'extension',
        {},
        async (command: string) => { confirmedCommands.push(command); },
    ) as any;
    await confirmedCommandProvider.handleMessage({
        type: 'runConfirmedCommand',
        command: 'localleaf.cleanIgnoredRemoteFiles',
    });
    await confirmedCommandProvider.handleMessage({
        type: 'runConfirmedCommand',
        command: 'localleaf.syncNow',
    });
    assert.deepStrictEqual(confirmedCommands, ['localleaf.cleanIgnoredRemoteFiles'],
        'only explicitly dangerous panel actions may use the panel-confirmed path');

    let postedStates = 0;
    mainProvider.onlineUsers = [];
    mainProvider.state = {
        linked: true,
        syncStatus: 'idle',
        statusText: 'Up to date',
        details: [],
        onlineUsers: [],
    };
    mainProvider.view = {
        webview: {
            postMessage: async () => {
                postedStates++;
                return true;
            },
        },
    };
    mainProvider.setOnlineUsers([]);
    assert.equal(postedStates, 0, 'an unchanged collaborator list must not refresh the webview');
    const onlineUser = { clientId: 'client', name: 'User', color: '#123456', docPath: '/main.tex', row: 4 };
    mainProvider.setOnlineUsers([onlineUser]);
    mainProvider.setOnlineUsers([{ ...onlineUser }]);
    assert.equal(postedStates, 1, 'equivalent collaborator updates must be coalesced');

    let finishStateBuild: (() => void) | undefined;
    let stateBuilds = 0;
    const refreshProvider = Object.create(MainWebviewProvider.prototype) as any;
    refreshProvider.buildState = async () => {
        stateBuilds++;
        await new Promise<void>(resolve => { finishStateBuild = resolve; });
        return {
            linked: true,
            syncStatus: 'idle',
            statusText: 'Up to date',
            details: [],
            onlineUsers: [],
        };
    };
    const firstRefresh = refreshProvider.refresh();
    const duplicateRefresh = refreshProvider.refresh();
    await Promise.resolve();
    assert.equal(stateBuilds, 1, 'overlapping full refreshes must share one state build');
    finishStateBuild?.();
    await Promise.all([firstRefresh, duplicateRefresh]);

    const accountSource = fs.readFileSync(path.join(viewsDirectory, 'accountPanel.js'), 'utf8');
    const cookieHandler = accountSource.indexOf("loginCookies.addEventListener('click'");
    const cookieClear = accountSource.indexOf("cookies.value = ''", cookieHandler);
    const cookiePost = accountSource.indexOf("vscode.postMessage({ type: 'loginCookies'", cookieHandler);
    assert.ok(cookieHandler >= 0 && cookieClear > cookieHandler && cookieClear < cookiePost,
        'session cookies must be removed from the DOM before the login message is posted');

    const extensionSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'extension.ts'),
        'utf8',
    );
    const cookieLoginStart = extensionSource.indexOf('async function loginWithCookies');
    const cookieLoginEnd = extensionSource.indexOf('// === Command Implementations ===', cookieLoginStart);
    const cookieLoginSource = extensionSource.slice(cookieLoginStart, cookieLoginEnd);
    const insecureWarning = extensionSource.indexOf('async function confirmInsecureServer');
    const cookieApiCreation = cookieLoginSource.indexOf('new BaseAPI');
    assert.ok(cookieLoginStart >= 0 && cookieLoginEnd > cookieLoginStart);
    assert.match(cookieLoginSource, /validateServerUrl\(serverUrl\)/);
    assert.match(cookieLoginSource, /await confirmInsecureServer/);
    assert.match(extensionSource.slice(insecureWarning, cookieLoginStart), /modal:\s*true/);
    assert.ok(insecureWarning >= 0 && cookieApiCreation >= 0,
        'HTTP cookie login must require a modal warning before any API request');
    assert.match(extensionSource, /if \(await loginWithCookies[\s\S]*await reconnectAfterLogin\(\)/,
        'cancelling the HTTP warning must also skip reconnecting');
    assert.doesNotMatch(extensionSource, /serverUrl\.includes\(['"]overleaf\.com/,
        'official Overleaf detection must use the parsed hostname, not a substring');
    assert.match(extensionSource, /async function cmdRefreshCookie[\s\S]*loginWithCookies\(serverUrl, cookies\)/,
        'cookie refresh must use the same URL and HTTP safety policy as login');
    assert.match(extensionSource, /handleWorkspaceFoldersChanged[\s\S]*disposeCurrentSyncSession\(\)[\s\S]*initializeSync/,
        'workspace-folder changes must replace the active synchronization session');

    const projectsSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'views', 'projectsWebviewProvider.ts'),
        'utf8',
    );
    assert.match(projectsSource, /Preparing synchronization\.\.\./);
    assert.doesNotMatch(projectsSource, /Ã|â€¦/,
        'project loading text must not contain mojibake');

    const { LinkOperationGate, shouldConfirmProjectLink } = require(
        path.join('..', 'utils', 'linkSafety')
    ) as {
        LinkOperationGate: new () => { tryEnter(): boolean; leave(): void; isActive: boolean };
        shouldConfirmProjectLink(entryNames: readonly string[]): boolean;
    };
    const linkGate = new LinkOperationGate();
    assert.equal(linkGate.tryEnter(), true);
    assert.equal(linkGate.tryEnter(), false, 'a concurrent project link must be rejected');
    linkGate.leave();
    assert.equal(linkGate.tryEnter(), true, 'the project link gate must release in a finally block');
    assert.equal(shouldConfirmProjectLink(['.localleaf', '.leafignore']), false);
    assert.equal(shouldConfirmProjectLink(['.localleaf', 'chapter.tex']), true,
        'folders containing user files must require confirmation');

    const { createNonce } = require(path.join('..', 'views', 'webviewUtils')) as {
        createNonce(): string;
    };
    const firstNonce = createNonce();
    const secondNonce = createNonce();
    assert.match(firstNonce, /^[0-9a-f]{32}$/);
    assert.notEqual(firstNonce, secondNonce, 'CSP nonces must use cryptographic randomness');

    const {
        assertSafeWorkspacePath,
        getWorkspaceRelativePath,
        isFileNotFoundError,
        joinProjectPath,
        normalizeProjectPath,
    } = require(
        path.join('..', 'utils', 'pathSafety')
    ) as {
        assertSafeWorkspacePath(workspace: MockUri, target: MockUri): Promise<void>;
        getWorkspaceRelativePath(workspace: MockUri, target: MockUri): string | undefined;
        isFileNotFoundError(error: unknown): boolean;
        joinProjectPath(parent: string, name: string, folder: boolean): string;
        normalizeProjectPath(candidate: string, allowRoot?: boolean): string;
    };
    assert.equal(joinProjectPath('/chapters/', 'intro.tex', false), '/chapters/intro.tex');
    assert.throws(() => joinProjectPath('/', '../outside.tex', false), /Unsafe Overleaf entity name/);
    assert.throws(() => normalizeProjectPath('/../../outside.tex', false), /Unsafe Overleaf entity name/);
    assert.throws(() => normalizeProjectPath('/safe\\..\\outside.tex', false), /Unsafe Overleaf project path/);
    assert.throws(() => normalizeProjectPath('/', false), /workspace root/);
    assert.throws(() => joinProjectPath('/', 'settings.json.', false), /Unsafe Overleaf entity name/);
    assert.throws(() => joinProjectPath('/', 'CON', false), /Unsafe Overleaf entity name/);
    const safetyRoot = mockFileUri('D:\\safety-workspace');
    const linkedTarget = mockFileUri('D:\\safety-workspace\\linked\\secret.tex');
    const driveCaseTarget = mockFileUri('d:\\SAFETY-WORKSPACE\\chapter.tex');
    resetMockWorkspace([safetyRoot], [
        ['D:\\safety-workspace', { type: 2 }],
        ['D:\\safety-workspace\\linked', { type: 66 }],
        ['D:\\safety-workspace\\chapter.tex', { type: 1, content: 'test' }],
    ]);
    await assert.rejects(
        () => assertSafeWorkspacePath(safetyRoot, linkedTarget),
        /symbolic link/,
        'existing symbolic-link ancestors must never be traversed',
    );
    await assert.rejects(
        () => assertSafeWorkspacePath(safetyRoot, mockFileUri('D:\\outside\\secret.tex')),
        /outside the workspace/,
    );
    assert.equal(
        getWorkspaceRelativePath(safetyRoot, driveCaseTarget),
        'chapter.tex',
        'Windows drive and directory case differences must remain inside the workspace',
    );
    await assert.doesNotReject(() => assertSafeWorkspacePath(safetyRoot, driveCaseTarget));
    assert.equal(
        getWorkspaceRelativePath(safetyRoot, mockFileUri('D:\\safety-workspace-evil\\secret.tex')),
        undefined,
        'a sibling with the same textual prefix must remain outside the workspace',
    );
    assert.equal(
        getWorkspaceRelativePath(safetyRoot, mockFileUri('E:\\safety-workspace\\secret.tex')),
        undefined,
        'a path on another Windows drive must remain outside the workspace',
    );
    assert.equal(isFileNotFoundError(new Error('ENOENT: missing file')), true);
    assert.equal(
        isFileNotFoundError(new MockFileSystemError('Access denied')),
        false,
        'filesystem errors without a missing-path signal must not bypass path safety checks',
    );

    const { validateServerUrl } = require(path.join('..', 'utils', 'serverUrl')) as {
        validateServerUrl(candidate: string): { url: string; isOfficialOverleaf: boolean };
    };
    assert.equal(validateServerUrl('https://www.overleaf.com/').url, 'https://www.overleaf.com');
    assert.equal(validateServerUrl('https://www.overleaf.com').isOfficialOverleaf, true);
    assert.equal(validateServerUrl('https://overleaf.com.attacker.example').isOfficialOverleaf, false);
    assert.throws(() => validateServerUrl('https://overleaf.com@attacker.example'), /embedded credentials/);
    assert.throws(() => validateServerUrl('file:///tmp/overleaf'), /HTTP or HTTPS/);

    const { SettingsManager, isValidProjectSettings } = require(
        path.join('..', 'utils', 'settingsManager')
    ) as {
        SettingsManager: {
            clearCurrentWorkspaceFolder(): void;
            getInstance(uri: MockUri): {
                getFilePath(relativePath: string): MockUri;
                getRelativePath(uri: MockUri): string | undefined;
            };
            createDefaultSettings(serverUrl: string, projectId: string, projectName: string): {
                mainTex?: string;
                mainPdf?: string;
            };
            findLinkedProjectFolders(): Promise<Array<{
                uri: MockUri;
                relativePath: string;
                settings: { projectId: string; projectName: string };
            }>>;
            inspectFolder(uri: MockUri): Promise<{ kind: string }>;
            resolveCurrentInstance(): Promise<{
                getWorkspaceFolder(): MockUri;
            } | undefined>;
        };
        isValidProjectSettings(value: unknown): boolean;
    };
    const defaultSettings = SettingsManager.createDefaultSettings(
        'https://overleaf.example',
        'project-id',
        'Project',
    );
    assert.equal(defaultSettings.mainTex, undefined, 'new links must not assume main.tex');
    assert.equal(defaultSettings.mainPdf, undefined, 'new links must not assume main.pdf');
    assert.equal(isValidProjectSettings({}), false, 'an empty .localleaf settings object is not a valid link');
    assert.equal(isValidProjectSettings({
        serverUrl: 'https://overleaf.example',
        projectId: 'project-id',
        projectName: 'Project',
        autoSync: true,
    }), true);
    assert.equal(isValidProjectSettings({
        serverUrl: 'https://overleaf.example',
        projectId: 'project-id',
        projectName: 'Project',
        mainTex: 42,
    }), false, 'invalid optional values must not pass the stored-settings validator');
    assert.equal(isValidProjectSettings({
        serverUrl: 'https://overleaf.example',
        projectId: 'project-id',
        projectName: 'Project',
        mainTex: '../outside.tex',
    }), false, 'main-document settings must remain inside the project');
    assert.equal(isValidProjectSettings({
        serverUrl: 'file:///tmp/not-a-server',
        projectId: 'project-id',
        projectName: 'Project',
    }), false, 'project settings must reject non-HTTP server URLs');

    const linkedSettings = JSON.stringify({
        serverUrl: 'https://overleaf.example',
        projectId: 'detected-project-id',
        projectName: 'Detected Project',
        autoSync: true,
    });
    const workspaceRoot = mockFileUri('D:\\workspace');
    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.localleaf', { type: 2 }],
        ['D:\\workspace\\.localleaf\\settings.json', { type: 1, content: linkedSettings }],
    ]);
    SettingsManager.clearCurrentWorkspaceFolder();
    const resolvedManager = await SettingsManager.resolveCurrentInstance();
    assert.equal(resolvedManager?.getWorkspaceFolder().toString(), workspaceRoot.toString(),
        'activation must restore a valid LocalLeaf project already open as a workspace root');
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'linked');
    const pathManager = SettingsManager.getInstance(workspaceRoot);
    assert.equal(pathManager.getFilePath('/safe/file.tex').fsPath, 'D:\\workspace\\safe\\file.tex');
    assert.throws(() => pathManager.getFilePath('/../outside.tex'), /Unsafe Overleaf entity name/);
    assert.throws(() => pathManager.getFilePath('/'), /workspace root/);
    assert.equal(
        pathManager.getRelativePath(mockFileUri('d:\\WORKSPACE\\safe\\file.tex')),
        '/safe/file.tex',
        'filesystem watcher URIs must tolerate Windows path casing differences',
    );
    assert.equal(pathManager.getRelativePath(mockFileUri('d:\\WORKSPACE')), '/');
    assert.equal(pathManager.getRelativePath(mockFileUri('D:\\workspace-evil\\file.tex')), undefined);
    assert.equal(pathManager.getRelativePath(mockFileUri('E:\\workspace\\file.tex')), undefined);

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\project-a', { type: 2 }],
        ['D:\\workspace\\project-a\\.localleaf', { type: 2 }],
        ['D:\\workspace\\project-a\\.localleaf\\settings.json', { type: 1, content: linkedSettings }],
    ]);
    SettingsManager.clearCurrentWorkspaceFolder();
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'non-empty');
    const detectedProjects = await SettingsManager.findLinkedProjectFolders();
    assert.equal(detectedProjects.length, 1, 'one-level LocalLeaf projects must be discovered');
    assert.equal(detectedProjects[0].relativePath, 'project-a');
    assert.equal(detectedProjects[0].settings.projectId, 'detected-project-id');

    const noCredentialManager = {
        getDefaultServer: () => 'https://overleaf.example',
        getCredential: async () => undefined,
    };
    const detectedProjectsProvider = new ProjectsWebviewProvider(
        'extension',
        noCredentialManager,
    ) as any;
    await detectedProjectsProvider.refresh();
    assert.equal(detectedProjectsProvider.state.status, 'local-projects');
    assert.equal(detectedProjectsProvider.state.localProjects[0].projectName, 'Detected Project');
    let openLocalProjectArgs: unknown[] | undefined;
    executeCommandImpl = async (...args: unknown[]) => {
        openLocalProjectArgs = args;
        return undefined;
    };
    await detectedProjectsProvider.handleMessage({
        type: 'openLocalProject',
        uri: detectedProjects[0].uri.toString(),
    });
    assert.equal(openLocalProjectArgs?.[0], 'vscode.openFolder');
    assert.equal((openLocalProjectArgs?.[1] as MockUri).toString(), detectedProjects[0].uri.toString());
    assert.equal(openLocalProjectArgs?.[2], false,
        'opening a detected project should reuse the Extension Development Host window');
    executeCommandImpl = async () => undefined;

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.leafignore', { type: 1, content: '*.aux' }],
    ]);
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'empty',
        '.leafignore alone must not make a workspace unsafe to link');
    const emptyFolderProvider = new ProjectsWebviewProvider('extension', noCredentialManager) as any;
    await emptyFolderProvider.refresh();
    assert.equal(emptyFolderProvider.state.status, 'not-logged-in');
    assert.equal(emptyFolderProvider.state.workspaceKind, 'empty');

    resetMockWorkspace([workspaceRoot], [
        ['D:\\workspace', { type: 2 }],
        ['D:\\workspace\\.localleaf', { type: 2 }],
        ['D:\\workspace\\.localleaf\\settings.json', { type: 1, content: '{"projectId":42}' }],
    ]);
    assert.equal((await SettingsManager.inspectFolder(workspaceRoot)).kind, 'invalid-config');
    const invalidFolderProvider = new ProjectsWebviewProvider('extension', noCredentialManager) as any;
    await invalidFolderProvider.refresh();
    assert.equal(invalidFolderProvider.state.status, 'not-logged-in');
    assert.equal(invalidFolderProvider.state.workspaceKind, 'invalid-config');

    const virtualWorkspace: MockUri = {
        scheme: 'vscode-remote',
        path: '/workspace',
        fsPath: '',
        toString: () => 'vscode-remote://workspace',
    };
    resetMockWorkspace([virtualWorkspace]);
    assert.equal((await SettingsManager.inspectFolder(virtualWorkspace)).kind, 'unsupported');
    const incompatibleFolderProvider = new ProjectsWebviewProvider(
        'extension',
        noCredentialManager,
    ) as any;
    await incompatibleFolderProvider.refresh();
    assert.equal(incompatibleFolderProvider.state.status, 'incompatible-folder');

    resetMockWorkspace();
    const noFolderProvider = new ProjectsWebviewProvider('extension', noCredentialManager) as any;
    await noFolderProvider.refresh();
    assert.equal(noFolderProvider.state.status, 'no-folder');

    const { IgnoreParser } = require(path.join('..', 'sync', 'ignoreParser')) as {
        IgnoreParser: { prototype: object };
    };
    const ignoreParser = Object.create(IgnoreParser.prototype) as any;
    ignoreParser.patterns = ['$MAIN_TEX', '$MAIN_PDF', '*.aux'];
    ignoreParser.settings = {};
    ignoreParser.resolveVariables();
    assert.deepStrictEqual(
        ignoreParser.resolvedPatterns,
        ['*.aux'],
        'unresolved main-document variables must not silently target main.tex/main.pdf',
    );

    const vscodeIgnore = fs.readFileSync(path.join(__dirname, '..', '..', '.vscodeignore'), 'utf8');
    assert.match(vscodeIgnore, /^LOCAL_GUI_INTEGRATION_CHECKLIST\.md$/m,
        'the local integration checklist must never be packaged');
    assert.match(vscodeIgnore, /^local-pr3-artifacts\/\*\*$/m,
        'local PR artifacts must never be packaged');
    assert.match(vscodeIgnore, /^out\/test\/\*\*$/m,
        'compiled test code must not be packaged');
    assert.match(vscodeIgnore, /^out\/test\/runTest\.js$/m,
        'the compiled regression runner must be explicitly excluded from the VSIX');
    ignoreParser.settings = { mainTex: 'thesis[1].tex', mainPdf: 'thesis[1].pdf' };
    ignoreParser.resolveVariables();
    assert.deepStrictEqual(
        ignoreParser.resolvedPatterns,
        ['thesis\\[1\\].tex', 'thesis\\[1\\].pdf', '*.aux'],
        'main-document names must be treated as literal ignore paths, not glob syntax',
    );

    const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'package.json'),
        'utf8',
    )) as {
        publisher: string;
        contributes?: {
            viewsContainers?: { activitybar?: Array<{ id?: string }> };
            views?: { localleaf?: Array<{ id?: string; type?: string }> };
        };
        capabilities?: { untrustedWorkspaces?: { supported?: boolean } };
    };
    assert.equal(manifest.publisher, 'teddy-van-jerry');
    assert.equal(manifest.contributes?.viewsContainers?.activitybar?.[0]?.id, 'localleaf');
    assert.deepStrictEqual(
        manifest.contributes?.views?.localleaf?.map(view => [view.id, view.type]),
        [
            ['localleaf.projectsView', 'webview'],
            ['localleaf.mainView', 'webview'],
        ],
    );
    assert.equal(
        manifest.capabilities?.untrustedWorkspaces?.supported,
        false,
        'LocalLeaf must stay disabled in untrusted workspaces because it writes remote content locally',
    );

    assert.equal(readInstalledPackageVersion('form-data'), '4.0.6');
    assert.equal(readInstalledPackageVersion('minimatch'), '9.0.9');
    assert.equal(readInstalledPackageVersion('ws'), '5.2.7');
    assert.equal(
        readInstalledPackageVersion(
            '@typescript-eslint',
            'typescript-estree',
            'node_modules',
            'minimatch',
        ),
        '9.0.9',
        'the development toolchain must not restore the vulnerable minimatch release',
    );

    const socketTransportSource = fs.readFileSync(
        path.join(
            __dirname,
            '..',
            '..',
            'node_modules',
            'socket.io-client',
            'lib',
            'transports',
            'websocket.js',
        ),
        'utf8',
    );
    assert.match(socketTransportSource, /require\('ws'\)/);
    assert.match(socketTransportSource, /headers:\s*extraHeaders\s*\|\|\s*\{\}/);
    assert.match(socketTransportSource, /\.onopen\s*=/);
    assert.match(socketTransportSource, /\.onmessage\s*=/);
    await verifyWebSocketCompatibility();

    Module._load = originalLoad;
    console.log('LocalLeaf synchronization and UI contract regression tests passed.');
}

run().catch(error => {
    Module._load = originalLoad;
    console.error(error);
    process.exitCode = 1;
});
