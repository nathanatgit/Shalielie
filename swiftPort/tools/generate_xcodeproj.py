"""Regenerate StylePort.xcodeproj/project.pbxproj from the sources on disk.

usage (from swiftPort/): python tools/generate_xcodeproj.py .
Gives every file a stable ID, so re-running after adding a .swift file only adds its entries.
"""
import sys
from pathlib import Path

root = Path(sys.argv[1])
core = sorted(p.name for p in (root / "Sources/StylePortCore").glob("*.swift"))
app = sorted(p.name for p in (root / "Sources/StylePortApp").glob("*.swift"))
tests = sorted(p.name for p in (root / "Tests/StylePortCoreTests").glob("*.swift"))


def ident(prefix, n):
    return f"{prefix}{n:0{24 - len(prefix)}X}"


files, build = {}, {}
for i, n in enumerate(core, 1):
    files[("core", n)] = ident("C0", i)
    build[("core", n)] = ident("B1", i)
for i, n in enumerate(app, 1):
    files[("app", n)] = ident("A0", i)
    build[("app", n)] = ident("B2", i)
for i, n in enumerate(tests, 1):
    files[("test", n)] = ident("D0", i)
    build[("test", n)] = ident("B3", i)
PRIV, PRIV_B = ident("A1", 1), ident("B4", 1)
PROF, PROF_B = ident("E0", 1), ident("B4", 2)
ASSETS, ASSETS_B = ident("E0", 2), ident("B4", 3)
INFO_VG, INFO_B = ident("E0", 3), ident("B4", 4)
INFO_EN, INFO_ZH = ident("E0", 4), ident("E0", 5)
FW, APP, XCT = ident("F1", 1), ident("F1", 2), ident("F1", 3)
FW_LINK, FW_EMBED, FW_TEST, XCT_B = ident("B5", 1), ident("B5", 2), ident("B5", 3), ident("B5", 4)
XCTEST_FW = ident("F0", 1)
G = {name: ident("A2", i) for i, name in enumerate(
    ["main", "StylePortCore", "StylePortApp", "Resources", "Tests", "Frameworks", "Products"], 1)}
Q = '"'

out = []
w = out.append
w("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {\n\t};\n\tobjectVersion = 56;\n\tobjects = {\n")
w("/* Begin PBXBuildFile section */")
for (k, n), b in build.items():
    w(f"\t\t{b} /* {n} in Sources */ = {{isa = PBXBuildFile; fileRef = {files[(k, n)]} /* {n} */; }};")
w(f"\t\t{PRIV_B} /* PrivacyInfo.xcprivacy in Resources */ = {{isa = PBXBuildFile; fileRef = {PRIV} /* PrivacyInfo.xcprivacy */; }};")
w(f"\t\t{PROF_B} /* Profiles in Resources */ = {{isa = PBXBuildFile; fileRef = {PROF} /* Profiles */; }};")
w(f"\t\t{ASSETS_B} /* Assets.xcassets in Resources */ = {{isa = PBXBuildFile; fileRef = {ASSETS} /* Assets.xcassets */; }};")
w(f"\t\t{INFO_B} /* InfoPlist.strings in Resources */ = {{isa = PBXBuildFile; fileRef = {INFO_VG} /* InfoPlist.strings */; }};")
w(f"\t\t{FW_LINK} /* StylePortCore.framework in Frameworks */ = {{isa = PBXBuildFile; fileRef = {FW} /* StylePortCore.framework */; }};")
w(f"\t\t{FW_EMBED} /* StylePortCore.framework in Embed Frameworks */ = {{isa = PBXBuildFile; fileRef = {FW} /* StylePortCore.framework */; settings = {{ATTRIBUTES = (CodeSignOnCopy, RemoveHeadersOnCopy, ); }}; }};")
w(f"\t\t{FW_TEST} /* StylePortCore.framework in Frameworks */ = {{isa = PBXBuildFile; fileRef = {FW} /* StylePortCore.framework */; }};")
w(f"\t\t{XCT_B} /* XCTest.framework in Frameworks */ = {{isa = PBXBuildFile; fileRef = {XCTEST_FW} /* XCTest.framework */; }};")
w("/* End PBXBuildFile section */\n")

