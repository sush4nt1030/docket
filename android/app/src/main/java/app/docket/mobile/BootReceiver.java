package app.docket.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Re-arms alarms after a reboot, app update, clock/timezone change or exact-alarm permission change. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                ReminderScheduler.rescheduleStored(c);
                SyncJobService.schedule(c);
                ReminderSync.syncBlocking(c);
            } finally {
                pending.finish();
            }
        }).start();
    }
}
