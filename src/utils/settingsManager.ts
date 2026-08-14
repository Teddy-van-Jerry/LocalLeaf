/**
 * LocalLeaf Settings Manager
 * Handles .localleaf/settings.json configuration
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CONFIG_DIR, SETTINGS_FILE, DEFAULT_SERVER, IGNORE_FILE } from '../consts';
import { assertSafeWorkspacePath, isFileNotFoundError, normalizeProjectPath } from './pathSafety';
import { isSupportedServerUrl, validateServerUrl } from './serverUrl';

/**
 * Project settings stored in .localleaf/settings.json
 */
export interface ProjectSettings {
    serverUrl: string;
    projectId: string;
    projectName: string;
    mainTex?: string;
    mainPdf?: string;
    autoSync: boolean;
    lastSynced?: string;
}

export type StoredProjectSettings = Omit<ProjectSettings, 'autoSync'> & { autoSync?: boolean };

export type WorkspaceFolderKind =
    | 'linked'
    | 'invalid-config'
    | 'empty'
    | 'non-empty'
    | 'unsupported';

export interface WorkspaceFolderInspection {
    uri: vscode.Uri;
    kind: WorkspaceFolderKind;
    settings?: ProjectSettings;
}

export interface DetectedLocalLeafProject {
    uri: vscode.Uri;
    workspaceFolder: vscode.Uri;
    relativePath: string;
    settings: ProjectSettings;
}

function isValidOptionalProjectFile(value: unknown, extension: string): boolean {
    if (value === undefined) return true;
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
    try {
        const normalized = normalizeProjectPath(value, false);
        return !normalized.endsWith('/') && normalized.toLowerCase().endsWith(extension);
    } catch {
        return false;
    }
}

export function isValidProjectSettings(value: unknown): value is StoredProjectSettings {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<StoredProjectSettings>;
    return isSupportedServerUrl(candidate.serverUrl)
        && typeof candidate.projectId === 'string'
        && candidate.projectId.trim().length > 0
        && candidate.projectId.length <= 1024
        && !candidate.projectId.includes('\0')
        && typeof candidate.projectName === 'string'
        && candidate.projectName.trim().length > 0
        && candidate.projectName.length <= 4096
        && !candidate.projectName.includes('\0')
        && isValidOptionalProjectFile(candidate.mainTex, '.tex')
        && isValidOptionalProjectFile(candidate.mainPdf, '.pdf')
        && (candidate.autoSync === undefined || typeof candidate.autoSync === 'boolean')
        && (candidate.lastSynced === undefined || typeof candidate.lastSynced === 'string');
}

/**
 * Settings Manager - handles local project configuration
 *
 * Configuration is stored per-folder in .localleaf/settings.json
 * This is completely decoupled from credentials (stored in SecretStorage)
 */
export class SettingsManager {
    private static instances: Map<string, SettingsManager> = new Map();
    private static currentWorkspaceFolder?: vscode.Uri;
    private settings?: ProjectSettings;
    private readonly configDir: vscode.Uri;
    private readonly settingsFile: vscode.Uri;