w("/* Begin PBXContainerItemProxy section */")
for pid in ("900000000000000000000001", "900000000000000000000002"):
    w(f"\t\t{pid} /* PBXContainerItemProxy */ = {{\n\t\t\tisa = PBXContainerItemProxy;\n"
      f"\t\t\tcontainerPortal = 800000000000000000000001 /* Project object */;\n\t\t\tproxyType = 1;\n"
      f"\t\t\tremoteGlobalIDString = 500000000000000000000001;\n\t\t\tremoteInfo = StylePortCore;\n\t\t}};")
w("/* End PBXContainerItemProxy section */\n")

w("/* Begin PBXCopyFilesBuildPhase section */")
w(f"\t\t400000000000000000000001 /* Embed Frameworks */ = {{\n\t\t\tisa = PBXCopyFilesBuildPhase;\n"
  f"\t\t\tbuildActionMask = 2147483647;\n\t\t\tdstPath = {Q}{Q};\n\t\t\tdstSubfolderSpec = 10;\n"
  f"\t\t\tfiles = (\n\t\t\t\t{FW_EMBED} /* StylePortCore.framework in Embed Frameworks */,\n\t\t\t);\n"
  f"\t\t\tname = {Q}Embed Frameworks{Q};\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t}};")
w("/* End PBXCopyFilesBuildPhase section */\n")

GROUP_TREE = f"sourceTree = {Q}<group>{Q};"
w("/* Begin PBXFileReference section */")
for (k, n), f in files.items():
    w(f"\t\t{f} /* {n} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {n}; {GROUP_TREE} }};")
w(f"\t\t{PRIV} /* PrivacyInfo.xcprivacy */ = {{isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; {GROUP_TREE} }};")
w(f"\t\t{PROF} /* Profiles */ = {{isa = PBXFileReference; lastKnownFileType = folder; path = Profiles; {GROUP_TREE} }};")
w(f"\t\t{ASSETS} /* Assets.xcassets */ = {{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; {GROUP_TREE} }};")
w(f"\t\t{INFO_EN} /* en */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = en; path = en.lproj/InfoPlist.strings; {GROUP_TREE} }};")
w(f"\t\t{INFO_ZH} /* zh-Hans */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = {Q}zh-Hans{Q}; path = {Q}zh-Hans.lproj/InfoPlist.strings{Q}; {GROUP_TREE} }};")
w(f"\t\t{XCTEST_FW} /* XCTest.framework */ = {{isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = XCTest.framework; path = System/Library/Frameworks/XCTest.framework; sourceTree = SDKROOT; }};")
w(f"\t\t{FW} /* StylePortCore.framework */ = {{isa = PBXFileReference; explicitFileType = wrapper.framework; includeInIndex = 0; path = StylePortCore.framework; sourceTree = BUILT_PRODUCTS_DIR; }};")
w(f"\t\t{APP} /* StylePort.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = StylePort.app; sourceTree = BUILT_PRODUCTS_DIR; }};")
w(f"\t\t{XCT} /* StylePortCoreTests.xctest */ = {{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = StylePortCoreTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; }};")
w("/* End PBXFileReference section */\n")

w("/* Begin PBXFrameworksBuildPhase section */")
w("\t\t300000000000000000000001 /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };")
w(f"\t\t300000000000000000000002 /* Frameworks */ = {{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({FW_LINK} /* StylePortCore.framework in Frameworks */, ); runOnlyForDeploymentPostprocessing = 0; }};")
w(f"\t\t300000000000000000000003 /* Frameworks */ = {{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({FW_TEST} /* StylePortCore.framework in Frameworks */, {XCT_B} /* XCTest.framework in Frameworks */, ); runOnlyForDeploymentPostprocessing = 0; }};")
w("/* End PBXFrameworksBuildPhase section */\n")


