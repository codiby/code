import type { ComponentType } from 'react';

/** Identificador estable de cada destino de la barra. */
export type TabKey = 'home' | 'chat' | 'settings';

export interface TabIconProps {
  /** Lado del viewBox cuadrado, en px. */
  readonly size: number;
  /** Color del trazo. */
  readonly color: string;
}

export type TabIcon = ComponentType<TabIconProps>;

export interface TabItem {
  readonly key: TabKey;
  /** Etiqueta visible y para lectores de pantalla. */
  readonly label: string;
  readonly Icon: TabIcon;
}

export interface GlassTabBarProps {
  readonly activeKey: TabKey;
  readonly onChange: (key: TabKey) => void;
  /** Permite sustituir o reordenar los destinos. Por defecto: chat, home, settings. */
  readonly items?: readonly TabItem[];
}
