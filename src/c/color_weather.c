#include <pebble.h>

// We'll use these keys to send data from JS to C
#define MESSAGE_KEY_PRESSURE 0
#define MESSAGE_KEY_TEMPERATURE 1
#define MESSAGE_KEY_CONDITIONS 2
#define MESSAGE_KEY_HUMIDITY 3
#define MESSAGE_KEY_WIND 4
#define MESSAGE_KEY_PRECIP 5
#define MESSAGE_KEY_LOCATION 6
#define MESSAGE_KEY_PRESSURE_TREND 7
// Diagnostic/test key sent from the companion to indicate HTTPS/XHR test result
#define MESSAGE_KEY_PRESSURE_TEST 8
// Unit labels sent from JS to ensure correct display
#define MESSAGE_KEY_TEMP_UNIT 9
#define MESSAGE_KEY_WIND_UNIT 10
#define MESSAGE_KEY_PRECIP_UNIT 11
#define MESSAGE_KEY_HOURLY_VIBRATION 12
#define MESSAGE_KEY_UPDATE_COUNTDOWN 13
#define MESSAGE_KEY_SHOW_STEPS 14
#define MESSAGE_KEY_STEP_UNIT 15
#define MESSAGE_KEY_STEP_COUNT 16
#define MESSAGE_KEY_STEP_DISTANCE 17
#define MESSAGE_KEY_STORM_WARNING 18
#define MESSAGE_KEY_WEATHER_ICON 20
#define MESSAGE_KEY_UV 21
#define MESSAGE_KEY_TEXT_COLOR 22
// 1 when the pressure came from the user's own weather station, 0 from the model
#define MESSAGE_KEY_PRESSURE_SOURCE 23

static Window *s_main_window;
static TextLayer *s_time_layer;
static TextLayer *s_location_layer;
static Layer *s_update_progress_layer;
static TextLayer *s_temp_layer;
static TextLayer *s_temp_cond_layer;
static TextLayer *s_pressure_layer;
static TextLayer *s_wind_precip_layer;
static TextLayer *s_steps_layer = NULL;

static GColor s_text_color;
static GColor s_bg_color;
static int s_current_temp = 999;
static bool s_temp_is_fahrenheit = false;
static int s_user_text_color_preference = 1; // 0=Black, 1=White (Default)

static Layer *s_weather_icon_layer;
static int s_weather_icon_code = 6; // default unknown
static GFont s_weather_font;

// Weather Icons Unicode characters (UTF-8 encoded)
#define ICON_CLEAR "\xef\x80\x8d"           // wi-day-sunny
#define ICON_PARTLY_CLOUDY "\xef\x80\x82"    // wi-day-cloudy
#define ICON_CLEAR_NIGHT "\xef\x80\xae"      // wi-night-clear
#define ICON_PARTLY_CLOUDY_NIGHT "\xef\x82\x81" // wi-night-alt-cloudy
#define ICON_CLOUDY "\xef\x80\x93"           // wi-cloudy
#define ICON_RAIN "\xef\x80\x99"             // wi-rain
#define ICON_SNOW "\xef\x80\x9b"             // wi-snow
#define ICON_FOG "\xef\x80\x94"              // wi-fog
#define ICON_THUNDERSTORM "\xef\x80\x9e"    // wi-thunderstorm
#define ICON_UNKNOWN "\xef\x81\xbb"          // wi-na

static void weather_icon_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  graphics_context_set_fill_color(ctx, s_bg_color);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  char *icon_text;
  switch (s_weather_icon_code) {
    case 0: icon_text = ICON_CLEAR; break;
    case 1: icon_text = ICON_PARTLY_CLOUDY; break;
    case 2: icon_text = ICON_CLOUDY; break;
    case 3: icon_text = ICON_RAIN; break;
    case 4: icon_text = ICON_SNOW; break;
    case 5: icon_text = ICON_FOG; break;
    case 7: icon_text = ICON_THUNDERSTORM; break;
    case 8: icon_text = ICON_CLEAR_NIGHT; break;
    case 9: icon_text = ICON_PARTLY_CLOUDY_NIGHT; break;
    default: icon_text = ICON_UNKNOWN; break;
  }

  graphics_context_set_text_color(ctx, s_text_color);

  // Center horizontally and vertically
  GSize text_size = graphics_text_layout_get_content_size(icon_text, s_weather_font, bounds, GTextOverflowModeFill, GTextAlignmentCenter);
  // Vertically centered in the layer
  GRect text_bounds = GRect(0, (bounds.size.h - text_size.h) / 2, bounds.size.w, text_size.h);

  graphics_draw_text(ctx, icon_text, s_weather_font, text_bounds, GTextOverflowModeFill, GTextAlignmentCenter, NULL);
}

// A buffer to hold the pressure string, e.g., "1012 hPa"
// Buffers for displayed strings
static char s_temp_buffer[16];
static char s_pressure_buffer[64];
static char s_temp_cond_buffer[128];
static char s_location_buffer[128];  // Buffer for location string

// Hourly vibration setting
static bool s_hourly_vibration_enabled = false;
static bool s_update_countdown_enabled = true;
static bool s_storm_warning_enabled = false; // Experimental storm warning feature
static bool s_pressure_from_pws = false; // Pressure came from the user's own station
static int s_last_hour = -1;

// Storm warning state tracking
static bool s_storm_warning_active = false;
static int s_last_storm_trend = 0;

// Update progress tracking
static time_t s_last_weather_update = 0;

// Step tracking settings and data
static bool s_show_steps_enabled = false;
static bool s_step_unit_miles = true; // true = miles, false = kilometers
static char s_step_display_buffer[64];
static int s_current_step_count = 0;
static int s_current_step_distance = 0;

