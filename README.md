# [🔥] iOS build fails with Expo SDK 55 + RN 0.83 + use_frameworks :static — React-use-frameworks.modulemap not found & HERMES_CLI_PATH hardcoded as absolute path

## Issue

Building an Expo SDK 55 project with `@react-native-firebase` v24 fails on iOS with **two separate errors** depending on the environment (local Xcode build vs EAS Build). Both stem from the interaction between RN 0.83's prebuilt binary distribution (`RCT_USE_PREBUILT_RNCORE=1`) and `use_frameworks! :linkage => :static` required by Firebase Swift pods.

### Error 1 — Local Xcode Build

```
<unknown>:0: error: module map file
'/path/to/project/ios/Pods/React-Core-prebuilt/React-use-frameworks.modulemap' not found
```

The `React-Core-prebuilt` pod (introduced with RN 0.83 prebuilt binaries) references a `React-use-frameworks.modulemap` file that is never created when `use_frameworks: :static` is enabled. The modulemap path gets injected into xcconfig files via `-fmodule-map-file=` flags, but the actual file doesn't exist on disk.

### Error 2 — EAS Build

```
/Users/expo/workingdir/build/node_modules/react-native/scripts/react-native-xcode.sh: line 179:
/Volumes/DiscoD/Projects/rn-projects/expo-testbuild/node_modules/hermes-compiler/hermesc/osx-bin/hermesc:
No such file or directory
Command PhaseScriptExecution failed with a nonzero exit code
```

During `pod install`, the `HERMES_CLI_PATH` build setting is resolved to an **absolute path on the local development machine** and baked into the xcconfig files. When the project is then built on EAS (or any CI), the path points to a non-existent local filesystem location.

### Steps to Reproduce

1. Create a new Expo SDK 55 project with `react-native@0.83.4`
2. Add `@react-native-firebase/app@24` + any Firebase module (e.g., analytics, auth)
3. Add `expo-build-properties` with `ios.useFrameworks: 'static'` (required for Firebase Swift pods)
4. Run `npx expo prebuild --platform ios`
5. Build locally with Xcode → **Error 1** (modulemap not found)
6. Build on EAS → **Error 2** (HERMES_CLI_PATH absolute path)

### Root Cause Analysis

With RN 0.83, the default `RCT_USE_PREBUILT_RNCORE=1` introduces the `React-Core-prebuilt` pod that distributes precompiled binaries. This pod:

1. References a `React-use-frameworks.modulemap` that only makes sense when `use_frameworks` is **not** used, but the reference is injected into xcconfig regardless
2. Resolves `HERMES_CLI_PATH` to an absolute local path during `pod install`, which breaks any CI/remote build

Since Firebase requires `use_frameworks! :linkage => :static` for its Swift pods, every project using `@react-native-firebase` on RN 0.83+ hits this incompatibility.

### Workaround — Error 1 SOLVED (local Xcode build)

A custom Expo config plugin (`plugins/with-rnfb-fix.js`) applies two `post_install` patches that **fully resolve Error 1** for local Release builds:

1. **Recreate the modulemap** — injects a shell script into the `React-Core-prebuilt` build phase to generate the missing `React-use-frameworks.modulemap` after tarball extraction
2. **Allow non-modular includes** — sets `CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES=YES` and `-Wno-non-modular-include-in-framework-module` for all RNFB pod targets

After removing an earlier HERMES_CLI_PATH patch (which was interfering), the **local Xcode Release build succeeds**.

<details><summary>Current plugin code (plugins/with-rnfb-fix.js)</summary>
<p>

