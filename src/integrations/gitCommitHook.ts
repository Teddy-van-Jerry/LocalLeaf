import * as path from 'path';
import * as vscode from 'vscode';
import type {
    API as GitAPI,
    GitExtension,
    Repository as GitRepository,
} from '../types/vscode-git';

type CommitHandler = () => Promise<void>;

/**
 * Watches VS Code Git commit events and invokes a single-flight async handler.
 */
export class GitCommitHook implements vscode.Disposable {
    private gitApi?: GitAPI;
    private workspaceUri?: vscode.Uri;
    private repository?: GitRepository;
    private commitDisposable?: vscode.Disposable;
    private disposables: vscode.Disposable[] = [];

    private running = false;
    private rerunRequested = false;

    constructor(
        private readonly onCommit: CommitHandler,
        private readonly log: (message: string) => void,
    ) {}

    async start(workspaceUri: vscode.Uri): Promise<void> {
        if (
            this.workspaceUri?.toString() === workspaceUri.toString() &&
            this.gitApi
        ) {
            this.attachWorkspaceRepository();
            return;
        }

        this.stop();
        this.workspaceUri = workspaceUri;

        const api = await this.getGitApi();
        if (!api) {
            return;
        }
        this.gitApi = api;

        this.disposables.push(
            api.onDidChangeState(() => this.attachWorkspaceRepository()),
            api.onDidOpenRepository(() => this.attachWorkspaceRepository()),
            api.onDidCloseRepository(() => this.attachWorkspaceRepository()),
        );

        if (api.state === 'uninitialized') {
            this.log('Git commit hook waiting: Git API is uninitialized.');
        }
        this.attachWorkspaceRepository();
    }

    stop(): void {
        this.commitDisposable?.dispose();
        this.commitDisposable = undefined;
        this.repository = undefined;

        this.disposables.forEach(d => d.dispose());
        this.disposables = [];

        this.gitApi = undefined;
        this.workspaceUri = undefined;

        this.running = false;
        this.rerunRequested = false;
    }

    dispose(): void {
        this.stop();
    }

    private async getGitApi(): Promise<GitAPI | undefined> {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) {
            this.log('Git commit hook disabled: VS Code Git extension not found.');
            return undefined;
        }

        try {
            const exports = extension.isActive ? extension.exports : await extension.activate();
            if (!exports) {
                this.log('Git commit hook disabled: VS Code Git extension exports unavailable.');
                return undefined;
            }
            return exports.getAPI(1);
        } catch (error) {
            this.log(`Git commit hook disabled: failed to acquire Git API - ${error}`);
            return undefined;
        }
    }

    private attachWorkspaceRepository(): void {
        if (!this.gitApi || !this.workspaceUri) {
            return;
        }

        const nextRepository = this.resolveRepository(this.gitApi, this.workspaceUri);
        if (this.repository === nextRepository && this.commitDisposable) {
            return;
        }

        this.commitDisposable?.dispose();
        this.commitDisposable = undefined;
        this.repository = nextRepository;

        if (!this.repository) {
            this.log('Git commit hook idle: no repository matches the workspace folder.');
            return;
        }

        this.commitDisposable = this.repository.onDidCommit(() => {
            void this.handleCommitEvent();
        });
        this.log(`Git commit hook attached to repository: ${this.repository.rootUri.fsPath}`);
    }

    private resolveRepository(api: GitAPI, workspaceUri: vscode.Uri): GitRepository | undefined {
        const direct = api.getRepository(workspaceUri);
        if (direct) {
            return direct;
        }

        const workspacePath = this.normalizePathForCompare(workspaceUri.fsPath);
        const sortedRepositories = [...api.repositories]
            .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);

        return sortedRepositories.find(repo => {
            const repositoryPath = this.normalizePathForCompare(repo.rootUri.fsPath);
            return workspacePath === repositoryPath ||
                workspacePath.startsWith(repositoryPath + path.sep) ||
                repositoryPath.startsWith(workspacePath + path.sep);
        });
    }

    private normalizePathForCompare(rawPath: string): string {
        const normalized = path.normalize(path.resolve(rawPath));
        return process.platform === 'win32'
            ? normalized.toLowerCase()
            : normalized;
    }

    private async handleCommitEvent(): Promise<void> {
        this.log('Git commit hook event received.');
        if (this.running) {
            this.rerunRequested = true;
            return;
        }

        this.running = true;
        try {
            do {
                this.rerunRequested = false;
                await this.onCommit();
            } while (this.rerunRequested);
        } catch (error) {
            this.log(`Git commit hook handler failed: ${error}`);
        } finally {
            this.running = false;
        }
    }
}
