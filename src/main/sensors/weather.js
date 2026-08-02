'use strict';

/**
 * Weather, from Open-Meteo.
 *
 * Chosen because it needs no API key, no signup and no account: a plain HTTPS
 * GET with coordinates. That keeps the project's "clone it and it works"
 * property, with no secrets story on a public repo.
 *
 * Coordinates come from config and are never guessed from the IP address —
 * IP geolocation would send the user's address to a third party on every
 * start, and lands on the ISP's city (or the VPN exit) anyway.
 *
 * Polled on a long interval: the upstream model only updates hourly, so
 * anything faster is pure waste.
 */

const BASE = 'https://api.open-meteo.com/v1/forecast';

/**
 * WMO weather interpretation codes, collapsed into the handful of categories
 * a 5-inch panel can actually distinguish at a glance.
 * https://open-meteo.com/en/docs
 */
const CODES = new Map([
  [0, { icon: 'clear', label: 'Clear' }],
  [1, { icon: 'mostly-clear', label: 'Mostly clear' }],
  [2, { icon: 'partly-cloudy', label: 'Partly cloudy' }],
  [3, { icon: 'overcast', label: 'Overcast' }],
  [45, { icon: 'fog', label: 'Fog' }],
  [48, { icon: 'fog', label: 'Rime fog' }],
  [51, { icon: 'drizzle', label: 'Light drizzle' }],
  [53, { icon: 'drizzle', label: 'Drizzle' }],
  [55, { icon: 'drizzle', label: 'Heavy drizzle' }],
  [56, { icon: 'drizzle', label: 'Freezing drizzle' }],
  [57, { icon: 'drizzle', label: 'Freezing drizzle' }],
  [61, { icon: 'rain', label: 'Light rain' }],
  [63, { icon: 'rain', label: 'Rain' }],
  [65, { icon: 'rain', label: 'Heavy rain' }],
  [66, { icon: 'rain', label: 'Freezing rain' }],
  [67, { icon: 'rain', label: 'Freezing rain' }],
  [71, { icon: 'snow', label: 'Light snow' }],
  [73, { icon: 'snow', label: 'Snow' }],
  [75, { icon: 'snow', label: 'Heavy snow' }],
  [77, { icon: 'snow', label: 'Snow grains' }],
  [80, { icon: 'rain', label: 'Showers' }],
  [81, { icon: 'rain', label: 'Showers' }],
  [82, { icon: 'rain', label: 'Heavy showers' }],
  [85, { icon: 'snow', label: 'Snow showers' }],
  [86, { icon: 'snow', label: 'Snow showers' }],
  [95, { icon: 'thunder', label: 'Thunderstorm' }],
  [96, { icon: 'thunder', label: 'Thunderstorm' }],
  [99, { icon: 'thunder', label: 'Thunderstorm' }],
]);

const describe = (code) =>
  CODES.get(code) ?? { icon: 'unknown', label: 'Unknown' };

/**
 * The next twelve hours, starting from the current one.
 *
 * Open-Meteo returns the whole local day from midnight, so the first half of
 * the array is usually already in the past. Finding the current hour by
 * timestamp rather than assuming an offset also keeps this correct across a DST
 * boundary, where the day is 23 or 25 entries long.
 */
function buildHourly(json, hours = 12) {
  const h = json.hourly;
  if (!h || !Array.isArray(h.time)) return [];

  const now = Date.now();
  // The API returns local wall-clock stamps without a zone when timezone=auto,
  // and its utc_offset_seconds says what that local time means.
  const offsetMs = (Number(json.utc_offset_seconds) || 0) * 1000;
  const at = (t) => Date.parse(`${t}Z`) - offsetMs;

  let start = h.time.findIndex((t) => at(t) + 3600_000 > now);
  if (start < 0) start = 0;

  return h.time.slice(start, start + hours).map((t, i) => {
    const idx = start + i;
    const code = Number(h.weather_code?.[idx]);
    const { icon } = describe(code);
    const hourOfDay = Number(t.slice(11, 13));
    // Same reason the current icon has a night variant: a sun glyph on the 3am
    // column reads as a bug rather than as weather.
    const night = hourOfDay < 6 || hourOfDay >= 19;
    return {
      at: at(t),
      hour: hourOfDay,
      tempC: num(h.temperature_2m?.[idx]),
      pop: num(h.precipitation_probability?.[idx]),
      code,
      icon:
        night && (icon === 'clear' || icon === 'mostly-clear') ? `${icon}-night` : icon,
    };
  });
}