```js
const {withDangerousMod, createRunOncePlugin} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const RNFB_TARGETS = ["RNFBApp", "RNFBAuth", "RNFBAnalytics", "RNFBCrashlytics", "RNFBMessaging", "RNFBRemoteConfig"];

const POST_INSTALL_SNIPPET = `
    # [with-rnfb-fix] Patch React-Core-prebuilt replace script to recreate modulemap
    react_core_target = installer.pods_project.targets.find { |t| t.name == 'React-Core-prebuilt' }
    if react_core_target
      react_core_target.shell_script_build_phases.each do |phase|
        if phase.name&.include?('Replace React Native Core')
          unless phase.shell_script.include?('React-use-frameworks.modulemap')
            phase.shell_script += %q(
# [with-rnfb-fix] Recreate modulemap after tarball extraction
MODULEMAP_PATH="\\${PODS_ROOT}/React-Core-prebuilt/React-use-frameworks.modulemap"
cat > "$MODULEMAP_PATH" << 'MODULEMAP'
module React {
  umbrella header "React.xcframework/Headers/React_Core/React_Core-umbrella.h"
  export *
}
MODULEMAP
echo "[with-rnfb-fix] Created React-use-frameworks.modulemap"
)
          end
        end
      end
    end

    # [with-rnfb-fix] Allow non-modular includes for Firebase pods
    installer.pods_project.targets.each do |t|
      if ${JSON.stringify(RNFB_TARGETS)}.include?(t.name)
        t.build_configurations.each do |config|
          config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
          other = config.build_settings['OTHER_CFLAGS'] ||= ['$(inherited)']
          config.build_settings['OTHER_CFLAGS'] = (other + ['-Wno-non-modular-include-in-framework-module']).uniq
        end
      end
    end
`;

function injectSnippets(podfile) {
    if (podfile.includes("[with-rnfb-fix]")) return podfile;
    return podfile.replace(
        /post_install do \|installer\|([\s\S]*?)(\n\s*end\s*$)/m,
        (_match, body, ending) => `post_install do |installer|${body}\n${POST_INSTALL_SNIPPET}${ending}`,
    );
}

const withRNFBFix = (config) =>
    withDangerousMod(config, [
        "ios",
        async (cfg) => {
            const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
            const original = fs.readFileSync(podfilePath, "utf8");
            const updated = injectSnippets(original);
            if (updated !== original) fs.writeFileSync(podfilePath, updated);
            return cfg;
        },
    ]);

module.exports = createRunOncePlugin(withRNFBFix, "with-rnfb-fix", "1.0.0");
```

</p>
</details>

### Error 2 — STILL FAILING on EAS Build

The EAS build still fails because `HERMES_CLI_PATH` is baked as an absolute local machine path during `pod install`. The `react-native-xcode.sh` script tries to invoke `hermesc` at a path like `/Volumes/DiscoD/Projects/.../hermesc` which doesn't exist on the EAS build server.

This is **not specific to react-native-firebase** — it affects any Expo SDK 55 + RN 0.83 project using `use_frameworks: :static` on EAS Build. The `HERMES_CLI_PATH` is resolved to an absolute path by the React Native CocoaPods setup and there is no hook available to override it before the value is written to the xcconfig files that get uploaded to EAS.

A previous attempt to patch `HERMES_CLI_PATH` in `post_install` was removed because it interfered with local builds. The absolute path appears to be set somewhere outside the Podfile's control (possibly in the hermes-engine podspec or React Native's `react_native_pods.rb` script).

### Suggested Fix

The RNFB Expo config plugin could:

1. Automatically strip or fix `React-use-frameworks.modulemap` references when `use_frameworks: :static` is active
2. Ensure `HERMES_CLI_PATH` uses a relative/variable-based path (`$(PODS_ROOT)/...`) instead of an absolute path
3. Or recommend setting `RCT_USE_PREBUILT_RNCORE=0` as a documented workaround for RN 0.83+

### Related Issues

- #8657 — Central tracking issue for Expo + Firebase build failures
- #8883 — RN 0.84 pre-compiled iOS distribution compile errors
- #8908 — Expo SDK 55 + newArch compatibility

---

## Project Files

### Javascript

<details><summary>Click To Expand</summary>
<p>

#### `package.json`:

```json
{
    "name": "expo-testbuild",
    "main": "expo-router/entry",
    "version": "1.0.0",
    "scripts": {
        "start": "expo start",
        "android": "expo run:android",
        "ios": "expo run:ios"
    },
    "dependencies": {
        "@react-native-firebase/analytics": "^24.0.0",
        "@react-native-firebase/auth": "^24.0.0",
        "@react-native-firebase/crashlytics": "^24.0.0",
        "@react-native-firebase/firestore": "^24.0.0",
        "@react-native-firebase/messaging": "^24.0.0",
        "@react-native-firebase/remote-config": "^24.0.0",
        "@react-navigation/bottom-tabs": "^7.15.5",
        "@react-navigation/elements": "^2.9.10",
        "@react-navigation/native": "^7.1.33",
        "expo": "~55.0.11",
        "expo-build-properties": "~55.0.11",
        "expo-constants": "~55.0.11",
        "expo-dev-client": "~55.0.22",
        "expo-device": "~55.0.12",
        "expo-font": "~55.0.6",
        "expo-glass-effect": "~55.0.10",
        "expo-image": "~55.0.8",
        "expo-linking": "~55.0.11",
        "expo-router": "~55.0.10",
        "expo-splash-screen": "~55.0.15",
        "expo-status-bar": "~55.0.5",
        "expo-symbols": "~55.0.7",
        "expo-system-ui": "~55.0.13",
        "expo-web-browser": "~55.0.12",
        "react": "19.2.0",
        "react-dom": "19.2.0",
        "react-native": "0.83.4",
        "react-native-gesture-handler": "~2.30.0",
        "react-native-google-mobile-ads": "^16.3.1",
        "react-native-reanimated": "4.2.1",
        "react-native-safe-area-context": "~5.6.2",
        "react-native-screens": "~4.23.0",
        "react-native-web": "~0.21.0",
        "react-native-worklets": "0.7.2"
    },
    "devDependencies": {
        "@types/react": "~19.2.2",
        "typescript": "~5.9.2"
    },
    "private": true
}
```

