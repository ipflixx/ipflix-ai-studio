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

    flavorDimensions += "channel"
    productFlavors {
        create("phone") {
            dimension = "channel"
            buildConfigField("String", "DISTRIBUTION_CHANNEL", "\"android_apk\"")
            buildConfigField("boolean", "ALLOW_EXTERNAL_APK_INSTALL", "true")
        }
        create("tv") {
            dimension = "channel"
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
            buildConfigField("String", "DISTRIBUTION_CHANNEL", "\"android_tv_play\"")
            buildConfigField("boolean", "ALLOW_EXTERNAL_APK_INSTALL", "false")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
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
