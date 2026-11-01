import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type * as vscode from 'vscode';

/** Exercise real folder persistence and extension commands without an Overleaf session. */
export async function testSyncFolders(): Promise<void> {
    const Module = require('module') as {
        _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const originalLoad = Module._load;
    const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 200; i++) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail('Expected background activation to finish');
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localleaf-folders-'));
    const workspacePath = path.join(root, 'workspace');
    const externalPath = path.join(root, 'external');
    const unlinkedPath = path.join(root, 'unlinked');
    for (const folder of [workspacePath, externalPath, unlinkedPath]) {
        await fs.mkdir(folder);
    }

    class Uri {
        constructor(private readonly value: URL) {}
        static file(filename: string): Uri { return new Uri(pathToFileURL(filename)); }
        static parse(value: string): Uri { return new Uri(new URL(value)); }
        static joinPath(base: Uri, ...parts: string[]): Uri {
            return Uri.file(path.join(base.fsPath, ...parts));
        }
        get scheme(): string { return this.value.protocol.slice(0, -1); }
        get path(): string { return decodeURIComponent(this.value.pathname); }
        get fsPath(): string { return fileURLToPath(this.value); }
        toString(): string { return this.value.toString(); }
    }

    const stored = new Map<string, unknown>();
    const storage: vscode.Memento = {
        keys: () => Array.from(stored.keys()),
        get: <T>(key: string, defaultValue?: T) =>
            stored.has(key) ? stored.get(key) as T : defaultValue as T,
        update: async (key: string, value: unknown) => {
            if (value === undefined) stored.delete(key);
            else stored.set(key, value);
        },
    };
    const commands = new Map<string, () => Promise<unknown>>();
    const watchers: { base: Uri; disposed: boolean }[] = [];
    const shownDocuments: Uri[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let selection: Uri[] | undefined;
    let quickPickLabel: string | undefined;
    let nextPull: Promise<void> | undefined;
    const engines: MockSyncEngine[] = [];

    class MockSyncEngine {
        disconnected = false;
        status = 'idle';
        readonly folder: Uri;
        constructor(_api: unknown, settings: { getWorkspaceFolder(): Uri }) {
            this.folder = settings.getWorkspaceFolder();
            engines.push(this);
        }
        onStatusChange(): void {}
        async connect(): Promise<void> {}
        getSocket(): { isConnected: boolean } { return { isConnected: true }; }
        startLocalWatcher(): void {}
        async detectMainDocument(): Promise<void> {}
        async pullAll(): Promise<void> {
            const pull = nextPull;
            nextPull = undefined;
            await pull;
        }
        async joinAllDocsForWatching(): Promise<void> {}
        disconnect(): void { this.disconnected = true; }
    }

    const mockVscode = {
        Uri,
        FileType: { File: 1, Directory: 2 },
        RelativePattern: class {
            constructor(readonly baseUri: Uri, readonly pattern: string) {}
        },
        StatusBarAlignment: { Left: 1 },
        QuickPickItemKind: { Separator: -1 },
        ProgressLocation: { Notification: 1 },
        MarkdownString: class {},
        ThemeColor: class {},
        workspace: {
            workspaceFolders: [{ uri: Uri.file(workspacePath) }] as { uri: Uri }[] | undefined,
            fs: {
                stat: async (uri: Uri) => {
                    const stat = await fs.stat(uri.fsPath);
                    return { type: stat.isDirectory() ? 2 : 1 };
                },
                readFile: (uri: Uri) => fs.readFile(uri.fsPath),
                writeFile: (uri: Uri, bytes: Uint8Array) => fs.writeFile(uri.fsPath, bytes),
                createDirectory: (uri: Uri) => fs.mkdir(uri.fsPath, { recursive: true }),
                delete: (uri: Uri) => fs.rm(uri.fsPath, { recursive: true }),
            },
            createFileSystemWatcher: (pattern: { baseUri: Uri }) => {
                const watcher = {
                    base: pattern.baseUri,
                    disposed: false,
                    onDidChange: () => ({ dispose() {} }),
                    onDidCreate: () => ({ dispose() {} }),
                    onDidDelete: () => ({ dispose() {} }),
                    dispose() { this.disposed = true; },
                };
                watchers.push(watcher);
                return watcher;
            },
        },
        commands: {
            registerCommand: (name: string, handler: () => Promise<unknown>) => {
                commands.set(name, handler);
                return { dispose() {} };
            },
        },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
            showOpenDialog: async () => selection,
            showInformationMessage: async () => undefined,
            showWarningMessage: async (message: string) => {
                warnings.push(message);
                return 'Unlink';
            },
            showErrorMessage: async (message: string) => { errors.push(message); },
            showTextDocument: async (uri: Uri) => { shownDocuments.push(uri); },
            showInputBox: async () => 'thesis.tex',
            showQuickPick: async (items: { label: string }[]) =>
                items.find(item => item.label.includes(quickPickLabel || 'External project')),
            withProgress: async (_options: unknown, task: () => Promise<void>) => task(),
        },
    };

    Module._load = function (request, parent, isMain): unknown {
        if (request === 'vscode') return mockVscode;
        if (request === './sync/syncEngine') return { SyncEngine: MockSyncEngine };
        if (request === './utils/credentialManager') return {
            CredentialManager: { initialize: () => ({
                getDefaultServer: () => 'https://overleaf.example',
                getCredential: async () => ({ identity: {}, userEmail: 'test@example.com' }),
            }) },
        };
        if (request === './api/base') return { BaseAPI: class {
            setIdentity(): void {}
            async getProjects(): Promise<unknown> {
                return { type: 'success', projects: [{ id: 'external', name: 'External project' }] };
            }
        } };
        if (request === './collaboration/cursorTracker') return { CursorTracker: class {
            async initialize(): Promise<void> {}
            dispose(): void {}
            getOnlineUsers(): unknown[] { return []; }
            getUserCount(): number { return 0; }
        } };
        if (request === './api/socketio') return { setOutputChannel() {} };
        return originalLoad(request, parent, isMain);
    };

    const context = {
        globalState: storage,
        subscriptions: [] as vscode.Disposable[],
    } as unknown as vscode.ExtensionContext;
    let extension: typeof import('../extension') | undefined;
    try {
        const { SyncFolderManager } = require('../utils/syncFolderManager') as typeof import('../utils/syncFolderManager');
        const folders = new SyncFolderManager(storage);
        const external = Uri.file(externalPath) as unknown as vscode.Uri;
        assert.equal(folders.getFolder()?.fsPath, workspacePath);
        await folders.selectFolder(external);
        assert.equal(new SyncFolderManager(storage).getFolder()?.fsPath, externalPath);
        const otherWindow = new SyncFolderManager(storage);
        await otherWindow.selectFolder(Uri.file(unlinkedPath) as unknown as vscode.Uri);
        assert.equal(folders.getFolder()?.fsPath, externalPath, 'another window cannot change an active destination');
        await folders.selectFolder(external);
        stored.set('localleaf.syncFolder', 'https://example.com/folder');
        assert.throws(() => new SyncFolderManager(storage).getFolder(), /local filesystem/);
        await folders.selectFolder(external);
        mockVscode.workspace.workspaceFolders = undefined;
        assert.equal(folders.getFolder()?.fsPath, externalPath, 'selection survives an empty window');
        await assert.rejects(folders.selectFolder(Uri.parse('https://example.com/folder') as unknown as vscode.Uri));
        await assert.rejects(folders.selectFolder(Uri.file(path.join(root, 'missing')) as unknown as vscode.Uri));
        await fs.writeFile(path.join(root, 'file'), 'text');
        await assert.rejects(folders.selectFolder(Uri.file(path.join(root, 'file')) as unknown as vscode.Uri));
        assert.equal(folders.getFolder()?.fsPath, externalPath, 'invalid choices preserve the selection');
        await folders.useWorkspaceFolder();
        assert.equal(folders.getFolder(), undefined);
        mockVscode.workspace.workspaceFolders = [{ uri: Uri.file(workspacePath) }];
        await folders.selectFolder(external);

        extension = require('../extension') as typeof import('../extension');
        await extension.activate(context);
        assert.equal(engines.length, 0, 'selecting an unlinked folder does not create a connection');
        await waitFor(() => watchers.length > 0);
        assert.equal(watchers[0].base.fsPath, externalPath);
        const engineModule = require.resolve('../sync/syncEngine');
        const cachedEngine = require.cache[engineModule];
        delete require.cache[engineModule];
        const { SyncEngine } = require('../sync/syncEngine') as typeof import('../sync/syncEngine');
        require.cache[engineModule] = cachedEngine;
        const localWatching = Object.create(SyncEngine.prototype) as {
            settings: { getWorkspaceFolder(): vscode.Uri };
            disposables: vscode.Disposable[];
            socket: { isConnected: boolean };
            startLocalWatcher(): void;
        };
        localWatching.settings = { getWorkspaceFolder: () => external };
        localWatching.disposables = [];
        localWatching.socket = { isConnected: true };
        localWatching.startLocalWatcher();
        assert.equal(watchers.at(-1)?.base.fsPath, externalPath, 'file events use the external sync root');
        localWatching.disposables.forEach(disposable => disposable.dispose());
        await commands.get('localleaf.linkFolder')!();
        assert.equal(engines[0].folder.fsPath, externalPath);
        await fs.access(path.join(externalPath, '.localleaf', 'settings.json'));
        await assert.rejects(fs.access(path.join(workspacePath, '.localleaf')));
        await commands.get('localleaf.editIgnorePatterns')!();
        assert.equal(shownDocuments.at(-1)?.fsPath, path.join(externalPath, '.leafignore'));
        await commands.get('localleaf.setMainDocument')!();
        assert.equal(JSON.parse(await fs.readFile(path.join(externalPath, '.localleaf', 'settings.json'), 'utf8')).mainTex, 'thesis.tex');
        await commands.get('localleaf.configure')!();
        assert.equal(shownDocuments.at(-1)?.fsPath, path.join(externalPath, '.localleaf', 'settings.json'));

        selection = undefined;
        await commands.get('localleaf.selectSyncFolder')!();
        assert.equal(engines[0].disconnected, false, 'cancelling does not disconnect');
        selection = [Uri.file(path.join(root, 'missing'))];
        await commands.get('localleaf.selectSyncFolder')!();
        assert.equal(engines[0].disconnected, false, 'an invalid selection does not disconnect');
        assert.equal(errors.length, 1);

        let finishPull!: () => void;
        nextPull = new Promise<void>(resolve => { finishPull = resolve; });
        const pull = commands.get('localleaf.pullFromOverleaf')!();
        await new Promise(resolve => setImmediate(resolve));
        selection = [Uri.file(unlinkedPath)];
        const switchFolder = commands.get('localleaf.selectSyncFolder')!();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(engines[0].disconnected, false, 'switching waits for an in-flight pull');
        finishPull();
        await Promise.all([pull, switchFolder]);
        assert.equal(engines[0].disconnected, true);
        assert.equal(watchers.filter(watcher => !watcher.disposed).length, 1);
        assert.equal(watchers.at(-1)?.base.fsPath, unlinkedPath);
        await fs.access(path.join(externalPath, '.localleaf', 'settings.json'));

        selection = [Uri.file(externalPath)];
        await commands.get('localleaf.selectSyncFolder')!();
        assert.equal(engines.at(-1)?.folder.fsPath, externalPath, 'existing link reconnects without relinking');
        quickPickLabel = 'Reconnect';
        engines.at(-1)!.status = 'disconnected';
        await commands.get('localleaf.showSyncStatus')!();
        assert.equal(engines.at(-1)?.folder.fsPath, externalPath);
        assert.equal(engines.at(-2)?.disconnected, true);
        extension.deactivate();
        mockVscode.workspace.workspaceFolders = undefined;
        await extension.activate(context);
        assert.equal(engines.at(-1)?.folder.fsPath, externalPath, 'startup restores a linked folder in an empty window');
        mockVscode.workspace.workspaceFolders = [{ uri: Uri.file(workspacePath) }];
        await commands.get('localleaf.unlinkFolder')!();
        assert.equal(new SyncFolderManager(storage).getFolder()?.fsPath, externalPath, 'unlink keeps the selection');
        await assert.rejects(fs.access(path.join(externalPath, '.localleaf')));

        await commands.get('localleaf.useWorkspaceFolder')!();
        assert.equal(new SyncFolderManager(storage).getFolder()?.fsPath, workspacePath);
        assert.equal(stored.size, 0);
        await folders.selectFolder(external);
        await fs.rm(externalPath, { recursive: true });
        extension.deactivate();
        await extension.activate(context);
        assert.equal(folders.getFolder()?.fsPath, externalPath, 'missing saved folder never falls back');
        assert.equal(watchers.filter(watcher => !watcher.disposed).length, 0);
        await waitFor(() => warnings.some(message => message.includes('Cannot use the sync folder')));
        await commands.get('localleaf.useWorkspaceFolder')!();
        assert.equal(watchers.at(-1)?.base.fsPath, workspacePath, 'commands recover after a failed restore');
        console.log('LocalLeaf sync folder regression tests passed.');
    } finally {
        extension?.deactivate();
        context.subscriptions.forEach(disposable => disposable.dispose());
        Module._load = originalLoad;
        await fs.rm(root, { recursive: true, force: true });
    }
}