#### `app.json`:

```json
{
    "expo": {
        "name": "expo-testbuild",
        "slug": "expo-testbuild",
        "version": "1.0.0",
        "orientation": "portrait",
        "scheme": "expotestbuild",
        "userInterfaceStyle": "automatic",
        "ios": {
            "googleServicesFile": "./GoogleService-Info.plist",
            "bundleIdentifier": "com.testbuild.usaq",
            "entitlements": {
                "aps-environment": "production"
            },
            "infoPlist": {
                "UIBackgroundModes": ["remote-notification"],
                "ITSAppUsesNonExemptEncryption": false
            }
        },
        "plugins": [
            "expo-router",
            "@react-native-firebase/app",
            "@react-native-firebase/auth",
            "@react-native-firebase/crashlytics",
            [
                "expo-build-properties",
                {
                    "ios": {
                        "useFrameworks": "static"
                    }
                }
            ],
            "./plugins/with-rnfb-fix"
        ],
        "experiments": {
            "typedRoutes": true,
            "reactCompiler": true
        }
    }
}
```

#### `firebase.json` for react-native-firebase v6:

```json
# N/A — not using firebase.json config overrides
```

</p>
</details>

### iOS

<details><summary>Click To Expand</summary>
<p>

#### `ios/Podfile`:

- [ ] I'm not using Pods
- [x] I'm using Pods and my Podfile looks like:

```ruby
ENV['RNS_GAMMA_ENABLED'] ||= '1'
require File.join(File.dirname(`node --print "require.resolve('expo/package.json')"`), "scripts/autolinking")
require File.join(File.dirname(`node --print "require.resolve('react-native/package.json')"`), "scripts/react_native_pods")

require 'json'
podfile_properties = JSON.parse(File.read(File.join(__dir__, 'Podfile.properties.json'))) rescue {}

def ccache_enabled?(podfile_properties)
  return ENV['USE_CCACHE'] == '1' if ENV['USE_CCACHE']
  podfile_properties['apple.ccacheEnabled'] == 'true'
end

ENV['EX_DEV_CLIENT_NETWORK_INSPECTOR'] ||= podfile_properties['EX_DEV_CLIENT_NETWORK_INSPECTOR']
ENV['RCT_USE_RN_DEP'] ||= '1' if podfile_properties['ios.buildReactNativeFromSource'] != 'true'
ENV['RCT_USE_PREBUILT_RNCORE'] ||= '1' if podfile_properties['ios.buildReactNativeFromSource'] != 'true'
ENV['RCT_HERMES_V1_ENABLED'] ||= '1' if podfile_properties['expo.useHermesV1'] == 'true'
platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'

prepare_react_native_project!

target 'expotestbuild' do
  use_expo_modules!

  if ENV['EXPO_USE_COMMUNITY_AUTOLINKING'] == '1'
    config_command = ['node', '-e', "process.argv=['', '', 'config'];require('@react-native-community/cli').run()"];
  else
    config_command = [
      'node', '--no-warnings', '--eval',
      'require(\'expo/bin/autolinking\')',
      'expo-modules-autolinking', 'react-native-config',
      '--json', '--platform', 'ios'
    ]
  end

  config = use_native_modules!(config_command)

  use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']
  use_frameworks! :linkage => ENV['USE_FRAMEWORKS'].to_sym if ENV['USE_FRAMEWORKS']

  use_react_native!(
    :path => config[:reactNativePath],
    :hermes_enabled => podfile_properties['expo.jsEngine'] == nil || podfile_properties['expo.jsEngine'] == 'hermes',
    :app_path => "#{Pod::Config.instance.installation_root}/..",
    :privacy_file_aggregation_enabled => podfile_properties['apple.privacyManifestAggregationEnabled'] != 'false',
  )

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )

    # [with-rnfb-fix] Strip broken React-use-frameworks.modulemap references from xcconfig files
    support_dir = File.join(installer.sandbox.root.to_s, 'Target Support Files')
    Dir.glob(File.join(support_dir, '**', '*.xcconfig')).each do |xcconfig_path|
      content = File.read(xcconfig_path)
      patched = content
        .gsub(/ ?-fmodule-map-file="[^"]*React-use-frameworks\.modulemap"/, '')
        .gsub(/ ?-Xcc -fmodule-map-file[=\\]+"[^"]*React-use-frameworks\.modulemap"/, '')
        .gsub(/ ?-Xcc -fmodule-map-file="[^"]*React-use-frameworks\.modulemap"/, '')
      if patched != content
        File.write(xcconfig_path, patched)
      end
    end

    # [with-rnfb-fix] Allow non-modular includes for Firebase pods
    installer.pods_project.targets.each do |t|
      if ["RNFBApp","RNFBAuth","RNFBAnalytics","RNFBCrashlytics","RNFBMessaging","RNFBRemoteConfig"].include?(t.name)
        t.build_configurations.each do |config|
          config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
          other = config.build_settings['OTHER_CFLAGS'] ||= ['$(inherited)']
          config.build_settings['OTHER_CFLAGS'] = (other + ['-Wno-non-modular-include-in-framework-module']).uniq
        end
      end
    end
  end
end
```

