import * as path from 'path';
import * as semver from 'semver';
import * as vscode from 'vscode';
import { createParser, ParseResult } from './parser';
import { ThrottledDelayer } from './utils/async';
import { FileMatcher, FileSettings } from './utils/filematcher';
import { getToolVersion, tryPromptForUpdatingTool } from './utils/tool-check';
import * as wsl from './utils/wslSupport';
import { getWorkspaceFolderPath } from './utils/path';


interface ShellCheckSettings {
    enabled: boolean;
    enableQuickFix: boolean;
    executable: string;
    trigger: RunTrigger;
    exclude: string[];
    customArgs: string[];
    ignorePatterns: FileSettings;
    ignoreFileSchemes: Set<string>;
    useWorkspaceRootAsCwd: boolean;
    useWSL: boolean;
}

enum RunTrigger {
    onSave,
    onType,
    manual,
}

namespace RunTrigger {
    export const strings = {
        onSave: 'onSave',
        onType: 'onType',
        manual: 'manual',
    };

    export function from(value: string): RunTrigger {
        switch (value) {
            case strings.onSave:
                return RunTrigger.onSave;
            case strings.onType:
                return RunTrigger.onType;
            default:
                return RunTrigger.manual;
        }
    }
}

namespace CommandIds {
    export const runLint: string = 'shellcheck.runLint';
    export const openRuleDoc: string = 'shellcheck.openRuleDoc';
}