static void update_colors() {
#if defined(PBL_COLOR)
  // Determine background color based on temperature (Celsius) - for all color platforms
  int temp_c = s_current_temp;
  if (s_temp_is_fahrenheit && s_current_temp != 999) {
    temp_c = (s_current_temp - 32) * 5 / 9;
  }

  if (s_current_temp == 999) {
    s_bg_color = GColorBlack;
  } else if (temp_c >= 25) {
    s_bg_color = GColorDarkCandyAppleRed;
  } else if (temp_c >= 20) {
    s_bg_color = GColorWindsorTan;
  } else if (temp_c >= 15) {
    s_bg_color = GColorMidnightGreen;
  } else if (temp_c >= 10) {
    s_bg_color = GColorTiffanyBlue;
  } else if (temp_c >= 0) {
    s_bg_color = GColorCobaltBlue;
  } else {
    s_bg_color = GColorOxfordBlue;
  }

  // Automatic Contrast Fix:
  // Determine legible text color based on the selected background
  s_text_color = gcolor_legible_over(s_bg_color);

  // Apply user overrides if specified (0=Black, 1=White, -1=Auto/Legible)
  if (s_user_text_color_preference == 0) {
    s_text_color = GColorBlack;
  } else if (s_user_text_color_preference == 1) {
    s_text_color = GColorWhite;
  }
#else
  // Pebble 2 (Diorite) and others: Fixed high-contrast (White on Black)
  s_bg_color = GColorBlack;
  s_text_color = GColorWhite;
#endif

  window_set_background_color(s_main_window, s_bg_color);

  // Set text color for all layers
  text_layer_set_text_color(s_time_layer, s_text_color);
  text_layer_set_text_color(s_location_layer, s_text_color);
  text_layer_set_text_color(s_temp_layer, s_text_color);
  text_layer_set_text_color(s_temp_cond_layer, s_text_color);
  text_layer_set_text_color(s_pressure_layer, s_text_color);
  text_layer_set_text_color(s_wind_precip_layer, s_text_color);
  if (s_steps_layer) {
    text_layer_set_text_color(s_steps_layer, s_text_color);
  }

  // Mark layers for redraw
  if (s_weather_icon_layer) layer_mark_dirty(s_weather_icon_layer);
  if (s_update_progress_layer) layer_mark_dirty(s_update_progress_layer);
}

// --- Function Declarations --- //
static void progress_layer_draw(Layer *layer, GContext *ctx);
static void update_step_data(void);
static void update_step_display(void);

static void update_layer_positions() {
  if (!s_main_window) return;

  Layer *window_layer = window_get_root_layer(s_main_window);
  GRect bounds = layer_get_bounds(window_layer);

#if defined(PBL_PLATFORM_EMERY)
  // Pebble Time 2: 200 × 228 px
  const int vertical_padding = 0;
  const int time_h            = 46;
  const int icon_h            = 44;

  // Dynamic layout constants
  int location_h, temp_cond_h, pressure_h, wind_precip_h, steps_h, gap;
  if (s_update_countdown_enabled) {
    // Tighter layout for "Bar" version (v6.18.0)
    location_h    = 31;
    temp_cond_h   = 31;
    pressure_h    = 28;
    wind_precip_h = 28;
    steps_h       = 28;
    gap           = 1;
  } else {
    // Standard layout for "No Bar" version (v6.17.0 standard)
    location_h    = 32;
    temp_cond_h   = 32;
    pressure_h    = 32;
    wind_precip_h = 32;
    steps_h       = 32;
    gap           = 2; // Slightly more gap for "No Bar" to look consistent
  }
#elif defined(PBL_PLATFORM_DIORITE)
  const int vertical_padding = 4;
  const int time_h            = 42;
  const int location_h        = 22;
  const int icon_h            = 22;
  const int temp_h            = 24;
  const int temp_cond_h       = 20;
  const int pressure_h        = 20;
  const int wind_precip_h     = 20;
  const int gap               = 1;
#else
  const int vertical_padding = -3;
  const int time_h            = 42;
  const int location_h        = 18;
  const int icon_h            = 20;
  const int temp_h            = 20;
  const int temp_cond_h       = 20;
  const int pressure_h        = 20;
  const int wind_precip_h     = 20;
  const int gap               = 0;
#endif

  int current_y = vertical_padding;

  // Time and Icon
#if defined(PBL_PLATFORM_EMERY)
  int side_pad = 10;
  int icon_w = 50;
  int time_w = bounds.size.w - icon_w - (side_pad * 2);
  layer_set_frame(text_layer_get_layer(s_time_layer), GRect(side_pad, current_y, time_w, time_h));
  if (s_weather_icon_layer) {
    layer_set_frame(s_weather_icon_layer, GRect(side_pad + time_w, current_y + (time_h - icon_h) / 2, icon_w, icon_h));
  }
#else
  layer_set_frame(text_layer_get_layer(s_time_layer), GRect(0, current_y, bounds.size.w, time_h));
#endif
  current_y += time_h + gap;

#if !defined(PBL_PLATFORM_EMERY)
  if (s_update_countdown_enabled && s_update_progress_layer) {
    int progress_h = 4;
    current_y += 1;
    layer_set_frame(s_update_progress_layer, GRect(0, current_y, bounds.size.w, progress_h));
    current_y += progress_h;
  }
#endif

#if !defined(PBL_PLATFORM_EMERY)
  if (s_weather_icon_layer) {
    layer_set_frame(s_weather_icon_layer, GRect(0, current_y, bounds.size.w, icon_h));
    current_y += icon_h + gap;
  }
#endif

  layer_set_frame(text_layer_get_layer(s_location_layer), GRect(0, current_y, bounds.size.w, location_h));
  current_y += location_h + gap;

#if defined(PBL_PLATFORM_EMERY)
  if (s_update_countdown_enabled && s_update_progress_layer) {
    int progress_h = 2; // Sleeker bar
    current_y += 6; // Centered between Location and Conditions
    layer_set_frame(s_update_progress_layer, GRect(0, current_y, bounds.size.w, progress_h));
    current_y += progress_h + 6;
  }
#endif

#if !defined(PBL_PLATFORM_EMERY)
  layer_set_frame(text_layer_get_layer(s_temp_layer), GRect(0, current_y, bounds.size.w, temp_h));
  current_y += temp_h + gap;
#endif

  layer_set_frame(text_layer_get_layer(s_temp_cond_layer), GRect(0, current_y, bounds.size.w, temp_cond_h));
  current_y += temp_cond_h + gap;

  layer_set_frame(text_layer_get_layer(s_pressure_layer), GRect(0, current_y, bounds.size.w, pressure_h));
  current_y += pressure_h + gap;

  layer_set_frame(text_layer_get_layer(s_wind_precip_layer), GRect(0, current_y, bounds.size.w, wind_precip_h));
  current_y += wind_precip_h + gap;

#if defined(PBL_PLATFORM_EMERY)
  if (s_steps_layer) {
    layer_set_frame(text_layer_get_layer(s_steps_layer), GRect(0, current_y, bounds.size.w, steps_h));
  }
#endif
}

