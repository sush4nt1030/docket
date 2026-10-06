package app.docket.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

/** Shows reminder notifications when an alarm fires; handles Snooze / Dismiss buttons. */
public class ReminderReceiver extends BroadcastReceiver {
    static final String CHANNEL_ID = "reminders";
    static final String ACTION_SNOOZE = "app.docket.mobile.SNOOZE";
    static final String ACTION_DISMISS = "app.docket.mobile.DISMISS";
    static final long SNOOZE_MS = 10 * 60_000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context c = context.getApplicationContext();
        String action = intent.getAction();
        if (ACTION_DISMISS.equals(action)) {
            cancelNotification(c, intent.getStringExtra(ReminderScheduler.EXTRA_KEY));
            return;
        }
        if (ACTION_SNOOZE.equals(action)) {
            String key = intent.getStringExtra(ReminderScheduler.EXTRA_KEY);
            cancelNotification(c, key);
            long at = System.currentTimeMillis() + SNOOZE_MS;
            // a snoozed copy is purely local: it does not depend on the server or the network
            ReminderScheduler.schedule(c, new ReminderScheduler.Item(key + "#snooze@" + at, at,
                    intent.getStringExtra(ReminderScheduler.EXTRA_TITLE),
                    intent.getStringExtra(ReminderScheduler.EXTRA_BODY) + " (snoozed)",
                    intent.getStringExtra(ReminderScheduler.EXTRA_ACTIVITY)));
            return;
        }
        if (!ReminderScheduler.ACTION_FIRE.equals(action)) return;

        final String key = intent.getStringExtra(ReminderScheduler.EXTRA_KEY);
        final String title = intent.getStringExtra(ReminderScheduler.EXTRA_TITLE);
        final String body = intent.getStringExtra(ReminderScheduler.EXTRA_BODY);
        final String activityId = intent.getStringExtra(ReminderScheduler.EXTRA_ACTIVITY);
        if (key == null) return;
        if (ReminderScheduler.shownKeys(c).contains(key)) return;

        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                String showTitle = title, showBody = body;
                boolean show = true;
                if (!key.contains("#snooze@")) {
                    // Double-check with the server so a reminder that was cancelled or rescheduled on another
                    // device is not shown. If the server can't be reached quickly, show it anyway.
                    ReminderSync.Result r = ReminderSync.fetch(c, 5000);
                    if (r.ok) {
                        boolean found = false;
                        for (ReminderScheduler.Item it : r.items) {
                            if (it.key.equals(key)) { found = true; showTitle = it.title; showBody = it.body; break; }
                        }
                        show = found || r.recentlySent.contains(key);
                    } else if (r.status == 401) {
                        show = false;
                    }
                }
                if (show) {
                    ReminderScheduler.markShown(c, key);
                    showNotification(c, key, showTitle, showBody, activityId);
                }
                ReminderSync.syncBlocking(c);
            } finally {
                pending.finish();
            }
        }).start();
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Reminders for your activities, deadlines and preparation tasks");
        ch.enableVibration(true);
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).build());
        nm.createNotificationChannel(ch);
    }

    static void showNotification(Context c, String key, String title, String body, String activityId) {
        ensureChannel(c);
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        int id = key.hashCode();

        Intent open = new Intent(c, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(ReminderScheduler.dataUri(key))
                .putExtra(MainActivity.EXTRA_PATH, activityId != null ? "/#/activity/" + activityId : "/#/notifications")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent snooze = new Intent(c, ReminderReceiver.class).setAction(ACTION_SNOOZE).setData(ReminderScheduler.dataUri(key))
                .putExtra(ReminderScheduler.EXTRA_KEY, key).putExtra(ReminderScheduler.EXTRA_TITLE, title)
                .putExtra(ReminderScheduler.EXTRA_BODY, body).putExtra(ReminderScheduler.EXTRA_ACTIVITY, activityId);
        PendingIntent snoozePi = PendingIntent.getBroadcast(c, id + 1, snooze, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent dismiss = new Intent(c, ReminderReceiver.class).setAction(ACTION_DISMISS).setData(ReminderScheduler.dataUri(key))
                .putExtra(ReminderScheduler.EXTRA_KEY, key);
        PendingIntent dismissPi = PendingIntent.getBroadcast(c, id + 2, dismiss, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(c, CHANNEL_ID)
                : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat_docket)
                .setContentTitle(title == null ? "Docket reminder" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                .setContentIntent(openPi)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setColor(0xFF3651D4)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .addAction(new Notification.Action.Builder(null, "Snooze 10 min", snoozePi).build())
                .addAction(new Notification.Action.Builder(null, "Dismiss", dismissPi).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            nm.notify(id, b.build());
        } catch (SecurityException ignored) {
            // notification permission revoked
        }
    }

    static void cancelNotification(Context c, String key) {
        if (key == null) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(key.hashCode());
    }
}
