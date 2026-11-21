plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ipflix.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ipflix.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 10000
        versionName = "1.0.0"
    }

    buildFeatures {
        buildConfig = true
    }

    val keystorePath = (project.findProperty("IPFLIX_KEYSTORE_PATH") as String?)
        ?: System.getenv("IPFLIX_KEYSTORE_PATH")
        ?: ""
    val keystorePassword = (project.findProperty("IPFLIX_KEYSTORE_PASSWORD") as String?)
        ?: System.getenv("IPFLIX_KEYSTORE_PASSWORD")
        ?: ""
    val keyAliasName = (project.findProperty("IPFLIX_KEY_ALIAS") as String?)
        ?: System.getenv("IPFLIX_KEY_ALIAS")
        ?: ""
    val keyPasswordValue = (project.findProperty("IPFLIX_KEY_PASSWORD") as String?)
        ?: System.getenv("IPFLIX_KEY_PASSWORD")
        ?: ""
    val requireSigning = ((project.findProperty("IPFLIX_REQUIRE_SIGNING") as String?)
        ?: System.getenv("IPFLIX_REQUIRE_SIGNING")
        ?: "false").equals("true", ignoreCase = true)

    val hasReleaseSigning = keystorePath.isNotBlank() &&
        file(keystorePath).exists() &&
        keystorePassword.isNotBlank() &&
        keyAliasName.isNotBlank() &&
        keyPasswordValue.isNotBlank()

    if (requireSigning && !hasReleaseSigning) {
        throw GradleException(
            "Release imzalama gerekli ancak IPFLIX_KEYSTORE_PATH / IPFLIX_KEYSTORE_PASSWORD / IPFLIX_KEY_ALIAS / IPFLIX_KEY_PASSWORD eksik."
        )
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = keystorePassword
                keyAlias = keyAliasName
                keyPassword = keyPasswordValue
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    flavorDimensions += "channel"
    productFlavors {
        create("phone") {
            dimension = "channel"
            buildConfigField("String", "DISTRIBUTION_CHANNEL", "\"android_apk\"")
            buildConfigField("boolean", "ALLOW_EXTERNAL_APK_INSTALL", "true")
        }
        create("tv") {
            dimension = "channel"
            applicationIdSuffix = ".tv"
            buildConfigField("String", "DISTRIBUTION_CHANNEL", "\"android_tv_apk\"")
            buildConfigField("boolean", "ALLOW_EXTERNAL_APK_INSTALL", "true")
        }
        create("playPhone") {
            dimension = "channel"
            buildConfigField("String", "DISTRIBUTION_CHANNEL", "\"google_play\"")
            buildConfigField("boolean", "ALLOW_EXTERNAL_APK_INSTALL", "false")
        }
        create("playTv") {
            dimension = "channel"
            applicationIdSuffix = ".tv"
            buildConfigField("String", "DISTRIBUTION_CHANNEL", "\"android_tv_play\"")
            buildConfigField("boolean", "ALLOW_EXTERNAL_APK_INSTALL", "false")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.google.android.play:app-update:2.1.0")
}
