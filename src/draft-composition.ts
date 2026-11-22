import { Platform } from 'obsidian';

type DraftControl = HTMLInputElement | HTMLTextAreaElement;
const focusChangeGraceMs = 50;
export const recomposeHint = 'Composition ended when focus moved. Start composing again to choose a candidate with the keyboard.';

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
  private focusState: 'uninterrupted' | 'blurred' | 'refocused' = 'uninterrupted';
  private confirmationKey?: string;
  private explicitCommit = false;
  private onSettled?: (confirmed: boolean) => void;
  private readonly onBlur = () => {
    this.focusState = 'blurred';
    this.confirmationKey = undefined;
    this.explicitCommit = false;
  };
  private readonly onFocus = () => {
    // Returning after compositionend cannot revive a candidate dismissed by focus loss.
    if (this.focusState === 'blurred' && !this.onSettled) this.focusState = 'refocused';
  };
  private readonly onKeyUp = (event: Event) => {
    const key = event as KeyboardEvent;
    if (!this.confirmationKey || (key.code || key.key) !== this.confirmationKey) return;
    this.confirmationKey = undefined;
    if (key.isComposing) return;
    if (this.focusState === 'refocused') this.explicitCommit = true;
    this.flush();
  };
  private readonly onInput = (event: Event) => {
    if ((event as InputEvent).inputType !== 'insertFromComposition' || this.focusState === 'blurred') return;
    this.explicitCommit = true;
    this.flush();
  };
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
    control.addEventListener('focus', this.onFocus);
    control.addEventListener('beforeinput', this.onBeforeInput);
    control.addEventListener('keyup', this.onKeyUp);
    control.addEventListener('input', this.onInput);
  }

  keyDown(event: KeyboardEvent): void {
    if (this.onSettled) {
      if (!event.isComposing && event.key === 'Tab') this.flush();
      return;
    }
    const key = event.code || event.key;
    this.confirmationKey = this.focusState !== 'blurred' && event.isComposing && !event.metaKey && !event.altKey &&
      (!event.ctrlKey || key === 'Space' || key === ' ') &&
      /^(Enter|NumpadEnter|Space| |Shift(Left|Right)?|Digit[0-9]|[0-9])$/.test(key) ? key : undefined;
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
    if (this.explicitCommit) this.flush();
    else compositionTiming.later(() => this.flush(), this.control.ownerDocument.defaultView ?? window);
  }

  /** Settles a finished composition before the control is changed by a new edit. */
  flush(): boolean | undefined {
    const done = this.onSettled;
    if (!done) return undefined;
    this.onSettled = undefined;
    const confirmed = !this.escaped && this.control.isConnected && (this.focusState === 'uninterrupted' || this.explicitCommit);
    done(confirmed);
    return confirmed;
  }

  /** Puts back the text and selection from before the composition. */
  restore(onRefocus?: () => void): void {
    const discardedText = this.control.value !== this.value;
    if (discardedText) this.control.value = this.value;
    this.control.setSelectionRange(this.start, this.end, this.direction ?? undefined);
    this.control.scrollTop = this.scrollTop;
    if (!onRefocus || !Platform.isDesktopApp || !Platform.isMacOS || !discardedText || this.escaped ||
        this.focusState === 'uninterrupted' || !this.control.isConnected || this.control.readOnly) return;
    // Apple Pinyin can leave its candidate window visible after the field has reverted to ordinary typing.
    const doc = this.control.ownerDocument;
    if (doc.activeElement === this.control && doc.hasFocus()) onRefocus();
    else this.control.addEventListener('focus', onRefocus, { once: true });
  }

  restoreIfEscaped(): boolean {
    if (!this.escaped) return false;
    this.restore();
    return true;
  }

  dispose(): void {
    this.onSettled = undefined;
    this.control.removeEventListener('blur', this.onBlur);
    this.control.removeEventListener('focus', this.onFocus);
    this.control.removeEventListener('beforeinput', this.onBeforeInput);
    this.control.removeEventListener('keyup', this.onKeyUp);
    this.control.removeEventListener('input', this.onInput);
  }
}