// --- AppMessage Handlers --- //

// This function runs every time the watch receives a message from the phone
static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  // First, declare all tuples we'll need
  Tuple *pressure_tuple = dict_find(iterator, MESSAGE_KEY_PRESSURE);
  Tuple *temp_tuple = dict_find(iterator, MESSAGE_KEY_TEMPERATURE);
  Tuple *cond_tuple = dict_find(iterator, MESSAGE_KEY_CONDITIONS);
  Tuple *loc_tuple = dict_find(iterator, MESSAGE_KEY_LOCATION);
  Tuple *icon_tuple = dict_find(iterator, MESSAGE_KEY_WEATHER_ICON);
  Tuple *wind_tuple = dict_find(iterator, MESSAGE_KEY_WIND);
  Tuple *precip_tuple = dict_find(iterator, MESSAGE_KEY_PRECIP);

  // Unit labels from JS
  Tuple *temp_unit_tuple = dict_find(iterator, MESSAGE_KEY_TEMP_UNIT);
  Tuple *wind_unit_tuple = dict_find(iterator, MESSAGE_KEY_WIND_UNIT);
  Tuple *precip_unit_tuple = dict_find(iterator, MESSAGE_KEY_PRECIP_UNIT);

  // Location and temperature display strings (for use across function)
  char location_name[64];
  char temp_display[16];

  // Variables that need to be accessible across scopes
  int pressure_val = 0;
  char trend_suffix[32] = "";

  // Read the pressure source before the trend string is built, so the pressure
  // row can say whose barometer this is.
  Tuple *pressure_source_tuple = dict_find(iterator, MESSAGE_KEY_PRESSURE_SOURCE);
  if (pressure_source_tuple && pressure_source_tuple->type == TUPLE_INT) {
    s_pressure_from_pws = (pressure_source_tuple->value->int32 != 0);
  }

  if (loc_tuple && loc_tuple->type == TUPLE_CSTRING) {
    snprintf(location_name, sizeof(location_name), "%s", loc_tuple->value->cstring);
  } else {
    location_name[0] = '\0';
  }

  if (temp_tuple && temp_tuple->type == TUPLE_INT) {
    int temp_val = (int)temp_tuple->value->int32;
    s_current_temp = temp_val;
    char temp_unit[4] = "C";
    if (temp_unit_tuple && temp_unit_tuple->type == TUPLE_CSTRING) {
      snprintf(temp_unit, sizeof(temp_unit), "%s", temp_unit_tuple->value->cstring);
      s_temp_is_fahrenheit = (strcmp(temp_unit, "F") == 0);
    } else {
      s_temp_is_fahrenheit = (temp_val > 40); // Simple heuristic if unit is missing
    }
    snprintf(temp_display, sizeof(temp_display), "%d%s", temp_val, temp_unit);
  } else {
    temp_display[0] = '\0';
  }

  // If the companion sent a diagnostic/test key, show a short status immediately
  Tuple *test_tuple = dict_find(iterator, MESSAGE_KEY_PRESSURE_TEST);
  if (test_tuple) {
    // If it's an integer, 1=success, 0=failure. Otherwise show the raw cstring if present.
    if (test_tuple->type == TUPLE_INT) {
      int v = (int)test_tuple->value->int32;
      if (v) {
        text_layer_set_text(s_pressure_layer, "Conn OK");
      } else {
        text_layer_set_text(s_pressure_layer, "Conn FAIL");
      }
    } else if (test_tuple->type == TUPLE_CSTRING) {
      text_layer_set_text(s_pressure_layer, test_tuple->value->cstring);
    }
    // We don't return here — allow pressure/other keys in same message to still be processed
  }

  if (pressure_tuple) {
    // We have the pressure! Read it as an integer
    pressure_val = (int)pressure_tuple->value->int32;

    // Update the weather update timestamp
    s_last_weather_update = time(NULL);

    // Log the received pressure for diagnostics
    APP_LOG(APP_LOG_LEVEL_INFO, "inbox_received_callback: received PRESSURE=%d", pressure_val);

    char trend_arrow[8] = "";
    Tuple *trend_tuple = dict_find(iterator, MESSAGE_KEY_PRESSURE_TREND);
    if (trend_tuple) {
      if (trend_tuple->type == TUPLE_CSTRING) {
        // Append a space then the provided trend string (expected like "+0.8")
        snprintf(trend_suffix, sizeof(trend_suffix), " %s", trend_tuple->value->cstring);
      } else if (trend_tuple->type == TUPLE_INT) {
        /* If JS sent an integer tenths-of-hPa value, format it as "+X.Y" */
        int t = (int)trend_tuple->value->int32; /* tenths */
        char sign = (t >= 0) ? '+' : '-';
        int a = t >= 0 ? t : -t;

        // Add descriptive tracking
        char *trend_text = "Steady";
        if (t >= 10) {
          trend_text = "Rising";
          snprintf(trend_arrow, sizeof(trend_arrow), "^");
        } else if (t >= 1) {
          trend_text = "Rising"; // Very slow
        } else if (t <= -10) {
          trend_text = "Falling";
          snprintf(trend_arrow, sizeof(trend_arrow), "v");
        } else if (t <= -1) {
          trend_text = "Falling"; // Very slow
        }

        // When the reading is from the user's own station, that is worth more
        // than the word: the arrow already says which way the pressure is
        // going, so the same slot carries the source instead. Costs no width.
        if (s_pressure_from_pws) {
          trend_text = "PWS";
        }

        (void)trend_text; // Prevent "unused variable" error on non-Emery platforms

#if defined(PBL_PLATFORM_EMERY)
        snprintf(trend_suffix, sizeof(trend_suffix), " %s %c%d.%d %s", trend_arrow, sign, a / 10, a % 10, trend_text);
#else
        snprintf(trend_suffix, sizeof(trend_suffix), " %s %c%d.%d", trend_arrow, sign, a / 10, a % 10);
#endif
      }
    }

    // Say where the reading came from even when there is no trend yet. A fresh
    // install has no three-hour history to compare against, and without this
    // the source would stay invisible for the first three hours - long enough
    // for someone to conclude their station is not being used at all.
    if (s_pressure_from_pws && trend_suffix[0] == '\0') {
      snprintf(trend_suffix, sizeof(trend_suffix), " PWS");
    }

    snprintf(s_pressure_buffer, sizeof(s_pressure_buffer), "%d mb%s", pressure_val, trend_suffix);
    // Set the text on our Pressure TextLayer
    text_layer_set_text(s_pressure_layer, s_pressure_buffer);
  } else {
    // Log for diagnosis (the message came in but no PRESSURE tuple was found)
    APP_LOG(APP_LOG_LEVEL_INFO, "inbox_received_callback: no PRESSURE tuple found in incoming message");
  }

  // Temperature and Conditions - now just conditions since temp moved to pressure line
  APP_LOG(APP_LOG_LEVEL_INFO, "Keys found: temp=%s cond=%s wind=%s precip=%s loc=%s",
    temp_tuple ? "YES" : "NO", cond_tuple ? "YES" : "NO", wind_tuple ? "YES" : "NO", precip_tuple ? "YES" : "NO", loc_tuple ? "YES" : "NO");

  // Display location only so the main weather block can focus on temp + condition
  int temp_display_len = strlen(temp_display);

  if (loc_tuple && loc_tuple->type == TUPLE_CSTRING) {
#if defined(PBL_PLATFORM_EMERY)
    if (temp_display_len > 0) {
      snprintf(s_location_buffer, sizeof(s_location_buffer), "%s  %s", location_name, temp_display);
    } else {
      snprintf(s_location_buffer, sizeof(s_location_buffer), "%s", location_name);
    }
#else
    snprintf(s_location_buffer, sizeof(s_location_buffer), "%s", location_name);
#endif
    text_layer_set_text(s_location_layer, s_location_buffer);
  } else {
    // No location available yet - show placeholder
    snprintf(s_location_buffer, sizeof(s_location_buffer), "Loading...");
    text_layer_set_text(s_location_layer, s_location_buffer);
  }

  // Temperature and Conditions - now just conditions since temp moved to pressure line
  // Check for storm warning override (experimental feature)
  bool show_storm_warning = false;

  APP_LOG(APP_LOG_LEVEL_DEBUG, "Storm warning check: enabled=%d pressure=%d", s_storm_warning_enabled, pressure_tuple ? 1 : 0);

  if (s_storm_warning_enabled && pressure_tuple && pressure_tuple->type == TUPLE_INT) {
    Tuple *trend_tuple = dict_find(iterator, MESSAGE_KEY_PRESSURE_TREND);
    if (trend_tuple && trend_tuple->type == TUPLE_INT) {
      int trend_tenths = (int)trend_tuple->value->int32;
      APP_LOG(APP_LOG_LEVEL_INFO, "Pressure trend for storm check: %d tenths (%.1f mb)", trend_tenths, trend_tenths / 10.0);
      if (trend_tenths <= -60) {
        // Severe storm warning (6.0+ mb drop - Met Office "Falling Rapidly")
        snprintf(s_temp_cond_buffer, sizeof(s_temp_cond_buffer), "Severe Storm");
        show_storm_warning = true;

        // Vibrate if this is a new or worsening severe warning
        if (!s_storm_warning_active || trend_tenths < s_last_storm_trend) {
          vibes_double_pulse();
          s_storm_warning_active = true;
          s_last_storm_trend = trend_tenths;
        }
      } else if (trend_tenths <= -40) {
        // Storm warning (4.0+ mb drop - Met Office "Falling Rather Quickly")
        APP_LOG(APP_LOG_LEVEL_INFO, "STORM WARNING TRIGGERED: trend=%d tenths", trend_tenths);
        snprintf(s_temp_cond_buffer, sizeof(s_temp_cond_buffer), "Storm Warning");
        show_storm_warning = true;

        // Vibrate if this is a new warning (only on initial trigger)
        if (!s_storm_warning_active) {
          APP_LOG(APP_LOG_LEVEL_INFO, "First storm warning - vibrating");
          vibes_double_pulse();
          s_storm_warning_active = true;
          s_last_storm_trend = trend_tenths;
        }
      } else {
        // Reset storm warning state when pressure stabilizes
        s_storm_warning_active = false;
        s_last_storm_trend = 0;
      }
    } else {
      APP_LOG(APP_LOG_LEVEL_DEBUG, "Storm warning enabled but no pressure trend tuple found");
    }
  } else {
    if (!s_storm_warning_enabled) {
      APP_LOG(APP_LOG_LEVEL_DEBUG, "Storm warning feature is disabled");
    }
    // Reset storm warning state when feature is disabled
    s_storm_warning_active = false;
    s_last_storm_trend = 0;
  }

  if (!show_storm_warning) {
    if (icon_tuple) {
      s_weather_icon_code = (int)icon_tuple->value->int32;
      if (s_weather_icon_layer) layer_mark_dirty(s_weather_icon_layer);
    }

    // Show conditions.
    if (cond_tuple && cond_tuple->type == TUPLE_CSTRING) {
      char *cond_str = cond_tuple->value->cstring;
      snprintf(s_temp_cond_buffer, sizeof(s_temp_cond_buffer), "%s", cond_str);
    } else if (temp_display_len > 0) {
      s_temp_cond_buffer[0] = '\0';
    } else {
      snprintf(s_temp_cond_buffer, sizeof(s_temp_cond_buffer), "Loading...");
    }
  }
