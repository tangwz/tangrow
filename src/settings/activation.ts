import { Modal, Notice } from 'obsidian';
import type { AccessResult } from '../access';
import type TangrowPlugin from '../main';
import { settingRows } from './sections';

const stateLabels = {
  not_started: 'Trial not started',
  trial: 'Trial in progress',
  expired: 'Trial expired',
  active: 'Activated',
  needs_network: 'Internet connection required'
} as const;

const errorLabels: Record<string, string> = {
  invalid_code: 'Check your redemption code and try again.',
  revoked: 'This redemption code has been revoked.',
  rate_limited: 'Too many requests. Try again later.',
  storage: 'Tangrow could not save access on this device.',
  unavailable: 'The trial is unavailable on this device.',
  no_lease: 'There is no activation to renew or release on this device.',
  timeout: 'The activation service timed out. Try again.',
  upstream_unavailable: 'The activation service is temporarily unavailable. Try again later.',
  request_failed: 'Could not reach the activation service. Check your connection and try again.',
  invalid_response: 'The activation service returned an unexpected response.',
  bad_request: 'The activation service rejected the request.',
  stale: 'Access changed during the request. Try again.'
};

export function renderAccessStatus(container: HTMLElement, plugin: TangrowPlugin): void {
  const { state } = plugin.access.snapshot();
  container.empty();
  container.createSpan({ cls: `tangrow-settings-dot is-${state}`, attr: { 'aria-hidden': 'true' } });
  container.createSpan({ text: plugin.t(stateLabels[state]) });
}

class ReleaseConfirmation extends Modal {
  constructor(private host: TangrowPlugin, private release: () => void) { super(host.app); }

  onOpen(): void {
    this.setTitle(this.host.t('Release this device?'));
    this.contentEl.createEl('p', { text: this.host.t('You will need to enter your redemption code again to activate this device.') });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: this.host.t('Cancel') }).onclick = () => this.close();
    actions.createEl('button', { cls: 'mod-warning', text: this.host.t('Release this device') }).onclick = () => {
      this.close();
      this.release();
    };
  }

  onClose(): void { this.contentEl.empty(); }
}