def group(gid, name, children, path=None, named=False):
    body = "".join(f"\t\t\t\t{c},\n" for c in children)
    extra = f"\t\t\tpath = {path};\n" if path else ""
    extra += f"\t\t\tname = {name};\n" if named else ""
    label = f" /* {name} */" if name else ""
    w(f"\t\t{gid}{label} = {{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n{body}\t\t\t);\n{extra}\t\t\t{GROUP_TREE}\n\t\t}};")


w("/* Begin PBXGroup section */")
group(G["main"], "", [f"{G[n]} /* {n} */" for n in ["StylePortCore", "StylePortApp", "Resources", "Tests", "Frameworks", "Products"]])
group(G["StylePortCore"], "StylePortCore", [f"{files[('core', n)]} /* {n} */" for n in core], "Sources/StylePortCore")
group(G["StylePortApp"], "StylePortApp", [f"{files[('app', n)]} /* {n} */" for n in app] + [f"{PRIV} /* PrivacyInfo.xcprivacy */"], "Sources/StylePortApp")
group(G["Resources"], "Resources", [f"{ASSETS} /* Assets.xcassets */", f"{INFO_VG} /* InfoPlist.strings */", f"{PROF} /* Profiles */"], "Resources")
group(G["Tests"], "Tests", [f"{files[('test', n)]} /* {n} */" for n in tests], "Tests/StylePortCoreTests")
group(G["Frameworks"], "Frameworks", [f"{XCTEST_FW} /* XCTest.framework */"], named=True)
group(G["Products"], "Products", [f"{FW} /* StylePortCore.framework */", f"{APP} /* StylePort.app */", f"{XCT} /* StylePortCoreTests.xctest */"], named=True)
w("/* End PBXGroup section */\n")


def target(tid, name, cfg, phases, deps, product, ptype, prodname):
    ph = "".join(f"\t\t\t\t{p},\n" for p in phases)
    dp = "".join(f"{d} /* PBXTargetDependency */, " for d in deps)
    w(f"\t\t{tid} /* {name} */ = {{\n\t\t\tisa = PBXNativeTarget;\n"
      f"\t\t\tbuildConfigurationList = {cfg} /* Build configuration list for PBXNativeTarget {Q}{name}{Q} */;\n"
      f"\t\t\tbuildPhases = (\n{ph}\t\t\t);\n\t\t\tbuildRules = ();\n\t\t\tdependencies = ({dp});\n"
      f"\t\t\tname = {name};\n\t\t\tproductName = {name};\n\t\t\tproductReference = {product} /* {prodname} */;\n"
      f"\t\t\tproductType = {Q}{ptype}{Q};\n\t\t}};")


w("/* Begin PBXNativeTarget section */")
target("500000000000000000000001", "StylePortCore", "700000000000000000000002",
       ["100000000000000000000001 /* Sources */", "300000000000000000000001 /* Frameworks */", "200000000000000000000001 /* Resources */"],
       [], FW, "com.apple.product-type.framework", "StylePortCore.framework")
target("500000000000000000000002", "StylePort", "700000000000000000000003",
       ["100000000000000000000002 /* Sources */", "300000000000000000000002 /* Frameworks */", "200000000000000000000002 /* Resources */", "400000000000000000000001 /* Embed Frameworks */"],
       ["900000000000000000000003"], APP, "com.apple.product-type.application", "StylePort.app")
target("500000000000000000000003", "StylePortCoreTests", "700000000000000000000004",
       ["100000000000000000000003 /* Sources */", "300000000000000000000003 /* Frameworks */", "200000000000000000000003 /* Resources */"],
       ["900000000000000000000004"], XCT, "com.apple.product-type.bundle.unit-test", "StylePortCoreTests.xctest")
w("/* End PBXNativeTarget section */\n")

