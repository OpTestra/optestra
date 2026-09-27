package com.acme.shop

// Every build of the app is this codebase with switches, like the shop website.
// Behaviour switches are in `Bugs`, surface switches (what the cosmetic build
// changes) are in `Surface`, so the whole difference between variants can be
// read in this one file. The flavor name picks the variant.

object Bugs {
  private val flavor = BuildConfig.FLAVOR

  /** Signing in with the right password shows an error. */
  val loginFails = flavor == "brokenLogin"

  /** False-pass trap: "Create project" looks tappable but does nothing. */
  val createDoesNothing = flavor == "brokenSilentTap"

  /** False-pass trap: the toast says "Project created" but nothing is sent; a refresh shows it's gone. */
  val projectNotSaved = flavor == "brokenNotSaved"

  /** Opening a project crashes the app. */
  val projectCrashes = flavor == "brokenCrash"
}

/**
 * Labels and view ids. The cosmetic build rewords what you tap and type into,
 * renames ids and moves a button; what a test checks (headings, messages, list
 * contents) reads the same.
 */
object Surface {
  val cosmetic = BuildConfig.FLAVOR == "cosmetic"

  private fun pick(correct: String, cosmetic: String) = if (this.cosmetic) cosmetic else correct

  private fun id(correct: Int, cosmetic: Int) = if (this.cosmetic) cosmetic else correct

  val signInHeading = "Sign in to Acme Shop"
  val email = pick("Email", "Email address")
  val password = pick("Password", "Your password")
  val signIn = pick("Sign in", "Log in")
  val projects = "Projects"
  val newProject = pick("New project", "Add project")
  val refresh = pick("Refresh", "Reload")
  val settings = pick("Settings", "Preferences")
  val settingsHeading = "Settings"
  val signOut = pick("Sign out", "Log out")
  val noProjects = "No projects yet"
  val projectName = pick("Project name", "Name")
  val create = pick("Create project", "Create")
  val scanBadge = pick("Scan badge", "Scan a badge")
  val notifications = pick("Email notifications", "Email alerts")
  val checkUpdates = pick("Check for updates", "Look for updates")

  /** Cosmetic: the "New project" button sits below the list instead of above it. */
  val newProjectBelowList = cosmetic

  val signInEmailId = id(R.id.sign_in_email, R.id.login_email)
  val signInPasswordId = id(R.id.sign_in_password, R.id.login_pass)
  val signInButtonId = id(R.id.sign_in_button, R.id.login_submit)
  val signInErrorId = id(R.id.sign_in_error, R.id.login_alert)
  val projectsListId = id(R.id.projects_list, R.id.project_items)
  val newProjectId = id(R.id.new_project_button, R.id.add_project)
  val refreshId = id(R.id.refresh_button, R.id.reload_items)
  val settingsId = id(R.id.settings_button, R.id.prefs_link)
  val signOutId = id(R.id.sign_out_button, R.id.logout_link)
  val projectNameId = id(R.id.project_name, R.id.name_input)
  val createId = id(R.id.create_project_button, R.id.save_project)
  val formErrorId = id(R.id.form_error, R.id.name_error)
  val projectTitleId = id(R.id.project_title, R.id.detail_heading)
  val scanBadgeId = id(R.id.scan_badge_button, R.id.badge_scan)
  val cameraStatusId = id(R.id.camera_status, R.id.camera_result)
  val notificationsId = id(R.id.notifications_switch, R.id.email_alerts_toggle)
  val checkUpdatesId = id(R.id.check_updates_button, R.id.updates_check)
  val updateStatusId = id(R.id.update_status, R.id.updates_result)
}