#if defined(PBL_PLATFORM_EMERY)
  s_temp_buffer[0] = '\0';
#else
  if (temp_display_len > 0) {
    snprintf(s_temp_buffer, sizeof(s_temp_buffer), "%s", temp_display);
  } else {
    s_temp_buffer[0] = '\0';
  }

  if (show_storm_warning && temp_display_len == 0) {
    s_temp_buffer[0] = '\0';
  }
#endif

  text_layer_set_text(s_temp_layer, s_temp_buffer);
  text_layer_set_text(s_temp_cond_layer, s_temp_cond_buffer);

  // Wind and Precip (combined display)
  /* Handle wind and precip data - can be integers or strings, and display even if only one is available */
  char wind_display[20] = "";
  char precip_display[20] = "";

  // Handle wind data with explicit units
  if (wind_tuple) {
    if (wind_tuple->type == TUPLE_INT) {
      int wind_val = (int)wind_tuple->value->int32;

      // Get wind unit from JS (default to mph)
      char wind_unit[8] = "mph";
      if (wind_unit_tuple && wind_unit_tuple->type == TUPLE_CSTRING) {
        snprintf(wind_unit, sizeof(wind_unit), "%s", wind_unit_tuple->value->cstring);
      }

      snprintf(wind_display, sizeof(wind_display), "%d %s", wind_val, wind_unit);
    } else if (wind_tuple->type == TUPLE_CSTRING) {
      snprintf(wind_display, sizeof(wind_display), "%s", wind_tuple->value->cstring);
    }
  }

  // Handle precip data with explicit units
  if (precip_tuple) {
    if (precip_tuple->type == TUPLE_INT) {
      int precip_val = (int)precip_tuple->value->int32;

      // Get precip unit from JS (default to mm)
      char precip_unit[8] = "mm";
      if (precip_unit_tuple && precip_unit_tuple->type == TUPLE_CSTRING) {
        snprintf(precip_unit, sizeof(precip_unit), "%s", precip_unit_tuple->value->cstring);
      }

      if (strcmp(precip_unit, "in") == 0) {
        // Handle inches (sent as hundredths) - use integer arithmetic for Pebble
        if (precip_val > 0) {
          int whole = precip_val / 100;
          int frac = precip_val % 100;
          snprintf(precip_display, sizeof(precip_display), "%d.%02d %s", whole, frac, precip_unit);
        } else {
          snprintf(precip_display, sizeof(precip_display), "0 %s", precip_unit);
        }
      } else {
        // Handle mm (sent as tenths) - use integer arithmetic for Pebble
        if (precip_val > 0) {
          int whole = precip_val / 10;
          int frac = precip_val % 10;
          snprintf(precip_display, sizeof(precip_display), "%d.%d %s", whole, frac, precip_unit);
        } else {
          snprintf(precip_display, sizeof(precip_display), "0 %s", precip_unit);
        }
      }
    } else if (precip_tuple->type == TUPLE_CSTRING) {
      snprintf(precip_display, sizeof(precip_display), "%s", precip_tuple->value->cstring);
    }
  }

  // Emery shows items on separate rows for clarity
