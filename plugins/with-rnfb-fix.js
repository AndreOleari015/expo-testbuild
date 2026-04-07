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
MODULEMAP_PATH="\${PODS_ROOT}/React-Core-prebuilt/React-use-frameworks.modulemap"
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
    if (podfile.includes("[with-rnfb-fix]")) {
        return podfile;
    }

    return podfile.replace(/post_install do \|installer\|([\s\S]*?)(\n\s*end\s*$)/m, (_match, body, ending) => {
        return `post_install do |installer|${body}\n${POST_INSTALL_SNIPPET}${ending}`;
    });
}

const withRNFBFix = (config) =>
    withDangerousMod(config, [
        "ios",
        async (cfg) => {
            const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
            const original = fs.readFileSync(podfilePath, "utf8");
            const updated = injectSnippets(original);
            if (updated !== original) {
                fs.writeFileSync(podfilePath, updated);
            }
            return cfg;
        },
    ]);

module.exports = createRunOncePlugin(withRNFBFix, "with-rnfb-fix", "1.0.0");
