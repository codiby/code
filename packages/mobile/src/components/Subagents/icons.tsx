import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Same Lucide glyphs the desktop Agents drawer uses, so both read alike. */
interface IconProps {
  readonly size: number;
  readonly color: string;
}

const STROKE = {
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  fill: 'none',
} as const;

export function BotIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 8V4H8" stroke={color} {...STROKE} />
      <Rect
        x={4}
        y={8}
        width={16}
        height={12}
        rx={2}
        stroke={color}
        {...STROKE}
      />
      <Path d="M2 14h2M20 14h2M15 13v2M9 13v2" stroke={color} {...STROKE} />
    </Svg>
  );
}

export function StopIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={5} y={5} width={14} height={14} rx={2.5} fill={color} />
    </Svg>
  );
}

/** "Send to the background": an arrow landing on a line. */
export function BackgroundIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 17V3M6 11l6 6 6-6M19 21H5" stroke={color} {...STROKE} />
    </Svg>
  );
}

/** Failed or stopped: the circle-slash the desktop row shows. */
export function SlashIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9} stroke={color} {...STROKE} />
      <Path d="M9 15l6-6" stroke={color} {...STROKE} />
    </Svg>
  );
}

/** Marks text handed between agents: the prompt in, the summary out. */
export function HandoffIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12"
        stroke={color}
        {...STROKE}
      />
    </Svg>
  );
}
