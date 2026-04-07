import { I18nProvider } from 'react-aria-components';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en-US">
      {children}
    </I18nProvider>
  );
}
