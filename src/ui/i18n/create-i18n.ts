import type { I18n } from './contract';
import type {
  LocaleCatalog,
  MessageArguments,
  MessageKey,
  SupportedLocale,
} from './locale-catalog';
import { createEnglishCatalog } from './locales/en';
import { createSimplifiedChineseCatalog } from './locales/zh';

export type { I18n } from './contract';
export type { SupportedLocale } from './locale-catalog';

export function normalizeLocale(locale: string): SupportedLocale {
  return locale.toLowerCase() === 'zh' ? 'zh' : 'en';
}

export function createI18n(localeInput: string): I18n {
  const locale = normalizeLocale(localeInput);
  const numberFormat = new Intl.NumberFormat(locale);
  const dateTimeFormat = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  });
  const formatNumber = (value: number): string => numberFormat.format(value);
  const catalog =
    locale === 'zh'
      ? createSimplifiedChineseCatalog(formatNumber)
      : createEnglishCatalog(formatNumber);

  return {
    formatDateTime: (value) =>
      dateTimeFormat.format(typeof value === 'string' ? new Date(value) : value),
    formatNumber,
    locale,
    t: <Key extends MessageKey>(key: Key, ...arguments_: MessageArguments<Key>): string =>
      invokeMessage(catalog, key, arguments_),
  };
}

function invokeMessage<Key extends MessageKey>(
  catalog: LocaleCatalog,
  key: Key,
  arguments_: MessageArguments<Key>,
): string {
  const message = catalog[key] as (parameters: MessageArguments<Key>[0]) => string;
  return message(arguments_[0]);
}
