var MessageKeys;
try {
  MessageKeys = require('message_keys');
} catch (e) {
  MessageKeys = null;
}

// --- Settings Management ---
var settings = {
  temperature_unit: 'celsius',
  wind_unit: 'mph',
  precipitation_unit: 'mm',
  hourly_vibration: false,
  update_countdown: true,
  show_steps: true,
  step_unit: 'miles',
  storm_warning: false,
  text_color: 'white',
  // Personal Weather Station (Weather Underground) - optional
  pws_enabled: false,
  pws_station_id: '',
  pws_api_key: ''
};

// Store last weather data for immediate re-sending when units change
var lastWeatherData = null;

// --- Personal Weather Station tuning ---------------------------------------
// Use the station's own readings only when we are actually near it. Beyond this
// the station stops being representative and Open-Meteo is the better answer.
var PWS_MAX_KM = 15;
// A station that has stopped uploading must not be shown as current.
var PWS_MAX_AGE_MIN = 30;
// If the station's 3-hour trend disagrees with the model's by more than this
// (in tenths of hPa), assume the sensor is drifting rather than the weather
// turning, and fall back. A failing barometer looks exactly like a storm.
var PWS_DISAGREE_TENTHS = 25;

function haversineKm(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Pressure history is kept per source. Readings from a barometer and readings
// from a model must never be differenced against each other - a fixed
// calibration offset between them would read as a storm.
function loadPressureHistory() {
  var raw = localStorage.getItem('pressure_history_v2');
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fall through and rebuild */ }
  }
  // Migrate the old flat history - all of it was Open-Meteo.
  var old = {};
  try { old = JSON.parse(localStorage.getItem('pressure_history') || '{}'); } catch (e) { old = {}; }
  var migrated = { om: {} };
  for (var t in old) {
    var entry = old[t];
    migrated.om[t] = (typeof entry === 'object') ? entry : { p: entry };
  }
  return migrated;
}

function savePressureHistory(history) {
  localStorage.setItem('pressure_history_v2', JSON.stringify(history));
}

// Record a reading against one source and return that source's 3-hour trend in
// tenths of hPa, or undefined when there is no trustworthy comparison to make.
// Pass lat/lon for a source that moves with the phone; pass null for a fixed
// station, which by definition never travels between weather systems.
function recordAndTrend(history, source, pressure, lat, lon) {
  if (!history[source]) history[source] = {};
  var series = history[source];
  var now = Date.now();
  var threeHoursAgo = now - (3 * 60 * 60 * 1000);
  var isFirstReading = Object.keys(series).length === 0;

  var oldestEntry = null;
  var oldestTime = null;
  for (var timeStr in series) {
    var time = parseInt(timeStr);
    if (time <= threeHoursAgo && (oldestTime === null || time > oldestTime)) {
      oldestTime = time;
      oldestEntry = series[timeStr];
    }
  }

  var trendTenths;
  if (oldestEntry !== null && !isFirstReading) {
    var oldP = (typeof oldestEntry === 'object') ? oldestEntry.p : oldestEntry;
    var oldLat = (oldestEntry && typeof oldestEntry.lat !== 'undefined') ? oldestEntry.lat : null;
    var oldLon = (oldestEntry && typeof oldestEntry.lon !== 'undefined') ? oldestEntry.lon : null;

    var hasMovedSignificantly = false;
    if (oldLat !== null && oldLon !== null && typeof lat === 'number') {
      if (Math.abs(lat - oldLat) > 0.2 || Math.abs(lon - oldLon) > 0.2) {
        hasMovedSignificantly = true;
      }
    }

    if (hasMovedSignificantly) {
      console.log('[JS] ' + source + ': moved more than ~20km since the reference reading, skipping trend');
    } else {
      trendTenths = Math.round((pressure - oldP) * 10);
      console.log('[JS] ' + source + ' 3hr trend: ' + (trendTenths / 10).toFixed(1) + ' hPa (' + oldP + ' -> ' + pressure + ')');
    }
  } else if (isFirstReading) {
    console.log('[JS] ' + source + ': first reading, no trend yet');
  }

  var entry = { p: pressure };
  if (typeof lat === 'number') { entry.lat = lat; entry.lon = lon; }
  series[now] = entry;

  var fourHoursAgo = now - (4 * 60 * 60 * 1000);
  for (var ts in series) {
    if (parseInt(ts) < fourHoursAgo) delete series[ts];
  }

  return trendTenths;
}

// Global function to resend weather data with current units
function resendWeatherWithCurrentUnits() {
  // Use real weather data if available, otherwise use test data
  var useData = lastWeatherData || {
    pressure: 1013,
    temperature: 20, // celsius
    wind: 15, // km/h  
    precipitation: 2.5, // mm
    conditions: 'Settings Update',
    iconCode: 6
  };
  
  // Simple inline message construction and sending with unit conversions
  var dict = {};
  dict[0] = Math.round(useData.pressure); // PRESSURE_KEY = 0
  dict[1] = Math.round(settings.temperature_unit === 'fahrenheit' ? (useData.temperature * 9/5) + 32 : useData.temperature); // TEMPERATURE_KEY = 1
  dict[2] = useData.conditions || 'Settings Update'; // CONDITIONS_KEY = 2 - use real conditions if available
  dict[20] = (typeof useData.iconCode !== 'undefined') ? useData.iconCode : 6; // ICON_KEY = 20
  if (typeof useData.humidity !== 'undefined') dict[3] = Math.round(useData.humidity); // HUMIDITY_KEY = 3
  dict[4] = Math.round(settings.wind_unit === 'mph' ? useData.wind * 0.621371 : useData.wind); // WIND_KEY = 4
  dict[5] = Math.round(settings.precipitation_unit === 'inches' ? useData.precipitation * 0.0393701 * 100 : useData.precipitation * 10); // PRECIP_KEY = 5
  dict[6] = useData.location || 'Settings'; // LOCATION_KEY = 6 - use real location if available
  if (typeof useData.trendTenths !== 'undefined') dict[7] = Math.round(useData.trendTenths); // PRESSURE_TREND_KEY = 7
  if (typeof useData.uv !== 'undefined') dict[21] = Math.round(useData.uv); // UV_KEY = 21
  dict[23] = useData.fromPws ? 1 : 0; // PRESSURE_SOURCE_KEY = 23 - keep the marker as it was
  dict[9] = settings.temperature_unit === 'fahrenheit' ? 'F' : 'C'; // TEMP_UNIT_KEY = 9
  dict[10] = settings.wind_unit === 'mph' ? 'mph' : 'kph'; // WIND_UNIT_KEY = 10
  dict[11] = settings.precipitation_unit === 'inches' ? 'in' : 'mm'; // PRECIP_UNIT_KEY = 11
  dict[12] = settings.hourly_vibration ? 1 : 0; // HOURLY_VIBRATION_KEY = 12
  dict[13] = settings.update_countdown ? 1 : 0; // UPDATE_COUNTDOWN_KEY = 13
  dict[14] = settings.show_steps ? 1 : 0; // SHOW_STEPS_KEY = 14  
  dict[15] = settings.step_unit === 'miles' ? 1 : 0; // STEP_UNIT_KEY = 15
  dict[18] = settings.storm_warning ? 1 : 0; // STORM_WARNING_KEY = 18
  // Set text color preference: -1=Auto (Legible), 0=Black, 1=White
  if (settings.text_color === 'white') {
    dict[22] = 1;
  } else if (settings.text_color === 'black') {
    dict[22] = 0;
  } else {
    dict[22] = -1; // Auto
  }
  
  Pebble.sendAppMessage(dict,
    function() { console.log('[JS] Settings update sent'); },
    function(e) { console.log('[JS] Settings update failed'); }
  );
}

