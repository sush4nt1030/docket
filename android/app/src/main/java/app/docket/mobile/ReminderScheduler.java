package app.docket.mobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Keeps one exact AlarmManager alarm per upcoming reminder. The list comes from the Docket
 * server (see ReminderSync) and is stored locally, so alarms survive reboots and work offline.
 */
final class ReminderScheduler {
    static final String ACTION_FIRE = "app.docket.mobile.FIRE";
    static final String EXTRA_KEY = "key";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";
    static final String EXTRA_ACTIVITY = "activity";
    static final String EXTRA_FIRE_AT = "fire_at";
    private static final int MAX_ALARMS = 250; // Android allows ~500 alarms per app

    private ReminderScheduler() {}

    static final class Item {
        final String key; final long fireAt; final String title; final String body; final String activityId;
        Item(String key, long fireAt, String title, String body, String activityId) {
            this.key = key; this.fireAt = fireAt; this.title = title; this.body = body; this.activityId = activityId;
        }
        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("key", key); o.put("fire_at", fireAt); o.put("title", title); o.put("body", body);
            o.put("activity_id", activityId == null ? JSONObject.NULL : activityId);
            return o;
        }
        static Item fromJson(JSONObject o) {
            String act = o.isNull("activity_id") ? null : o.optString("activity_id", null);
            return new Item(o.optString("key"), o.optLong("fire_at"), o.optString("title"), o.optString("body"), act);
        }
    }

    static synchronized List<Item> stored(Context c) {
        List<Item> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(Prefs.get(c).getString(Prefs.SCHEDULE, "[]"));
            for (int i = 0; i < arr.length(); i++) out.add(Item.fromJson(arr.getJSONObject(i)));
        } catch (JSONException ignored) { }
        return out;
    }

    /** Replace all alarms with the given list (cancels alarms that are no longer present). */
    static synchronized void replaceAll(Context c, List<Item> items) {
        Set<String> keep = new HashSet<>();
        for (Item it : items) keep.add(it.key);
        for (Item old : stored(c)) if (!keep.contains(old.key)) cancel(c, old.key);

        long now = System.currentTimeMillis();
        Set<String> shown = shownKeys(c);
        JSONArray arr = new JSONArray();
        int count = 0;
        for (Item it : items) {
            if (it.fireAt < now - 60_000L || shown.contains(it.key)) continue; // past or already shown
            if (count >= MAX_ALARMS) break;
            schedule(c, it);
            try { arr.put(it.toJson()); } catch (JSONException ignored) { }
            count++;
        }
        Prefs.get(c).edit().putString(Prefs.SCHEDULE, arr.toString()).apply();
    }

    /** Re-arm alarms from the stored list (after reboot / app update / time change). */
    static synchronized void rescheduleStored(Context c) {
        replaceAll(c, stored(c));
    }

    static synchronized void cancelAll(Context c) {
        for (Item it : stored(c)) cancel(c, it.key);
        Prefs.get(c).edit().putString(Prefs.SCHEDULE, "[]").apply();
    }

    static int scheduledCount(Context c) {
        long now = System.currentTimeMillis();
        int n = 0;
        for (Item it : stored(c)) if (it.fireAt >= now) n++;
        return n;
    }

    static boolean canExact(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    static void schedule(Context c, Item it) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = firePendingIntent(c, it);
        long when = Math.max(it.fireAt, System.currentTimeMillis() + 1000L);
        if (canExact(c)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
    }

    static void cancel(Context c, String key) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(c, ReminderReceiver.class).setAction(ACTION_FIRE).setData(dataUri(key));
        PendingIntent pi = PendingIntent.getBroadcast(c, key.hashCode(), i, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (pi != null) { am.cancel(pi); pi.cancel(); }
    }

    static PendingIntent firePendingIntent(Context c, Item it) {
        Intent i = new Intent(c, ReminderReceiver.class)
                .setAction(ACTION_FIRE)
                .setData(dataUri(it.key))
                .putExtra(EXTRA_KEY, it.key)
                .putExtra(EXTRA_TITLE, it.title)
                .putExtra(EXTRA_BODY, it.body)
                .putExtra(EXTRA_ACTIVITY, it.activityId)
                .putExtra(EXTRA_FIRE_AT, it.fireAt);
        return PendingIntent.getBroadcast(c, it.key.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Unique data URI per reminder so PendingIntents never collide. */
    static Uri dataUri(String key) {
        return Uri.parse("docket://reminder/" + Uri.encode(key));
    }

    // ---- remember which reminders were already shown, so a re-sync never shows one twice ----
    static synchronized Set<String> shownKeys(Context c) {
        Set<String> out = new HashSet<>();
        try {
            JSONArray arr = new JSONArray(Prefs.get(c).getString(Prefs.SHOWN, "[]"));
            for (int i = 0; i < arr.length(); i++) out.add(arr.getString(i));
        } catch (JSONException ignored) { }
        return out;
    }

    static synchronized void markShown(Context c, String key) {
        try {
            JSONArray arr = new JSONArray(Prefs.get(c).getString(Prefs.SHOWN, "[]"));
            arr.put(key);
            JSONArray trimmed = new JSONArray();
            for (int i = Math.max(0, arr.length() - 300); i < arr.length(); i++) trimmed.put(arr.get(i));
            Prefs.get(c).edit().putString(Prefs.SHOWN, trimmed.toString()).apply();
        } catch (JSONException ignored) { }
    }
}
