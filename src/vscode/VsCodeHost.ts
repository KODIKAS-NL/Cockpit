// EditorHost on the VS Code API (see src/core/host.ts).
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRef, isRefWorthy } from '../../shared/codeRef';
import type { DiffSide, EditorHost, NotifyLevel, SelectionInfo } from '../core/host';

const DIFF_SCHEME = 'cockpit-diff';

export class VsCodeHost implements EditorHost {
  // Virtual content (the "proposed" side) of the native diff, per URI.
  private diffContent = new Map<string, string>();
  private diffProviderReg?: vscode.Disposable;
  private diffSeq = 0;

  // --- Messages ---
  notify(level: NotifyLevel, message: string, ...actions: string[]): PromiseLike<string | undefined> {
    const w = vscode.window;
    return level === 'error'
      ? w.showErrorMessage(message, ...actions)
      : level === 'warning'
        ? w.showWarningMessage(message, ...actions)
        : w.showInformationMessage(message, ...actions);
  }

  hideNotifications(): void {
    void vscode.commands.executeCommand('notifications.hideToasts');
  }

  inputBox(opts: { title?: string; prompt?: string; placeholder?: string; value?: string; password?: boolean }) {
    return vscode.window.showInputBox({
      title: opts.title,
      prompt: opts.prompt,
      password: opts.password,
      value: opts.value,
      ignoreFocusOut: true,
      placeHolder: opts.placeholder,
    });
  }

  saveDialog(opts: { defaultPath: string; filters?: Record<string, string[]> }): PromiseLike<string | undefined> {
    return vscode.window
      .showSaveDialog({ defaultUri: vscode.Uri.file(opts.defaultPath), filters: opts.filters })
      .then((uri) => uri?.fsPath);
  }

  withProgress<T>(
    title: string,
    task: (progress: { report(increment: number, message: string): void; onCancel(fn: () => void): void }) => Promise<T>,
    opts?: { cancellable?: boolean },
  ): PromiseLike<T> {
    return vscode.window.withProgress<T>(
      { location: vscode.ProgressLocation.Notification, title, cancellable: !!opts?.cancellable },
      (progress, token) =>
        task({
          report: (increment, message) => progress.report({ increment, message }),
          onCancel: (fn) => {
            token.onCancellationRequested(fn);
          },
        }),
    );
  }

  // --- Workspace ---
  workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  relativePath(absPath: string): string {
    return vscode.workspace.asRelativePath(vscode.Uri.file(absPath), false);
  }

  findFiles(glob: string, exclude: string, max: number): PromiseLike<string[]> {
    return vscode.workspace.findFiles(glob, exclude, max).then((uris) => uris.map((u) => u.fsPath));
  }

