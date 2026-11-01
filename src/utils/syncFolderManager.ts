import * as vscode from 'vscode';

const SYNC_FOLDER_KEY = 'localleaf.syncFolder';

/** Stores the selected folder on this extension host, independently of the workspace. */
export class SyncFolderManager {
    private selectedFolder: string | undefined;

    constructor(private readonly storage: vscode.Memento) {
        // Keep the active destination stable if another window updates global storage.
        this.selectedFolder = storage.get<string>(SYNC_FOLDER_KEY);
    }

    getFolder(): vscode.Uri | undefined {
        const saved = this.selectedFolder;
        if (saved !== undefined) {
            // Never silently fall back to an unrelated workspace if the saved folder is invalid.
            const folder = vscode.Uri.parse(saved, true);
            if (folder.scheme !== 'file') {
                throw new Error('The saved sync folder must be a local filesystem folder.');
            }
            return folder;
        }
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        return folder?.scheme === 'file' ? folder : undefined;
    }

    async validateFolder(folder: vscode.Uri): Promise<void> {
        if (folder.scheme !== 'file') {
            throw new Error('Select a folder on the filesystem of this extension host.');
        }
        const stat = await vscode.workspace.fs.stat(folder);
        if (!(stat.type & vscode.FileType.Directory)) {
            throw new Error('The sync folder must be an existing directory.');
        }
    }

    async selectFolder(folder: vscode.Uri): Promise<void> {
        await this.validateFolder(folder);
        await this.storage.update(SYNC_FOLDER_KEY, folder.toString());
        this.selectedFolder = folder.toString();
    }

    async useWorkspaceFolder(): Promise<void> {
        await this.storage.update(SYNC_FOLDER_KEY, undefined);
        this.selectedFolder = undefined;
    }
}
