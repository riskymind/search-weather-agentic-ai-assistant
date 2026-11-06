import { Clock, Droplets, Thermometer, Wind } from "lucide-react";
import { createElement, type CSSProperties, type ReactNode } from "react";

import { formatNumber } from "@/lib/format";
import { temperatureHue, weatherIcon } from "@/lib/weather";
import type { WeatherData } from "@/types/agent";

/** Isobar contours behind the reading; their hue follows the temperature. */
function Isobars() {
  return (
    <svg
      viewBox="0 0 320 200"
      preserveAspectRatio="xMaxYMid slice"
      className="pointer-events-none absolute inset-y-0 right-0 h-full w-2/3 text-[hsl(var(--temp-h)_70%_50%)] opacity-30 dark:opacity-25"
      aria-hidden="true"
      focusable="false"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <ellipse
          key={i}
          cx="250"
          cy="70"
          rx={40 + i * 38}
          ry={26 + i * 27}
          transform={`rotate(${-14 + i * 4} 250 70)`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
      ))}
    </svg>
  );
}

function ConditionIcon({ description }: { description: string }) {
  return createElement(weatherIcon(description), {
    className: "size-9 shrink-0 text-[hsl(var(--temp-h)_65%_45%)]",
    "aria-hidden": true,
    strokeWidth: 1.6,
  });
}

function Reading({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function WeatherCard({ data }: { data: WeatherData }) {
  const place = [data.region && data.region !== data.city ? data.region : null, data.country]
    .filter(Boolean)
    .join(", ");
  const style = { "--temp-h": temperatureHue(data.temperature_c) } as CSSProperties;

  return (
    <article
      aria-label={`Current weather in ${data.city}`}
      style={style}
      className="relative overflow-hidden rounded-2xl border border-line bg-surface"
    >
      <Isobars />
      <div className="relative p-5 sm:p-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-semibold leading-tight">{data.city}</h3>
            {place && <p className="text-sm text-muted">{place}</p>}
          </div>
          <ConditionIcon description={data.description} />
        </header>

        <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-1">
          <p className="font-display text-6xl leading-none font-semibold tracking-tight tabular-nums">
            {formatNumber(data.temperature_c)}
            <span className="ml-0.5 align-top text-2xl font-medium text-muted">°C</span>
          </p>
          <p className="pb-1.5 text-base">{data.description}</p>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 text-sm sm:grid-cols-4">
          <Reading icon={<Thermometer className="size-3.5" aria-hidden="true" />} label="Feels like">
            {data.feels_like_c === null ? "—" : `${formatNumber(data.feels_like_c)}°C`}
          </Reading>
          <Reading icon={<Droplets className="size-3.5" aria-hidden="true" />} label="Humidity">
            {formatNumber(data.humidity)}%
          </Reading>
          <Reading icon={<Wind className="size-3.5" aria-hidden="true" />} label="Wind">
            {formatNumber(data.wind_speed_kmh)} km/h
          </Reading>
          <Reading icon={<Clock className="size-3.5" aria-hidden="true" />} label="Observed">
            {data.observation_time}
          </Reading>
        </dl>
        {data.local_time && <p className="mt-3 text-xs text-muted">Local time {data.local_time}</p>}
      </div>
    </article>
  );
}
