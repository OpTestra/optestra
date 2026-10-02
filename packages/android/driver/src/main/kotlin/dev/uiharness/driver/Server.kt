package dev.uiharness.driver

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.app.UiAutomation
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.view.Display
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import org.json.JSONArray
import org.json.JSONObject

private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
private val URI = Regex("^[A-Za-z][A-Za-z0-9+.-]*:[^\\s'\"`]+$")
private val COMPONENT = Regex("^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$")
private const val MAX_NODES = 4000
private const val MAX_DEPTH = 80
private const val ACTIVITY_SETTLE_MS = 2_000L

/** Thrown for a bad request; answered as `{ ok: false, error }`, never fatal. */
private class BadRequest(message: String) : Exception(message)

class Server(
  private val instrumentation: Instrumentation,
  private val token: String,
  private val socketName: String,
) {
  private val ua: UiAutomation =
    instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)

  @Volatile private var lastEventAt = SystemClock.uptimeMillis()
  @Volatile private var windowStateChanges = 0
  @Volatile private var lastWindowStateChangeAt = 0L
  private val toasts = mutableListOf<JSONObject>()
  /** The class of each window's latest state change: an Activity, or a dialog class. */
  private val windowClasses = java.util.concurrent.ConcurrentHashMap<Int, String>()
  private var nodes: List<AccessibilityNodeInfo> = emptyList()
  private var activityCheckedAt = -1
  private var activity: String? = null

  init {
    val info = ua.serviceInfo
    info.flags =
      info.flags or
        AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
        AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
        AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
    ua.serviceInfo = info
    ua.setOnAccessibilityEventListener { event -> onEvent(event) }
  }

  private fun onEvent(event: AccessibilityEvent) {
    when (event.eventType) {
      AccessibilityEvent.TYPE_VIEW_HOVER_ENTER,
      AccessibilityEvent.TYPE_VIEW_HOVER_EXIT,
      AccessibilityEvent.TYPE_TOUCH_INTERACTION_START,
      AccessibilityEvent.TYPE_TOUCH_INTERACTION_END,
      AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_START,
      AccessibilityEvent.TYPE_TOUCH_EXPLORATION_GESTURE_END,
      AccessibilityEvent.TYPE_GESTURE_DETECTION_START,
      AccessibilityEvent.TYPE_GESTURE_DETECTION_END,
      AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED,
      AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED -> return
      AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED -> {
        val cls = event.className?.toString() ?: ""
        val text = event.text.joinToString(" ") { it.toString() }
        synchronized(toasts) {
          toasts.add(
            JSONObject()
              .put("text", text)
              .put("package", event.packageName?.toString() ?: "")
              .put("cls", cls)
              .put("toast", cls.contains("Toast"))
          )
        }
      }
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
        windowStateChanges++
        lastWindowStateChangeAt = SystemClock.uptimeMillis()
        val cls = event.className?.toString()
        if (cls != null && event.windowId >= 0) windowClasses[event.windowId] = cls
      }
    }
    lastEventAt = SystemClock.uptimeMillis()
  }

  fun run() {
    val server = LocalServerSocket(socketName)
    try {
      while (true) {
        val socket = server.accept()
        val quit = socket.use { serve(it) }
        if (quit) return
      }
    } finally {
      server.close()
    }
  }

  /** Serves one connection. Returns true when the client asked the driver to stop. */
  private fun serve(socket: LocalSocket): Boolean {
    val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
    val writer = OutputStreamWriter(socket.outputStream, Charsets.UTF_8)
    var authenticated = false
    while (true) {
      val line = reader.readLine() ?: return false
      val request =
        try {
          JSONObject(line)
        } catch (error: Exception) {
          return false
        }
      val id = request.optInt("id", 0)
      val cmd = request.optString("cmd")
      if (!authenticated) {
        if (cmd != "hello" || token.isEmpty() || request.optString("token") != token) {
          reply(writer, JSONObject().put("id", id).put("ok", false).put("error", "unauthorized"))
          return false
        }
        authenticated = true
      }
      if (cmd == "quit") {
        reply(writer, JSONObject().put("id", id).put("ok", true))
        return true
      }
      val response =
        try {
          handle(cmd, request).put("ok", true)
        } catch (error: BadRequest) {
          JSONObject().put("ok", false).put("error", error.message)
        } catch (error: Throwable) {
          JSONObject().put("ok", false).put("error", "driver: ${error.javaClass.simpleName}: ${error.message}")
        }
      reply(writer, response.put("id", id))
    }
  }

  private fun reply(writer: OutputStreamWriter, response: JSONObject) {
    writer.write(response.toString())
    writer.write("\n")
    writer.flush()
  }

  // ── The closed command set ────────────────────────────────────────────────

  private fun handle(cmd: String, r: JSONObject): JSONObject =
    when (cmd) {
      "hello" -> hello()
      "dump" -> dump()
      "tap" -> tap(r)
      "long_press" -> longPress(r)
      "swipe" -> swipe(r)
      "set_text" -> setText(r)
      "scroll" -> scroll(r)
      "key" -> key(r)
      "global" -> global(r)
      "rotate" -> rotate(r)
      "idle" -> idle(r)
      "events" -> events()
      "screenshot" -> screenshot(r)
      "open_uri" -> openUri(r)
      "launch" -> launch(r)
      "app_state" -> appState(r)
      "label" -> label(r)
      else -> throw BadRequest("unknown command")
    }

  private fun hello(): JSONObject {
    val metrics = instrumentation.context.resources.displayMetrics
    return JSONObject()
      .put("sdk", Build.VERSION.SDK_INT)
      .put("release", Build.VERSION.RELEASE)
      .put("model", Build.MODEL)
      .put("width", metrics.widthPixels)
      .put("height", metrics.heightPixels)
      .put("density", metrics.densityDpi)
  }

  // ── Hierarchy ─────────────────────────────────────────────────────────────

  private fun dump(): JSONObject {
    val windows = JSONArray()
    val out = JSONArray()
    val kept = ArrayList<AccessibilityNodeInfo>()
    val index = HashMap<AccessibilityNodeInfo, Int>()
    val labels = ArrayList<Pair<Int, AccessibilityNodeInfo>>()
    var truncated = false
    val all = ua.windows.sortedByDescending { it.layer }
    for ((w, window) in all.withIndex()) {
      val bounds = Rect()
      window.getBoundsInScreen(bounds)
      val root = window.root
      windows.put(
        JSONObject()
          .put("id", w)
          .put("type", windowType(window.type))
          .put("layer", window.layer)
          .put("active", window.isActive)
          .put("focused", window.isFocused)
          .put("title", window.title?.toString() ?: JSONObject.NULL)
          .put("package", root?.packageName?.toString() ?: JSONObject.NULL)
          .put("cls", windowClasses[window.id] ?: JSONObject.NULL)
          .put("bounds", rect(bounds))
      )
      if (root == null) continue
      // Depth-first, keeping document order.
      val stack = ArrayDeque<Triple<AccessibilityNodeInfo, Int, Int>>()
      stack.addLast(Triple(root, -1, 0))
      while (stack.isNotEmpty()) {
        val (node, parent, depth) = stack.removeLast()
        if (kept.size >= MAX_NODES) {
          truncated = true
          break
        }
        val id = kept.size
        kept.add(node)
        index[node] = id
        out.put(describe(node, id, parent, w, depth))
        node.labeledBy?.let { labels.add(id to it) }
        if (depth >= MAX_DEPTH) continue
        for (i in node.childCount - 1 downTo 0) {
          val child = node.getChild(i) ?: continue
          stack.addLast(Triple(child, id, depth + 1))
        }
      }
    }
    for ((id, label) in labels) {
      val target = index[label] ?: continue
      out.getJSONObject(id).put("labeledBy", target)
    }
    nodes = kept
    return JSONObject()
      .put("windows", windows)
      .put("nodes", out)
      .put("truncated", truncated)
      .put("activity", currentActivity() ?: JSONObject.NULL)
      .put("rotation", rotation())
  }

  private fun rotation(): Int {
    val displays = instrumentation.context.getSystemService(DisplayManager::class.java)
    return when (displays?.getDisplay(Display.DEFAULT_DISPLAY)?.rotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
  }

  private fun describe(n: AccessibilityNodeInfo, id: Int, parent: Int, window: Int, depth: Int): JSONObject {
    val bounds = Rect()
    n.getBoundsInScreen(bounds)
    val o =
      JSONObject()
        .put("id", id)
        .put("parent", parent)
        .put("window", window)
        .put("depth", depth)
        .put("cls", n.className?.toString() ?: "")
        .put("pkg", n.packageName?.toString() ?: "")
        .put("bounds", rect(bounds))
    n.viewIdResourceName?.let { o.put("rid", it) }
    n.text?.let { o.put("text", it.toString()) }
    n.contentDescription?.let { o.put("desc", it.toString()) }
    n.hintText?.let { o.put("hint", it.toString()) }
    n.error?.let { o.put("error", it.toString()) }
    n.paneTitle?.let { o.put("pane", it.toString()) }
    n.tooltipText?.let { o.put("tooltip", it.toString()) }
    n.stateDescription?.let { o.put("stateDesc", it.toString()) }
    val flags = JSONArray()
    if (n.isClickable) flags.put("clickable")
    if (n.isLongClickable) flags.put("longClickable")
    if (n.isCheckable) flags.put("checkable")
    if (n.isChecked) flags.put("checked")
    if (n.isEnabled) flags.put("enabled")
    if (n.isFocusable) flags.put("focusable")
    if (n.isFocused) flags.put("focused")
    if (n.isScrollable) flags.put("scrollable")
    if (n.isSelected) flags.put("selected")
    if (n.isPassword) flags.put("password")
    if (n.isEditable) flags.put("editable")
    if (n.isVisibleToUser) flags.put("visible")
    if (n.isHeading) flags.put("heading")
    if (n.isShowingHintText) flags.put("showingHint")
    if (n.isMultiLine) flags.put("multiLine")
    o.put("flags", flags)
    if (n.inputType != 0) o.put("inputType", n.inputType)
    n.rangeInfo?.let {
      o.put("range", JSONObject().put("type", it.type).put("min", it.min.toDouble()).put("max", it.max.toDouble()).put("current", it.current.toDouble()))
    }
    n.collectionInfo?.let { o.put("collection", JSONObject().put("rows", it.rowCount).put("cols", it.columnCount)) }
    n.collectionItemInfo?.let { o.put("item", JSONObject().put("row", it.rowIndex).put("col", it.columnIndex)) }
    val actions = JSONArray()
    for (action in n.actionList) {
      when (action.id) {
        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> actions.put("scrollForward")
        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> actions.put("scrollBackward")
        AccessibilityNodeInfo.ACTION_SET_TEXT -> actions.put("setText")
        AccessibilityNodeInfo.ACTION_DISMISS -> actions.put("dismiss")
      }
    }
    if (actions.length() > 0) o.put("actions", actions)
    return o
  }

  private fun windowType(type: Int): String =
    when (type) {
      AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
      AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "input_method"
      AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
      AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "accessibility_overlay"
      AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "divider"
      else -> "other"
    }

  private fun rect(r: Rect): JSONArray = JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom)

  /**
   * The resumed activity, re-read after a window state change, and for a while
   * after it: on a slow device the event can come before the activity manager
   * has the new activity resumed, and a stale name would stick (MOB-3).
   */
  private fun currentActivity(): String? {
    val settled = SystemClock.uptimeMillis() - lastWindowStateChangeAt > ACTIVITY_SETTLE_MS
    if (activityCheckedAt == windowStateChanges && activity != null && settled) return activity
    activityCheckedAt = windowStateChanges
    val text = shell("dumpsys activity activities")
    val match =
      Regex("(?:topResumedActivity|mResumedActivity|ResumedActivity)[=:]\\s*ActivityRecord\\{\\S+ \\S+ (\\S+)")
        .find(text)
    activity = match?.groupValues?.get(1)
    return activity
  }

  /** Runs one of the driver's own fixed commands; never a client-provided string. */
  private fun shell(command: String): String {
    val fd = ua.executeShellCommand(command)
    ParcelFileDescriptor.AutoCloseInputStream(fd).use { return it.readBytes().toString(Charsets.UTF_8) }
  }

  private fun node(r: JSONObject): AccessibilityNodeInfo {
    val id = r.optInt("node", -1)
    val node = nodes.getOrNull(id) ?: throw BadRequest("stale_node")
    if (!node.refresh()) throw BadRequest("stale_node")
    return node
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private fun touch(action: Int, x: Float, y: Float, downTime: Long, eventTime: Long): Boolean {
    val event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0)
    event.source = InputDevice.SOURCE_TOUCHSCREEN
    val ok = ua.injectInputEvent(event, true)
    event.recycle()
    return ok
  }

  private fun point(r: JSONObject, key: String): Float {
    if (!r.has(key)) throw BadRequest("missing $key")
    return r.getDouble(key).toFloat()
  }

  private fun tap(r: JSONObject): JSONObject {
    val x = point(r, "x")
    val y = point(r, "y")
    val down = SystemClock.uptimeMillis()
    val ok = touch(MotionEvent.ACTION_DOWN, x, y, down, down) && touch(MotionEvent.ACTION_UP, x, y, down, down + 60)
    return JSONObject().put("injected", ok)
  }

  private fun longPress(r: JSONObject): JSONObject {
    val x = point(r, "x")
    val y = point(r, "y")
    val ms = r.optLong("ms", 900).coerceIn(500, 5000)
    val down = SystemClock.uptimeMillis()
    var ok = touch(MotionEvent.ACTION_DOWN, x, y, down, down)
    var t = 0L
    while (ok && t < ms) {
      SystemClock.sleep(100)
      t += 100
      ok = touch(MotionEvent.ACTION_MOVE, x, y, down, down + t)
    }
    ok = touch(MotionEvent.ACTION_UP, x, y, down, down + ms) && ok
    return JSONObject().put("injected", ok)
  }

  private fun swipe(r: JSONObject): JSONObject {
    val x1 = point(r, "x1")
    val y1 = point(r, "y1")
    val x2 = point(r, "x2")
    val y2 = point(r, "y2")
    val ms = r.optLong("ms", 300).coerceIn(50, 5000)
    val steps = (ms / 16).toInt().coerceAtLeast(4)
    val down = SystemClock.uptimeMillis()
    var ok = touch(MotionEvent.ACTION_DOWN, x1, y1, down, down)
    for (i in 1..steps) {
      val f = i.toFloat() / steps
      val at = down + ms * i / steps
      SystemClock.sleep(ms / steps)
      ok = touch(MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, down, at) && ok
    }
    ok = touch(MotionEvent.ACTION_UP, x2, y2, down, down + ms + 10) && ok
    return JSONObject().put("injected", ok)
  }

  private fun setText(r: JSONObject): JSONObject {
    val node = node(r)
    val text = r.optString("text", "")
    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val args = Bundle()
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    if (ok && text.isNotEmpty()) {
      val end = Bundle()
      end.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, text.length)
      end.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, text.length)
      node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, end)
    }
    return JSONObject().put("done", ok)
  }

  private fun scroll(r: JSONObject): JSONObject {
    val node = node(r)
    val action =
      when (r.optString("direction")) {
        "forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        "backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        else -> throw BadRequest("direction must be forward or backward")
      }
    return JSONObject().put("done", node.performAction(action))
  }

  private fun key(r: JSONObject): JSONObject {
    val code = r.optInt("code", -1)
    if (code <= 0 || code > KeyEvent.getMaxKeyCode()) throw BadRequest("bad key code")
    val down = SystemClock.uptimeMillis()
    val ok =
      ua.injectInputEvent(KeyEvent(down, down, KeyEvent.ACTION_DOWN, code, 0), true) &&
        ua.injectInputEvent(KeyEvent(down, down + 20, KeyEvent.ACTION_UP, code, 0), true)
    return JSONObject().put("injected", ok)
  }

  private fun global(r: JSONObject): JSONObject {
    val action =
      when (r.optString("action")) {
        "back" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK
        "home" -> android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME
        else -> throw BadRequest("unknown global action")
      }
    return JSONObject().put("done", ua.performGlobalAction(action))
  }

  private fun rotate(r: JSONObject): JSONObject {
    val rotation =
      when (r.optInt("degrees", -1)) {
        0 -> UiAutomation.ROTATION_FREEZE_0
        90 -> UiAutomation.ROTATION_FREEZE_90
        180 -> UiAutomation.ROTATION_FREEZE_180
        270 -> UiAutomation.ROTATION_FREEZE_270
        else -> throw BadRequest("degrees must be 0, 90, 180 or 270")
      }
    return JSONObject().put("done", ua.setRotation(rotation))
  }

  /**
   * Waits until no accessibility event has arrived for quietMs, or timeoutMs is up.
   * The quiet time counts from the later of the last event and this call, so a
   * reaction that hasn't started yet (right after a tap) still gets quietMs to show.
   */
  private fun idle(r: JSONObject): JSONObject {
    val quiet = r.optLong("quietMs", 300).coerceIn(50, 5000)
    val timeout = r.optLong("timeoutMs", 10_000).coerceIn(0, 60_000)
    val start = SystemClock.uptimeMillis()
    while (true) {
      val now = SystemClock.uptimeMillis()
      val sinceEvent = now - maxOf(lastEventAt, start)
      if (sinceEvent >= quiet) {
        return JSONObject().put("idle", true).put("waitedMs", now - start)
      }
      if (now - start >= timeout) {
        return JSONObject().put("idle", false).put("waitedMs", now - start)
      }
      SystemClock.sleep(minOf(quiet - sinceEvent, 50L).coerceAtLeast(10L))
    }
  }

  /** Toasts since the previous call, and how many window changes there were in total. */
  private fun events(): JSONObject {
    val list = JSONArray()
    synchronized(toasts) {
      toasts.forEach { list.put(it) }
      toasts.clear()
    }
    return JSONObject()
      .put("toasts", list)
      .put("windowStateChanges", windowStateChanges)
      .put("msSinceEvent", SystemClock.uptimeMillis() - lastEventAt)
  }

  private fun screenshot(r: JSONObject): JSONObject {
    val full = ua.takeScreenshot() ?: throw BadRequest("screenshot_failed")
    val crop = r.optJSONArray("crop")
    val bitmap =
      if (crop != null && crop.length() == 4) {
        val left = crop.getInt(0).coerceIn(0, full.width - 1)
        val top = crop.getInt(1).coerceIn(0, full.height - 1)
        val right = crop.getInt(2).coerceIn(left + 1, full.width)
        val bottom = crop.getInt(3).coerceIn(top + 1, full.height)
        Bitmap.createBitmap(full, left, top, right - left, bottom - top)
      } else {
        full
      }
    val maxWidth = r.optInt("maxWidth", 0)
    val scaled =
      if (maxWidth in 1 until bitmap.width) {
        val height = (bitmap.height.toLong() * maxWidth / bitmap.width).toInt()
        Bitmap.createScaledBitmap(bitmap, maxWidth, height, true)
      } else {
        bitmap
      }
    val jpeg = r.optString("format") == "jpeg"
    val bytes = ByteArrayOutputStream()
    scaled.compress(
      if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG,
      if (jpeg) r.optInt("quality", 80).coerceIn(30, 95) else 100,
      bytes,
    )
    return JSONObject()
      .put("width", scaled.width)
      .put("height", scaled.height)
      .put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
  }

  private fun packageArg(r: JSONObject): String {
    val pkg = r.optString("package")
    if (!PACKAGE.matches(pkg)) throw BadRequest("bad package name")
    return pkg
  }

  /**
   * Opens a link in the app under test only (the intent is pinned to its package).
   * Activities start through `am start`, which runs with the shell's right to start
   * them from the background; the arguments are tokens the driver checked, and
   * executeShellCommand splits on whitespace without a shell.
   */
  private fun openUri(r: JSONObject): JSONObject {
    val pkg = packageArg(r)
    val uri = r.optString("uri")
    if (!URI.matches(uri)) throw BadRequest("bad uri")
    return started(shell("am start -W -a android.intent.action.VIEW -d $uri -p $pkg"))
  }

  private fun launch(r: JSONObject): JSONObject {
    val pkg = packageArg(r)
    val intent =
      instrumentation.context.packageManager.getLaunchIntentForPackage(pkg)
        ?: return JSONObject().put("started", false).put("reason", "no_launcher_activity")
    val component = intent.component?.flattenToShortString() ?: throw BadRequest("no component")
    if (!COMPONENT.matches(component)) throw BadRequest("bad component")
    // No -W: on a slow machine `am start -W` can block for minutes behind other work.
    // The caller waits for the app's window itself (and clears system dialogs meanwhile).
    return started(shell("am start -n $component"))
  }

  private fun started(output: String): JSONObject {
    val failed = output.contains("Error") || output.contains("does not exist") || output.contains("unable to resolve")
    // What `am start` said, so a failure names its cause (the last lines are enough).
    return if (failed) JSONObject().put("started", false).put("reason", "no_activity").put("output", output.takeLast(500))
    else JSONObject().put("started", true)
  }

  /** The app's label as the system shows it (e.g. in "<label> isn't responding"). */
  private fun label(r: JSONObject): JSONObject {
    val pkg = packageArg(r)
    val pm = instrumentation.context.packageManager
    val info = pm.getApplicationInfo(pkg, 0)
    return JSONObject().put("label", pm.getApplicationLabel(info).toString())
  }

  private fun appState(r: JSONObject): JSONObject {
    val pkg = packageArg(r)
    val pid = shell("pidof $pkg").trim()
    return JSONObject().put("running", pid.isNotEmpty()).put("pid", pid)
  }
}