    private constructor(private readonly workspaceFolder: vscode.Uri) {
        this.configDir = vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR);
        this.settingsFile = vscode.Uri.joinPath(this.configDir, SETTINGS_FILE);
    }

    /**
     * Get or create instance for a workspace folder
     */
    static getInstance(workspaceFolder: vscode.Uri): SettingsManager {
        const key = workspaceFolder.toString();
        if (!SettingsManager.instances.has(key)) {
            SettingsManager.instances.set(key, new SettingsManager(workspaceFolder));
        }
        return SettingsManager.instances.get(key)!;
    }

    static setCurrentWorkspaceFolder(workspaceFolder: vscode.Uri | undefined): void {
        SettingsManager.currentWorkspaceFolder = workspaceFolder?.scheme === 'file'
            ? workspaceFolder
            : undefined;
    }

    static clearCurrentWorkspaceFolder(): void {
        SettingsManager.currentWorkspaceFolder = undefined;
    }

    static async inspectFolder(workspaceFolder: vscode.Uri): Promise<WorkspaceFolderInspection> {
        if (workspaceFolder.scheme !== 'file') {
            return { uri: workspaceFolder, kind: 'unsupported' };
        }

        const settings = await SettingsManager.loadSettings(workspaceFolder);
        if (settings) {
            return { uri: workspaceFolder, kind: 'linked', settings };
        }

        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR));
            return { uri: workspaceFolder, kind: 'invalid-config' };
        } catch {
            // No LocalLeaf configuration directory; inspect the folder contents below.
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(workspaceFolder);
            const meaningfulEntries = entries.filter(([name]) => name !== IGNORE_FILE);
            return {
                uri: workspaceFolder,
                kind: meaningfulEntries.length === 0 ? 'empty' : 'non-empty',
            };
        } catch {
            return { uri: workspaceFolder, kind: 'unsupported' };
        }
    }

    static async loadSettings(workspaceFolder: vscode.Uri): Promise<ProjectSettings | undefined> {
        try {
            const settingsFile = vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR, SETTINGS_FILE);
            await assertSafeWorkspacePath(workspaceFolder, settingsFile);
            const content = await vscode.workspace.fs.readFile(
                settingsFile,
            );
            const parsed: unknown = JSON.parse(new TextDecoder().decode(content));
            if (!isValidProjectSettings(parsed)) return undefined;
            return {
                ...parsed,
                serverUrl: validateServerUrl(parsed.serverUrl).url,
                autoSync: parsed.autoSync ?? true,
            };
        } catch {
            return undefined;
        }
    }

    static async isLinkedFolder(workspaceFolder: vscode.Uri): Promise<boolean> {
        return Boolean(await SettingsManager.loadSettings(workspaceFolder));
    }

    static async findLinkedProjectFolders(maxDepth: number = 1): Promise<DetectedLocalLeafProject[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders
            ?.map(folder => folder.uri)
            .filter(uri => uri.scheme === 'file') ?? [];
        const results: DetectedLocalLeafProject[] = [];
        const seen = new Set<string>();

        await Promise.all(workspaceFolders.map(workspaceFolder =>
            SettingsManager.collectLinkedProjectFolders(
                workspaceFolder,
                workspaceFolder,
                0,
                maxDepth,
                seen,
                results,
            )
        ));

        return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    }

    static async resolveCurrentInstance(): Promise<SettingsManager | undefined> {
        if (
            SettingsManager.currentWorkspaceFolder
            && await SettingsManager.isLinkedFolder(SettingsManager.currentWorkspaceFolder)
        ) {
            return SettingsManager.getInstance(SettingsManager.currentWorkspaceFolder);
        }

        SettingsManager.currentWorkspaceFolder = undefined;
        const linkedRoots: vscode.Uri[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme === 'file' && await SettingsManager.isLinkedFolder(folder.uri)) {
                linkedRoots.push(folder.uri);
            }
        }
        if (linkedRoots.length === 1) {
            SettingsManager.currentWorkspaceFolder = linkedRoots[0];
            return SettingsManager.getInstance(linkedRoots[0]);
        }
        return undefined;
    }

    /**
     * Get instance for the current workspace (first folder)
     */
    static getCurrentInstance(): SettingsManager | undefined {
        const fileFolders = vscode.workspace.workspaceFolders
            ?.map(folder => folder.uri)
            .filter(uri => uri.scheme === 'file') ?? [];
        const workspaceFolder = SettingsManager.currentWorkspaceFolder
            ?? (fileFolders.length === 1 ? fileFolders[0] : undefined);
        if (!workspaceFolder || workspaceFolder.scheme !== 'file') {
            return undefined;
        }
        return SettingsManager.getInstance(workspaceFolder);
    }

    /**
     * Check if this folder is linked to an Overleaf project
     */
    async isLinked(): Promise<boolean> {
        return SettingsManager.isLinkedFolder(this.workspaceFolder);
    }

    /**
     * Load settings from disk
     */
    async load(): Promise<ProjectSettings | undefined> {
        this.settings = await SettingsManager.loadSettings(this.workspaceFolder);
        return this.settings;
    }

    /**
     * Save settings to disk
     */
    async save(settings: ProjectSettings): Promise<void> {
        const canonicalSettings: ProjectSettings = {
            ...settings,
            serverUrl: validateServerUrl(settings.serverUrl).url,
        };
        if (!isValidProjectSettings(canonicalSettings)) {
            throw new Error('Refusing to save invalid LocalLeaf project settings.');
        }

        await assertSafeWorkspacePath(this.workspaceFolder, this.configDir);
        await vscode.workspace.fs.createDirectory(this.configDir);

        await assertSafeWorkspacePath(this.workspaceFolder, this.settingsFile);
        const content = new TextEncoder().encode(JSON.stringify(canonicalSettings, null, 2));
        await vscode.workspace.fs.writeFile(this.settingsFile, content);
        this.settings = canonicalSettings;
        SettingsManager.setCurrentWorkspaceFolder(this.workspaceFolder);
    }

    /**
     * Update partial settings
     */
    async update(partial: Partial<ProjectSettings>): Promise<void> {
        const current = await this.load();
        if (current) {
            await this.save({ ...current, ...partial });
        }
    }

    /**
     * Delete settings (unlink folder)
     */
    async delete(): Promise<void> {
        try {
            await assertSafeWorkspacePath(this.workspaceFolder, this.configDir);
            await vscode.workspace.fs.delete(this.configDir, { recursive: true });
            this.settings = undefined;
        } catch (error) {
            if (!isFileNotFoundError(error)) throw error;
            this.settings = undefined;
        }
    }

    /**
     * Get current settings (cached)
     */
    getSettings(): ProjectSettings | undefined {
        return this.settings;
    }

    /**
     * Get the workspace folder URI
     */
    getWorkspaceFolder(): vscode.Uri {
        return this.workspaceFolder;
    }

    /**
     * Get the config directory URI
     */
    getConfigDir(): vscode.Uri {
        return this.configDir;
    }

    /**
     * Create default settings for a new project link
     */
    static createDefaultSettings(
        serverUrl: string,
        projectId: string,
        projectName: string
    ): ProjectSettings {
        return {
            serverUrl: validateServerUrl(serverUrl || DEFAULT_SERVER).url,
            projectId,
            projectName,
            autoSync: true,
        };
    }

    /**
     * Get the path to a relative file in the workspace
     */
    getFilePath(relativePath: string): vscode.Uri {
        const canonicalPath = normalizeProjectPath(relativePath, false);
        const candidate = vscode.Uri.joinPath(this.workspaceFolder, canonicalPath.slice(1));
        const workspacePath = this.workspaceFolder.path.replace(/\/+$/, '');
        const candidatePath = candidate.path.replace(/\/+$/, '');
        const isContained = candidate.scheme === this.workspaceFolder.scheme
            && candidate.authority === this.workspaceFolder.authority
            && candidatePath.startsWith(`${workspacePath}/`);
        if (!isContained) {
            throw new Error(`Refusing to access a path outside the LocalLeaf workspace: ${relativePath}`);
        }
        return candidate;
    }

    /**
     * Convert an absolute URI to a relative path
     */
    getRelativePath(uri: vscode.Uri): string | undefined {
        if (uri.scheme !== this.workspaceFolder.scheme || uri.authority !== this.workspaceFolder.authority) {
            return undefined;
        }
        const workspacePath = this.workspaceFolder.path.replace(/\/+$/, '');
        if (uri.path === workspacePath) return '/';
        if (!uri.path.startsWith(`${workspacePath}/`)) return undefined;
        return normalizeProjectPath(uri.path.slice(workspacePath.length));
    }

    /**
     * Update last synced timestamp
     */
    async updateLastSynced(): Promise<void> {
        await this.update({ lastSynced: new Date().toISOString() });
    }

    private static async collectLinkedProjectFolders(
        uri: vscode.Uri,
        workspaceFolder: vscode.Uri,
        depth: number,
        maxDepth: number,
        seen: Set<string>,
        results: DetectedLocalLeafProject[],
    ): Promise<void> {
        const key = uri.toString();
        if (seen.has(key)) return;
        seen.add(key);

        const settings = await SettingsManager.loadSettings(uri);
        if (settings) {
            const relativePath = path.relative(workspaceFolder.fsPath, uri.fsPath)
                .split(path.sep)
                .join('/') || path.basename(uri.fsPath);
            results.push({ uri, workspaceFolder, relativePath, settings });
            return;
        }
        if (depth >= maxDepth) return;

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(uri);
        } catch {
            return;
        }
        await Promise.all(entries
            .filter(([name, type]) => SettingsManager.shouldScanChildDirectory(name, type))
            .map(([name]) => SettingsManager.collectLinkedProjectFolders(
                vscode.Uri.joinPath(uri, name),
                workspaceFolder,
                depth + 1,
                maxDepth,
                seen,
                results,
            )));
    }

    private static shouldScanChildDirectory(name: string, type: vscode.FileType): boolean {
        return (type & vscode.FileType.Directory) !== 0
            && (type & vscode.FileType.SymbolicLink) === 0
            && name !== CONFIG_DIR
            && name !== '.git'
            && name !== 'node_modules';
    }
}

/**
 * Watch for settings file changes
 */
export function createSettingsWatcher(
    workspaceFolder: vscode.Uri,
    onSettingsChanged: () => void
): vscode.FileSystemWatcher {
    const pattern = new vscode.RelativePattern(
        workspaceFolder.path,
        `${CONFIG_DIR}/${SETTINGS_FILE}`
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(onSettingsChanged);
    watcher.onDidCreate(onSettingsChanged);
    watcher.onDidDelete(onSettingsChanged);

    return watcher;
}