#if defined(PBL_PLATFORM_EMERY)
  // Row 1: Pressure (with Trend)
  if (pressure_val > 0) {
    snprintf(s_pressure_buffer, sizeof(s_pressure_buffer), "%dmb%s", pressure_val, trend_suffix);
  } else {
    s_pressure_buffer[0] = '\0';
  }
  text_layer_set_text(s_pressure_layer, s_pressure_buffer);

  // Row 2: Wind • Rain
  static char s_emery_weather_buffer[80];
  if (strlen(wind_display) > 0 && strlen(precip_display) > 0) {
    snprintf(s_emery_weather_buffer, sizeof(s_emery_weather_buffer), "%s • %s", wind_display, precip_display);
  } else {
    snprintf(s_emery_weather_buffer, sizeof(s_emery_weather_buffer), "%s%s", wind_display, precip_display);
  }
  text_layer_set_text(s_wind_precip_layer, s_emery_weather_buffer);

  // Row 3 (Steps): handeled by update_step_display
#else
  static char s_weather_display_buffer[40];
  if (strlen(wind_display) > 0 && strlen(precip_display) > 0) {
    snprintf(s_weather_display_buffer, sizeof(s_weather_display_buffer), "%s • %s", wind_display, precip_display);
    text_layer_set_text(s_wind_precip_layer, s_weather_display_buffer);
  } else if (strlen(wind_display) > 0) {
    text_layer_set_text(s_wind_precip_layer, wind_display);
  } else if (strlen(precip_display) > 0) {
    text_layer_set_text(s_wind_precip_layer, precip_display);
  }