export function renderActivation(container: HTMLElement, plugin: TangrowPlugin): { refresh(): void; dispose(): void } {
  const t = plugin.t.bind(plugin);
  const access = plugin.access;
  const rows = settingRows(plugin, 'activation');
  const redemption = rows.row(container, 'redemption');
  const code = redemption.controlEl.createEl('input', {
    type: 'text', placeholder: 'TGRW-XXXX-XXXX-XXXX-XXXX',
    attr: { 'aria-label': t('Redemption code'), autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' }
  });
  const activate = redemption.controlEl.createEl('button', { cls: 'mod-cta', text: t('Activate this device') });
  const trialRow = rows.row(container, 'trial');
  const trial = trialRow.controlEl.createEl('button', { text: t('Start 24-hour trial') });
  const message = container.createEl('p', { attr: { role: 'status' } });
  const entitlement = rows.row(container, 'entitlement');
  const entitlementValue = entitlement.controlEl.createSpan();
  const devices = rows.row(container, 'devices');
  const deviceCount = devices.controlEl.createSpan();
  const renew = devices.controlEl.createEl('button', { text: t('Refresh linked devices') });
  const release = devices.controlEl.createEl('button', { text: t('Release this device') });
  const list = container.createEl('ul', { cls: 'tangrow-settings-devices' });
  const limitHelp = container.createEl('p', { text: t('Device limit reached. Release one of your old devices, wait until it has gone 45 days without renewal, or contact the seller.') });

  container.createEl('p', { text: t('One purchase includes free updates to local features. Anthropic API fees and Claudian are separate.') });
  container.createEl('p', { text: t('A code covers up to 3 devices. Go online to activate and at least once every 30 days to renew.') });
  const version = rows.text(container, 'version');
  version.textContent = t('Current version v{version}', { version: plugin.manifest.version }) + ' · ';
  version.createEl('a', { text: t('Check for updates ↗'), href: 'https://github.com/tangwz/tangrow/releases', attr: { target: '_blank', rel: 'noopener noreferrer' } });

  let busy = false;
  let disposed = false;
  let fullList: typeof access.deviceList = null;
  let confirmation: ReleaseConfirmation | undefined;
  let renderedList: typeof access.deviceList | undefined;

  function refresh(): void {
    const { state, remainingMs } = access.snapshot();
    const minutes = Math.ceil(remainingMs / 60000);
    const hours = Math.floor(minutes / 60);
    entitlementValue.textContent = state === 'trial'
      ? hours > 0 ? t('Trial remaining: {hours} h {minutes} min', { hours, minutes: minutes % 60 })
        : t('Trial remaining: {minutes} min', { minutes })
      : t(stateLabels[state]);
    const linked = access.deviceList;
    const includesThisDevice = linked?.devices.some((device) => device.isCurrent) === true;
    const full = linked !== null && linked === fullList;
    const hasLease = state === 'active' || state === 'needs_network' || includesThisDevice;
    trialRow.settingEl.hidden = state !== 'not_started';
    activate.disabled = busy;
    trial.disabled = busy;
    release.hidden = !hasLease;
    release.disabled = busy;
    renew.hidden = !hasLease;
    renew.disabled = busy;
    renew.textContent = t(state === 'needs_network' ? 'Renew online' : 'Refresh linked devices');
    message.hidden = !message.textContent;
    limitHelp.hidden = !full;
    const visibleList = full || includesThisDevice ? linked : null;
    deviceCount.textContent = visibleList
      ? `${visibleList.devices.length}/${visibleList.deviceLimit}`
      : t(hasLease ? 'Refresh to load the device list.' : 'Activate to see linked devices.');
    if (renderedList === visibleList) return;
    renderedList = visibleList;
    list.empty();
    list.hidden = !visibleList?.devices.length;
    const dates = new Intl.DateTimeFormat(plugin.settings.language, { dateStyle: 'medium' });
    for (const device of visibleList?.devices ?? []) {
      const date = new Date(device.lastRenewedAt * 1000);
      const lastUsed = Number.isNaN(date.getTime()) ? t('Unknown date') : dates.format(date);
      list.createEl('li', { text: t(device.isCurrent ? '{platform} (this device) · Last used {date}' : '{platform} · Last used {date}', { platform: device.platform, date: lastUsed }) });
    }
  }

  async function run(operation: () => AccessResult | Promise<AccessResult>, success: string): Promise<void> {
    if (busy || disposed) return;
    busy = true;
    fullList = null;
    message.textContent = '';
    refresh();
    try {
      const result = await operation();
      if (disposed) {
        if (!result.ok && result.error !== 'stale') new Notice(t(result.error === 'device_limit'
          ? 'Device limit reached.' : errorLabels[result.error] ?? 'Access could not be updated.'));
        return;
      }
      if (result.ok) message.textContent = t(success);
      else if (result.error === 'device_limit') {
        fullList = access.deviceList;
        message.textContent = t('Device limit reached.');
      } else message.textContent = t(errorLabels[result.error] ?? 'Access could not be updated.');
    } catch (error) {
      if (!disposed) message.textContent = plugin.error(error);
    } finally {
      busy = false;
      if (!disposed) refresh();
    }
  }

  activate.onclick = () => {
    const submitted = code.value;
    void run(async () => {
      const result = await access.activate(submitted);
      if (result.ok && code.value === submitted) code.value = '';
      return result;
    }, 'This device is activated.');
  };
  code.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); activate.click(); }
  };
  trial.onclick = () => { void run(() => access.startTrial(), 'Your 24-hour trial has started.'); };
  renew.onclick = () => { void run(() => access.renew(), 'Access refreshed.'); };
  release.onclick = () => {
    confirmation = new ReleaseConfirmation(plugin, () => {
      confirmation = undefined;
      void run(() => access.release(), 'This device was released.');
    });
    confirmation.open();
  };

  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      confirmation?.close();
    }
  };
}
