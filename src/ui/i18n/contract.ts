import type { MessageArguments, MessageKey, SupportedLocale } from './locale-catalog';

export interface I18n {
  readonly locale: SupportedLocale;
  formatDateTime(value: string | Date): string;
  formatNumber(value: number): string;
  t<Key extends MessageKey>(key: Key, ...arguments_: MessageArguments<Key>): string;
}
