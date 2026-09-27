plugins {
  id("com.android.application") version "9.4.1"
}

android {
  namespace = "dev.uiharness.driver"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.uiharness.driver"
    minSdk = 30
    targetSdk = 36
    versionCode = 1
    versionName = "1"
  }

  buildTypes {
    debug { isMinifyEnabled = false }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
