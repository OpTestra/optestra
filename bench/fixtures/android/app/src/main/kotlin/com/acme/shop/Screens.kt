package com.acme.shop

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

private const val EXTRA_PROJECT = "project"
private const val CAMERA_REQUEST = 7

/** Where a deep link was headed before the user had to sign in. */
private var pendingLink: Uri? = null

class SignInActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = "Acme Shop"
    column {
      heading(Surface.signInHeading)
      val email = field(Surface.email, Surface.signInEmailId)
      val password = field(Surface.password, Surface.signInPasswordId, password = true)
      lateinit var error: TextView
      button(Surface.signIn, Surface.signInButtonId) {
        error.text = ""
        val address = email.text.toString().trim()
        val secret = password.text.toString()
        if (address.isEmpty() || secret.isEmpty()) {
          error.text = "Enter your email and password."
          return@button
        }
        background({ Api.signIn(address, secret) }) { result ->
          when {
            result is Result.Failed -> error.text = result.message
            Bugs.loginFails -> {
              Api.cookie = null
              error.text = "Something went wrong. Please try again later."
            }
            else -> {
              val link = pendingLink
              pendingLink = null
              val next =
                if (link != null) Intent(Intent.ACTION_VIEW, link, this@SignInActivity, ProjectActivity::class.java)
                else Intent(this@SignInActivity, ProjectsActivity::class.java)
              startActivity(next)
              finish()
            }
          }
        }
      }
      error = label(id = Surface.signInErrorId, color = Color.rgb(176, 0, 32))
    }
  }
}

class ProjectsActivity : Activity() {
  private val items = ArrayList<String>()
  private lateinit var adapter: ArrayAdapter<String>
  private lateinit var status: TextView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = Surface.projects
    adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, items)
    column(scroll = false) {
      heading(Surface.projects)
      val newProject = { startActivity(Intent(this@ProjectsActivity, NewProjectActivity::class.java)) }
      if (!Surface.newProjectBelowList) button(Surface.newProject, Surface.newProjectId, newProject)
      status = label()
      val list = ListView(this@ProjectsActivity)
      list.id = Surface.projectsListId
      list.adapter = adapter
      list.setOnItemClickListener { _, _, position, _ ->
        startActivity(Intent(this@ProjectsActivity, ProjectActivity::class.java).putExtra(EXTRA_PROJECT, items[position]))
      }
      addView(list, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(280)))
      if (Surface.newProjectBelowList) button(Surface.newProject, Surface.newProjectId, newProject)
      button(Surface.refresh, Surface.refreshId) { load() }
      button(Surface.settings, Surface.settingsId) {
        startActivity(Intent(this@ProjectsActivity, SettingsActivity::class.java))
      }
      button(Surface.signOut, Surface.signOutId) { confirmSignOut() }
    }
  }

  override fun onResume() {
    super.onResume()
    load()
  }

  private fun load() {
    background({ Api.projects() }) { result ->
      when (result) {
        is Result.Ok -> {
          // The broken-not-saved build keeps what it only pretended to save until a refresh.
          items.clear()
          items.addAll(result.value)
          items.addAll(Unsaved.names.filter { it !in result.value })
          Unsaved.names.clear()
          adapter.notifyDataSetChanged()
          status.text = if (items.isEmpty()) Surface.noProjects else ""
        }
        is Result.Failed -> status.text = result.message
      }
    }
  }

  private fun confirmSignOut() {
    AlertDialog.Builder(this)
      .setTitle("Sign out of Acme Shop?")
      .setMessage("You'll need your password to sign in again.")
      .setPositiveButton(Surface.signOut) { _, _ ->
        Api.cookie = null
        startActivity(Intent(this, SignInActivity::class.java))
        finish()
      }
      .setNegativeButton("Cancel", null)
      .show()
  }
}

/** Projects the broken-not-saved build claimed to create; shown once, gone after a refresh. */
object Unsaved {
  val names = ArrayList<String>()
}

class NewProjectActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = "New project"
    column {
      heading("New project")
      val name = field(Surface.projectName, Surface.projectNameId)
      lateinit var error: TextView
      val create = {
        val value = name.text.toString().trim()
        error.text = ""
        if (value.isEmpty()) {
          error.text = "Enter a project name."
        } else if (Bugs.projectNotSaved) {
          Unsaved.names.add(value)
          Toast.makeText(this@NewProjectActivity, "Project created", Toast.LENGTH_LONG).show()
          finish()
        } else {
          background({ Api.createProject(value) }) { result ->
            when (result) {
              is Result.Ok -> {
                Toast.makeText(this@NewProjectActivity, "Project created", Toast.LENGTH_LONG).show()
                finish()
              }
              is Result.Failed -> error.text = result.message
            }
          }
        }
      }
      button(Surface.create, Surface.createId, if (Bugs.createDoesNothing) null else create)
      error = label(id = Surface.formErrorId, color = Color.rgb(176, 0, 32))
    }
  }
}

class ProjectActivity : Activity() {
  private lateinit var camera: TextView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val link = intent.data
    val name = link?.pathSegments?.firstOrNull() ?: intent.getStringExtra(EXTRA_PROJECT) ?: ""
    if (Api.cookie == null) {
      // Deep links need a session: sign in first, then come back here.
      pendingLink = link
      startActivity(Intent(this, SignInActivity::class.java))
      finish()
      return
    }
    if (Bugs.projectCrashes) throw IllegalStateException("Project screen failed to load: $name")
    title = name
    column {
      heading(name, Surface.projectTitleId)
      label("Owner: you")
      button(Surface.scanBadge, Surface.scanBadgeId) { scanBadge() }
      camera = label(id = Surface.cameraStatusId)
    }
  }

  private fun scanBadge() {
    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      camera.text = "Camera access allowed"
    } else {
      requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
    }
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != CAMERA_REQUEST) return
    val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
    camera.text = if (granted) "Camera access allowed" else "Camera access denied"
  }
}

class SettingsActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = Surface.settingsHeading
    column {
      heading(Surface.settingsHeading)
      val toggle = Switch(this@SettingsActivity)
      toggle.id = Surface.notificationsId
      toggle.text = Surface.notifications
      toggle.isChecked = true
      addView(toggle)
      // A long page, so reaching the bottom takes a scroll or a swipe.
      for (section in SECTIONS) {
        label(section, color = Color.BLACK)
        label("Manage how Acme Shop handles ${section.lowercase()} on this device.")
      }
      lateinit var status: TextView
      button(Surface.checkUpdates, Surface.checkUpdatesId) {
        status.text = "Checking…"
        background({ Api.checkForUpdates() }) { result ->
          status.text = if (result is Result.Ok) result.value else "Couldn't check for updates."
        }
      }
      status = label(id = Surface.updateStatusId)
      label("Acme Shop for Android 1.0")
    }
  }

  companion object {
    private val SECTIONS =
      listOf("Account", "Privacy", "Storage", "Downloads", "Language", "Accessibility", "Security", "Help")
  }
}
