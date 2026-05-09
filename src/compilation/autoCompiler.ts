/**
 * LocalLeaf Auto Compiler
 * Watches for .tex/.bib file saves and triggers compilation with debouncing
 */

import * as vscode from 'vscode';
import { LatexCompiler, CompilationResult } from './latexCompiler';

export class AutoCompiler implements vscode.Disposable {
    private debounceTimer: NodeJS.Timeout | undefined;
    private isCompiling: boolean = false;
    private pendingCompile: boolean = false;
    private disposables: vscode.Disposable[] = [];
    private enabled: boolean = false;
    private workspaceFolder?: vscode.Uri;
    private mainTex?: string;
    private debounceDelay: number = 1500;

    private _onDidCompile = new vscode.EventEmitter<CompilationResult>();
    readonly onDidCompile = this._onDidCompile.event;

    private _onWillCompile = new vscode.EventEmitter<void>();
    readonly onWillCompile = this._onWillCompile.event;

    constructor(private compiler: LatexCompiler) {}

    /**
     * Enable auto-compilation on file save
     */
    enable(workspaceFolder: vscode.Uri, mainTex: string, debounceDelay?: number): void {
        this.disable(); // Clean up any previous watchers

        this.workspaceFolder = workspaceFolder;
        this.mainTex = mainTex;
        this.enabled = true;
        if (debounceDelay !== undefined) {
            this.debounceDelay = debounceDelay;
        }

        // Watch for relevant file saves
        const saveHandler = vscode.workspace.onDidSaveTextDocument(doc => {
            if (!this.enabled) return;

            const ext = doc.uri.fsPath.toLowerCase();
            const isRelevant = ext.endsWith('.tex') ||
                ext.endsWith('.bib') ||
                ext.endsWith('.sty') ||
                ext.endsWith('.cls');

            if (isRelevant) {
                this.scheduleCompilation();
            }
        });

        this.disposables.push(saveHandler);
    }

    /**
     * Disable auto-compilation
     */
    disable(): void {
        this.enabled = false;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    /**
     * Check if auto-compile is enabled
     */
    get isEnabled(): boolean {
        return this.enabled;
    }

    private scheduleCompilation(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            this.runCompilation();
        }, this.debounceDelay);
    }

    private async runCompilation(): Promise<void> {
        if (!this.workspaceFolder || !this.mainTex) return;

        if (this.isCompiling) {
            this.pendingCompile = true;
            return;
        }

        this.isCompiling = true;
        this._onWillCompile.fire();

        try {
            const result = await this.compiler.compile(
                this.workspaceFolder.fsPath,
                this.mainTex,
            );
            this._onDidCompile.fire(result);
        } finally {
            this.isCompiling = false;

            // If another save happened during compilation, compile again
            if (this.pendingCompile) {
                this.pendingCompile = false;
                this.runCompilation();
            }
        }
    }

    dispose(): void {
        this.disable();
        this._onDidCompile.dispose();
        this._onWillCompile.dispose();
    }
}
