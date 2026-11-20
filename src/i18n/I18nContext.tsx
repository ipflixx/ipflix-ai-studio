import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import type { AppLanguage } from '../types/iptv';
import { translate, type TranslationKey } from './translations';

interface I18nContextValue {
  lang: AppLanguage;
  setLang: (lang: AppLanguage) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'tr',
  setLang: () => {},
  t: (key, vars) => translate('tr', key, vars),
});

interface I18nProviderProps {
  lang: AppLanguage;
  onChangeLang: (lang: AppLanguage) => void;
  children: ReactNode;
}

export function I18nProvider({ lang, onChangeLang, children }: I18nProviderProps) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      translate(lang, key, vars),
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang: onChangeLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
