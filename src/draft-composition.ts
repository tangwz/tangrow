import { Platform } from 'obsidian';

type DraftControl = HTMLInputElement | HTMLTextAreaElement;
const focusChangeGraceMs = 50;

/**
 * Android keyboards such as Gboard keep the word being typed as composition text, so on Android that text is the
 * user's input and is saved like ordinary input. Desktop and iOS compose CJK candidates (pinyin, kana, Hangul),
 * which stay out of drafts until confirmed.
 */
export function tracksComposition(): boolean {
  return !Platform.isAndroidApp;
}

/** Defers a composition's verdict. Tests can replace it to settle synchronously. */
export const compositionTiming = {
  later(callback: () => void, owner: Window): void { owner.setTimeout(callback, focusChangeGraceMs); }
};

/**
 * Tracks one IME composition so that text which was never confirmed stays out of the shared draft.
 *
 * Chromium can end composition and run a zero-delay timer before dispatching the pointer press or blur that caused
 * it. Keep the draft pending briefly so focus loss can cancel the preedit. Escape also cancels. Other endings are
 * kept, including commit keys that leave the text unchanged, such as Shift, Enter or an IME toggle like Ctrl+Space.
 */
export class DraftComposition {
  private readonly value: string;
  private readonly start: number;
  private readonly end: number;
  private readonly direction: DraftControl['selectionDirection'];
  private readonly scrollTop: number;
  private escaped = false;
  private blurred = false;
  private onSettled?: (confirmed: boolean) => void;
  private readonly onBlur = () => { this.blurred = true; };
  private readonly onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    if (!input.isComposing && !input.inputType?.includes('Composition')) this.flush();
  };

  constructor(readonly control: DraftControl) {
    this.value = control.value;
    this.start = control.selectionStart ?? 0;
    this.end = control.selectionEnd ?? this.start;
    this.direction = control.selectionDirection;
    this.scrollTop = control.scrollTop;
    control.addEventListener('blur', this.onBlur);
    control.addEventListener('beforeinput', this.onBeforeInput);
  }

  keyDown(event: KeyboardEvent): void {
    if (this.onSettled) return;
    if (event.key === 'Escape' || event.code === 'Escape') {
      this.escaped = true;
      // Let the IME handle Escape without letting a workspace shortcut move focus.
      event.stopPropagation();
    } else {
      // Typing on after Escape continues the same composition: a Japanese IME only reverts the conversion.
      this.escaped = false;
    }
  }

  /** Calls `done` once focus changes from the same action have been dispatched. */
  settle(done: (confirmed: boolean) => void): void {
    this.onSettled = done;
    compositionTiming.later(() => this.flush(), this.control.ownerDocument.defaultView ?? window);
  }

  /** Settles a finished composition before the control is changed by a new edit. */
  flush(): void {
    const done = this.onSettled;
    this.onSettled = undefined;
    done?.(!this.escaped && !this.blurred && this.control.isConnected);
  }

  /** Puts back the text and selection from before the composition. */
  restore(): void {
    if (this.control.value !== this.value) this.control.value = this.value;
    this.control.setSelectionRange(this.start, this.end, this.direction ?? undefined);
    this.control.scrollTop = this.scrollTop;
  }

  restoreIfEscaped(): boolean {
    if (!this.escaped) return false;
    this.restore();
    return true;
  }

  dispose(): void {
    this.onSettled = undefined;
    this.control.removeEventListener('blur', this.onBlur);
    this.control.removeEventListener('beforeinput', this.onBeforeInput);
  }
}
