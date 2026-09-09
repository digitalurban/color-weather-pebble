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

**Three message keys are missing from the manifest.** The C uses `WEATHER_ICON`
(20), `UV` (21) and `TEXT_COLOR` (22), but `messageKeys` doesn't declare them, so
`src/pkjs/app.js` falls back to hard-coded ids. It works, but declaring them is
tidier. `DYNAMIC_BACKGROUND` (19) is declared and no longer used.

**Note on the UUID.** This is `26561edc-d219-46de-8be2-9833c511e9e2`. Version 1.0
shipped as `7c6d5e4f-3a2b-1c0d-9e8f-7a6b5c4d3e2f`, so to a watch those are two
different apps rather than an upgrade.

## Version history

- **2.1.0** — widened the condition-icon font subset from seven glyphs to ten.
  Thunderstorm, night-clear and night-alt-cloudy previously rendered blank.
- **2.0.0** — colour layout for the Pebble Time 2 (emery).