w("/* Begin PBXProject section */")
w("\t\t800000000000000000000001 /* Project object */ = {\n\t\t\tisa = PBXProject;\n\t\t\tattributes = {\n"
  "\t\t\t\tBuildIndependentTargetsInParallel = 1;\n\t\t\t\tLastSwiftUpdateCheck = 1600;\n\t\t\t\tLastUpgradeCheck = 1600;\n"
  "\t\t\t\tTargetAttributes = {\n\t\t\t\t\t500000000000000000000001 = {CreatedOnToolsVersion = 16.0; };\n"
  "\t\t\t\t\t500000000000000000000002 = {CreatedOnToolsVersion = 16.0; };\n"
  "\t\t\t\t\t500000000000000000000003 = {CreatedOnToolsVersion = 16.0; };\n\t\t\t\t};\n\t\t\t};\n"
  f"\t\t\tbuildConfigurationList = 700000000000000000000001 /* Build configuration list for PBXProject {Q}StylePort{Q} */;\n"
  f"\t\t\tcompatibilityVersion = {Q}Xcode 14.0{Q};\n\t\t\tdevelopmentRegion = en;\n\t\t\thasScannedForEncodings = 0;\n"
  f"\t\t\tknownRegions = (en, Base, {Q}zh-Hans{Q}, );\n\t\t\tmainGroup = {G['main']};\n"
  f"\t\t\tproductRefGroup = {G['Products']} /* Products */;\n\t\t\tprojectDirPath = {Q}{Q};\n\t\t\tprojectRoot = {Q}{Q};\n"
  "\t\t\ttargets = (\n\t\t\t\t500000000000000000000001 /* StylePortCore */,\n\t\t\t\t500000000000000000000002 /* StylePort */,\n"
  "\t\t\t\t500000000000000000000003 /* StylePortCoreTests */,\n\t\t\t);\n\t\t};")
w("/* End PBXProject section */\n")

w("/* Begin PBXResourcesBuildPhase section */")
w(f"\t\t200000000000000000000001 /* Resources */ = {{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({PROF_B} /* Profiles in Resources */, ); runOnlyForDeploymentPostprocessing = 0; }};")
w(f"\t\t200000000000000000000002 /* Resources */ = {{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({ASSETS_B} /* Assets.xcassets in Resources */, {INFO_B} /* InfoPlist.strings in Resources */, {PRIV_B} /* PrivacyInfo.xcprivacy in Resources */, ); runOnlyForDeploymentPostprocessing = 0; }};")
w("\t\t200000000000000000000003 /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };")
w("/* End PBXResourcesBuildPhase section */\n")

w("/* Begin PBXSourcesBuildPhase section */")
for pid, kind, names in (("100000000000000000000001", "core", core), ("100000000000000000000002", "app", app),
                         ("100000000000000000000003", "test", tests)):
    body = "".join(f"\t\t\t\t{build[(kind, n)]} /* {n} in Sources */,\n" for n in names)
    w(f"\t\t{pid} /* Sources */ = {{\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n"
      f"\t\t\tfiles = (\n{body}\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t}};")
w("/* End PBXSourcesBuildPhase section */\n")

w("/* Begin PBXTargetDependency section */")
w("\t\t900000000000000000000003 /* PBXTargetDependency */ = {isa = PBXTargetDependency; target = 500000000000000000000001 /* StylePortCore */; targetProxy = 900000000000000000000001 /* PBXContainerItemProxy */; };")
w("\t\t900000000000000000000004 /* PBXTargetDependency */ = {isa = PBXTargetDependency; target = 500000000000000000000001 /* StylePortCore */; targetProxy = 900000000000000000000002 /* PBXContainerItemProxy */; };")
w("/* End PBXTargetDependency section */\n")

