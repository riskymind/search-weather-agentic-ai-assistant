/** Weather presentation helpers: condition icons and a temperature-driven hue. */

import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Sun,
  Wind,
  type LucideIcon,
} from "lucide-react";

const RULES: Array<[RegExp, LucideIcon]> = [
  [/thunder|lightning/i, CloudLightning],
  [/snow|sleet|blizzard|ice|hail/i, CloudSnow],
  [/drizzle/i, CloudDrizzle],
  [/rain|shower/i, CloudRain],
  [/fog|mist|haze|smoke|dust/i, CloudFog],
  [/partly|patchy|intervals/i, CloudSun],
  [/overcast|cloud/i, Cloud],
  [/sun|clear|fair/i, Sun],
  [/wind|breez|gust/i, Wind],
];

export function weatherIcon(description: string): LucideIcon {
  return RULES.find(([pattern]) => pattern.test(description))?.[1] ?? Cloud;
}

/** Map temperature to a hue: -10 °C → 215 (cold blue) … 40 °C → 25 (hot amber). */
export function temperatureHue(celsius: number): number {
  const clamped = Math.min(40, Math.max(-10, celsius));
  return Math.round(215 - ((clamped + 10) / 50) * 190);
}