#### `AppDelegate.m`:

```objc
// N/A — using Expo's default AppDelegate (managed by expo-router)
```

</p>
</details>

---

### Android

<details><summary>Click To Expand</summary>
<p>

#### Have you converted to AndroidX?

- [x] my application is an AndroidX application?
- [ ] I am using `android/gradle.settings` `jetifier=true` for Android compatibility?
- [ ] I am using the NPM package `jetifier` for react-native compatibility?

> Android builds work fine. This issue is iOS-only.

#### `android/build.gradle`:

```groovy
// N/A — Android is not affected
```

#### `android/app/build.gradle`:

```groovy
// N/A
```

#### `android/settings.gradle`:

```groovy
// N/A
```

#### `MainApplication.java`:

```java
// N/A
```

#### `AndroidManifest.xml`:

```xml
<!-- N/A -->
```

</p>
</details>

---

## Environment

<details><summary>Click To Expand</summary>
<p>

**`expo-env-info` output:**

```
  System:
    OS: macOS 26.1
    Shell: 5.9 - /bin/zsh
  Binaries:
    Node: 22.21.1 - /opt/homebrew/bin/node
    npm: 11.11.0
    Watchman: 2025.12.22.00 - /opt/homebrew/bin/watchman
  Managers:
    CocoaPods: 1.16.2 - /opt/homebrew/bin/pod
  SDKs:
    iOS SDK:
      Platforms: DriverKit 25.2, iOS 26.2, macOS 26.2, tvOS 26.2, visionOS 26.2, watchOS 26.2
  IDEs:
    Android Studio: 2025.2 AI-252.27397.103.2522.14617522
    Xcode: 26.2/17C52 - /usr/bin/xcodebuild
  npmPackages:
    expo: ~55.0.11 => 55.0.11
    react: 19.2.0 => 19.2.0
    react-native: 0.83.4 => 0.83.4
  npmGlobalPackages:
    eas-cli: 18.5.0
  Expo Workflow: bare
```

- **Platform that you're experiencing the issue on**:
    - [x] iOS
    - [ ] Android
    - [ ] **iOS** but have not tested behavior on Android
    - [ ] **Android** but have not tested behavior on iOS
    - [ ] Both
- **`react-native-firebase` version you're using that has this issue:**
    - `24.0.0`
- **`Firebase` module(s) you're using that has the issue:**
    - `app, analytics, auth, crashlytics, firestore, messaging, remote-config`
- **Are you using `TypeScript`?**
    - `Y` & `5.9.2`

</p>
</details>

---

- 🔗 **Reproduction repository:** [AndreOleari015/expo-testbuild](https://github.com/AndreOleari015/expo-testbuild)
