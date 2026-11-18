plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.attendance"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.anjali0956.attendance"   // must match PACKAGE_NAME on the server
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1"

        buildConfigField("String", "SERVER_URL", "\"https://139.59.6.181.sslip.io\"")
        buildConfigField("long", "CLOUD_PROJECT_NUMBER", "0L") // Google Cloud project number linked in Play Console
    }

    signingConfigs {
        create("release") {
            // The GitHub Actions workflow supplies these from the repository's secrets.
            storeFile = System.getenv("SIGNING_KEYSTORE")?.let { file(it) }
            storePassword = System.getenv("SIGNING_PASSWORD")
            keyAlias = "upload"
            keyPassword = System.getenv("SIGNING_PASSWORD")
        }
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("com.google.android.play:integrity:1.4.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    testImplementation("junit:junit:4.13.2")
}
