import Svg, { Path } from 'react-native-svg';

import type { TabIconProps } from './types';

/**
 * Iconos macizos sobre un viewBox de 24x24.
 *
 * Eran de trazo, pero sobre el vidrio oscuro un contorno de 1.75 px se
 * deshace: no hay suficiente tinta para separarse del desenfoque de detrás.
 * La silueta llena aguanta el fondo sea cual sea.
 *
 * Los huecos —los puntos del bocadillo, el eje del engrane— son subtrazos con
 * `fillRule="evenodd"`, no formas pintadas del color del fondo: el fondo aquí
 * es translúcido y variable, así que pintarlo encima se notaría.
 */

export function HomeIcon({ size, color }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12.65 2.76a1 1 0 0 0-1.3 0L2.6 10.3a1 1 0 0 0 .65 1.76H4.7v7.2a1.9 1.9 0 0 0 1.9 1.9h2.75v-5.5a.7.7 0 0 1 .7-.7h3.9a.7.7 0 0 1 .7.7v5.5h2.75a1.9 1.9 0 0 0 1.9-1.9v-7.2h1.45a1 1 0 0 0 .65-1.76Z"
        fill={color}
      />
    </Svg>
  );
}

export function ConversationsIcon({ size, color }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M9 2a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H9ZM3 7a1 1 0 0 0-2 0v11a4 4 0 0 0 4 4h11a1 1 0 0 0 0-2H5a2 2 0 0 1-2-2V7Z"
        fill={color}
      />
    </Svg>
  );
}

export function ChatIcon({ size, color }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 3.1c-4.9 0-8.85 3.35-8.85 7.5 0 2.25 1.16 4.27 3 5.65v3.35a.7.7 0 0 0 1.12.56l2.84-2.13c.6.11 1.24.17 1.89.17 4.9 0 8.85-3.35 8.85-7.6S16.9 3.1 12 3.1Z
           M7.25 10.6a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0Z
           M10.8 10.6a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0Z
           M14.35 10.6a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0Z"
        fill={color}
        fillRule="evenodd"
      />
    </Svg>
  );
}

export function SettingsIcon({ size, color }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41L9.25 5.35c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58Z
           M12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z"
        fill={color}
        fillRule="evenodd"
      />
    </Svg>
  );
}

export function NewChatIcon({ size, color }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M20 11.5V7a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v13l4-3h5M18 14v8m-4-4h8"
        fill="none"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
