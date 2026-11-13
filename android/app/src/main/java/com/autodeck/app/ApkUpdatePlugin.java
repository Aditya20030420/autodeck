package com.autodeck.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Self-update for the sideloaded app: look for a newer APK on the GitHub release, download it, verify its SHA-256
 * (the one GitHub records for the asset), and hand it to Android's installer. Android always asks the user to
 * confirm an install, so the last step is one tap on "Install".
 */
@CapacitorPlugin(name = "ApkUpdate")
public class ApkUpdatePlugin extends Plugin {
    private static final String API = "https://api.github.com/repos/Aditya20030420/autodeck/releases/latest";

    private File apkFile() {
        File dir = new File(getContext().getCacheDir(), "updates");
        dir.mkdirs();
        return new File(dir, "AutoDeck.apk");
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "AutoDeck-updater");
        c.setRequestProperty("Accept", "application/vnd.github+json");
        return c;
    }

    private String current() throws Exception {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
    }

    private static boolean newer(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? Integer.parseInt(x[i].replaceAll("\\D", "0")) : 0;
            int q = i < y.length ? Integer.parseInt(y[i].replaceAll("\\D", "0")) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    @PluginMethod
    public void check(PluginCall call) {
        new Thread(() -> {
            try {
                HttpURLConnection c = open(API);
                StringBuilder body = new StringBuilder();
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) body.append(new String(buf, 0, n, "UTF-8"));
                }
                JSONObject rel = new JSONObject(body.toString());
                String tag = rel.getString("tag_name").replaceFirst("^v", "");
                JSONArray assets = rel.getJSONArray("assets");
                JSObject out = new JSObject();
                out.put("current", current());
                out.put("version", tag);
                out.put("available", false);
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject a = assets.getJSONObject(i);
                    if (!a.getString("name").endsWith(".apk")) continue;
                    String digest = a.optString("digest", "");
                    // Without a published checksum the file can't be verified, so it isn't offered.
                    boolean hasSum = digest.startsWith("sha256:");
                    out.put("url", a.getString("browser_download_url"));
                    out.put("sha256", hasSum ? digest.substring(7) : "");
                    out.put("available", hasSum && newer(tag, current()));
                    break;
                }
                call.resolve(out);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String want = call.getString("sha256", "");
        new Thread(() -> {
            File apk = apkFile();
            try {
                HttpURLConnection c = open(url);
                long total = c.getContentLengthLong(), got = 0;
                int last = -1;
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        md.update(buf, 0, n);
                        got += n;
                        int pct = total > 0 ? (int) (got * 100 / total) : 0;
                        if (pct != last) {
                            last = pct;
                            JSObject p = new JSObject();
                            p.put("percent", pct);
                            notifyListeners("progress", p);
                        }
                    }
                }
                if (want.isEmpty() || !hex(md.digest()).equalsIgnoreCase(want)) {
                    apk.delete();
                    call.reject("The download didn't match its checksum, so it was discarded.");
                    return;
                }
                call.resolve();
            } catch (Exception e) {
                apk.delete();
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        Context ctx = getContext();
        File apk = apkFile();
        if (!apk.exists()) {
            call.reject("No update has been downloaded.");
            return;
        }
        // First time only: Android needs "Install unknown apps" switched on for AutoDeck.
        if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(s);
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        call.resolve();
    }
}