w("/* Begin PBXVariantGroup section */")
w(f"\t\t{INFO_VG} /* InfoPlist.strings */ = {{\n\t\t\tisa = PBXVariantGroup;\n\t\t\tchildren = (\n"
  f"\t\t\t\t{INFO_EN} /* en */,\n\t\t\t\t{INFO_ZH} /* zh-Hans */,\n\t\t\t);\n\t\t\tname = InfoPlist.strings;\n\t\t\t{GROUP_TREE}\n\t\t}};")
w("/* End PBXVariantGroup section */\n")

VERSION = "0.6.3"


def settings(cid, name, pairs):
    body = "".join(f"\t\t\t\t{k} = {v};\n" for k, v in pairs)
    w(f"\t\t{cid} /* {name} */ = {{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {{\n{body}\t\t\t}};\n\t\t\tname = {name};\n\t\t}};")


def q(s):
    return Q + s + Q


w("/* Begin XCBuildConfiguration section */")
settings("600000000000000000000001", "Debug", [
    ("ALWAYS_SEARCH_USER_PATHS", "NO"), ("CLANG_ENABLE_MODULES", "YES"), ("COPY_PHASE_STRIP", "NO"),
    ("DEBUG_INFORMATION_FORMAT", "dwarf"), ("ENABLE_TESTABILITY", "YES"), ("GCC_C_LANGUAGE_STANDARD", "gnu17"),
    ("GCC_OPTIMIZATION_LEVEL", "0"), ("ONLY_ACTIVE_ARCH", "YES"), ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", "DEBUG"),
    ("SWIFT_OPTIMIZATION_LEVEL", q("-Onone"))])
settings("600000000000000000000002", "Release", [
    ("ALWAYS_SEARCH_USER_PATHS", "NO"), ("CLANG_ENABLE_MODULES", "YES"), ("COPY_PHASE_STRIP", "NO"),
    ("DEBUG_INFORMATION_FORMAT", q("dwarf-with-dsym")), ("ENABLE_NS_ASSERTIONS", "NO"),
    ("GCC_C_LANGUAGE_STANDARD", "gnu17"), ("SWIFT_COMPILATION_MODE", "wholemodule"),
    ("SWIFT_OPTIMIZATION_LEVEL", q("-O")), ("VALIDATE_PRODUCT", "YES")])
core_settings = [
    ("CODE_SIGN_STYLE", "Automatic"), ("CURRENT_PROJECT_VERSION", "1"), ("DEFINES_MODULE", "YES"),
    ("DYLIB_INSTALL_NAME_BASE", q("@rpath")), ("INSTALL_PATH", q("$(LOCAL_LIBRARY_DIR)/Frameworks")),
    ("LD_RUNPATH_SEARCH_PATHS", q("$(inherited) @executable_path/Frameworks @loader_path/Frameworks")),
    ("GENERATE_INFOPLIST_FILE", "YES"), ("IPHONEOS_DEPLOYMENT_TARGET", "17.0"), ("MACOSX_DEPLOYMENT_TARGET", "14.0"),
    ("MARKETING_VERSION", VERSION), ("PRODUCT_BUNDLE_IDENTIFIER", "com.nathanhanapps.styleport.core"),
    ("PRODUCT_NAME", q("$(TARGET_NAME)")), ("SKIP_INSTALL", "YES"),
    ("SUPPORTED_PLATFORMS", q("iphoneos iphonesimulator macosx")), ("SWIFT_VERSION", "5.0"),
    ("TARGETED_DEVICE_FAMILY", q("1,2"))]