function substitutePath(s: string, workspaceFolder?: string): string {
    if (!workspaceFolder && vscode.workspace.workspaceFolders) {
        workspaceFolder = getWorkspaceFolderPath(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    }

    return s.replace(/\${workspaceRoot}/g, workspaceFolder || '');
}

export default class ShellCheckProvider implements vscode.CodeActionProvider {

    public static LANGUAGE_ID = 'shellscript';
    private channel: vscode.OutputChannel;
    private settings!: ShellCheckSettings;
    private executableNotFound: boolean;
    private toolVersion: semver.SemVer | null;
    private documentListener!: vscode.Disposable;
    private delayers!: { [key: string]: ThrottledDelayer<void> };
    private readonly fileMatcher: FileMatcher;
    private readonly diagnosticCollection: vscode.DiagnosticCollection;
    private readonly codeActionCollection: Map<string, ParseResult[]>;

    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    constructor(private readonly context: vscode.ExtensionContext) {
        this.channel = vscode.window.createOutputChannel('ShellCheck');
        this.executableNotFound = false;
        this.toolVersion = null;
        this.fileMatcher = new FileMatcher();
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
        this.codeActionCollection = new Map();

        // code actions
        context.subscriptions.push(
            vscode.languages.registerCodeActionsProvider('shellscript', this, {
                providedCodeActionKinds: ShellCheckProvider.providedCodeActionKinds,
            }),
        );

        // commands
        context.subscriptions.push(
            vscode.commands.registerCommand(CommandIds.openRuleDoc, async (url: string) => {
                return await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
            }),
            vscode.commands.registerTextEditorCommand(CommandIds.runLint, async (editor) => {
                return await this.triggerLint(editor.document);
            }),
        );

        // event handlers
        vscode.workspace.onDidChangeConfiguration(this.loadConfiguration, this, context.subscriptions);
        vscode.workspace.onDidOpenTextDocument(this.triggerLint, this, context.subscriptions);
        vscode.workspace.onDidCloseTextDocument((textDocument) => {
            this.setCollection(textDocument.uri);
            delete this.delayers[textDocument.uri.toString()];
        }, null, context.subscriptions);

        // populate this.settings
        this.loadConfiguration().then(() => {
            // Shellcheck all open shell documents
            vscode.workspace.textDocuments.forEach(this.triggerLint, this);
        });
    }

    public dispose(): void {
        this.disposeDocumentListener();
        this.diagnosticCollection.clear();
        this.codeActionCollection.clear();
        this.diagnosticCollection.dispose();
        this.channel.dispose();
    }

    private disposeDocumentListener(): void {
        if (this.documentListener) {
            this.documentListener.dispose();
        }
    }

    private async loadConfiguration() {
        const section = vscode.workspace.getConfiguration('shellcheck', null);
        const settings = <ShellCheckSettings>{
            enabled: section.get('enable', true),
            trigger: RunTrigger.from(section.get('run', RunTrigger.strings.onType)),
            executable: substitutePath(section.get('executablePath', 'shellcheck')),
            exclude: section.get('exclude', []),
            customArgs: section.get('customArgs', []),
            ignorePatterns: section.get('ignorePatterns', {}),
            ignoreFileSchemes: new Set(section.get('ignoreFileSchemes', ['git', 'gitfs'])),
            useWorkspaceRootAsCwd: section.get('useWorkspaceRootAsCwd', false),
            useWSL: section.get('useWSL', false),
            enableQuickFix: section.get('enableQuickFix', false),
        };
        this.settings = settings;

        this.fileMatcher.configure(settings.ignorePatterns);
        this.delayers = Object.create(null);

        this.disposeDocumentListener();
        this.diagnosticCollection.clear();
        this.codeActionCollection.clear();
        if (settings.enabled) {
            if (settings.trigger === RunTrigger.onType) {
                this.documentListener = vscode.workspace.onDidChangeTextDocument((e) => {
                    this.triggerLint(e.document);
                }, this, this.context.subscriptions);
            } else if (settings.trigger === RunTrigger.onSave) {
                this.documentListener = vscode.workspace.onDidSaveTextDocument(this.triggerLint, this, this.context.subscriptions);
            }
        }

        // Configuration has changed. Re-evaluate all documents
        this.executableNotFound = false;
        this.toolVersion = await getToolVersion(this.settings.useWSL, this.settings.executable);
        this.channel.appendLine(`[INFO] shellcheck version: ${this.toolVersion}`);
        tryPromptForUpdatingTool(this.toolVersion);
        vscode.workspace.textDocuments.forEach(this.triggerLint, this);
    }

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== 'shellcheck') {
                continue;
            }

            if (typeof diagnostic.code === 'string' && diagnostic.code.startsWith('SC')) {
                const ruleId = diagnostic.code;
                const title = `Show ShellCheck Wiki for ${ruleId}`;
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.command = {
                    title: title,
                    command: CommandIds.openRuleDoc,
                    arguments: [`https://www.shellcheck.net/wiki/${ruleId}`],
                };
                actions.push(action);
            }
        }

        const results = this.codeActionCollection.get(document.uri.toString());
        if (results && results.length) {
            for (const result of results) {
                if (!result.codeAction) {
                    continue;
                }

                if (!result.diagnostic.range.contains(range)) {
                    continue;
                }

                actions.push(result.codeAction);
            }
        }

        return actions;
    }

    private isAllowedTextDocument(textDocument: vscode.TextDocument): boolean {
        if (textDocument.languageId !== ShellCheckProvider.LANGUAGE_ID) {
            return false;
        }

        const scheme = textDocument.uri.scheme;
        return !this.settings.ignoreFileSchemes.has(scheme);
    }

    private triggerLint(textDocument: vscode.TextDocument): void {
        if (this.executableNotFound || !this.isAllowedTextDocument(textDocument)) {
            return;
        }

        if (!this.settings.enabled) {
            this.setCollection(textDocument.uri);
            return;
        }

        if (this.fileMatcher.excludes(textDocument.fileName, getWorkspaceFolderPath(textDocument.uri))) {
            return;
        }

        const key = textDocument.uri.toString();
        let delayer = this.delayers[key];
        if (!delayer) {
            delayer = new ThrottledDelayer<void>(this.settings.trigger === RunTrigger.onType ? 250 : 0);
            this.delayers[key] = delayer;
        }

        delayer.trigger(() => this.runLint(textDocument));
    }

    private runLint(textDocument: vscode.TextDocument): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const settings = this.settings;
            if (settings.useWSL && !wsl.subsystemForLinuxPresent()) {
                if (!this.executableNotFound) {
                    vscode.window.showErrorMessage('Got told to use WSL, but cannot find installation. Bailing out.');
                }
                this.executableNotFound = true;
                resolve();
                return;
            }

            const executable = settings.executable || 'shellcheck';
            const parser = createParser(textDocument, {
                toolVersion: this.toolVersion,
                enableQuickFix: this.settings.enableQuickFix,
            });
            let args = ['-f', parser.outputFormat];
            if (settings.exclude.length) {
                args = args.concat(['-e', settings.exclude.join(',')]);
            }

            // https://github.com/timonwong/vscode-shellcheck/issues/43
            // We should explicit set shellname based on file extension name
            const fileExt = path.extname(textDocument.fileName);
            if (fileExt === '.bash' || fileExt === '.ksh' || fileExt === '.dash') {
                // shellcheck args: specify dialect (sh, bash, dash, ksh)
                args = args.concat(['-s', fileExt.substr(1)]);
            }

            if (settings.customArgs.length) {
                args = args.concat(settings.customArgs);
            }

            args.push('-'); // Use stdin for shellcheck

            let cwd: string | undefined;
            if (settings.useWorkspaceRootAsCwd) {
                cwd = getWorkspaceFolderPath(textDocument.uri);
            } else {
                cwd = textDocument.isUntitled ? getWorkspaceFolderPath(textDocument.uri) : path.dirname(textDocument.fileName);
            }

            const options = cwd ? { cwd: cwd } : undefined;
            // this.channel.appendLine(`[DEBUG] Spawn: ${executable} ${args.join(' ')}`);
            const childProcess = wsl.spawn(settings.useWSL, executable, args, options);
            childProcess.on('error', (error: Error) => {
                if (!this.executableNotFound) {
                    this.showShellCheckError(error, executable);
                }

                this.executableNotFound = true;
                resolve();
                return;
            });

            if (childProcess.pid) {
                childProcess.stdout.setEncoding('utf-8');

                let script = textDocument.getText();
                if (settings.useWSL) {
                    script = script.replace(/\r\n/g, '\n'); // shellcheck doesn't likes CRLF, although this is caused by a git checkout on Windows.
                }
                childProcess.stdin.write(script);
                childProcess.stdin.end();

                const output: string[] = [];
                childProcess.stdout
                    .on('data', (data: Buffer) => {
                        output.push(data.toString());
                    })
                    .on('end', () => {
                        let result: ParseResult[] | null = null;
                        if (output.length) {
                            result = parser.parse(output.join(''));
                        }

                        this.setCollection(textDocument.uri, result);
                        resolve();
                    });
            } else {
                resolve();
            }
        });
    }

    private setCollection(uri: vscode.Uri, results?: ParseResult[] | null) {
        if (!results || !results.length) {
            this.diagnosticCollection.delete(uri);
            this.codeActionCollection.delete(uri.toString());
            return;
        }

        const diagnostics = results.map((result) => result.diagnostic);
        this.diagnosticCollection.set(uri, diagnostics);
        this.codeActionCollection.set(uri.toString(), results);
    }

    private showShellCheckError(error: any, executable: string): void {
        let message: string;
        if (error.code === 'ENOENT') {
            message = `Cannot shellcheck the shell script. The shellcheck program was not found. Use the 'shellcheck.executablePath' setting to configure the location of 'shellcheck' or enable WSL integration with 'shellcheck.useWSL'`;
        } else {
            message = error.message ? error.message : `Failed to run shellcheck using path: ${executable}. Reason is unknown.`;
        }

        vscode.window.showInformationMessage(message);
    }
}
