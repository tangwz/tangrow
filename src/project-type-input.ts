import type { SidebarUI } from './ui';

export function renderProjectTypeInput(
  parent: HTMLElement, ui: SidebarUI, choices: readonly string[], value: string, onInput: (value: string) => void
): HTMLInputElement {
  const controls = parent.createDiv({ cls: 'tangrow-project-type-control' });
  const input = controls.createEl('input', { type: 'text', attr: {
    'aria-label': ui.t('Project type (optional)'), placeholder: ui.t('Enter a type or leave blank')
  } });
  input.value = value;
  if (choices.length) {
    const suggestions = controls.createEl('select', { attr: { 'aria-label': ui.t('Existing project types') } });
    suggestions.createEl('option', { value: '', text: ui.t('Choose an existing type') });
    for (const choice of choices) suggestions.createEl('option', { value: choice, text: choice });
    suggestions.value = choices.includes(value) ? value : '';
    suggestions.addEventListener('change', () => {
      if (!suggestions.value) return;
      input.value = suggestions.value;
      onInput(input.value);
    });
    input.addEventListener('input', () => { suggestions.value = choices.includes(input.value) ? input.value : ''; });
  }
  input.addEventListener('input', (event) => { if (!(event as InputEvent).isComposing) onInput(input.value); });
  input.addEventListener('compositionend', () => { onInput(input.value); });
  return input;
}