  saveIfDirty(absPath: string): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && doc.uri.fsPath === absPath) {
        void doc.save();
        return;
      }
    }
  }

  // --- Editor ---
  async openFile(absPath: string, opts?: { line?: number; preview?: boolean }): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: opts?.preview ?? true });
    if (opts?.line) {
      const pos = new vscode.Position(Math.max(0, opts.line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  openQuietly(absPath: string): void {
    const uri = vscode.Uri.file(absPath);
    if (hasMarkdownAssociation()) {
      void vscode.commands.executeCommand('vscode.open', uri, { preview: true, preserveFocus: true });
    } else {
      void vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    }
  }

  async previewFile(absPath: string): Promise<void> {
    // Markdown -> native preview, unless the user chose an editor for Markdown files
    // (workbench.editorAssociations): then their choice opens it. VS Code itself falls back to the
    // text editor when that editor does not exist in this version. The rest -> default opener.
    const uri = vscode.Uri.file(absPath);
    const cmd = /\.(md|markdown)$/i.test(absPath) && !hasMarkdownAssociation() ? 'markdown.showPreview' : 'vscode.open';
    try {
      await vscode.commands.executeCommand(cmd, uri);
    } catch {
      void vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  async showDiff(left: DiffSide, right: DiffSide, name: string, title: string): Promise<void> {
    // Lazy provider of the virtual scheme for in-memory sides.
    if (!this.diffProviderReg) {
      this.diffProviderReg = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
        provideTextDocumentContent: (uri) => this.diffContent.get(uri.toString()) ?? '',
      });
    }
    const toUri = (side: DiffSide, label: string): vscode.Uri => {
      if ('path' in side) return vscode.Uri.file(side.path);
      const u = vscode.Uri.parse(`${DIFF_SCHEME}:/${this.diffSeq++}/${label}${path.basename(name)}`);
      this.diffContent.set(u.toString(), side.text);
      return u;
    };
    // The right side is made first: the sequence numbers keep the order they always had.
    const rightUri = toUri(right, '');
    const leftUri = toUri(left, 'old-');
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
  }

  onSelection(listener: (sel: SelectionInfo | undefined) => void): vscode.Disposable {
    const emit = (ed: vscode.TextEditor) => {
      const sel = ed.selection;
      if (ed.document.uri.scheme === 'file' && !sel.isEmpty) {
        listener({
          path: vscode.workspace.asRelativePath(ed.document.uri, false),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
          endChar: sel.end.character,
          docKey: ed.document.uri.toString(),
        });
      } else {
        listener(undefined);
      }
    };
    return vscode.Disposable.from(
      vscode.window.onDidChangeTextEditorSelection((e) => emit(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) emit(ed);
      }),
    );
  }

  onTabsChanged(listener: () => void): vscode.Disposable {
    return vscode.window.tabGroups.onDidChangeTabs(() => listener());
  }

  isDocumentOpen(docKey: string): boolean {
    return vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => {
        const input = t.input;
        return (
          (input instanceof vscode.TabInputText && input.uri.toString() === docKey) ||
          (input instanceof vscode.TabInputTextDiff &&
            (input.modified.toString() === docKey || input.original.toString() === docKey))
        );
      }),
    );
  }

  onCopySource(listener: (text: string, ref: string) => void): vscode.Disposable {
    if (typeof vscode.languages.registerDocumentPasteEditProvider !== 'function') {
      return { dispose: () => undefined };
    }
    return vscode.languages.registerDocumentPasteEditProvider(
      { scheme: 'file' },
      {
        prepareDocumentPaste: (doc, ranges) => {
          const r = ranges[0];
          if (ranges.length !== 1 || !r) return;
          const text = doc.getText(r);
          if (!isRefWorthy(text, r.start.line + 1, r.end.line + 1)) return;
          const rel = vscode.workspace.asRelativePath(doc.uri, false);
          listener(text, buildRef(rel, r.start.line + 1, r.end.line + 1, r.end.character));
        },
      },
      { providedPasteEditKinds: [], copyMimeTypes: ['application/vnd.cockpit.copy-source'] },
    );
  }

  // --- Shell and environment ---
  runInTerminal(name: string, command: string): void {
    const term = vscode.window.createTerminal(name);
    term.show();
    term.sendText(command);
  }

  openExternal(url: string): void {
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  openPath(absPath: string): void {
    void vscode.env.openExternal(vscode.Uri.file(absPath));
  }

  isLocalUi(): boolean {
    return !vscode.env.remoteName && vscode.env.uiKind !== vscode.UIKind.Web;
  }

  isWebUi(): boolean {
    return vscode.env.uiKind === vscode.UIKind.Web;
  }

  openSettings(): void {
    void vscode.commands.executeCommand('cockpitDaemon.settings');
  }

  installDaemon(): void {
    void vscode.commands.executeCommand('cockpitDaemon.daemon.install');
  }
}

/** The user picked an editor for Markdown files (`*.md`, `*.{md,…}`) in workbench.editorAssociations. */
export function hasMarkdownAssociation(): boolean {
  const assoc = vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('editorAssociations') ?? {};
  return Object.keys(assoc).some((k) => /(^|[*{,.])(md|markdown)([,}]|$)/.test(k));
}
