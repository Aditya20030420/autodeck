package com.autodeck.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkUpdatePlugin.class); // before super, so the page can call it
        super.onCreate(savedInstanceState);
    }
}