settings("600000000000000000000003", "Debug", core_settings)
settings("600000000000000000000004", "Release", core_settings)
app_settings = [
    ("ASSETCATALOG_COMPILER_APPICON_NAME", "AppIcon"),
    ("ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME", "AccentColor"),
    ("CODE_SIGN_STYLE", "Automatic"),
    ("CURRENT_PROJECT_VERSION", "1"),
    ("GENERATE_INFOPLIST_FILE", "YES"),
    ("INFOPLIST_FILE", "Sources/StylePortApp/Info.plist"),
    ("INFOPLIST_KEY_CFBundleDisplayName", "Shalielie"),
    ("INFOPLIST_KEY_ITSAppUsesNonExemptEncryption", "NO"),
    ("INFOPLIST_KEY_LSSupportsOpeningDocumentsInPlace", "YES"),
    ("INFOPLIST_KEY_LSApplicationCategoryType", q("public.app-category.photography")),
    ("INFOPLIST_KEY_NSPhotoLibraryAddUsageDescription", q("Shalielie saves the styled photos to your library.")),
    ("INFOPLIST_KEY_NSPhotoLibraryUsageDescription",
     q("Shalielie reads the original HEIC and Live Photo video of the photos you style, and replaces them when you ask it to.")),
    ("INFOPLIST_KEY_UIApplicationSceneManifest_Generation", "YES"),
    ("INFOPLIST_KEY_UILaunchScreen_Generation", "YES"),
    ("INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad",
     q("UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight")),
    ("INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone",
     q("UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight")),
    ("IPHONEOS_DEPLOYMENT_TARGET", "17.0"),
    ("LD_RUNPATH_SEARCH_PATHS", q("$(inherited) @executable_path/Frameworks")),
    ("MARKETING_VERSION", VERSION),
    ("PRODUCT_BUNDLE_IDENTIFIER", "com.nathanhanapps.styleport"),
    ("PRODUCT_NAME", q("$(TARGET_NAME)")),
    ("SDKROOT", "iphoneos"),
    ("SUPPORTED_PLATFORMS", q("iphoneos iphonesimulator")),
    ("SUPPORTS_MACCATALYST", "NO"),
    ("SWIFT_VERSION", "5.0"),
    ("TARGETED_DEVICE_FAMILY", q("1,2")),
]
settings("600000000000000000000005", "Debug", app_settings)
settings("600000000000000000000006", "Release", app_settings)
test_settings = [
    ("BUNDLE_LOADER", q("")), ("CODE_SIGN_STYLE", "Automatic"), ("GENERATE_INFOPLIST_FILE", "YES"),
    ("IPHONEOS_DEPLOYMENT_TARGET", "17.0"), ("MACOSX_DEPLOYMENT_TARGET", "14.0"),
    ("PRODUCT_BUNDLE_IDENTIFIER", "com.nathanhanapps.styleport.coretests"), ("PRODUCT_NAME", q("$(TARGET_NAME)")),
    ("SUPPORTED_PLATFORMS", q("iphoneos iphonesimulator macosx")), ("SWIFT_VERSION", "5.0"),
    ("TARGETED_DEVICE_FAMILY", q("1,2")), ("TEST_HOST", q(""))]
settings("600000000000000000000007", "Debug", test_settings)
settings("600000000000000000000008", "Release", test_settings)
w("/* End XCBuildConfiguration section */\n")

w("/* Begin XCConfigurationList section */")
for lid, name, a, b in (
        ("700000000000000000000001", f"PBXProject {Q}StylePort{Q}", "600000000000000000000001", "600000000000000000000002"),
        ("700000000000000000000002", f"PBXNativeTarget {Q}StylePortCore{Q}", "600000000000000000000003", "600000000000000000000004"),
        ("700000000000000000000003", f"PBXNativeTarget {Q}StylePort{Q}", "600000000000000000000005", "600000000000000000000006"),
        ("700000000000000000000004", f"PBXNativeTarget {Q}StylePortCoreTests{Q}", "600000000000000000000007", "600000000000000000000008")):
    w(f"\t\t{lid} /* Build configuration list for {name} */ = {{isa = XCConfigurationList; buildConfigurations = ({a} /* Debug */, {b} /* Release */, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; }};")
w("/* End XCConfigurationList section */")
w("\t};\n\trootObject = 800000000000000000000001 /* Project object */;\n}")
(root / "StylePort.xcodeproj/project.pbxproj").write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
print(len(core), len(app), len(tests))