// Settings are logged in several places; never log the API key itself.
function settingsForLog() {
  var copy = {};
  for (var k in settings) { copy[k] = settings[k]; }
  if (copy.pws_api_key) copy.pws_api_key = '(set)';
  return JSON.stringify(copy);
}

// Load settings from localStorage
function loadSettings() {
  var saved = localStorage.getItem('color_weather_settings');
  if (saved) {
    try {
      var savedSettings = JSON.parse(saved);
      // Merge saved settings with defaults to ensure all properties exist
      if (savedSettings.temperature_unit) settings.temperature_unit = savedSettings.temperature_unit;
      if (savedSettings.wind_unit) settings.wind_unit = savedSettings.wind_unit;
      if (savedSettings.precipitation_unit) settings.precipitation_unit = savedSettings.precipitation_unit;
      if (typeof savedSettings.hourly_vibration !== 'undefined') settings.hourly_vibration = savedSettings.hourly_vibration;
      if (typeof savedSettings.update_countdown !== 'undefined') settings.update_countdown = savedSettings.update_countdown;
      if (typeof savedSettings.show_steps !== 'undefined') settings.show_steps = savedSettings.show_steps;
      if (savedSettings.step_unit) settings.step_unit = savedSettings.step_unit;
      if (typeof savedSettings.storm_warning !== 'undefined') settings.storm_warning = savedSettings.storm_warning;
      if (savedSettings.text_color) settings.text_color = savedSettings.text_color;
      if (typeof savedSettings.pws_enabled !== 'undefined') settings.pws_enabled = savedSettings.pws_enabled;
      if (typeof savedSettings.pws_station_id === 'string') settings.pws_station_id = savedSettings.pws_station_id;
      if (typeof savedSettings.pws_api_key === 'string') settings.pws_api_key = savedSettings.pws_api_key;
      console.log('[JS] Loaded settings: ' + settingsForLog());
    } catch (e) {
      console.log('[JS] Error loading settings, using defaults');
    }
  }
}

// Save settings to localStorage
function saveSettings() {
  localStorage.setItem('color_weather_settings', JSON.stringify(settings));
  console.log('[JS] Saved settings: ' + settingsForLog());
  
  // Immediately update display with new units when settings are saved
  console.log('[JS] Settings saved - immediately updating display with new units...');
  try {
    console.log('[JS] About to call resend function...');
    
    // Check if the function exists
    if (typeof resendWeatherWithCurrentUnits === 'function') {
      console.log('[JS] resendWeatherWithCurrentUnits function exists, calling it...');
      resendWeatherWithCurrentUnits();
    } else {
      console.log('[JS] ERROR: resendWeatherWithCurrentUnits function not found!');
      console.log('[JS] typeof resendWeatherWithCurrentUnits: ' + typeof resendWeatherWithCurrentUnits);
    }
  } catch (error) {
    console.log('[JS] ERROR calling resend function: ' + error.toString());
  }
}

// Unit conversion functions
function convertTemperature(celsius, targetUnit) {
  if (targetUnit === 'fahrenheit') {
    return (celsius * 9/5) + 32;
  }
  return celsius; // celsius
}

function convertWindSpeed(kmh, targetUnit) {
  if (targetUnit === 'mph') {
    return kmh * 0.621371; // km/h to mph
  }
  return kmh; // kph
}

function convertPrecipitation(mm, targetUnit) {
  if (targetUnit === 'inches') {
    return mm * 0.0393701; // mm to inches
  }
  return mm; // mm
}

function getTemperatureLabel() {
  return settings.temperature_unit === 'fahrenheit' ? 'F' : 'C';
}

function getWindLabel() {
  return settings.wind_unit === 'mph' ? 'mph' : 'kph';
}

function getPrecipitationLabel() {
  return settings.precipitation_unit === 'inches' ? 'in' : 'mm';
}