#endif

  // Handle step tracking settings
  Tuple *show_steps_tuple = dict_find(iterator, MESSAGE_KEY_SHOW_STEPS);
  if (show_steps_tuple) {
    if (show_steps_tuple->type == TUPLE_INT) {
      s_show_steps_enabled = (show_steps_tuple->value->int32 != 0);
      APP_LOG(APP_LOG_LEVEL_INFO, "Show steps setting: %s",
              s_show_steps_enabled ? "enabled" : "disabled");

      // When steps are enabled/disabled, update the display
      update_step_display();
    }
  }

  Tuple *step_unit_tuple = dict_find(iterator, MESSAGE_KEY_STEP_UNIT);
  if (step_unit_tuple) {
    if (step_unit_tuple->type == TUPLE_INT) {
      s_step_unit_miles = (step_unit_tuple->value->int32 != 0); // 1 = miles, 0 = kilometers
      APP_LOG(APP_LOG_LEVEL_INFO, "Step unit setting: %s",
              s_step_unit_miles ? "miles" : "kilometers");

      // Update display if steps are enabled
      if (s_show_steps_enabled) {
        update_step_display();
      }
    }
  }

  // Handle hourly vibration setting
  Tuple *vibration_tuple = dict_find(iterator, MESSAGE_KEY_HOURLY_VIBRATION);
  if (vibration_tuple) {
    if (vibration_tuple->type == TUPLE_INT) {
      s_hourly_vibration_enabled = (vibration_tuple->value->int32 != 0);
      APP_LOG(APP_LOG_LEVEL_INFO, "Hourly vibration setting: %s",
              s_hourly_vibration_enabled ? "enabled" : "disabled");
    }
  }

  // Handle update countdown setting
  Tuple *countdown_tuple = dict_find(iterator, MESSAGE_KEY_UPDATE_COUNTDOWN);
  if (countdown_tuple) {
    if (countdown_tuple->type == TUPLE_INT) {
      bool old_countdown_enabled = s_update_countdown_enabled;
      s_update_countdown_enabled = (countdown_tuple->value->int32 != 0);
      APP_LOG(APP_LOG_LEVEL_INFO, "Update countdown setting: %s",
              s_update_countdown_enabled ? "enabled" : "disabled");

      // If countdown setting changed, adjust the UI dynamically
      if (old_countdown_enabled != s_update_countdown_enabled) {
        APP_LOG(APP_LOG_LEVEL_INFO, "Countdown setting changed - update visibility");
        if (s_update_progress_layer) {
          layer_set_hidden(s_update_progress_layer, !s_update_countdown_enabled);
          update_layer_positions(); // Re-flow the layout
        }
      }
    }
  }

  // Handle storm warning setting (experimental)
  Tuple *storm_warning_tuple = dict_find(iterator, MESSAGE_KEY_STORM_WARNING);
  if (storm_warning_tuple) {
    if (storm_warning_tuple->type == TUPLE_INT) {
      s_storm_warning_enabled = (storm_warning_tuple->value->int32 != 0);
      APP_LOG(APP_LOG_LEVEL_INFO, "Storm warning %s",
              s_storm_warning_enabled ? "ENABLED" : "disabled");
    }
  }

  // Handle text color setting
  Tuple *text_color_tuple = dict_find(iterator, MESSAGE_KEY_TEXT_COLOR);
  if (text_color_tuple && text_color_tuple->type == TUPLE_INT) {
    s_user_text_color_preference = (int)text_color_tuple->value->int32;
    APP_LOG(APP_LOG_LEVEL_INFO, "Text color preference: %d", s_user_text_color_preference);
  }

  // Final UI update after all data is processed
  update_colors();
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped!");
}

static void outbox_failed_callback(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox send failed!");
}

// --- Update Progress Handler --- //

static void progress_layer_draw(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  // Set drawing color
  graphics_context_set_fill_color(ctx, s_text_color);

  // 15 minute cycle (900 seconds)
  const int total_seconds = 15 * 60;
  int elapsed_seconds = 0;

  if (s_last_weather_update != 0) {
    elapsed_seconds = (int)(time(NULL) - s_last_weather_update);
  }

  if (elapsed_seconds < 0) elapsed_seconds = 0;
  if (elapsed_seconds > total_seconds) elapsed_seconds = total_seconds;

  // Calculate progress width (Count up: Increases as time passes)
  int filled_width = (elapsed_seconds * bounds.size.w) / total_seconds;

  // Draw a sleek solid bar
  // We use the full height of the layer (e.g. 4px as defined in main_window_load)
  graphics_fill_rect(ctx, GRect(0, 0, filled_width, bounds.size.h), 0, GCornerNone);
}

static void update_progress_bar() {
  // Just trigger a redraw of the progress layer
  if (s_update_progress_layer) {
    layer_mark_dirty(s_update_progress_layer);
  }
}

// --- Step Tracking Functions --- //

static void update_step_data(void) {
  #if defined(PBL_HEALTH)
  // Get current step count for today
  HealthMetric metric = HealthMetricStepCount;
  HealthValue step_count = health_service_sum_today(metric);

  if (step_count >= 0) {
    s_current_step_count = (int)step_count;

    // Calculate distance based on step count
    // Average step length assumptions: ~2.5 feet per step = ~0.76 meters
    // So: steps * 0.76 meters = total meters
    // Convert to miles: meters * 0.000621371 = miles
    // Convert to kilometers: meters / 1000 = km

    int distance_meters = (int)(s_current_step_count * 0.76f);

    if (s_step_unit_miles) {
      // Convert to miles and store as tenths (for 1 decimal place display)
      s_current_step_distance = (int)(distance_meters * 0.000621371f * 10);
    } else {
      // Convert to kilometers and store as tenths
      s_current_step_distance = (int)(distance_meters / 100.0f); // Convert to km then multiply by 10 for tenths
    }

    APP_LOG(APP_LOG_LEVEL_INFO, "Steps: %d, Distance: %d (%s)",
            s_current_step_count, s_current_step_distance,
            s_step_unit_miles ? "miles*100" : "km*10");
  } else {
    s_current_step_count = 0;
    s_current_step_distance = 0;
    APP_LOG(APP_LOG_LEVEL_WARNING, "Health data unavailable");
  }
  #else
  // Health API not available on this platform
  s_current_step_count = 0;
  s_current_step_distance = 0;
  APP_LOG(APP_LOG_LEVEL_WARNING, "Health API not available on this platform");
  #endif
}

static void update_step_display(void) {
  if (s_show_steps_enabled) {
    update_step_data();
    if (s_step_unit_miles) {
      int whole_miles = s_current_step_distance / 10;
      int frac_miles  = s_current_step_distance % 10;
      snprintf(s_step_display_buffer, sizeof(s_step_display_buffer),
               "Steps: %d  %d.%d mi", s_current_step_count, whole_miles, frac_miles);
    } else {
      int whole_km = s_current_step_distance / 10;
      int frac_km  = s_current_step_distance % 10;
      snprintf(s_step_display_buffer, sizeof(s_step_display_buffer),
               "Steps: %d  %d.%d km", s_current_step_count, whole_km, frac_km);
    }

    // Use the dedicated steps layer on Emery, otherwise share wind/precip layer
#if defined(PBL_PLATFORM_EMERY)
    if (s_steps_layer) text_layer_set_text(s_steps_layer, s_step_display_buffer);
#else
    text_layer_set_text(s_wind_precip_layer, s_step_display_buffer);
#endif
    APP_LOG(APP_LOG_LEVEL_INFO, "Step display: %s", s_step_display_buffer);
  } else {
#if defined(PBL_PLATFORM_EMERY)
    if (s_steps_layer) text_layer_set_text(s_steps_layer, "");
#else
    text_layer_set_text(s_wind_precip_layer, "");
#endif
    APP_LOG(APP_LOG_LEVEL_INFO, "Step display disabled");
  }
}

