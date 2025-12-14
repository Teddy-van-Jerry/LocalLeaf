/**
 * LocalLeaf Ignore Parser
 * Parses .leafignore files with support for $MAIN_TEX and $MAIN_PDF variables
 */

import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { IGNORE_FILE, VAR_MAIN_TEX, VAR_MAIN_PDF, DEFAULT_IGNORE_PATTERNS } from '../consts';
import { ProjectSettings } from '../utils/settingsManager';

/**
 * Ignore Parser - handles .leafignore patterns
 */
export class IgnoreParser {
    private patterns: string[] = [];
    private resolvedPatterns: string[] = [];

    constructor(
        private readonly workspaceFolder: vscode.Uri,
        private settings?: ProjectSettings
    ) {}

    /**
     * Get the path to .leafignore file
     */
    private getIgnoreFilePath(): vscode.Uri {
        return vscode.Uri.joinPath(this.workspaceFolder, IGNORE_FILE);
    }

    /**
     * Load patterns from .leafignore file
     */
    async load(): Promise<void> {
        try {
            const ignoreFilePath = this.getIgnoreFilePath();
            const content = await vscode.workspace.fs.readFile(ignoreFilePath);
            const text = new TextDecoder().decode(content);
            this.patterns = this.parseIgnoreFile(text);
        } catch {
            // File doesn't exist, use defaults
            this.patterns = [...DEFAULT_IGNORE_PATTERNS];
        }
        this.resolveVariables();
    }

    /**
     * Parse .leafignore file content
     */
    private parseIgnoreFile(content: string): string[] {
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
    }

    /**
     * Resolve variables like $MAIN_TEX and $MAIN_PDF
     */
    private resolveVariables(): void {
        this.resolvedPatterns = this.patterns.map(pattern => {
            let resolved = pattern;

            // Resolve $MAIN_TEX
            if (resolved.includes(VAR_MAIN_TEX)) {
                const mainTex = this.settings?.mainTex || 'main.tex';
                resolved = resolved.replace(VAR_MAIN_TEX, mainTex);
            }

            // Resolve $MAIN_PDF
            if (resolved.includes(VAR_MAIN_PDF)) {
                const mainPdf = this.settings?.mainPdf || 'main.pdf';
                resolved = resolved.replace(VAR_MAIN_PDF, mainPdf);
            }

            return resolved;
        });
    }

    /**
     * Update settings (e.g., when mainTex/mainPdf changes)
     */
    updateSettings(settings: ProjectSettings): void {
        this.settings = settings;
        this.resolveVariables();
    }

    /**
     * Check if a path should be ignored
     */
    shouldIgnore(relativePath: string): boolean {
        // Normalize path (ensure it starts with /)
        const normalizedPath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;

        for (const pattern of this.resolvedPatterns) {
            // Handle patterns that start with / (anchored to root)
            const patternToMatch = pattern.startsWith('/') ? pattern : '**/' + pattern;

            if (minimatch(normalizedPath, patternToMatch, { dot: true })) {
                return true;
            }

            // Also try matching without leading slash
            if (minimatch(normalizedPath.slice(1), pattern, { dot: true })) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get all patterns (raw, unresolved)
     */
    getPatterns(): string[] {
        return [...this.patterns];
    }

    /**
     * Get resolved patterns
     */
    getResolvedPatterns(): string[] {
        return [...this.resolvedPatterns];
    }

    /**
     * Save patterns to .leafignore file
     */
    async save(patterns: string[]): Promise<void> {
        this.patterns = patterns;
        this.resolveVariables();

        const content = patterns.join('\n') + '\n';
        await vscode.workspace.fs.writeFile(
            this.getIgnoreFilePath(),
            new TextEncoder().encode(content)
        );
    }

    /**
     * Create a default .leafignore file
     */
    async createDefault(): Promise<void> {
        const defaultContent = `# LocalLeaf Ignore File
# Patterns work like .gitignore
# Use $MAIN_PDF to reference the main PDF file from settings

# Don't sync the compiled PDF (prevents corruption during local compile)
$MAIN_PDF

# Hidden files and directories
.*
.*/**

# LaTeX build artifacts
*.aux
*.bbl
*.bcf
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.run.xml
*.synctex.gz
*.synctex(busy)
*.toc
*.lof
*.lot
*.xdv

# LocalLeaf config directory
.localleaf/**
`;
        await vscode.workspace.fs.writeFile(
            this.getIgnoreFilePath(),
            new TextEncoder().encode(defaultContent)
        );
        await this.load();
    }

    /**
     * Check if .leafignore file exists
     */
    async exists(): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(this.getIgnoreFilePath());
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Add a pattern to the ignore file
     */
    async addPattern(pattern: string): Promise<void> {
        if (!this.patterns.includes(pattern)) {
            this.patterns.push(pattern);
            await this.save(this.patterns);
        }
    }

    /**
     * Remove a pattern from the ignore file
     */
    async removePattern(pattern: string): Promise<void> {
        const index = this.patterns.indexOf(pattern);
        if (index !== -1) {
            this.patterns.splice(index, 1);
            await this.save(this.patterns);
        }
    }
}

/**
 * Create a watcher for .leafignore file changes
 */
export function createIgnoreWatcher(
    workspaceFolder: vscode.Uri,
    onIgnoreChanged: () => void
): vscode.FileSystemWatcher {
    const pattern = new vscode.RelativePattern(workspaceFolder.path, IGNORE_FILE);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(onIgnoreChanged);
    watcher.onDidCreate(onIgnoreChanged);
    watcher.onDidDelete(onIgnoreChanged);

    return watcher;
}
