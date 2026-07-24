import { createContext, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';

import type { I18n } from './contract';

const Context = createContext<I18n | null>(null);

export function I18nProvider({
  children,
  i18n,
}: {
  readonly children: ComponentChildren;
  readonly i18n: I18n;
}) {
  return <Context.Provider value={i18n}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const i18n = useContext(Context);
  if (i18n === null) throw new Error('I18nProvider is required for localized Preact UI.');
  return i18n;
}
