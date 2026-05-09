import * as fs from 'fs/promises';
import * as path from 'path';
import { CONFIG_DIR } from '../consts';

const STATE_FILE = 'sync-state.json';
const BASE_DIR = 'base';
const STATE_VERSION = 1;

export type BaselineEntityType = 'doc' | 'file' | 'folder';

export interface BaselineEntry {
    path: string;
    entityId?: string;
    entityType?: BaselineEntityType;
    hash: number;
    timestamp: number;
}

export interface BaselineSnapshot {
    version: number;
    entries: BaselineEntry[];
}

export interface BaselineReplacement {
    entry: BaselineEntry;
    content?: Uint8Array;
}

interface StoredBaselineSnapshot {
    version?: number;
    entries?: BaselineEntry[];
}

export class SyncBaselineStore {
    private entries: Map<string, BaselineEntry> = new Map();
    private readonly statePath: string;
    private readonly baseDir: string;

    constructor(private readonly workspaceFsPath: string) {
        const configDir = path.join(workspaceFsPath, CONFIG_DIR);
        this.statePath = path.join(configDir, STATE_FILE);
        this.baseDir = path.join(configDir, BASE_DIR);
    }

    async load(): Promise<BaselineSnapshot> {
        this.entries.clear();

        try {
            const raw = await fs.readFile(this.statePath, 'utf8');
            const parsed = JSON.parse(raw) as StoredBaselineSnapshot;
            for (const entry of parsed.entries ?? []) {
                if (!entry.path) {
                    continue;
                }
                this.entries.set(entry.path, { ...entry });
            }
        } catch (error) {
            if (!isNotFoundError(error)) {
                throw error;
            }
        }

        return this.snapshot();
    }

    snapshot(): BaselineSnapshot {
        return {
            version: STATE_VERSION,
            entries: Array.from(this.entries.values()).sort((a, b) => a.path.localeCompare(b.path)),
        };
    }

    has(pathName: string): boolean {
        return this.entries.has(pathName);
    }

    getEntry(pathName: string): BaselineEntry | undefined {
        const entry = this.entries.get(pathName);
        return entry ? { ...entry } : undefined;
    }

    async getContent(pathName: string): Promise<Buffer | undefined> {
        try {
            return await fs.readFile(this.contentPath(pathName));
        } catch (error) {
            if (isNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }
    }

    async setEntry(entryPath: string, entry: BaselineEntry, content?: Uint8Array): Promise<void> {
        const normalized = normalizeSyncPath(entryPath);
        this.entries.set(normalized, { ...entry, path: normalized });

        if (content !== undefined) {
            await fs.mkdir(this.baseDir, { recursive: true });
            await fs.writeFile(this.contentPath(normalized), Buffer.from(content));
        }

        await this.save();
    }

    async deletePrefix(prefix: string): Promise<void> {
        const normalizedPrefix = normalizeSyncPath(prefix);
        const paths = Array.from(this.entries.keys())
            .filter(entryPath => matchesPrefix(entryPath, normalizedPrefix));

        for (const entryPath of paths) {
            this.entries.delete(entryPath);
            await this.deleteContent(entryPath);
        }

        await this.save();
    }

    async movePrefix(oldPrefix: string, newPrefix: string): Promise<void> {
        const normalizedOldPrefix = normalizeSyncPath(oldPrefix);
        const normalizedNewPrefix = normalizeSyncPath(newPrefix);
        const moves = Array.from(this.entries.values())
            .filter(entry => matchesPrefix(entry.path, normalizedOldPrefix))
            .map(entry => ({
                entry,
                oldPath: entry.path,
                newPath: entry.path === normalizedOldPrefix
                    ? normalizedNewPrefix
                    : normalizedNewPrefix + entry.path.slice(normalizedOldPrefix.length),
            }));

        for (const move of moves) {
            this.entries.delete(move.oldPath);
        }

        for (const move of moves) {
            this.entries.set(move.newPath, { ...move.entry, path: move.newPath });
            await this.moveContent(move.oldPath, move.newPath);
        }

        await this.save();
    }

    async replaceAll(replacements: BaselineReplacement[]): Promise<void> {
        this.entries.clear();
        await fs.rm(this.baseDir, { recursive: true, force: true });

        for (const replacement of replacements) {
            const normalized = normalizeSyncPath(replacement.entry.path);
            this.entries.set(normalized, { ...replacement.entry, path: normalized });
            if (replacement.content !== undefined) {
                await fs.mkdir(this.baseDir, { recursive: true });
                await fs.writeFile(this.contentPath(normalized), Buffer.from(replacement.content));
            }
        }

        await this.save();
    }

    private async save(): Promise<void> {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        const content = JSON.stringify(this.snapshot(), null, 2);
        await fs.writeFile(this.statePath, `${content}\n`, 'utf8');
    }

    private contentPath(pathName: string): string {
        return path.join(this.baseDir, Buffer.from(pathName).toString('base64url'));
    }

    private async deleteContent(pathName: string): Promise<void> {
        try {
            await fs.rm(this.contentPath(pathName), { force: true });
        } catch (error) {
            if (!isNotFoundError(error)) {
                throw error;
            }
        }
    }

    private async moveContent(oldPath: string, newPath: string): Promise<void> {
        try {
            await fs.mkdir(this.baseDir, { recursive: true });
            await fs.rename(this.contentPath(oldPath), this.contentPath(newPath));
        } catch (error) {
            if (!isNotFoundError(error)) {
                throw error;
            }
        }
    }
}

function normalizeSyncPath(pathName: string): string {
    return pathName.startsWith('/') ? pathName : `/${pathName}`;
}

function matchesPrefix(pathName: string, prefix: string): boolean {
    return pathName === prefix || pathName.startsWith(prefix);
}

function isNotFoundError(error: unknown): boolean {
    return !!error &&
        typeof error === 'object' &&
        'code' in error &&
        ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
            (error as NodeJS.ErrnoException).code === 'ENOTDIR');
}
