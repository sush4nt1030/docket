package app.docket.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Docket for Android: hosts the Docket web app (from your own Docket server) in a WebView and adds
 * native features — exact-time reminder alarms that work offline, system notifications with
 * Snooze/Dismiss, file uploads and downloads, and opening meeting / map / phone links in other apps.
 */
public class MainActivity extends Activity {
    static final String EXTRA_PATH = "path";
    private static final int REQ_FILE = 10;
    private static final int REQ_NOTIFICATIONS = 11;

    private FrameLayout root;
    private WebView web;
    private View overlay; // setup or error screen shown above the WebView
    private ValueCallback<Uri[]> fileCallback;
    private boolean night;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        setupEdgeToEdge();
        root = new FrameLayout(this);
        root.setBackgroundColor(night ? 0xFF0E1117 : 0xFFF5F6FA);
        root.setOnApplyWindowInsetsListener(this::applyInsets);
        setContentView(root);

        ReminderReceiver.ensureChannel(this);
        SyncJobService.schedule(this);

        if (Prefs.serverUrl(this).isEmpty()) showSetup("");
        else loadApp(getIntent().getStringExtra(EXTRA_PATH));
    }

    // ------------------------------------------------------------------ layout & insets
    @SuppressWarnings("deprecation")
    private void setupEdgeToEdge() {
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            if (getWindow().getInsetsController() != null) {
                int light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                getWindow().getInsetsController().setSystemBarsAppearance(night ? 0 : light, light);
            }
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (!night) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (!night && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    @SuppressWarnings("deprecation")
    private WindowInsets applyInsets(View v, WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        }
        v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
        return insets.consumeSystemWindowInsets();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private int textColor() { return night ? 0xFFE7EAF0 : 0xFF151922; }
    private int mutedColor() { return night ? 0xFFA3AAB8 : 0xFF5A6273; }

    // ------------------------------------------------------------------ setup screen
    private void showSetup(String prefill) {
        removeOverlay();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(night ? 0xFF0E1117 : 0xFFF5F6FA);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(28), dp(40), dp(28), dp(40));
        scroll.addView(box, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText("Docket");
        title.setTextSize(30);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(textColor());
        box.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Connect to your Docket server. Your activities, reminders and settings live there, so you see the same information on every device.");
        sub.setTextSize(15);
        sub.setTextColor(mutedColor());
        sub.setPadding(0, dp(8), 0, dp(24));
        box.addView(sub);

        TextView label = new TextView(this);
        label.setText("Server address");
        label.setTextSize(14);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setTextColor(textColor());
        box.addView(label);

        final EditText input = new EditText(this);
        input.setHint("https://docket.example.com");
        input.setText(prefill);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setTextColor(textColor());
        input.setHintTextColor(mutedColor());
        input.setContentDescription("Server address");
        box.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final TextView status = new TextView(this);
        status.setTextSize(14);
        status.setPadding(0, dp(8), 0, dp(8));
        status.setTextColor(mutedColor());
        status.setText("Use https:// for a server on the internet. http:// works only for testing on your own Wi-Fi network.");
        box.addView(status);

        final Button connect = new Button(this);
        connect.setText("Connect");
        connect.setAllCaps(false);
        connect.setTextColor(Color.WHITE);
        connect.setBackgroundColor(0xFF3651D4);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(12);
        box.addView(connect, lp);

        Runnable go = () -> {
            final String url = Prefs.normalizeUrl(input.getText().toString());
            if (url.isEmpty() || !URLUtil.isNetworkUrl(url)) {
                status.setTextColor(0xFFC3302A);
                status.setText("Enter the address of your Docket server, for example https://docket.example.com");
                return;
            }
            connect.setEnabled(false);
            status.setTextColor(mutedColor());
            status.setText("Checking " + url + " …");
            new Thread(() -> {
                final String error = checkServer(url);
                runOnUiThread(() -> {
                    connect.setEnabled(true);
                    if (error != null) {
                        status.setTextColor(0xFFC3302A);
                        status.setText(error);
                        return;
                    }
                    if (!url.equals(Prefs.serverUrl(this))) {
                        ReminderScheduler.cancelAll(this);
                        Prefs.get(this).edit().remove(Prefs.COOKIE).remove(Prefs.LAST_SYNC).remove(Prefs.LAST_ERROR).apply();
                    }
                    Prefs.setServerUrl(this, url);
                    loadApp(null);
                });
            }).start();
        };
        connect.setOnClickListener(v -> go.run());
        input.setOnEditorActionListener((v, actionId, event) -> { go.run(); return true; });

        overlay = scroll;
        root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** Returns null if a Docket server answers at url, otherwise a human-readable error. */
    private static String checkServer(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url + "/api/health").openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            int code = conn.getResponseCode();
            if (code != 200) return "The server answered with HTTP " + code + ". Is this the address of a Docket server?";
            JSONObject o = new JSONObject(ReminderSync.readAll(conn.getInputStream()));
            if (!o.optBoolean("ok")) return "This doesn't look like a Docket server.";
            return null;
        } catch (javax.net.ssl.SSLException e) {
            return "Secure connection failed (" + e.getMessage() + "). Check that the server has a valid HTTPS certificate.";
        } catch (Exception e) {
            return "Couldn't reach " + url + ". Check the address and your internet connection.";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void showError(String message) {
        removeOverlay();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));
        box.setBackgroundColor(night ? 0xFF0E1117 : 0xFFF5F6FA);

        TextView t = new TextView(this);
        t.setText("Can't reach Docket");
        t.setTextSize(22);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextColor(textColor());
        t.setGravity(Gravity.CENTER);
        box.addView(t);

        TextView m = new TextView(this);
        m.setText(message + "\n\nNothing is lost — your data is stored on the server. Reminders already on this phone still go off.");
        m.setTextSize(15);
        m.setTextColor(mutedColor());
        m.setGravity(Gravity.CENTER);
        m.setPadding(0, dp(10), 0, dp(20));
        box.addView(m);

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setAllCaps(false);
        retry.setOnClickListener(v -> { removeOverlay(); if (web != null) web.reload(); });
        box.addView(retry);

        Button change = new Button(this);
        change.setText("Change server");
        change.setAllCaps(false);
        change.setOnClickListener(v -> showSetup(Prefs.serverUrl(this)));
        box.addView(change);

        overlay = box;
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void removeOverlay() {
        if (overlay != null) { root.removeView(overlay); overlay = null; }
    }

    // ------------------------------------------------------------------ web app
    private void loadApp(String path) {
        removeOverlay();
        String base = Prefs.serverUrl(this);
        if (web == null) createWebView();
        String target = base + (path != null && path.startsWith("/") ? path : "/");
        web.loadUrl(target);
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(night ? 0xFF0E1117 : 0xFFF5F6FA);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " DocketAndroid/1.0");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "DocketAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (isOwnServer(u)) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                ReminderSync.captureCookie(MainActivity.this);
                ReminderSync.syncAsync(MainActivity.this);
                maybeAskNotificationPermission();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError(String.valueOf(error.getDescription()));
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // the WebView engine crashed or was killed to free memory: rebuild it
                root.removeView(web);
                web.destroy();
                web = null;
                loadApp(null);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = params.createIntent();
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "No app available to pick files", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });

        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> download(url, userAgent, contentDisposition, mimeType));
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private boolean isOwnServer(Uri u) {
        Uri base = Uri.parse(Prefs.serverUrl(this));
        return u.getScheme() != null && u.getScheme().equalsIgnoreCase(base.getScheme())
                && u.getHost() != null && u.getHost().equalsIgnoreCase(base.getHost())
                && u.getPort() == base.getPort();
    }

    private void openExternal(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (!(scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto") || scheme.equals("tel")
                || scheme.equals("sms") || scheme.equals("geo"))) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    private void download(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) r.addRequestHeader("Cookie", cookie);
            r.addRequestHeader("User-Agent", userAgent);
            r.setTitle(name);
            r.setMimeType(mimeType);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            else r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(r);
            Toast.makeText(this, "Downloading " + name + " — see your notifications", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------------ notifications permission
    private boolean notificationsAllowed() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        boolean enabled = nm == null || nm.areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= 33) enabled = enabled && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        return enabled;
    }

    private void maybeAskNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || notificationsAllowed()) return;
        if (Prefs.get(this).getBoolean(Prefs.ASKED_NOTIFICATIONS, false)) return;
        Prefs.get(this).edit().putBoolean(Prefs.ASKED_NOTIFICATIONS, true).apply();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }

    private void openNotificationSettings() {
        Intent i;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
        }
        try { startActivity(i); } catch (ActivityNotFoundException ignored) { }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIFICATIONS && notificationsAllowed()) ReminderSync.syncAsync(this);
    }

    // ------------------------------------------------------------------ lifecycle
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String path = intent.getStringExtra(EXTRA_PATH);
        if (path == null) return;
        if (web == null || overlay != null) { loadApp(path); return; }
        int hash = path.indexOf('#');
        if (hash >= 0) web.evaluateJavascript("location.hash = " + JSONObject.quote(path.substring(hash)) + ";", null);
        else web.loadUrl(Prefs.serverUrl(this) + path);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            ReminderSync.captureCookie(this);
            ReminderSync.syncAsync(this);
        }
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (overlay != null && web != null && !Prefs.serverUrl(this).isEmpty()) { removeOverlay(); return; }
        if (web != null && overlay == null && web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ JavaScript bridge
    /** Methods callable from the Docket web app as window.DocketAndroid.*. Only the configured server is loaded. */
    private final class Bridge {
        @JavascriptInterface
        public void onDataChanged() {
            runOnUiThread(() -> {
                ReminderSync.captureCookie(MainActivity.this);
                ReminderSync.syncAsync(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void onSignedOut() {
            ReminderScheduler.cancelAll(MainActivity.this);
            Prefs.get(MainActivity.this).edit().remove(Prefs.COOKIE).remove(Prefs.LAST_SYNC).apply();
        }

        @JavascriptInterface
        public void syncNow() { onDataChanged(); }

        @JavascriptInterface
        public String notificationStatus() {
            JSONObject o = new JSONObject();
            try {
                o.put("permission", notificationsAllowed() ? "granted" : "denied");
                o.put("exactAlarms", ReminderScheduler.canExact(MainActivity.this));
                o.put("scheduled", ReminderScheduler.scheduledCount(MainActivity.this));
                long last = Prefs.get(MainActivity.this).getLong(Prefs.LAST_SYNC, 0);
                o.put("lastSync", last == 0 ? JSONObject.NULL : last);
                String err = Prefs.get(MainActivity.this).getString(Prefs.LAST_ERROR, null);
                o.put("lastError", err == null ? JSONObject.NULL : err);
                o.put("server", Prefs.serverUrl(MainActivity.this));
            } catch (Exception ignored) { }
            return o.toString();
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        && (!Prefs.get(MainActivity.this).getBoolean(Prefs.ASKED_NOTIFICATIONS, false) || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
                    Prefs.get(MainActivity.this).edit().putBoolean(Prefs.ASKED_NOTIFICATIONS, true).apply();
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
                } else {
                    openNotificationSettings();
                }
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(MainActivity.this::openNotificationSettings);
        }

        @JavascriptInterface
        public void openExactAlarmSettings() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName())));
                    } catch (ActivityNotFoundException e) {
                        openNotificationSettings();
                    }
                }
            });
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Change server?")
                    .setMessage("You'll be signed out on this phone and its scheduled reminders will be removed until you sign in again.")
                    .setPositiveButton("Change", (d, w) -> {
                        ReminderScheduler.cancelAll(MainActivity.this);
                        Prefs.get(MainActivity.this).edit().remove(Prefs.COOKIE).remove(Prefs.LAST_SYNC).remove(Prefs.LAST_ERROR).apply();
                        CookieManager.getInstance().removeAllCookies(null);
                        showSetup(Prefs.serverUrl(MainActivity.this));
                    })
                    .setNegativeButton("Cancel", null)
                    .show());
        }
    }
}
