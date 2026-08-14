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
    lastSynced?: string;
}

export type StoredProjectSettings = Omit<ProjectSettings, 'autoSync'> & { autoSync?: boolean };

export function isValidProjectSettings(value: unknown): value is StoredProjectSettings {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<StoredProjectSettings>;
    return typeof candidate.serverUrl === 'string' && candidate.serverUrl.trim().length > 0
        && typeof candidate.projectId === 'string' && candidate.projectId.trim().length > 0
        && typeof candidate.projectName === 'string' && candidate.projectName.trim().length > 0
        && (candidate.mainTex === undefined || typeof candidate.mainTex === 'string')
        && (candidate.mainPdf === undefined || typeof candidate.mainPdf === 'string')
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
     * Get instance for the current workspace (first folder)
     */
    static getCurrentInstance(): SettingsManager | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceFolder || workspaceFolder.scheme !== 'file') {
            return undefined;
        }
        return SettingsManager.getInstance(workspaceFolder);
    }

    /**
     * Check if this folder is linked to an Overleaf project
     */
    async isLinked(): Promise<boolean> {
        try {
            const content = await vscode.workspace.fs.readFile(this.settingsFile);
            return isValidProjectSettings(JSON.parse(new TextDecoder().decode(content)));
        } catch {
            return false;
        }
    }

    /**
     * Load settings from disk
     */
    async load(): Promise<ProjectSettings | undefined> {
        try {
            const content = await vscode.workspace.fs.readFile(this.settingsFile);
            const parsed: unknown = JSON.parse(new TextDecoder().decode(content));
            if (!isValidProjectSettings(parsed)) {
                this.settings = undefined;
                return undefined;
            }
            this.settings = { ...parsed, autoSync: parsed.autoSync ?? true };
            return this.settings;
        } catch {
            this.settings = undefined;
            return undefined;
        }
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
            autoSync: true,
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
