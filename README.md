![Color Weather](colorweather.png)

# Color Weather - Pebble Time 2

A sleek, customizable weather watchface for Pebble Time 2. Get real-time weather data, track your steps, and stay prepared with smart storm alerts.

## Features

**Complete Weather Data**
- Current temperature & conditions
- Barometric pressure with trend
- Humidity, wind speed & precipitation
- UV index
- Auto-updating every 15 minutes

**Smart Location**
- Automatic geolocation
- Displays your current city

**Personal Weather Station (optional)**
- Use your own Weather Underground station instead of the forecast
- Switches to it automatically when you are near it, and back when you are not
- Falls back on its own if the station stops reporting

**Fitness Tracking**
- Real-time step count & distance
- Enabled by default
- Choose miles or kilometers
- Toggle on/off anytime

**Storm Warnings**
- Pressure-based alerts for severe weather changes
- Optional vibration notifications
- 3+ hour historical tracking

**Customization**
- White or black text options
- Temperature, wind & precipitation unit selection
- Hourly vibration alerts
- Update countdown display

## Installation

1. Download `Color Weather v2.1.0.pbw`
2. Open Pebble app on your phone
3. Install the watchface
4. Configure settings via the companion app

## Requirements

- Pebble Time 2
- Smartphone (iOS or Android) with Pebble app
- Location services enabled

## Settings

Access settings through your Pebble companion app:
- **Temperature Units:** Celsius or Fahrenheit
- **Wind Speed:** mph or km/h
- **Precipitation:** mm or inches
- **Text Color:** White (default) or Black
- **Step Tracking:** Toggle on/off
- **Storm Warnings:** Enable/disable
- **Hourly Vibration:** Optional alerts

## Technical

- Built with Pebble SDK v3
- Uses Open-Meteo weather API
- Real-time Health API integration for step tracking

## License

© Digital Urban - All rights reserved

---

**Version:** 1.0.0
**Platform:** Pebble Time 2 (Emery)

## Building

Built with the Pebble SDK (`sdkVersion` 3), targeting **emery** (Pebble Time 2).

```
pebble build
pebble install --phone <ip>
```

Project layout:

```
package.json                                   app config, UUID, message keys, resources
src/c/color_weather.c                          the watchface itself
src/pkjs/app.js                                companion app - weather fetching and settings
src/pkjs/index.js                              PebbleKit JS entry point
resources/images/shoe_icon.png                 step icon
resources/fonts/weathericons-regular-webfont.ttf  condition icons (subset at build time)
```

The C also carries layout branches for `basalt` and `diorite`, but only `emery`
is in `targetPlatforms` — add the others there to build for them.

## Weather data

[Open-Meteo](https://open-meteo.com/en/docs) for current conditions, the
15-minute forecast block and daily rainfall. No API key required. City names
come from Nominatim reverse geocoding. The face refreshes every 15 minutes.

## Background colours

The background is set from the temperature, converted to Celsius first so the
bands land at the same real-world temperatures whichever unit is displayed:

| Temperature | Colour | Hex |
|---|---|---|
| Below 0°C | `GColorOxfordBlue` | `#000055` |
| 0 to 9°C | `GColorCobaltBlue` | `#0055AA` |
| 10 to 14°C | `GColorTiffanyBlue` | `#00AAAA` |
| 15 to 19°C | `GColorMidnightGreen` | `#005555` |
| 20 to 24°C | `GColorWindsorTan` | `#AA5500` |
| 25°C and above | `GColorDarkCandyAppleRed` | `#AA0000` |

Before weather data arrives the background stays black.

## Licence

Weather Icons by Erik Flowers — font licensed under SIL OFL 1.1.

## Known issues

`DYNAMIC_BACKGROUND` (19) is still declared in `messageKeys` but nothing uses
it. It is left in place so an existing install's stored configuration is not
disturbed.

**Note on the UUID.** This is `26561edc-d219-46de-8be2-9833c511e9e2`. Version 1.0
shipped as `7c6d5e4f-3a2b-1c0d-9e8f-7a6b5c4d3e2f`, so to a watch those are two
different apps rather than an upgrade.

## Using a personal weather station

If you run a station that uploads to Weather Underground, the face can show your
own readings instead of the forecast. Enter the station ID and a
[free contributor API key](https://www.wunderground.com/member/api-keys) in the
settings.

The request asks for `numericPrecision=decimal`. Without it Weather Underground
rounds the metric conversion to whole degrees, so a station uploading in
Fahrenheit would report `18` where the forecast reports `18.3` - the real sensor
would read less precisely than the model it is meant to improve on.

It is an overlay, not a replacement. A weather station reports sensors only, so
the condition text and the weather icon always come from Open-Meteo. What your
station replaces, when it is used, is temperature, humidity, wind, rainfall,
pressure and UV.

Three rules decide whether the station is used, and all three fail safe back to
Open-Meteo:

- **Distance.** The station's coordinates come back with the observation, so the
  face works out how far away you are and uses the station only within
  `PWS_MAX_KM` (15km). Walk out of range and the forecast takes over; come home
  and the station does. There is nothing to switch.
- **Age.** An observation older than `PWS_MAX_AGE_MIN` (30 minutes) is ignored,
  so a station that has gone offline is never presented as current.
- **Agreement.** A drifting or failing barometer looks exactly like an
  approaching storm. Open-Meteo is fetched every cycle anyway for the
  conditions, which gives a second pressure reading for free. If the station's
  three-hour trend disagrees with the model's by more than
  `PWS_DISAGREE_TENTHS` (2.5 hPa), the station is distrusted for that cycle.

Pressure history is kept separately per source and readings are never compared
across sources. Many amateur stations report station pressure rather than
mean-sea-level, so a station's absolute value can sit tens of hPa from the
model's - differencing the two would manufacture a storm. Because the warning is
trend-based, a constant offset is harmless as long as the series stay apart.

Both series are recorded every cycle, so the station's history stays warm while
you are away and a trend is ready the moment you are back in range.

The settings page shows the result of the last station check - which station is
in use and how far away it is, or why it was not used. Save your settings, wait
a few seconds for the refresh, then reopen the page to see it.

When the displayed pressure came from your station, the pressure row shows `PWS`
where it would otherwise say `Rising`, `Falling` or `Steady` - the arrow already
gives the direction, so the source is the more useful thing in that slot. Before
there is any trend to show, which is the case for the first three hours after
you enable it, the row simply reads `1013mb PWS`. The marker is never absent
while the station is in use.

## Version history

- **2.3.3** — ask Weather Underground for decimal precision; without it station
  temperatures arrive rounded to whole degrees.
- **2.3.1** — the settings page now reports the result of the last station
  check, so a misconfigured station explains itself instead of failing
  silently.
- **2.3.0** — temperature and pressure now show one decimal place (18.1C,
  1015.8mb). The pressure row no longer repeats the trend as a word, since the
  arrow already gives the direction and the width pays for the decimal.
- **2.2.0** — optional Weather Underground personal weather station as a data
  source, used automatically when you are near it.
- **2.1.0** — widened the condition-icon font subset from seven glyphs to ten.
  Thunderstorm, night-clear and night-alt-cloudy previously rendered blank.
- **2.0.0** — colour layout for the Pebble Time 2 (emery).