/** Today plus the following days, as the daily block reports them. */
function buildDays(daily) {
  if (!daily || !Array.isArray(daily.time)) return [];
  return daily.time.map((t, i) => ({
    at: Date.parse(`${t}T12:00:00Z`),
    highC: num(daily.temperature_2m_max?.[i]),
    lowC: num(daily.temperature_2m_min?.[i]),
    pop: num(daily.precipitation_probability_max?.[i]),
    icon: describe(Number(daily.weather_code?.[i])).icon,
  }));
}

class WeatherSource {
  constructor({
    enabled = true,
    latitude = null,
    longitude = null,
    units = 'metric',
    refreshMinutes = 15,
    timeoutMs = 8000,
  } = {}) {
    this.enabled = enabled;
    this.latitude = latitude;
    this.longitude = longitude;
    this.units = units === 'imperial' ? 'imperial' : 'metric';
    this.refreshMs = Math.max(5, refreshMinutes) * 60_000;
    this.timeoutMs = timeoutMs;

    this.latest = null;
    this.available = false;
    this.reason = 'not fetched yet';
    this.timer = null;
    this.inFlight = false;
    this.failures = 0;
  }

  get configured() {
    return (
      Number.isFinite(this.latitude) &&
      Number.isFinite(this.longitude) &&
      Math.abs(this.latitude) <= 90 &&
      Math.abs(this.longitude) <= 180
    );
  }

  start() {
    if (!this.enabled) return;
    if (!this.configured) {
      this.reason = 'no coordinates in config';
      return;
    }
    this.fetchNow();
    this.timer = setInterval(() => this.fetchNow(), this.refreshMs);
  }

  buildUrl() {
    const params = new URLSearchParams({
      latitude: String(this.latitude),
      longitude: String(this.longitude),
      current: [
        'temperature_2m',
        'apparent_temperature',
        'relative_humidity_2m',
        'is_day',
        'weather_code',
        'wind_speed_10m',
      ].join(','),
      // The hourly and multi-day blocks cost nothing extra: the model has
      // already computed them and one request returns the lot. Only the
      // current reading fits in the bar, so the rest feeds a forecast panel
      // that only exists because rotation made room for it.
      hourly: ['temperature_2m', 'precipitation_probability', 'weather_code'].join(','),
      daily: [
        'temperature_2m_max',
        'temperature_2m_min',
        'weather_code',
        'precipitation_probability_max',
      ].join(','),
      timezone: 'auto',
      forecast_days: '5',
    });
    if (this.units === 'imperial') {
      params.set('temperature_unit', 'fahrenheit');
      params.set('wind_speed_unit', 'mph');
    }
    return `${BASE}?${params.toString()}`;
  }

  async fetchNow() {
    if (this.inFlight || !this.configured) return;
    this.inFlight = true;
    try {
      const res = await fetch(this.buildUrl(), {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      const cur = json.current;
      const daily = json.daily;
      if (!cur) throw new Error('no current block in response');

      const code = Number(cur.weather_code);
      const { icon, label } = describe(code);

      this.latest = {
        tempC: num(cur.temperature_2m),
        feelsC: num(cur.apparent_temperature),
        humidity: num(cur.relative_humidity_2m),
        windKph: num(cur.wind_speed_10m),
        code,
        label,
        // Distinct night icons matter: a sun glyph at 3am reads as broken.
        icon: cur.is_day === 0 && (icon === 'clear' || icon === 'mostly-clear')
          ? `${icon}-night`
          : icon,
        isDay: cur.is_day !== 0,
        highC: daily ? num(daily.temperature_2m_max?.[0]) : null,
        lowC: daily ? num(daily.temperature_2m_min?.[0]) : null,
        hourly: buildHourly(json),
        days: buildDays(daily),
        unit: this.units === 'imperial' ? 'F' : 'C',
        fetchedAt: Date.now(),
      };
      this.available = true;
      this.reason = null;
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      // Keep showing the last good reading rather than blanking on a single
      // blip; only give up after a sustained outage.
      if (this.failures >= 3) {
        this.available = false;
        this.latest = null;
      }
      this.reason = /abort|timeout/i.test(err.message)
        ? 'weather request timed out'
        : /fetch failed|ENOTFOUND|EAI_AGAIN/i.test(err.message)
          ? 'no internet connection'
          : err.message;
    } finally {
      this.inFlight = false;
    }
  }

  read() {
    if (!this.enabled) return { available: false, reason: 'disabled', data: null };
    if (!this.configured) {
      return {
        available: false,
        reason: 'set sensors.weather.latitude/longitude in config.json',
        data: null,
      };
    }
    if (!this.available) return { available: false, reason: this.reason, data: null };
    return { available: true, reason: null, data: this.latest };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { WeatherSource, describe };
