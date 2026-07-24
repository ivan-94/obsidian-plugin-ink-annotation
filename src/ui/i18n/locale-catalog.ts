export type SupportedLocale = 'en' | 'zh';

export interface MessageParameters {
  readonly 'sidebar.selectedCount': { readonly count: number };
}

export type MessageKey = keyof MessageParameters;

export type MessageArguments<Key extends MessageKey> = MessageParameters[Key] extends undefined
  ? []
  : [parameters: MessageParameters[Key]];

export type LocaleCatalog = {
  readonly [Key in MessageKey]: (parameters: MessageParameters[Key]) => string;
};
