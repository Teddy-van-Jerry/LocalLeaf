/**
 * LocalLeaf Settings Manager
 * Handles .localleaf/settings.json configuration
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CONFIG_DIR, SETTINGS_FILE, DEFAULT_SERVER } from '../consts';

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
    syncMode?: 'manual' | 'realtime';
    lastSynced?: string;
    compiler?: 'auto' | 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex';
    compileOnSave?: boolean;
}

/**
 * A linked LocalLeaf project discovered in the current VS Code workspace.
 */
export interface DetectedLocalLeafProject {
    uri: vscode.Uri;
    workspaceFolder: vscode.Uri;
    relativePath: string;
    settings?: ProjectSettings;
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

    /**
     * Set the LocalLeaf project root used by "current project" commands.
     * This may be a child folder of the opened VS Code workspace folder.
     */
    static setCurrentWorkspaceFolder(workspaceFolder: vscode.Uri | undefined): void {
        if (workspaceFolder?.scheme === 'file') {
            SettingsManager.currentWorkspaceFolder = workspaceFolder;
        } else {
            SettingsManager.currentWorkspaceFolder = undefined;
        }
    }

    /**
     * Forget the selected LocalLeaf project root.
     */
    static clearCurrentWorkspaceFolder(): void {
        SettingsManager.currentWorkspaceFolder = undefined;
    }

    /**
     * Check whether a folder contains LocalLeaf settings.
     */
    static async isLinkedFolder(workspaceFolder: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR, SETTINGS_FILE));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Load project settings for an arbitrary LocalLeaf project folder.
     */
    static async loadSettings(workspaceFolder: vscode.Uri): Promise<ProjectSettings | undefined> {
        try {
            const content = await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR, SETTINGS_FILE)
            );
            return JSON.parse(new TextDecoder().decode(content));
        } catch {
            return undefined;
        }
    }

    /**
     * Find linked LocalLeaf project folders in the opened workspace.
     *
     * The scan is intentionally shallow by default: it covers the workspace
     * folder itself and its direct children, which matches the common
     * "open a parent folder containing project folders" workflow without
     * walking large dependency trees.
     */
    static async findLinkedProjectFolders(maxDepth: number = 1): Promise<DetectedLocalLeafProject[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders
            ?.map(folder => folder.uri)
            .filter(uri => uri.scheme === 'file') ?? [];

        const results: DetectedLocalLeafProject[] = [];
        const seen = new Set<string>();

        for (const workspaceFolder of workspaceFolders) {
            await SettingsManager.collectLinkedProjectFolders(
                workspaceFolder,
                workspaceFolder,
                0,
                maxDepth,
                seen,
                results,
            );
        }

        return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }

    /**
     * Resolve the current linked project, auto-selecting a direct workspace
     * folder or the only linked child folder when possible.
     */
    static async resolveCurrentInstance(): Promise<SettingsManager | undefined> {
        if (
            SettingsManager.currentWorkspaceFolder &&
            await SettingsManager.isLinkedFolder(SettingsManager.currentWorkspaceFolder)
        ) {
            return SettingsManager.getInstance(SettingsManager.currentWorkspaceFolder);
        }

        SettingsManager.currentWorkspaceFolder = undefined;

        const workspaceFolders = vscode.workspace.workspaceFolders
            ?.map(folder => folder.uri)
            .filter(uri => uri.scheme === 'file') ?? [];

        for (const workspaceFolder of workspaceFolders) {
            if (await SettingsManager.isLinkedFolder(workspaceFolder)) {
                SettingsManager.setCurrentWorkspaceFolder(workspaceFolder);
                return SettingsManager.getInstance(workspaceFolder);
            }
        }

        const linkedProjects = await SettingsManager.findLinkedProjectFolders();
        if (linkedProjects.length === 1) {
            SettingsManager.setCurrentWorkspaceFolder(linkedProjects[0].uri);
            return SettingsManager.getInstance(linkedProjects[0].uri);
        }

        return undefined;
    }

    /**
     * Get instance for the current workspace (first folder)
     */
    static getCurrentInstance(): SettingsManager | undefined {
        const workspaceFolder = SettingsManager.currentWorkspaceFolder
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
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
        // Ensure config directory exists
        try {
            await vscode.workspace.fs.createDirectory(this.configDir);
        } catch {
            // Directory may already exist
        }

        this.settings = settings;
        const content = new TextEncoder().encode(JSON.stringify(settings, null, 2));
        await vscode.workspace.fs.writeFile(this.settingsFile, content);
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
            await vscode.workspace.fs.delete(this.configDir, { recursive: true });
            this.settings = undefined;
        } catch {
            // Ignore errors
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
            serverUrl: serverUrl || DEFAULT_SERVER,
            projectId,
            projectName,
            mainTex: 'main.tex',
            mainPdf: 'main.pdf',
            autoSync: true,
            syncMode: 'manual',
        };
    }

    /**
     * Get the path to a relative file in the workspace
     */
    getFilePath(relativePath: string): vscode.Uri {
        return vscode.Uri.joinPath(this.workspaceFolder, relativePath);
    }

    /**
     * Convert an absolute URI to a relative path
     */
    getRelativePath(uri: vscode.Uri): string | undefined {
        const workspacePath = this.workspaceFolder.path;
        if (uri.path.startsWith(workspacePath)) {
            return uri.path.slice(workspacePath.length);
        }
        return undefined;
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
        if (seen.has(key)) {
            return;
        }
        seen.add(key);

        const settings = await SettingsManager.loadSettings(uri);
        if (settings) {
            const relativePath = path.relative(workspaceFolder.fsPath, uri.fsPath)
                .split(path.sep)
                .join('/') || path.basename(uri.fsPath);
            results.push({ uri, workspaceFolder, relativePath, settings });
            return;
        }

        if (depth >= maxDepth) {
            return;
        }

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(uri);
        } catch {
            return;
        }

        for (const [name, type] of entries) {
            if (!SettingsManager.shouldScanChildDirectory(name, type)) {
                continue;
            }
            await SettingsManager.collectLinkedProjectFolders(
                vscode.Uri.joinPath(uri, name),
                workspaceFolder,
                depth + 1,
                maxDepth,
                seen,
                results,
            );
        }
    }

    private static shouldScanChildDirectory(name: string, type: vscode.FileType): boolean {
        if ((type & vscode.FileType.Directory) === 0) {
            return false;
        }
        return name !== CONFIG_DIR && name !== '.git' && name !== 'node_modules';
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
