import { ItemView, Platform, type App, type Workspace, type WorkspaceLeaf } from 'obsidian';
import { CapturePanel } from './capture-panel';
import { translate } from './i18n';
import type { SidebarHost } from './types';

export const CAPTURE_VIEW_TYPE = 'tangrow-capture';
const openingWindows = new WeakMap<Workspace, Promise<void>>();
const windowSize = { size: { width: 460, height: 760 } };

export class TangrowCapture extends ItemView {
  private panel?: CapturePanel;

  constructor(leaf: WorkspaceLeaf, private readonly host: SidebarHost) { super(leaf); }

  getViewType(): string { return CAPTURE_VIEW_TYPE; }
  getDisplayText(): string { return translate(this.host.settings.language, 'Capture window'); }
  getIcon(): string { return 'notebook-pen'; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('tangrow-capture-window');
    this.panel = new CapturePanel(this.host, { allowPopout: false });
    this.panel.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.panel?.destroy();
    this.panel = undefined;
    this.contentEl.empty();
  }

  refreshLanguage(): void { this.panel?.refresh(); }
}

export function openCaptureWindow(app: App, _host: SidebarHost): Promise<void> {
  const workspace = app.workspace;
  const pending = openingWindows.get(workspace);
  if (pending) return pending;
  const opening = Promise.resolve().then(async () => {
    const existing = workspace.getLeavesOfType(CAPTURE_VIEW_TYPE)[0];
    const leaf = existing ?? (Platform.isDesktopApp ? workspace.openPopoutLeaf(windowSize) : workspace.getLeaf('tab'));
    try {
      if (!existing) await leaf.setViewState({ type: CAPTURE_VIEW_TYPE, active: true });
      if (existing && Platform.isDesktopApp && leaf.getContainer() === workspace.rootSplit) {
        workspace.moveLeafToPopout(leaf, windowSize);
      }
      await workspace.revealLeaf(leaf);
      leaf.getContainer().win.focus();
    } catch (error) {
      if (!existing) leaf.detach();
      throw error;
    }
  });
  openingWindows.set(workspace, opening);
  void opening.then(
    () => openingWindows.delete(workspace),
    () => openingWindows.delete(workspace)
  );
  return opening;
}
