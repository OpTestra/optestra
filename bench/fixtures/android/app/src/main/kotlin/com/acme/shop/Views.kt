package com.acme.shop

import android.app.Activity
import android.graphics.Color
import android.text.InputType
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

// Plain framework views built in code: no AndroidX, no layouts, so one codebase
// can swap ids and labels per variant (see Surface).

fun Activity.dp(value: Int): Int =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

/** A padded vertical column, scrollable when `scroll`. */
fun Activity.column(scroll: Boolean = true, build: LinearLayout.() -> Unit): LinearLayout {
  val column = LinearLayout(this)
  column.orientation = LinearLayout.VERTICAL
  val pad = intArrayOf(dp(20), dp(16), dp(20), dp(16))
  column.setPadding(pad[0], pad[1], pad[2], pad[3])
  column.build()
  val root: View =
    if (scroll) {
      val scroller = ScrollView(this)
      scroller.addView(column)
      scroller
    } else {
      column
    }
  // Android 15+ draws apps edge to edge: keep the content clear of the system bars.
  root.setOnApplyWindowInsetsListener { view, insets ->
    val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
    val extra = if (view === column) pad else intArrayOf(0, 0, 0, 0)
    view.setPadding(bars.left + extra[0], bars.top + extra[1], bars.right + extra[2], bars.bottom + extra[3])
    insets
  }
  setContentView(root)
  return column
}

fun LinearLayout.heading(text: String, id: Int = View.NO_ID): TextView {
  val view = TextView(context)
  view.id = id
  view.text = text
  view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
  view.isAccessibilityHeading = true
  view.setPadding(0, 0, 0, 24)
  addView(view)
  return view
}

fun LinearLayout.label(text: String = "", id: Int = View.NO_ID, color: Int = Color.DKGRAY): TextView {
  val view = TextView(context)
  view.id = id
  view.text = text
  view.setTextColor(color)
  view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
  view.setPadding(0, 12, 0, 12)
  addView(view)
  return view
}

fun LinearLayout.field(hint: String, id: Int, password: Boolean = false): EditText {
  val view = EditText(context)
  view.id = id
  view.hint = hint
  view.isSingleLine = true
  view.inputType =
    if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
  addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  return view
}

fun LinearLayout.button(text: String, id: Int, onTap: (() -> Unit)?): Button {
  val view = Button(context)
  view.id = id
  view.text = text
  view.isAllCaps = false
  // A button without a listener still looks and reads as tappable (the silent-tap trap).
  view.isClickable = true
  if (onTap != null) view.setOnClickListener { onTap() }
  addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  return view
}
