// Acme Shop for Android: the Bench fixture app (BEN-1). One codebase, one APK per
// variant (product flavors). Built with the system Gradle, no committed wrapper:
// `gradle -p bench/fixtures/android/app assembleDebug` (or `pnpm build:apks`).
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "acme-shop-android"