Pebble.addEventListener('ready', function(e) {
  console.log('[JS] src/pkjs/app.js is ready.');
  
  // Load settings on startup
  loadSettings();
  
  // --- 1. Define Keys ---
  var PRESSURE_KEY = (MessageKeys && typeof MessageKeys.PRESSURE !== 'undefined') ? MessageKeys.PRESSURE : 0;
  var TEMPERATURE_KEY = (MessageKeys && typeof MessageKeys.TEMPERATURE !== 'undefined') ? MessageKeys.TEMPERATURE : 1;
  var CONDITIONS_KEY = (MessageKeys && typeof MessageKeys.CONDITIONS !== 'undefined') ? MessageKeys.CONDITIONS : 2;
  var HUMIDITY_KEY = (MessageKeys && typeof MessageKeys.HUMIDITY !== 'undefined') ? MessageKeys.HUMIDITY : 3;
  var WIND_KEY = (MessageKeys && typeof MessageKeys.WIND !== 'undefined') ? MessageKeys.WIND : 4;
  var PRECIP_KEY = (MessageKeys && typeof MessageKeys.PRECIP !== 'undefined') ? MessageKeys.PRECIP : 5;
  var LOCATION_KEY = (MessageKeys && typeof MessageKeys.LOCATION !== 'undefined') ? MessageKeys.LOCATION : 6;
  var PRESSURE_TREND_KEY = (MessageKeys && typeof MessageKeys.PRESSURE_TREND !== 'undefined') ? MessageKeys.PRESSURE_TREND : 7;
  var TEST_KEY = (MessageKeys && typeof MessageKeys.PRESSURE_TEST !== 'undefined') ? MessageKeys.PRESSURE_TEST : 8;
  var TEMP_UNIT_KEY = (MessageKeys && typeof MessageKeys.TEMP_UNIT !== 'undefined') ? MessageKeys.TEMP_UNIT : 9;
  var WIND_UNIT_KEY = (MessageKeys && typeof MessageKeys.WIND_UNIT !== 'undefined') ? MessageKeys.WIND_UNIT : 10;
  var PRECIP_UNIT_KEY = (MessageKeys && typeof MessageKeys.PRECIP_UNIT !== 'undefined') ? MessageKeys.PRECIP_UNIT : 11;
  var HOURLY_VIBRATION_KEY = (MessageKeys && typeof MessageKeys.HOURLY_VIBRATION !== 'undefined') ? MessageKeys.HOURLY_VIBRATION : 12;
  var UPDATE_COUNTDOWN_KEY = (MessageKeys && typeof MessageKeys.UPDATE_COUNTDOWN !== 'undefined') ? MessageKeys.UPDATE_COUNTDOWN : 13;
  var SHOW_STEPS_KEY = (MessageKeys && typeof MessageKeys.SHOW_STEPS !== 'undefined') ? MessageKeys.SHOW_STEPS : 14;
  var STEP_UNIT_KEY = (MessageKeys && typeof MessageKeys.STEP_UNIT !== 'undefined') ? MessageKeys.STEP_UNIT : 15;
  var STORM_WARNING_KEY = (MessageKeys && typeof MessageKeys.STORM_WARNING !== 'undefined') ? MessageKeys.STORM_WARNING : 18;
  var UV_KEY = (MessageKeys && typeof MessageKeys.UV !== 'undefined') ? MessageKeys.UV : 21;
  var TEXT_COLOR_KEY = (MessageKeys && typeof MessageKeys.TEXT_COLOR !== 'undefined') ? MessageKeys.TEXT_COLOR : 22;
  var PRESSURE_SOURCE_KEY = (MessageKeys && typeof MessageKeys.PRESSURE_SOURCE !== 'undefined') ? MessageKeys.PRESSURE_SOURCE : 23;

  // --- 2. Weather Sending Helper ---
  function sendWeatherToWatch(pressureValue, tempValue, condText, humidityValue, windValue, precipValue, pressureTrendStr, locationName, pressureTrendTenths, uvValue, pressureFromPws) {
    console.log('[JS] sendWeatherToWatch called with args:', {p: pressureValue, t: tempValue, w: windValue, pr: precipValue, loc: locationName, trendTenths: pressureTrendTenths, uv: uvValue});
    
    // Store the raw data for re-sending when units change
    lastWeatherData = {
      pressure: pressureValue,
      temperature: tempValue, 
      conditions: condText,
      iconCode: (typeof window.currentIconCode !== 'undefined') ? window.currentIconCode : 6,
      humidity: humidityValue,
      wind: windValue,
      precipitation: precipValue,
      trend: pressureTrendStr,
      trendTenths: pressureTrendTenths,
      uv: uvValue,
      location: locationName,
      fromPws: pressureFromPws ? true : false
    };
    
    var dict = {};
    if (typeof pressureValue !== 'undefined') dict[PRESSURE_KEY] = Math.round(pressureValue);
    if (typeof pressureTrendTenths !== 'undefined') dict[PRESSURE_TREND_KEY] = Math.round(pressureTrendTenths);
    
    // Apply unit conversions with debug logging
    if (typeof tempValue !== 'undefined') {
      var convertedTemp = convertTemperature(tempValue, settings.temperature_unit);
      dict[TEMPERATURE_KEY] = Math.round(convertedTemp);
    }
    
    if (typeof condText !== 'undefined') dict[CONDITIONS_KEY] = condText.toString();
    var ICON_KEY = (MessageKeys && typeof MessageKeys.WEATHER_ICON !== 'undefined') ? MessageKeys.WEATHER_ICON : 20;
    dict[ICON_KEY] = (typeof window.currentIconCode !== 'undefined') ? window.currentIconCode : 6;

    if (typeof humidityValue !== 'undefined') dict[HUMIDITY_KEY] = Math.round(humidityValue);
    if (typeof uvValue !== 'undefined') dict[UV_KEY] = Math.round(uvValue);
    
    if (typeof windValue !== 'undefined') {
      var convertedWind = convertWindSpeed(windValue, settings.wind_unit);
      dict[WIND_KEY] = Math.round(convertedWind);
    }
    
    if (typeof precipValue !== 'undefined') {
      var convertedPrecip = convertPrecipitation(precipValue, settings.precipitation_unit);
      if (settings.precipitation_unit === 'inches') {
        // Send as hundredths of an inch (multiply by 100)
        dict[PRECIP_KEY] = Math.round(convertedPrecip * 100);
      } else {
        // Send as tenths of mm (multiply by 10)
        dict[PRECIP_KEY] = Math.round(convertedPrecip * 10);
      }
    }
    
    if (typeof locationName !== 'undefined') dict[LOCATION_KEY] = locationName.toString();
    
    // Send unit labels so watch displays correctly
    dict[TEMP_UNIT_KEY] = getTemperatureLabel();
    dict[WIND_UNIT_KEY] = getWindLabel();
    dict[PRECIP_UNIT_KEY] = getPrecipitationLabel();
    
    // Send settings
    dict[HOURLY_VIBRATION_KEY] = settings.hourly_vibration ? 1 : 0;
    dict[UPDATE_COUNTDOWN_KEY] = settings.update_countdown ? 1 : 0;
    dict[SHOW_STEPS_KEY] = settings.show_steps ? 1 : 0;
    dict[STEP_UNIT_KEY] = settings.step_unit === 'miles' ? 1 : 0; // 1 = miles, 0 = kilometers
    dict[STORM_WARNING_KEY] = settings.storm_warning ? 1 : 0;
    if (settings.text_color === 'white') {
      dict[TEXT_COLOR_KEY] = 1;
    } else if (settings.text_color === 'black') {
      dict[TEXT_COLOR_KEY] = 0;
    }

    // Tell the watch whose barometer this is, so the pressure row can say so
    dict[PRESSURE_SOURCE_KEY] = pressureFromPws ? 1 : 0;

    Pebble.sendAppMessage(dict,
      function() { console.log('[JS] Weather update sent'); },
      function(e) { console.log('[JS] Weather update failed'); }
    );
  }

  // --- 2.6 Test function to send sample data with current unit settings ---
  function sendTestDataWithCurrentUnits() {
    console.log('[JS] Sending test data with current units: ' + settingsForLog());
    
    // Always start with base metric values and let the conversion functions handle it
    var baseTempC = 20; // 20C
    var baseWindKmh = 16; // 16 km/h  
    var basePrecipMm = 2.5; // 2.5 mm
    
    console.log('[JS] Base values: temp=' + baseTempC + 'C, wind=' + baseWindKmh + 'kmh, precip=' + basePrecipMm + 'mm');
    console.log('[JS] Target units: temp=' + settings.temperature_unit + ', wind=' + settings.wind_unit + ', precip=' + settings.precipitation_unit);
    
    console.log('[JS] About to call sendWeatherToWatch with converted units...');
    
    try {
      // The sendWeatherToWatch function will convert these to the user's preferred units
      sendWeatherToWatch(
        1013, // pressure
        baseTempC, // temperature in Celsius (will be converted)
        'Test Mode',
        50, // humidity
        baseWindKmh, // wind in km/h (will be converted)
        basePrecipMm, // precip in mm (will be converted)
        '+0.5', // trend
        'Settings Test'
      );
      
      console.log('[JS] sendWeatherToWatch call completed');
    } catch (error) {
      console.log('[JS] ERROR in sendWeatherToWatch: ' + error.toString());
    }
  }

  // --- 3. Weather Mapping ---
  function getWeatherIconCode(code, isDay) {
    if (isDay === undefined) isDay = 1; // Default to day
    
    if (code === 0 || code === 1) {
      return isDay ? 0 : 8; // 0 for Day Clear, 8 for Night Clear
    }
    if (code === 2) {
      return isDay ? 1 : 9; // 1 for Day Partly Cloudy, 9 for Night Partly Cloudy
    }
    if (code === 3) return 2; // Overcast
    if (code === 45 || code === 48) return 5; // Fog
    if (code >= 51 && code <= 67) return 3; // Rain / Drizzle
    if (code >= 80 && code <= 82) return 3; // Showers
    if (code === 71 || code === 73 || code === 75 || code === 77) return 4; // Snow
    if (code >= 85 && code <= 86) return 4; // Snow showers
    if (code >= 95 && code <= 99) return 7; // Thunderstorm
    return 6; // Unknown
  }

  function weatherCodeToString(code) {
    // Open-Meteo WMO Weather interpretation codes (WW)
    // https://open-meteo.com/en/docs
    
    if (code === 0) return 'Clear Sky';
    if (code === 1) return 'Mainly Clear';
    if (code === 2) return 'Partly Cloudy';
    if (code === 3) return 'Overcast';
    
    if (code === 45) return 'Fog';
    if (code === 48) return 'Depositing Rime';
    
    if (code === 51) return 'Light Drizzle';
    if (code === 53) return 'Moderate Drizzle';
    if (code === 55) return 'Dense Drizzle';
    if (code === 56) return 'Light Freezing Drizzle';
    if (code === 57) return 'Dense Freezing Drizzle';
    
    if (code === 61) return 'Rain';
    if (code === 63) return 'Moderate Rain';
    if (code === 65) return 'Heavy Rain';
    if (code === 66) return 'Light Freezing Rain';
    if (code === 67) return 'Heavy Freezing Rain';
    
    if (code === 71) return 'Snow';
    if (code === 73) return 'Moderate Snow';
    if (code === 75) return 'Heavy Snow';
    if (code === 77) return 'Snow Grains';
    
    if (code === 80) return 'Rain Showers';
    if (code === 81) return 'Moderate Rain Showers';
    if (code === 82) return 'Violent Rain Showers';
    if (code === 85) return 'Snow Showers';
    if (code === 86) return 'Heavy Snow Showers';
    
    if (code === 95) return 'Thunderstorm';
    if (code === 96) return 'Thunderstorm w/ Hail';
    if (code === 99) return 'Thunderstorm w/ Heavy Hail';
    
    return 'Unknown (' + code + ')';
  }

  // --- 3.5. Reverse Geocoding (NEW: Using Nominatim for better accuracy) ---
  function reverseGeocode(lat, lon, callback) {
    // Use Nominatim (OpenStreetMap) for more detailed, local results
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
              '&lat=' + encodeURIComponent(lat) +
              '&lon=' + encodeURIComponent(lon) +
              '&accept-language=en';
    
    console.log('[JS] Reverse geocoding (Nominatim): ' + url);

    var xhr = new XMLHttpRequest();
    xhr.timeout = 10000; // 10 second timeout
    
    xhr.open('GET', url, true);
    
    // IMPORTANT: Nominatim's usage policy requires a valid User-Agent.
    // We must set this header or we will be blocked.
    xhr.setRequestHeader('User-Agent', 'Color Weather Pebble Face/1.0.0 (https://github.com/digitalurban/color-weather-pebble)');

    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          var locationName = 'Unknown';

          // --- New Parsing Logic for Nominatim ---
          // Try to find the most local name possible
          if (data && data.address) {
            if (data.address.village) {
              locationName = data.address.village; // e.g., "Fincham"
            } else if (data.address.hamlet) {
              locationName = data.address.hamlet;
            } else if (data.address.suburb) {
              locationName = data.address.suburb;
            } else if (data.address.town) {
              locationName = data.address.town;
            } else if (data.address.city) {
              locationName = data.address.city; // e.g., "King's Lynn"
            } else if (data.address.county) {
              locationName = data.address.county;
            }
          } else if (data && data.display_name) {
            // Fallback to just the first part of the full name
            locationName = data.display_name.split(',')[0];
          }
          // --- End of New Parsing Logic ---

          console.log('[JS] Reverse geocoding result: ' + locationName);
          callback(locationName);
        } catch (ex) {
          console.log('[JS] Error parsing reverse geocode response: ' + ex);
          callback('Unknown');
        }
      } else {
        console.log('[JS] Reverse geocode failed: HTTP ' + xhr.status);
        callback('Unknown');
      }
    };

    xhr.ontimeout = function() {
      console.log('[JS] Reverse geocode timeout');
      callback('Unknown');
    };

    xhr.onerror = function(e) {
      console.log('[JS] Reverse geocode error');
      callback('Unknown');
    };
    
    xhr.send();
  }

  // --- 4. Fetch Function (No Promises) ---
  // --- 4.5 Personal Weather Station (Weather Underground) ---
  // A PWS reports sensors only - no condition text, no weather code - so this
  // never replaces Open-Meteo, it only overlays the measured values on top.
  function fetchPWSObservation(callback) {
    if (!settings.pws_enabled || !settings.pws_station_id || !settings.pws_api_key) {
      callback(null);
      return;
    }

    var url = 'https://api.weather.com/v2/pws/observations/current' +
              '?stationId=' + encodeURIComponent(settings.pws_station_id) +
              '&format=json&units=m' +
              '&apiKey=' + encodeURIComponent(settings.pws_api_key);

    console.log('[JS] Fetching PWS observation for ' + settings.pws_station_id);

    var xhr = new XMLHttpRequest();
    xhr.timeout = 15000;

    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;

      if (xhr.status === 401 || xhr.status === 403) {
        console.log('[JS] PWS rejected the API key (HTTP ' + xhr.status + ') - check it in settings');
        callback(null);
        return;
      }
      if (xhr.status === 204 || xhr.status === 404) {
        console.log('[JS] PWS returned no data for station "' + settings.pws_station_id + '" - check the station ID');
        callback(null);
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        console.log('[JS] PWS fetch failed: HTTP ' + xhr.status + ' - falling back to Open-Meteo');
        callback(null);
        return;
      }

      try {
        var data = JSON.parse(xhr.responseText);
        var obs = (data.observations && data.observations.length > 0) ? data.observations[0] : null;
        if (!obs) {
          console.log('[JS] PWS response had no observations - falling back');
          callback(null);
          return;
        }

        var metric = obs.metric || {};

        // A station that has stopped uploading must not be presented as current.
        var obsMs = obs.epoch ? (obs.epoch * 1000) : Date.parse(obs.obsTimeUtc);
        var ageMin = isFinite(obsMs) ? ((Date.now() - obsMs) / 60000) : 0;
        if (ageMin > PWS_MAX_AGE_MIN) {
          console.log('[JS] PWS reading is ' + Math.round(ageMin) + ' minutes old - ignoring it');
          callback(null);
          return;
        }

        callback({
          stationId: obs.stationID,
          lat: obs.lat,
          lon: obs.lon,
          ageMin: ageMin,
          temp: metric.temp,             // degrees C
          humidity: obs.humidity,        // percent
          wind: metric.windSpeed,        // km/h, matching Open-Meteo
          precip: metric.precipTotal,    // mm accumulated today
          pressure: metric.pressure,     // hPa
          uv: obs.uv,
          solar: obs.solarRadiation
        });
      } catch (ex) {
        console.log('[JS] Error parsing PWS response: ' + ex);
        callback(null);
      }
    };

    xhr.ontimeout = function() {
      console.log('[JS] PWS request timed out - falling back to Open-Meteo');
      callback(null);
    };
    xhr.onerror = function() {
      console.log('[JS] PWS network error - falling back to Open-Meteo');
      callback(null);
    };

    xhr.open('GET', url, true);
    xhr.send();
  }

  function fetchPressureFromOpenMeteo(lat, lon, locationName, pwsData) {
    // Build API URL to get current data for temperature/pressure/wind, 15-minute forecast for conditions, daily for rainfall
    // We use pressure_msl (Mean Sea Level) instead of surface_pressure to avoid false storm warnings while traveling/changing altitude
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon) + 
              '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,pressure_msl,uv_index,is_day' + // Current conditions (including is_day)
              '&minutely_15=weather_code&forecast_minutely_15=1' + // 15-min forecast for conditions only
              '&daily=precipitation_sum&forecast_days=1' + // Daily accumulated rainfall
              '&timeformat=unixtime&timezone=auto';
    
    console.log('[JS] Fetching Open-Meteo: ' + url);

    var xhr = new XMLHttpRequest();
    xhr.timeout = 30000; // 30 second timeout

    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return; // Wait for request to be done

      console.log('[JS] XHR readyState=4 status=' + (xhr.status || 0) + ' url=' + url);

      if (xhr.status >= 200 && xhr.status < 300) {
        // SUCCESS
        try {
          var data = JSON.parse(xhr.responseText);
          console.log('[JS] Open-Meteo JSON received and parsed.');

          var currentTemp = undefined;
          var currentCondition = undefined;
          var humidity = undefined;
          var windSpeed = undefined;
          var precipitation = undefined;
          var pressure = undefined;
          var trendStr = undefined;
          var trendTenths = undefined;
          var uvIndex = undefined;
          var isDay = 1;

          console.log('[JS] Using current data for temperature/pressure/wind, 15-minute forecast for conditions, daily for rainfall');
          
          // Extract current weather data (most accurate for present conditions)
          if (data.current) {
            var current = data.current;
            if (current.is_day !== undefined) {
              isDay = current.is_day;
            }
            if (current.temperature_2m !== undefined) {
              currentTemp = current.temperature_2m;
            }
            if (current.relative_humidity_2m !== undefined) {
              humidity = current.relative_humidity_2m;
            }
            if (current.wind_speed_10m !== undefined) {
              windSpeed = current.wind_speed_10m;
            }
            if (current.uv_index !== undefined) {
              uvIndex = current.uv_index;
            }
            if (current.pressure_msl !== undefined) {
              pressure = current.pressure_msl;
              console.log('[JS] Open-Meteo pressure (MSL): ' + pressure + ' hPa');
            }
          }
          
          // Extract weather conditions from 15-minute forecast (next 15 minutes)
          if (data.minutely_15 && data.minutely_15.weather_code && data.minutely_15.weather_code.length > 0) {
            currentCondition = weatherCodeToString(data.minutely_15.weather_code[0]);
            try { window.currentIconCode = getWeatherIconCode(data.minutely_15.weather_code[0], isDay); } catch(e){ window.currentIconCode = 6;}
            console.log('[JS] 15-minute forecast conditions: ' + currentCondition + ' (isDay: ' + isDay + ')');
          }
            
            // Extract daily accumulated rainfall
            if (data.daily && data.daily.precipitation_sum && data.daily.precipitation_sum.length > 0) {
              precipitation = data.daily.precipitation_sum[0];
              console.log('[JS] Daily accumulated rainfall: ' + precipitation + ' mm');
            }

          // --- Choose a source and work out the pressure trend ---------------
          // Both series are recorded every cycle, so the station's history stays
          // warm while you are away and is ready the moment you come home.
          var history = loadPressureHistory();
          var omTrend, pwsTrend;
          var usingPws = false;

          if (typeof pressure === 'number') {
            omTrend = recordAndTrend(history, 'om', pressure, lat, lon);
          }

          if (pwsData) {
            if (typeof pwsData.pressure === 'number') {
              // A fixed station never travels, so no lat/lon guard is needed.
              pwsTrend = recordAndTrend(history, 'pws:' + (pwsData.stationId || 'station'), pwsData.pressure, null, null);
            }

            var distKm = (typeof pwsData.lat === 'number' && typeof pwsData.lon === 'number')
              ? haversineKm(lat, lon, pwsData.lat, pwsData.lon) : null;

            if (distKm === null) {
              console.log('[JS] PWS gave no coordinates, cannot tell how far away it is - using Open-Meteo');
            } else if (distKm > PWS_MAX_KM) {
              console.log('[JS] ' + distKm.toFixed(1) + ' km from ' + pwsData.stationId + ' (limit ' + PWS_MAX_KM + ') - using Open-Meteo');
            } else {
              usingPws = true;
              console.log('[JS] ' + distKm.toFixed(1) + ' km from ' + pwsData.stationId + ' - using station readings');
            }

            // Sanity-check the barometer against the model before trusting it.
            if (usingPws && typeof pwsTrend === 'number' && typeof omTrend === 'number' &&
                Math.abs(pwsTrend - omTrend) > PWS_DISAGREE_TENTHS) {
              console.log('[JS] Station trend ' + (pwsTrend / 10).toFixed(1) + ' hPa disagrees with model ' +
                          (omTrend / 10).toFixed(1) + ' hPa - distrusting the station and falling back');
              usingPws = false;
            }
          }

          savePressureHistory(history);

          if (usingPws) {
            if (typeof pwsData.temp === 'number') currentTemp = pwsData.temp;
            if (typeof pwsData.humidity === 'number') humidity = pwsData.humidity;
            if (typeof pwsData.wind === 'number') windSpeed = pwsData.wind;
            if (typeof pwsData.precip === 'number') precipitation = pwsData.precip;
            if (typeof pwsData.uv === 'number') uvIndex = pwsData.uv;
            if (typeof pwsData.pressure === 'number') pressure = pwsData.pressure;
            trendTenths = pwsTrend;
          } else {
            trendTenths = omTrend;
          }

          if (typeof trendTenths === 'number') {
            trendStr = (trendTenths >= 0 ? '+' : '') + (trendTenths / 10).toFixed(1);
          }

          sendWeatherToWatch(pressure, currentTemp, currentCondition, humidity, windSpeed, precipitation, trendStr, locationName, trendTenths, uvIndex, usingPws);

        } catch (ex) {
          console.log('[JS] Error parsing Open-Meteo response: ' + ex);
          sendWeatherToWatch(1013, 20, 'Parse Error', undefined, undefined, undefined, undefined, locationName, undefined); // Send specific error
        }
      } else {
        // FAILURE (status 0, 404, 500, etc.)
        console.log('[JS] Open-Meteo fetch failed: HTTP status ' + xhr.status + ' -- sending fallback');
        sendWeatherToWatch(1013, 20, 'HTTP Fail ' + xhr.status, undefined, undefined, undefined, undefined, locationName, undefined); // Send specific error
      }
    };

    xhr.ontimeout = function() {
      console.log('[JS] XHR TIMEOUT after ' + xhr.timeout + 'ms url=' + url);
      sendWeatherToWatch(1013, 20, 'Timeout', undefined, undefined, undefined, undefined, locationName, undefined); // Send specific error
    };

    xhr.onerror = function(e) {
      console.log('[JS] XHR ERROR url=' + url);
      sendWeatherToWatch(1013, 20, 'Net Error', undefined, undefined, undefined, undefined, locationName, undefined); // Send specific error
    };
    
    xhr.open('GET', url, true);
    xhr.send();
  }

  // --- 5. Geolocation ---
  var DEFAULT_LAT = 51.5074;  // London
  var DEFAULT_LON = -0.1278;

  function updatePressure() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(position) {
          var lat = position.coords.latitude;
          var lon = position.coords.longitude;
          console.log('[JS] Geolocation success: lat=' + lat + ' lon=' + lon);
          
          // CORRECT: The weather fetch is now INSIDE the callback.
          reverseGeocode(lat, lon, function(locationName) {
            fetchPWSObservation(function(pwsData) {
              fetchPressureFromOpenMeteo(lat, lon, locationName, pwsData);
            });
          });
        },
        function(error) {
          console.log('[JS] Geolocation error: ' + error.message + ' -- using default coords');
          fetchPressureFromOpenMeteo(DEFAULT_LAT, DEFAULT_LON, "London", null);
        },
        { timeout: 10000, enableHighAccuracy: false }
      );
    } else {
      console.log('[JS] Geolocation not available -- using default coords');
      fetchPressureFromOpenMeteo(DEFAULT_LAT, DEFAULT_LON, "London", null);
    }
  }

  // Initial immediate update
  updatePressure();

  // Then refresh periodically
  setInterval(updatePressure, 15 * 60 * 1000);
});

