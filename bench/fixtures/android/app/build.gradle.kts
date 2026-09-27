plugins {
  id("com.android.application") version "9.4.1"
}

// The shop server the app talks to: the host's loopback through the emulator's
// host alias. Its port is fixed so the APKs need no configuration.
val shopUrl = "http://10.0.2.2:4180"

android {
  namespace = "com.acme.shop"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.acme.shop"
    minSdk = 30
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"
    buildConfigField("String", "SHOP_URL", "\"$shopUrl\"")
  }

  buildFeatures { buildConfig = true }

  // Variant names match manifest.yaml (camelCase here: flavor names can't hold "-").
  flavorDimensions += "variant"
  productFlavors {
    create("correct") { dimension = "variant" }
    create("cosmetic") { dimension = "variant" }
    create("brokenLogin") { dimension = "variant" }
    create("brokenSilentTap") { dimension = "variant" }
    create("brokenNotSaved") { dimension = "variant" }
    create("brokenCrash") { dimension = "variant" }
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
