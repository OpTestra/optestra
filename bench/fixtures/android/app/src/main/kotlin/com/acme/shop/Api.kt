package com.acme.shop

import android.app.Activity
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONObject

// The shop's own API (bench/fixtures/shop), reached through the emulator's host
// alias. The session cookie lives in memory: every install starts signed out.

sealed class Result<out T> {
  data class Ok<T>(val value: T) : Result<T>()

  data class Failed(val message: String) : Result<Nothing>()
}

object Api {
  @Volatile var cookie: String? = null

  const val UNREACHABLE = "Can't reach Acme Shop. Check your connection."

  private fun open(path: String, method: String): HttpURLConnection {
    val connection = URL(BuildConfig.SHOP_URL + path).openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 5000
    connection.readTimeout = 5000
    cookie?.let { connection.setRequestProperty("Cookie", it) }
    return connection
  }

  private fun body(connection: HttpURLConnection): String {
    val stream = if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
    return stream?.bufferedReader()?.use { it.readText() } ?: ""
  }

  fun signIn(email: String, password: String): Result<Unit> =
    call {
      val connection = open("/login", "POST")
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
      val form =
        "email=" + URLEncoder.encode(email, "UTF-8") +
          "&password=" + URLEncoder.encode(password, "UTF-8") + "&next=%2Fdashboard"
      connection.outputStream.use { it.write(form.toByteArray()) }
      val status = connection.responseCode
      val setCookie = connection.getHeaderField("Set-Cookie")
      val location = connection.getHeaderField("Location") ?: ""
      connection.disconnect()
      when {
        status == 401 -> Result.Failed("Email or password is incorrect.")
        status in 300..399 && setCookie != null && location.startsWith("/dashboard") -> {
          cookie = setCookie.substringBefore(";")
          Result.Ok(Unit)
        }
        else -> Result.Failed("Something went wrong. Please try again later.")
      }
    }

  fun projects(): Result<List<String>> =
    call {
      val connection = open("/api/projects", "GET")
      val status = connection.responseCode
      val text = body(connection)
      connection.disconnect()
      if (status != 200) return@call Result.Failed("Couldn't load projects.")
      val list = JSONObject(text).getJSONArray("projects")
      Result.Ok((0 until list.length()).map { list.getJSONObject(it).getString("name") })
    }

  fun createProject(name: String): Result<Unit> =
    call {
      val connection = open("/api/projects", "POST")
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.outputStream.use { it.write(JSONObject().put("name", name).toString().toByteArray()) }
      val status = connection.responseCode
      val text = body(connection)
      connection.disconnect()
      if (status == 201) Result.Ok(Unit)
      else Result.Failed(runCatching { JSONObject(text).getString("error") }.getOrDefault("Couldn't create the project."))
    }

  /** A third-party host outside the allowed domains: the harness refuses it. */
  fun checkForUpdates(): Result<String> =
    call {
      val connection = URL("https://203.0.113.7/acme-shop/latest.json").openConnection() as HttpURLConnection
      connection.connectTimeout = 4000
      connection.readTimeout = 4000
      val status = connection.responseCode
      connection.disconnect()
      if (status == 200) Result.Ok("You're up to date.") else Result.Failed("Couldn't check for updates.")
    }

  private fun <T> call(block: () -> Result<T>): Result<T> =
    try {
      block()
    } catch (error: java.io.IOException) {
      Result.Failed(UNREACHABLE)
    }
}

/** Runs `work` off the main thread and hands its result back on it. */
fun <T> Activity.background(work: () -> T, done: (T) -> Unit) {
  Thread {
      val result = work()
      runOnUiThread { if (!isFinishing && !isDestroyed) done(result) }
    }
    .start()
}