// --- Clock Update Handler --- //

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  // Use a static buffer so we don't keep it on the stack
  static char s_time_buffer[8]; // "00:00"

  // Format the time into the buffer
  if(clock_is_24h_style()) {
    strftime(s_time_buffer, sizeof(s_time_buffer), "%H:%M", tick_time);
  } else {
    strftime(s_time_buffer, sizeof(s_time_buffer), "%I:%M", tick_time);
  }

  // Set the text on our Time TextLayer
  text_layer_set_text(s_time_layer, s_time_buffer);

  // Update the progress bar
  update_progress_bar();

  // Update step display every minute if enabled (minimal battery impact)
  if (s_show_steps_enabled) {
    update_step_display();
  }

  // Check for hourly vibration
  if (s_hourly_vibration_enabled) {
    int current_hour = tick_time->tm_hour;
    int current_minute = tick_time->tm_min;

    // Vibrate at the top of each hour (minute 0) if hour changed
    if (current_minute == 0 && s_last_hour != current_hour) {
      // Short, subtle vibration
      vibes_short_pulse();
      APP_LOG(APP_LOG_LEVEL_INFO, "Hourly vibration at %d:00", current_hour);
    }

    // Update last hour
    s_last_hour = current_hour;
  }
}

// --- Window Load/Unload --- //

static void main_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  // Default colors
  s_text_color = GColorWhite;
  s_bg_color = GColorBlack;
  window_set_background_color(window, s_bg_color);

  // Platform-adaptive layout — pixel-perfect for each screen
  // All layers are stacked sequentially: current_y advances after each
#if defined(PBL_PLATFORM_EMERY)
  // Pebble Time 2: 200 × 228 px
  // Ultra-Bold Layout: Time at top, tight gaps to move icon and text up.
  const int vertical_padding = 0;
  const int time_h            = 46;  // BITHAM_42_BOLD
  const int location_h        = 31;  // GOTHIC_28_BOLD
  const int icon_h            = 44;  // Increased from 40 to prevent icon clipping
  const int temp_h            = 1;
  const int temp_cond_h       = 31;  // GOTHIC_28_BOLD
  const int pressure_h        = 28;  // Restored height for larger font
  const int wind_precip_h     = 28;  // Restored height for larger font
  const int steps_h           = 28;  // Dedicated step height
  (void)steps_h;
  const int gap               = 1;   // Reduced from 4 to move everything up
  const char *fnt_location    = FONT_KEY_GOTHIC_28_BOLD;
  const char *fnt_temp        = FONT_KEY_GOTHIC_18_BOLD;
  const char *fnt_cond        = FONT_KEY_GOTHIC_28_BOLD;
  const char *fnt_small       = FONT_KEY_GOTHIC_24_BOLD; // Back to large readable font
#elif defined(PBL_PLATFORM_DIORITE)
  // Pebble Time Round: 180 × 180 px
  const int vertical_padding = 4;
  const int time_h            = 42;
  const int location_h        = 22;
  const int icon_h            = 22;
  const int temp_h            = 24;
  const int temp_cond_h       = 20; // Increased from 18
  const int pressure_h        = 20; // Increased from 18
  const int wind_precip_h     = 20; // Increased from 18
  const int gap               = 1;
  const char *fnt_location    = FONT_KEY_GOTHIC_18_BOLD;
  const char *fnt_temp        = FONT_KEY_GOTHIC_24_BOLD;
  const char *fnt_cond        = FONT_KEY_GOTHIC_18_BOLD;
  const char *fnt_small       = FONT_KEY_GOTHIC_18_BOLD;
#else
  // Pebble Time (basalt): 144 × 168 px
  const int vertical_padding = -3; // Slightly more padding to fit all layers
  const int time_h            = 42; // Reduced from 44
  const int location_h        = 18;
  const int icon_h            = 20;
  const int temp_h            = 20; // Reduced from 22
  const int temp_cond_h       = 20; // Increased from 16 to prevent clipping
  const int pressure_h        = 20; // Increased from 16 to prevent clipping
  const int wind_precip_h     = 20; // Increased from 16 to prevent clipping
  const int gap               = 0;
  const char *fnt_location    = FONT_KEY_GOTHIC_18_BOLD;
  const char *fnt_temp        = FONT_KEY_GOTHIC_24_BOLD;
  const char *fnt_cond        = FONT_KEY_GOTHIC_18_BOLD;
  const char *fnt_small       = FONT_KEY_GOTHIC_18_BOLD;
#endif

  int current_y = vertical_padding;

  // --- Time and Icon (Side-by-Side on Emery) ---
#if defined(PBL_PLATFORM_EMERY)
  // Shift Time left and place Icon to the right
  int side_pad = 10;
  int icon_w = 50;
  int time_w = bounds.size.w - icon_w - (side_pad * 2);

  s_time_layer = text_layer_create(GRect(side_pad, current_y, time_w, time_h));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentLeft);

  s_weather_icon_layer = layer_create(GRect(side_pad + time_w, current_y + (time_h - icon_h) / 2, icon_w, icon_h));
#else
  // Standard Centered Layout
  s_time_layer = text_layer_create(GRect(0, current_y, bounds.size.w, time_h));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
#endif

  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, s_text_color);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS));
  layer_add_child(window_layer, text_layer_get_layer(s_time_layer));

  // --- Data Layers --- each placed directly after the previous
  current_y += time_h + gap;

  // Update Progress Line (Created for all platforms now to allow dynamic toggling)
  int progress_h = 2;
  s_update_progress_layer = layer_create(GRect(0, 0, bounds.size.w, progress_h));
  layer_set_update_proc(s_update_progress_layer, progress_layer_draw);

  // Weather Icon (Registration)
#if !defined(PBL_PLATFORM_EMERY)
  s_weather_icon_layer = layer_create(GRect(0, current_y, bounds.size.w, icon_h));
#endif

  s_weather_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_WEATHER_FONT_36));
  layer_set_update_proc(s_weather_icon_layer, weather_icon_update_proc);
  layer_add_child(window_layer, s_weather_icon_layer);

