// The on-device driver: an instrumentation APK with no dependencies beyond the
// Android framework and the Kotlin standard library. Built with the system Gradle
// (no committed wrapper jar): `gradle -p packages/android/driver assembleDebug`.
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

rootProject.name = "android-driver"
