import * as vscode from 'vscode';
import { CREDENTIAL_KEY_PREFIX, DEFAULT_SERVER } from '../consts';
import { validateServerUrl } from './serverUrl';

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
        const normalized = validateServerUrl(serverUrl).url;
        return `${CREDENTIAL_KEY_PREFIX}${normalized}`;
    }

    private getLegacyKey(serverUrl: string): string {
        return `${CREDENTIAL_KEY_PREFIX}${validateServerUrl(serverUrl).url.toLowerCase()}`;
    }

    private validateCredential(value: unknown, expectedServerUrl?: string): ServerCredential | undefined {
        if (!value || typeof value !== 'object') return undefined;
        const credential = value as Partial<ServerCredential>;
        let serverUrl: string;
        try {
            serverUrl = validateServerUrl(credential.serverUrl || '').url;
        } catch {
            return undefined;
        }
        if (expectedServerUrl && serverUrl !== validateServerUrl(expectedServerUrl).url) return undefined;
        if (
            typeof credential.userId !== 'string'
            || credential.userId.length > 4096
            || typeof credential.userEmail !== 'string'
            || credential.userEmail.length > 4096
            || !credential.identity
            || typeof credential.identity.csrfToken !== 'string'
            || credential.identity.csrfToken.length === 0
            || credential.identity.csrfToken.length > 65536
            || /[\r\n\0]/.test(credential.identity.csrfToken)
            || typeof credential.identity.cookies !== 'string'
            || credential.identity.cookies.length === 0
            || credential.identity.cookies.length > 65536
            || /[\r\n\0]/.test(credential.identity.cookies)
        ) {
            return undefined;
        }
        return {
            serverUrl,
            userId: credential.userId,
            userEmail: credential.userEmail,
            identity: {
                csrfToken: credential.identity.csrfToken,
                cookies: credential.identity.cookies,
            },
        };
    }

    /**
     * Store credentials for a server
     */
    async storeCredential(credential: ServerCredential): Promise<void> {
        const validated = this.validateCredential(credential);
        if (!validated) throw new Error('Refusing to store invalid Overleaf credentials.');
        const key = this.getKey(validated.serverUrl);
        await this.secretStorage.store(key, JSON.stringify(validated));
    }

    /**
     * Get credentials for a server
     */
    async getCredential(serverUrl: string): Promise<ServerCredential | undefined> {
        const key = this.getKey(serverUrl);
        const legacyKey = this.getLegacyKey(serverUrl);
        const stored = await this.secretStorage.get(key)
            ?? (legacyKey !== key ? await this.secretStorage.get(legacyKey) : undefined);
        if (stored) {
            try {
                return this.validateCredential(JSON.parse(stored), serverUrl);
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
        const legacyKey = this.getLegacyKey(serverUrl);
        if (legacyKey !== key) await this.secretStorage.delete(legacyKey);
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
        const configured = vscode.workspace.getConfiguration('localleaf').get('defaultServer', DEFAULT_SERVER);
        try {
            return validateServerUrl(configured).url;
        } catch {
            return DEFAULT_SERVER;
        }
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