#if !defined(PBL_PLATFORM_EMERY)
  current_y += icon_h + gap;
#endif

  // Location
  s_location_layer = text_layer_create(GRect(0, current_y, bounds.size.w, location_h));
  text_layer_set_background_color(s_location_layer, GColorClear);
  text_layer_set_text_color(s_location_layer, s_text_color);
  text_layer_set_font(s_location_layer, fonts_get_system_font(fnt_location));
  text_layer_set_text_alignment(s_location_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_location_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_text(s_location_layer, "");
  layer_add_child(window_layer, text_layer_get_layer(s_location_layer));
  APP_LOG(APP_LOG_LEVEL_DEBUG, "Location layer created at y=%d, height=%d, width=%d", current_y, location_h, bounds.size.w);
  current_y += location_h + gap;

  // Hidden temp layer retained for non-Emery layouts.
#if defined(PBL_PLATFORM_EMERY)
  s_temp_layer = text_layer_create(GRect(0, bounds.size.h, 1, temp_h));
#else
  s_temp_layer = text_layer_create(GRect(0, current_y, bounds.size.w, temp_h));
#endif
  text_layer_set_background_color(s_temp_layer, GColorClear);
  text_layer_set_text_color(s_temp_layer, s_text_color);
  text_layer_set_font(s_temp_layer, fonts_get_system_font(fnt_temp));
  text_layer_set_text_alignment(s_temp_layer, GTextAlignmentCenter);
  text_layer_set_text(s_temp_layer, "");
  layer_add_child(window_layer, text_layer_get_layer(s_temp_layer));
#if !defined(PBL_PLATFORM_EMERY)
  current_y += temp_h + gap;
#endif

  // Condition
  s_temp_cond_layer = text_layer_create(GRect(0, current_y, bounds.size.w, temp_cond_h));
  text_layer_set_background_color(s_temp_cond_layer, GColorClear);
  text_layer_set_text_color(s_temp_cond_layer, s_text_color);
  text_layer_set_font(s_temp_cond_layer, fonts_get_system_font(fnt_cond));
  text_layer_set_text_alignment(s_temp_cond_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_temp_cond_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_text(s_temp_cond_layer, "");
  layer_add_child(window_layer, text_layer_get_layer(s_temp_cond_layer));
  current_y += temp_cond_h + gap;

  // Pressure
  s_pressure_layer = text_layer_create(GRect(0, current_y, bounds.size.w, pressure_h));
  text_layer_set_background_color(s_pressure_layer, GColorClear);
  text_layer_set_text_color(s_pressure_layer, s_text_color);
  text_layer_set_font(s_pressure_layer, fonts_get_system_font(fnt_small));
  text_layer_set_text_alignment(s_pressure_layer, GTextAlignmentCenter);

  if (connection_service_peek_pebble_app_connection()) {
    text_layer_set_text(s_pressure_layer, "Waiting for phone"); // Default text
  } else {
    text_layer_set_text(s_pressure_layer, "Disconnected"); // Default text
  }

  layer_add_child(window_layer, text_layer_get_layer(s_pressure_layer));
  current_y += pressure_h + gap;

  // Wind and precipitation
  s_wind_precip_layer = text_layer_create(GRect(0, current_y, bounds.size.w, wind_precip_h));
  text_layer_set_background_color(s_wind_precip_layer, GColorClear);
  text_layer_set_text_color(s_wind_precip_layer, s_text_color);
  text_layer_set_font(s_wind_precip_layer, fonts_get_system_font(fnt_small));
  text_layer_set_text_alignment(s_wind_precip_layer, GTextAlignmentCenter);
  text_layer_set_text(s_wind_precip_layer, "");
  layer_add_child(window_layer, text_layer_get_layer(s_wind_precip_layer));

  // Steps layer (Emery only for now)
#if defined(PBL_PLATFORM_EMERY)
  s_steps_layer = text_layer_create(GRect(0, 0, bounds.size.w, 32));
  text_layer_set_background_color(s_steps_layer, GColorClear);
  text_layer_set_text_color(s_steps_layer, s_text_color);
  text_layer_set_font(s_steps_layer, fonts_get_system_font(fnt_small));
  text_layer_set_text_alignment(s_steps_layer, GTextAlignmentCenter);
  text_layer_set_text(s_steps_layer, "");
  layer_add_child(window_layer, text_layer_get_layer(s_steps_layer));
#endif

  // Add Progress Layer LAST to ensure it's on top of everything
  if (s_update_progress_layer) {
    layer_add_child(window_layer, s_update_progress_layer);
    layer_set_hidden(s_update_progress_layer, !s_update_countdown_enabled);
  }

  // Set initial positions
  update_layer_positions();
}

static void main_window_unload(Window *window) {
  // Destroy the TextLayers and custom layers to free up memory
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_location_layer);
  if (s_update_progress_layer) {
    layer_destroy(s_update_progress_layer);
  }
  if (s_weather_icon_layer) layer_destroy(s_weather_icon_layer);
  if (s_weather_font) fonts_unload_custom_font(s_weather_font);

  text_layer_destroy(s_temp_layer);
  text_layer_destroy(s_temp_cond_layer);
  text_layer_destroy(s_pressure_layer);
  text_layer_destroy(s_wind_precip_layer);
#if defined(PBL_PLATFORM_EMERY)
  text_layer_destroy(s_steps_layer);
#endif

}

// Connection state handler
static void connection_callback(bool connected) {
  if (!connected) {
    text_layer_set_text(s_pressure_layer, "Disconnected");
  } else {
    if (s_last_weather_update == 0) {
      text_layer_set_text(s_pressure_layer, "Waiting for phone");
    }
  }
}

// --- Main App Init/Deinit --- //

static void init() {
  s_main_window = window_create();

  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load = main_window_load,
    .unload = main_window_unload
  });

  window_stack_push(s_main_window, true /* Animated */);

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);

  app_message_open(2048, 512);

  if (s_show_steps_enabled) {
    update_step_display();
  }

  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = connection_callback
  });
}

static void deinit() {
  connection_service_unsubscribe();
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
