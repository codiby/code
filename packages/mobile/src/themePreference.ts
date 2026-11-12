import AsyncStorage from '@react-native-async-storage/async-storage';
import { colorScheme } from 'nativewind';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_KEY = 'codiby.theme';

/** El tema guardado; sin nada guardado, el del teléfono. */
export async function loadThemePreference(): Promise<ThemePreference> {
  const saved = await AsyncStorage.getItem(THEME_KEY).catch(() => null);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function applyThemePreference(preference: ThemePreference): void {
  try {
    colorScheme.set(preference);
  } catch {
    /* Sin módulo de apariencia (tests): se queda en el del sistema. */
  }
}

export async function saveThemePreference(
  preference: ThemePreference,
): Promise<void> {
  applyThemePreference(preference);
  await AsyncStorage.setItem(THEME_KEY, preference).catch(() => undefined);
}
