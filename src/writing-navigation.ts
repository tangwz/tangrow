import { FileView, type Workspace, type WorkspaceLeaf } from 'obsidian';
import type { WritingSaveOrigin } from './types';

export interface WritingNavigation {
  destination(): WorkspaceLeaf | null;
  dispose(): void;
}

export function captureWritingNavigation(workspace: Workspace, origin?: WritingSaveOrigin): WritingNavigation {
  const unavailable: WritingNavigation = { destination: () => null, dispose: () => undefined };
  if (!origin) return unavailable;
  let dispose = (): void => undefined;
  try {
    const source = origin.leaf;
    const editor = origin.editor;
    const sourceView = source.view;
    const document = editor.ownerDocument;
    const container = source.getContainer();
    const target = workspace.getMostRecentLeaf(container);
    // A missing or non-file target leaves the saved draft available in Studio history.
    if (!target || target.view.containerEl.ownerDocument !== document || !(target.view instanceof FileView)) return unavailable;
    const targetView = target.view;
    const file = targetView.file;
    const active = document.activeElement;
    const window = document.defaultView;
    let eligible = true;
    const current = (): boolean => {
      let sourceExists = false;
      let targetExists = false;
      workspace.iterateAllLeaves((leaf) => {
        if (leaf === source) sourceExists = true;
        if (leaf === target) targetExists = true;
      });
      return eligible && sourceExists && targetExists && source.view === sourceView && source.getContainer() === container
        && editor.isConnected && !editor.readOnly && editor.ownerDocument === document
        && sourceView.containerEl.isConnected && sourceView.containerEl.ownerDocument === document && sourceView.containerEl.contains(editor)
        && target.getContainer() === container && target.view === targetView && targetView.file === file
        && targetView.containerEl.isConnected && targetView.containerEl.ownerDocument === document
        && workspace.getMostRecentLeaf(container) === target && !target.getViewState().pinned
        && window !== null && !window.closed && !document.hidden && document.hasFocus() && document.activeElement === active;
    };
    if (!current()) return unavailable;
    const revoke = (): void => { eligible = false; };
    const focus = (): void => { if (document.activeElement !== active) revoke(); };
    const visibility = (): void => { if (document.hidden) revoke(); };
    dispose = (): void => {
      revoke();
      try {
        window?.removeEventListener('blur', revoke);
        document.removeEventListener('focusin', focus);
        document.removeEventListener('visibilitychange', visibility);
        document.removeEventListener('compositionstart', revoke, true);
      } catch { /* A disposed window cannot retain navigation permission. */ }
    };
    window?.addEventListener('blur', revoke);
    document.addEventListener('focusin', focus);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('compositionstart', revoke, true);
    return {
      destination: () => {
        try { return current() ? target : null; }
        catch { return null; }
      },
      dispose
    };
  } catch {
    // Navigation context is optional; an unavailable window must never prevent saving.
    dispose();
    return unavailable;
  }
}
