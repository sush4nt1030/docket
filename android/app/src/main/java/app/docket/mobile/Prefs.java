package app.docket.mobile;

import android.content.Context;
import android.content.SharedPreferences;

/** Small wrapper around SharedPreferences for the app's own settings. */
final class Prefs {
    private static final String FILE = "docket";
    static final String SERVER_URL = "server_url";
    static final String COOKIE = "session_cookie";
    static final String SCHEDULE = "schedule_json";
    static final String SHOWN = "shown_keys";
    static final String LAST_SYNC = "last_sync";
    static final String LAST_ERROR = "last_error";
    static final String ASKED_NOTIFICATIONS = "asked_notifications";

    private Prefs() {}

    static SharedPreferences get(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String serverUrl(Context c) {
        return get(c).getString(SERVER_URL, "");
    }

    static void setServerUrl(Context c, String url) {
        get(c).edit().putString(SERVER_URL, url).apply();
    }

    /** Normalises what the user typed into "https://host[:port]" without a trailing slash. */
    static String normalizeUrl(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }
}
