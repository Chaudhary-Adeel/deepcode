/**
 * Minimal mock of the `vscode` module for unit tests.
 * Only stubs the APIs used by DeepCode source files.
 */

export const workspace = {
    workspaceFolders: [],
    getConfiguration: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(''),
        update: jest.fn(),
    }),
    fs: {
        readFile: jest.fn().mockResolvedValue(Buffer.from('')),
        writeFile: jest.fn().mockResolvedValue(undefined),
        stat: jest.fn().mockResolvedValue({ mtime: 0 }),
        createDirectory: jest.fn().mockResolvedValue(undefined),
    },
    onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidCreateFiles: jest.fn(() => ({ dispose: jest.fn() })),
    onDidDeleteFiles: jest.fn(() => ({ dispose: jest.fn() })),
    onDidRenameFiles: jest.fn(() => ({ dispose: jest.fn() })),
};

export const window = {
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    createOutputChannel: jest.fn(() => ({
        appendLine: jest.fn(),
        append: jest.fn(),
        show: jest.fn(),
        dispose: jest.fn(),
    })),
    showInputBox: jest.fn(),
    showQuickPick: jest.fn(),
    createStatusBarItem: jest.fn(() => ({
        text: '',
        tooltip: '',
        command: '',
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
    })),
    withProgress: jest.fn((_opts: any, task: any) => task({ report: jest.fn() })),
};

export const Uri = {
    file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
    parse: (str: string) => ({ fsPath: str, scheme: 'file', path: str }),
};

export const EventEmitter = class {
    private listeners: Array<(...args: any[]) => void> = [];
    event = (listener: (...args: any[]) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data: any) { this.listeners.forEach(l => l(data)); }
    dispose() { this.listeners = []; }
};

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export const languages = {
    getDiagnostics: jest.fn().mockReturnValue([]),
};

export const commands = {
    registerCommand: jest.fn(),
    executeCommand: jest.fn(),
};

export const extensions = {
    getExtension: jest.fn(),
};

export class CancellationTokenSource {
    token = { isCancellationRequested: false };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
}

export class Disposable {
    static from(...disposables: { dispose: () => void }[]) {
        return { dispose: () => disposables.forEach(d => d.dispose()) };
    }
    constructor(private callOnDispose: () => void) {}
    dispose() { this.callOnDispose(); }
}
