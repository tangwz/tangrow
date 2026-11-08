import core from './locales/core.zh-CN.json';
import sidebar from './locales/sidebar.zh-CN.json';
import bases from './locales/bases.zh-CN.json';
import report from './locales/report.zh-CN.json';
import capture from './locales/capture.zh-CN.json';
import type { Locale } from './types';

export type TranslationValues = Record<string, string | number>;
const chinese: Record<string, string> = { ...core, ...sidebar, ...bases, ...report, ...capture };

export function translate(language: Locale, source: string, values: TranslationValues = {}): string {
  const template = language === 'zh-CN' ? chinese[source] ?? source : source;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, key: string) => Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}

export function describeError(language: Locale, error: unknown): string {
  return translate(language, error instanceof Error ? error.message : String(error));
}