// --- Settings Event Handlers ---
Pebble.addEventListener('showConfiguration', function() {
  // Load settings first to ensure current state is reflected
  loadSettings();
  console.log('[JS] showConfiguration - Current settings: ' + settingsForLog());
  
  var appVersion = '1.0.0';
  var watchPlatform = Pebble.getActiveWatchInfo() ? Pebble.getActiveWatchInfo().platform : 'unknown';
  var isEmery = (watchPlatform === 'emery');

  // Appearance group only for Time 2 (Emery)
  var appearanceGroup = '';
  if (isEmery) {
    appearanceGroup = '<div class="setting-group"><div class="setting-label">🎨 Appearance</div><div class="radio-group">' +
      '<div class="radio-option"><input type="radio" id="text_white" name="text_color" value="white" ' + (settings.text_color === 'white' ? 'checked' : '') + '><label for="text_white">White Text</label></div>' +
      '<div class="radio-option"><input type="radio" id="text_black" name="text_color" value="black" ' + (settings.text_color === 'black' ? 'checked' : '') + '><label for="text_black">Black Text</label></div>' +
      '</div><div class="description">Choose the font color. The background will change automatically based on temperature.</div></div>';
  }

  // For now, we'll use a simple data: URL with embedded configuration
  var configHtml = '<!DOCTYPE html><html><head><title>Color Weather Settings</title>' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<style>' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:20px;background-color:#f5f5f5;line-height:1.6}' +
'.container{max-width:600px;margin:0 auto;background:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}' +
'h1{color:#333;text-align:center;margin-bottom:30px}' +
'.setting-group{margin-bottom:25px;padding:20px;border:1px solid #e0e0e0;border-radius:8px;background-color:#fafafa}' +
'.setting-label{font-weight:bold;margin-bottom:10px;color:#555}' +
'.radio-group{display:flex;gap:20px;flex-wrap:wrap}' +
'.radio-option{display:flex;align-items:center;gap:8px}' +
'input[type="radio"]{margin:0}' +
'.button-group{text-align:center;margin-top:30px;gap:15px;display:flex;justify-content:center}' +
'button{padding:12px 25px;font-size:16px;border:none;border-radius:6px;cursor:pointer;font-weight:500}' +
'.save-btn{background-color:#4CAF50;color:white}.save-btn:hover{background-color:#45a049}' +
'.cancel-btn{background-color:#f44336;color:white}.cancel-btn:hover{background-color:#da190b}' +
'.description{color:#666;font-size:14px;margin-top:5px;font-style:italic}' +
'</style></head><body>' +
'<div class="container">' +
'<h1>⛅ Color Weather Settings</h1>' +
'<form id="settingsForm">' +
'<div class="setting-group">' +
'<div class="setting-label">Temperature Units</div>' +
'<div class="radio-group">' +
'<div class="radio-option"><input type="radio" id="temp_celsius" name="temperature_unit" value="celsius" ' + (settings.temperature_unit === 'celsius' ? 'checked' : '') + '><label for="temp_celsius">Celsius (°C)</label></div>' +
'<div class="radio-option"><input type="radio" id="temp_fahrenheit" name="temperature_unit" value="fahrenheit" ' + (settings.temperature_unit === 'fahrenheit' ? 'checked' : '') + '><label for="temp_fahrenheit">Fahrenheit (°F)</label></div>' +
'</div><div class="description">Choose how temperature is displayed on your watch</div></div>' +
'<div class="setting-group">' +
'<div class="setting-label">Wind Speed Units</div>' +
'<div class="radio-group">' +
'<div class="radio-option"><input type="radio" id="wind_mph" name="wind_unit" value="mph" ' + (settings.wind_unit === 'mph' ? 'checked' : '') + '><label for="wind_mph">Miles per hour (mph)</label></div>' +
'<div class="radio-option"><input type="radio" id="wind_kph" name="wind_unit" value="kph" ' + (settings.wind_unit === 'kph' ? 'checked' : '') + '><label for="wind_kph">Kilometers per hour (km/h)</label></div>' +
'</div><div class="description">Choose wind speed measurement unit</div></div>' +
'<div class="setting-group">' +
'<div class="setting-label">Precipitation Units</div>' +
'<div class="radio-group">' +
'<div class="radio-option"><input type="radio" id="precip_mm" name="precipitation_unit" value="mm" ' + (settings.precipitation_unit === 'mm' ? 'checked' : '') + '><label for="precip_mm">Millimeters (mm)</label></div>' +
'<div class="radio-option"><input type="radio" id="precip_in" name="precipitation_unit" value="inches" ' + (settings.precipitation_unit === 'inches' ? 'checked' : '') + '><label for="precip_in">Inches (in)</label></div>' +
'</div><div class="description">Choose rainfall measurement unit</div></div>' +
'<div class="setting-group"><div class="setting-label">Hourly Vibration</div><div class="radio-option">' +
'<input type="checkbox" id="hourly_vibration" name="hourly_vibration" ' + (settings.hourly_vibration ? 'checked' : '') + '>' +
'<label for="hourly_vibration">Vibrate on the hour</label></div>' +
'<div class="description">Watch will vibrate briefly at the top of each hour</div></div>' +
'<div class="setting-group"><div class="setting-label">Update Countdown</div><div class="radio-option">' +
'<input type="checkbox" id="update_countdown" name="update_countdown" ' + (settings.update_countdown ? 'checked' : '') + '>' +
'<label for="update_countdown">Show weather update progress</label></div>' +
'<div class="description">Display a progress line showing time until next weather update (15 minutes)</div></div>' +
'<div class="setting-group"><div class="setting-label">Step Tracking</div><div class="radio-option">' +
'<input type="checkbox" id="show_steps" name="show_steps" ' + (settings.show_steps ? 'checked' : '') + '>' +
'<label for="show_steps">Show step count and distance</label></div>' +
'<div class="description">Replace wind/precipitation data with daily step count and distance (requires Health permission)</div></div>' +
'<div class="setting-group"><div class="setting-label">Distance Units</div><div class="radio-group">' +
'<div class="radio-option"><input type="radio" id="step_miles" name="step_unit" value="miles" ' + (settings.step_unit === 'miles' ? 'checked' : '') + '><label for="step_miles">Miles (mi)</label></div>' +
'<div class="radio-option"><input type="radio" id="step_km" name="step_unit" value="kilometers" ' + (settings.step_unit === 'kilometers' ? 'checked' : '') + '><label for="step_km">Kilometers (km)</label></div>' +
'</div><div class="description">Choose distance measurement unit for step tracking</div></div>' +
'<div class="setting-group"><div class="setting-label">⚠️ Storm Warning (Experimental)</div><div class="radio-option">' +
'<input type="checkbox" id="storm_warning" name="storm_warning" ' + (settings.storm_warning ? 'checked' : '') + '>' +
'<label for="storm_warning">Enable storm warnings</label></div>' +
'<div class="description">Get vibration alerts and watch warnings when barometric pressure drops -3mb in 3 hours, indicating potential severe weather</div></div>' +
'<div class="setting-group"><div class="setting-label">📡 Personal Weather Station (optional)</div><div class="radio-option">' +
'<input type="checkbox" id="pws_enabled" name="pws_enabled" ' + (settings.pws_enabled ? 'checked' : '') + '>' +
'<label for="pws_enabled">Use my Weather Underground station</label></div>' +
'<div style="margin-top:12px"><label for="pws_station_id" style="display:block;margin-bottom:4px">Station ID</label>' +
'<input type="text" id="pws_station_id" name="pws_station_id" value="' + (settings.pws_station_id || '').replace(/"/g, '&quot;') + '" placeholder="e.g. IcambRIDG42" autocapitalize="characters" autocorrect="off" spellcheck="false" style="width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box"></div>' +
'<div style="margin-top:12px"><label for="pws_api_key" style="display:block;margin-bottom:4px">API key</label>' +
'<input type="text" id="pws_api_key" name="pws_api_key" value="' + (settings.pws_api_key || '').replace(/"/g, '&quot;') + '" placeholder="32-character key" autocorrect="off" spellcheck="false" style="width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box"></div>' +
'<div class="description">Station owners get a free key from wunderground.com/member/api-keys. Your station replaces the forecast values for temperature, humidity, wind, rainfall, pressure and UV &mdash; but only while you are within ' + PWS_MAX_KM + 'km of it. Further away, or if the station stops reporting, the face falls back to Open-Meteo on its own. Conditions and the weather icon always come from Open-Meteo, since a weather station has no way to report them.</div></div>' +
appearanceGroup +
'<div class="button-group"><button type="submit" class="save-btn">Save Settings</button>' +
'<button type="button" class="cancel-btn" onclick="document.location=\'pebblejs://close#\'">Cancel</button></div>' +
'</form></div>' +
'<script>' +
'document.getElementById("settingsForm").addEventListener("submit", function(e) {' +
'  e.preventDefault();' +
'  var settings = {' +
'    temperature_unit: document.querySelector(\'input[name="temperature_unit"]:checked\').value,' +
'    wind_unit: document.querySelector(\'input[name="wind_unit"]:checked\').value,' +
'    precipitation_unit: document.querySelector(\'input[name="precipitation_unit"]:checked\').value,' +
'    hourly_vibration: document.getElementById("hourly_vibration").checked,' +
'    update_countdown: document.getElementById("update_countdown").checked,' +
'    show_steps: document.getElementById("show_steps").checked,' +
'    step_unit: document.querySelector(\'input[name="step_unit"]:checked\').value,' +
'    storm_warning: document.getElementById("storm_warning").checked,' +
'    pws_enabled: document.getElementById("pws_enabled").checked,' +
'    pws_station_id: document.getElementById("pws_station_id").value.trim(),' +
'    pws_api_key: document.getElementById("pws_api_key").value.trim(),' +
'    text_color: document.querySelector(\'input[name="text_color"]\') ? document.querySelector(\'input[name="text_color"]:checked\').value : "white"' +
'  };' +
'  if (settings.pws_enabled && (!settings.pws_station_id || !settings.pws_api_key)) {' +
'    alert("Enter both a station ID and an API key, or untick the personal weather station option.");' +
'    return;' +
'  }' +
'  document.location = "pebblejs://close#" + encodeURIComponent(JSON.stringify(settings));' +
'});' +
'</script></body></html>';

  var url = 'data:text/html;charset=utf-8,' + encodeURIComponent(configHtml);
  console.log('[JS] Opening settings page');
  Pebble.openURL(url);
});

Pebble.addEventListener('webviewclosed', function(e) {
  try {
    console.log('[JS] webviewclosed event fired, response: ' + (e.response ? 'YES' : 'NO'));
    if (e.response) {
    console.log('[JS] Raw response: ' + e.response);
    try {
      var newSettings = JSON.parse(decodeURIComponent(e.response));
      console.log('[JS] Received new settings: ' + JSON.stringify(newSettings));
      console.log('[JS] Old settings: ' + settingsForLog());
      
      // Update settings
      if (newSettings.temperature_unit) settings.temperature_unit = newSettings.temperature_unit;
      if (newSettings.wind_unit) settings.wind_unit = newSettings.wind_unit;  
      if (newSettings.precipitation_unit) settings.precipitation_unit = newSettings.precipitation_unit;
      if (typeof newSettings.hourly_vibration !== 'undefined') {
        console.log('[JS] Updating hourly_vibration from ' + settings.hourly_vibration + ' to ' + newSettings.hourly_vibration);
        settings.hourly_vibration = newSettings.hourly_vibration;
      } else {
        console.log('[JS] hourly_vibration not found in new settings');
      }
      if (typeof newSettings.update_countdown !== 'undefined') {
        console.log('[JS] Updating update_countdown from ' + settings.update_countdown + ' to ' + newSettings.update_countdown);
        settings.update_countdown = newSettings.update_countdown;
      } else {
        console.log('[JS] update_countdown not found in new settings');
      }
      if (typeof newSettings.show_steps !== 'undefined') {
        console.log('[JS] Updating show_steps from ' + settings.show_steps + ' to ' + newSettings.show_steps);
        settings.show_steps = newSettings.show_steps;
      } else {
        console.log('[JS] show_steps not found in new settings');
      }
      if (newSettings.step_unit) {
        console.log('[JS] Updating step_unit from ' + settings.step_unit + ' to ' + newSettings.step_unit);
        settings.step_unit = newSettings.step_unit;
      } else {
        console.log('[JS] step_unit not found in new settings');
      }
      if (typeof newSettings.storm_warning !== 'undefined') {
        console.log('[JS] Updating storm_warning from ' + settings.storm_warning + ' to ' + newSettings.storm_warning);
        settings.storm_warning = newSettings.storm_warning;
      } else {
        console.log('[JS] storm_warning not found in new settings');
      }
      if (newSettings.text_color) {
        console.log('[JS] Updating text_color from ' + settings.text_color + ' to ' + newSettings.text_color);
        settings.text_color = newSettings.text_color;
      } else {
        console.log('[JS] text_color not found in new settings');
      }
      if (typeof newSettings.pws_enabled !== 'undefined') {
        settings.pws_enabled = newSettings.pws_enabled;
      }
      if (typeof newSettings.pws_station_id === 'string') {
        settings.pws_station_id = newSettings.pws_station_id;
      }
      if (typeof newSettings.pws_api_key === 'string') {
        settings.pws_api_key = newSettings.pws_api_key;
      }
      console.log('[JS] PWS: ' + (settings.pws_enabled ? ('enabled, station ' + settings.pws_station_id) : 'disabled'));
      console.log('[JS] Updated settings: ' + settingsForLog());
      
      // Save settings
      saveSettings();
      
      // Send a test message with new units to verify they work
      console.log('[JS] Testing units: temp=' + getTemperatureLabel() + ', wind=' + getWindLabel() + ', precip=' + getPrecipitationLabel());
      
      // Immediately resend last weather data with new units
      console.log('[JS] Units changed - resending weather data with new units...');
      resendWeatherWithCurrentUnits();
      
      // Also refresh real weather data after a short delay
      console.log('[JS] Settings updated, refreshing weather data in 2 seconds...');
      setTimeout(function() {
        updatePressure();
      }, 2000);
      
    } catch (ex) {
      console.log('[JS] Error parsing settings response: ' + ex);
      console.log('[JS] Raw response: ' + e.response);
    }
  } else {
    console.log('[JS] Settings cancelled by user');
  }
  } catch (error) {
    console.log('[JS] ERROR in webviewclosed handler: ' + error.toString());
  }
});

console.log('[JS] src/pkjs/app.js loaded.');

// Load settings and send them to the watch on startup
loadSettings();
console.log('[JS] Settings loaded on startup, sending to watch...');
resendWeatherWithCurrentUnits();


//////////////////
// WEBPACK FOOTER
// ./src/pkjs/app.js
// module id = 3
// module chunks = 0