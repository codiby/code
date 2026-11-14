import { Platform } from 'react-native';

/** What the Devices list on the desktop shows until the owner renames it. */
export function deviceName(): string {
  if (Platform.OS === 'ios') {
    return Platform.isPad ? 'iPad' : 'iPhone';
  }
  const constants = Platform.constants as { Brand?: string; Model?: string };
  const model = constants.Model?.trim() ?? '';
  const brand = constants.Brand?.trim() ?? '';
  if (model.length === 0) {
    return 'Android phone';
  }
  // "Pixel 9" already says it all; "SM-S921B" reads better as "samsung SM-S921B".
  return brand.length > 0 &&
    !model.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${model}`
    : model;
}
