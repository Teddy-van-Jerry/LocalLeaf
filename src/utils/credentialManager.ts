import * as vscode from 'vscode';
import { CREDENTIAL_KEY_PREFIX, DEFAULT_SERVER } from '../consts';

/**
 * Identity contains authentication tokens for Overleaf
 */
export interface Identity {
    csrfToken: string;
    cookies: string;
}

/**
 * Stored credential for a server
 */
export interface ServerCredential {
    serverUrl: string;
    userId: string;
    userEmail: string;
    identity: Identity;
}

/**
 * Credential Manager using VS Code's SecretStorage
 *
 * IMPORTANT: This is completely separate from project/folder configuration.
 * Logging out does NOT affect project settings stored in .localleaf/settings.json
 */
export class CredentialManager {
    private static instance: CredentialManager;
    private secretStorage: vscode.SecretStorage;

    private constructor(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
    }

    static initialize(context: vscode.ExtensionContext): CredentialManager {
        if (!CredentialManager.instance) {
            CredentialManager.instance = new CredentialManager(context);
        }
        return CredentialManager.instance;
    }

    static getInstance(): CredentialManager {
        if (!CredentialManager.instance) {
            throw new Error('CredentialManager not initialized. Call initialize() first.');
        }
        return CredentialManager.instance;
    }

    /**
     * Get the storage key for a server URL
     */
    private getKey(serverUrl: string): string {
        // Normalize server URL
        const normalized = serverUrl.replace(/\/+$/, '').toLowerCase();
        return `${CREDENTIAL_KEY_PREFIX}${normalized}`;
    }

    /**
     * Store credentials for a server
     */
    async storeCredential(credential: ServerCredential): Promise<void> {
        const key = this.getKey(credential.serverUrl);
        await this.secretStorage.store(key, JSON.stringify(credential));
    }

    /**
     * Get credentials for a server
     */
    async getCredential(serverUrl: string): Promise<ServerCredential | undefined> {
        const key = this.getKey(serverUrl);
        const stored = await this.secretStorage.get(key);
        if (stored) {
            try {
                return JSON.parse(stored) as ServerCredential;
            } catch {
                return undefined;
            }
        }
        return undefined;
    }

    /**
     * Delete credentials for a server
     * NOTE: This only removes credentials, NOT project configurations
     */
    async deleteCredential(serverUrl: string): Promise<void> {
        const key = this.getKey(serverUrl);
        await this.secretStorage.delete(key);
    }

    /**
     * Check if credentials exist for a server
     */
    async hasCredential(serverUrl: string): Promise<boolean> {
        const credential = await this.getCredential(serverUrl);
        return credential !== undefined;
    }

    /**
     * Get the default server URL
     */
    getDefaultServer(): string {
        return vscode.workspace.getConfiguration('localleaf').get('defaultServer', DEFAULT_SERVER);
    }

    /**
     * List all stored server URLs
     */
    async listServers(): Promise<string[]> {
        // Note: VS Code SecretStorage doesn't provide a way to list all keys
        // We'll need to maintain a separate list in globalState if needed
        // For now, we'll just check the default server
        const servers: string[] = [];
        if (await this.hasCredential(DEFAULT_SERVER)) {
            servers.push(DEFAULT_SERVER);
        }
        return servers;
    }
}
