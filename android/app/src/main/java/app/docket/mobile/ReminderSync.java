package app.docket.mobile;

import android.content.Context;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Downloads the reminder schedule from the Docket server and hands it to ReminderScheduler. */
final class ReminderSync {
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();

    private ReminderSync() {}

    static final class Result {
        final boolean ok; final int status; final List<ReminderScheduler.Item> items; final Set<String> recentlySent;
        Result(boolean ok, int status, List<ReminderScheduler.Item> items, Set<String> recentlySent) {
            this.ok = ok; this.status = status; this.items = items; this.recentlySent = recentlySent;
        }
    }

    static void syncAsync(Context ctx) {
        final Context c = ctx.getApplicationContext();
        EXEC.execute(() -> syncBlocking(c));
    }

    /** Returns true when the schedule was refreshed. Safe to call from a background thread. */
    static boolean syncBlocking(Context c) {
        Result r = fetch(c, 15000);
        if (r.ok) {
            ReminderScheduler.replaceAll(c, r.items);
            Prefs.get(c).edit().putLong(Prefs.LAST_SYNC, System.currentTimeMillis()).remove(Prefs.LAST_ERROR).apply();
            return true;
        }
        if (r.status == 401) {
            // signed out or session expired: never show reminders for an account that is not signed in
            ReminderScheduler.cancelAll(c);
            Prefs.get(c).edit().putString(Prefs.LAST_ERROR, "Signed out — open Docket and sign in").apply();
        } else {
            Prefs.get(c).edit().putString(Prefs.LAST_ERROR, r.status == 0 ? "No connection (alarms already scheduled still work)" : "Server error " + r.status).apply();
        }
        return false;
    }

    /** Remember the WebView session cookie so background syncs can authenticate. Call on the UI thread. */
    static void captureCookie(Context c) {
        String base = Prefs.serverUrl(c);
        if (base.isEmpty()) return;
        try {
            String cookie = CookieManager.getInstance().getCookie(base);
            if (cookie != null && cookie.contains("sid=")) Prefs.get(c).edit().putString(Prefs.COOKIE, cookie).apply();
        } catch (Exception ignored) { }
    }

    static Result fetch(Context c, int timeoutMs) {
        String base = Prefs.serverUrl(c);
        String cookie = Prefs.get(c).getString(Prefs.COOKIE, "");
        if (base.isEmpty() || cookie.isEmpty()) return new Result(false, base.isEmpty() ? -1 : 401, null, null);
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(base + "/api/device/reminders").openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "DocketAndroid/1.0");
            int status = conn.getResponseCode();
            if (status != 200) return new Result(false, status, null, null);
            JSONObject json = new JSONObject(readAll(conn.getInputStream()));
            JSONArray arr = json.optJSONArray("reminders");
            List<ReminderScheduler.Item> items = new ArrayList<>();
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    String act = o.isNull("activity_id") ? null : o.optString("activity_id", null);
                    items.add(new ReminderScheduler.Item(o.getString("key"), o.getLong("fire_at"), o.optString("title", "Docket reminder"), o.optString("body", ""), act));
                }
            }
            Set<String> recent = new HashSet<>();
            JSONArray rs = json.optJSONArray("recentlySent");
            if (rs != null) for (int i = 0; i < rs.length(); i++) recent.add(rs.getString(i));
            return new Result(true, 200, items, recent);
        } catch (Exception e) {
            return new Result(false, 0, null, null);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static String readAll(InputStream in) throws java.io.IOException {
        try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** POST helper used by notification actions (snooze/dismiss on the server copy). */
    static int post(Context c, String path) {
        String base = Prefs.serverUrl(c);
        String cookie = Prefs.get(c).getString(Prefs.COOKIE, "");
        if (base.isEmpty() || cookie.isEmpty()) return -1;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(base + path).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("X-Docket", "1");
            conn.getOutputStream().write("{}".getBytes(StandardCharsets.UTF_8));
            return conn.getResponseCode();
        } catch (Exception e) {
            return 0;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
