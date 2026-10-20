// The VS Code implementations of the core's host services (see src/core/host.ts).
import * as vscode from 'vscode';
import type { Localizer, SettingScope, Settings } from '../core/host';
import { setLocalizer, setSettings } from '../core/services';
import { setLogSink } from '../util/logger';

const TARGET: Record<SettingScope, vscode.ConfigurationTarget> = {
  global: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
  folder: vscode.ConfigurationTarget.WorkspaceFolder,
};

export const vsCodeSettings: Settings = {
  get: (key, fallback) => vscode.workspace.getConfiguration('cockpitDaemon').get(key, fallback),
  update: (key, value, scope = 'global') =>
    vscode.workspace.getConfiguration('cockpitDaemon').update(key, value, TARGET[scope]),
};

export const vsCodeLocalizer: Localizer = {
  t: (message, ...args) => vscode.l10n.t(message, ...args),
  language: () => vscode.env.language,
};

/** Registers the VS Code services with the core. Called first thing in `activate`. */
export function registerVsCodeServices(): void {
  setSettings(vsCodeSettings);
  setLocalizer(vsCodeLocalizer);
  const channel = vscode.window.createOutputChannel('Cockpit for Claude Code');
  setLogSink((line) => channel.appendLine(line));
}
