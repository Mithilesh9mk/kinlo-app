/**
 * Android home-screen widget: one small launcher card with three buttons.
 *
 *   Split  -> kinlo://expense/amount        (friend or circle expense)
 *   Scan   -> kinlo://finance?action=scan   (personal: pick a screenshot to scan)
 *   Manual -> kinlo://finance?action=manual (personal: type it in)
 *
 * It is deliberately a plain native AppWidgetProvider (RemoteViews + deep
 * links) rather than a JS-rendered widget: nothing on it is data-driven, so
 * there is no headless JS to keep alive and no extra native dependency. Every
 * button just opens the app on the right screen through the existing `kinlo`
 * scheme, so all auth/onboarding gating stays in app/_layout.tsx.
 *
 * Adding this changes native code, so it ships only with a new build — not as
 * an OTA.
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withAndroidManifest, withStringsXml, AndroidConfig } = require('@expo/config-plugins');

const WIDGET_CLASS = 'KinloWidgetProvider';

const cell = (id, iconDrawable, labelString) => `
    <LinearLayout
        android:id="@+id/${id}"
        android:layout_width="0dp"
        android:layout_height="match_parent"
        android:layout_weight="1"
        android:layout_margin="4dp"
        android:orientation="vertical"
        android:gravity="center"
        android:background="@drawable/kinlo_widget_cell">
        <ImageView
            android:layout_width="28dp"
            android:layout_height="28dp"
            android:importantForAccessibility="no"
            android:src="@drawable/${iconDrawable}" />
        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="4dp"
            android:text="@string/${labelString}"
            android:textColor="#FFFFFF"
            android:textSize="12sp"
            android:textStyle="bold" />
    </LinearLayout>
`;

const LAYOUT = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="horizontal"
    android:padding="8dp"
    android:background="@drawable/kinlo_widget_bg">
${cell('kinlo_widget_split', 'kinlo_widget_ic_split', 'kinlo_widget_split')}${cell('kinlo_widget_scan', 'kinlo_widget_ic_scan', 'kinlo_widget_scan')}${cell('kinlo_widget_manual', 'kinlo_widget_ic_manual', 'kinlo_widget_manual')}</LinearLayout>
`;

const INFO = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="250dp"
    android:minHeight="70dp"
    android:targetCellWidth="4"
    android:targetCellHeight="1"
    android:updatePeriodMillis="0"
    android:resizeMode="horizontal"
    android:widgetCategory="home_screen"
    android:initialLayout="@layout/kinlo_widget"
    android:previewLayout="@layout/kinlo_widget"
    android:description="@string/kinlo_widget_description" />
`;

const BG = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#004C22" />
    <corners android:radius="24dp" />
</shape>
`;

const CELL = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#26FFFFFF" />
    <corners android:radius="18dp" />
</shape>
`;

const icon = (pathData, evenOdd) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#A6F4B5"${evenOdd ? '\n        android:fillType="evenOdd"' : ''}
        android:pathData="${pathData}" />
</vector>
`;

// Material "group", "photo_camera" and "edit" glyphs.
const IC_SPLIT = icon(
  'M16,11c1.66,0 2.99,-1.34 2.99,-3S17.66,5 16,5c-1.66,0 -3,1.34 -3,3s1.34,3 3,3zM8,11c1.66,0 2.99,-1.34 2.99,-3S9.66,5 8,5C6.34,5 5,6.34 5,8s1.34,3 3,3zM8,13c-2.33,0 -7,1.17 -7,3.5V19h14v-2.5c0,-2.33 -4.67,-3.5 -7,-3.5zM16,13c-0.29,0 -0.62,0.02 -0.97,0.05 1.16,0.84 1.97,1.97 1.97,3.45V19h6v-2.5c0,-2.33 -4.67,-3.5 -7,-3.5z'
);
const IC_SCAN = icon(
  'M9,2L7.17,4H4c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2h-3.17L15,2H9zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5zM12,9a3,3 0 1,0 0.001,0z',
  true
);
const IC_MANUAL = icon(
  'M3,17.25V21h3.75L17.81,9.94l-3.75,-3.75L3,17.25zM20.71,7.04c0.39,-0.39 0.39,-1.02 0,-1.41l-2.34,-2.34c-0.39,-0.39 -1.02,-0.39 -1.41,0l-1.83,1.83 3.75,3.75 1.83,-1.83z'
);

const provider = (pkg) => `package ${pkg}

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/**
 * Home-screen launcher card. Each button fires a kinlo:// deep link at the app
 * (handled by expo-router); see plugins/withKinloWidget.js.
 */
class ${WIDGET_CLASS} : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (appWidgetId in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.kinlo_widget)
            views.setOnClickPendingIntent(R.id.kinlo_widget_split, link(context, 1, "kinlo://expense/amount"))
            views.setOnClickPendingIntent(R.id.kinlo_widget_scan, link(context, 2, "kinlo://finance?action=scan"))
            views.setOnClickPendingIntent(R.id.kinlo_widget_manual, link(context, 3, "kinlo://finance?action=manual"))
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }

    private fun link(context: Context, requestCode: Int, uri: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
`;

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

module.exports = function withKinloWidget(config) {
  const pkg = config.android && config.android.package;
  if (!pkg) throw new Error('withKinloWidget: expo.android.package must be set');

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const main = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main');
      write(path.join(main, 'res', 'layout', 'kinlo_widget.xml'), LAYOUT);
      write(path.join(main, 'res', 'xml', 'kinlo_widget_info.xml'), INFO);
      write(path.join(main, 'res', 'drawable', 'kinlo_widget_bg.xml'), BG);
      write(path.join(main, 'res', 'drawable', 'kinlo_widget_cell.xml'), CELL);
      write(path.join(main, 'res', 'drawable', 'kinlo_widget_ic_split.xml'), IC_SPLIT);
      write(path.join(main, 'res', 'drawable', 'kinlo_widget_ic_scan.xml'), IC_SCAN);
      write(path.join(main, 'res', 'drawable', 'kinlo_widget_ic_manual.xml'), IC_MANUAL);
      write(path.join(main, 'java', ...pkg.split('.'), `${WIDGET_CLASS}.kt`), provider(pkg));
      return cfg;
    },
  ]);

  config = withStringsXml(config, (cfg) => {
    const items = {
      kinlo_widget_label: 'Kinlo quick add',
      kinlo_widget_description: 'Add a split or personal expense in one tap.',
      kinlo_widget_split: 'Split',
      kinlo_widget_scan: 'Scan',
      kinlo_widget_manual: 'Manual',
    };
    for (const [name, value] of Object.entries(items)) {
      cfg.modResults = AndroidConfig.Strings.setStringItem(
        [{ $: { name }, _: value }],
        cfg.modResults
      );
    }
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.receiver = app.receiver || [];
    const name = `.${WIDGET_CLASS}`;
    if (!app.receiver.some((r) => r.$['android:name'] === name)) {
      app.receiver.push({
        $: {
          'android:name': name,
          'android:exported': 'false',
          'android:label': '@string/kinlo_widget_label',
        },
        'intent-filter': [
          { action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.appwidget.provider',
              'android:resource': '@xml/kinlo_widget_info',
            },
          },
        ],
      });
    }
    return cfg;
  });

  return config;
};
