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
    json: () => Promise<unknown>;
    text: () => Promise<string>;
} = {
    ok: true,
    status: 200,
    json: async () => ({ entity_id: 'binary-id-1', entity_type: 'file' }),
    text: async () => '',
};

let executeCommandImpl: (...args: unknown[]) => Promise<unknown> = async () => undefined;

interface MockUri {
    scheme: string;
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
            Uri: {
                joinPath: (
                    base: MockUri | string,
                    ...segments: string[]
                ): MockUri | string => typeof base === 'string'
                    ? [base, ...segments].join('/')
                    : mockFileUri(path.win32.join(base.fsPath, ...segments)),
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
    const insecureWarning = cookieLoginSource.indexOf('showWarningMessage');
    const cookieApiCreation = cookieLoginSource.indexOf('new BaseAPI');
    assert.ok(cookieLoginStart >= 0 && cookieLoginEnd > cookieLoginStart);
    assert.match(cookieLoginSource, /parsed\.protocol === 'http:'/);
    assert.match(cookieLoginSource, /modal:\s*true/);
    assert.ok(insecureWarning >= 0 && insecureWarning < cookieApiCreation,
        'HTTP cookie login must require a modal warning before any API request');
    assert.match(extensionSource, /if \(await loginWithCookies[\s\S]*await reconnectAfterLogin\(\)/,
        'cancelling the HTTP warning must also skip reconnecting');

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

    const { SettingsManager, isValidProjectSettings } = require(
        path.join('..', 'utils', 'settingsManager')
    ) as {
        SettingsManager: {
            clearCurrentWorkspaceFolder(): void;
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
    ignoreParser.settings = { mainTex: 'thesis.tex', mainPdf: 'thesis.pdf' };
    ignoreParser.resolveVariables();
    assert.deepStrictEqual(ignoreParser.resolvedPatterns, ['thesis.tex', 'thesis.pdf', '*.aux']);

    const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'package.json'),
        'utf8',
    )) as {
        publisher: string;
        contributes?: {
            viewsContainers?: { activitybar?: Array<{ id?: string }> };
            views?: { localleaf?: Array<{ id?: string; type?: string }> };
        };
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
