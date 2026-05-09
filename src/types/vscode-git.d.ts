import * as vscode from 'vscode';

/**
 * Adapted from VS Code's built-in Git extension API typings.
 * Source: extensions/git/src/api/git.d.ts (public API shape, subset used here).
 */
export interface GitExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement: vscode.Event<boolean>;
    getAPI(version: 1): API;
}

export interface API {
    readonly state: 'uninitialized' | 'initialized';
    readonly onDidChangeState: vscode.Event<void>;
    readonly repositories: Repository[];
    readonly onDidOpenRepository: vscode.Event<Repository>;
    readonly onDidCloseRepository: vscode.Event<Repository>;
    getRepository(uri: vscode.Uri): Repository | null;
}

export interface Repository {
    readonly rootUri: vscode.Uri;
    readonly onDidCommit: vscode.Event<void>;
}
