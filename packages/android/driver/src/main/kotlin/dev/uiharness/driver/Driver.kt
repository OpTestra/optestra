package dev.uiharness.driver

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle

/**
 * The on-device half of the Android harness. Started by the host with
 * `am instrument -w -e token <t> -e socket <name> dev.uiharness.driver/.Driver`.
 *
 * It serves one line-delimited JSON protocol on a local abstract socket, which
 * the host reaches only through `adb forward`. The first message on every
 * connection must carry the session token. The command set is closed (see
 * Server.handle): read the UI hierarchy, inject touches and keys, set text,
 * take screenshots, rotate, open a link or the app under test. There is no
 * shell command, file access or network call a client can ask for.
 */
class Driver : Instrumentation() {
  private var token = ""
  private var socketName = "uiharness-driver"

  override fun onCreate(arguments: Bundle?) {
    super.onCreate(arguments)
    token = arguments?.getString("token") ?: ""
    socketName = arguments?.getString("socket") ?: socketName
    start()
  }

  override fun onStart() {
    val result = Bundle()
    try {
      Server(this, token, socketName).run()
      result.putString("stopped", "quit")
    } catch (error: Throwable) {
      result.putString("stopped", "error: $error")
    }
    finish(Activity.RESULT_OK, result)
  }
}
