#pragma once
#include <stdbool.h>

typedef struct {
  const char *pane_title;
  const char *instruction_prefix;
  const char *instruction_middle;
  const char *instruction_suffix;
  const char *drag_label;
  const char *reopen_url;
  const char *app_path;
  double source_x;
  double source_y;
  double source_w;
  double source_h;
  bool has_source_rect;
} KlausPermissionGuideConfig;

// Shows or updates the floating drag-and-drop guidance panel anchored beneath macOS System Settings.
// Safe to call from any thread; UI work runs on the main thread. Returns false when no valid .app
// bundle can be resolved.
bool klaus_permission_guide_show(const KlausPermissionGuideConfig *config);

// Dismisses the floating guidance panel and stops tracking System Settings.
// When restore_previous_app is true, reactivates the application that was frontmost before the
// guidance flow began.
void klaus_permission_guide_close(bool restore_previous_app);

// Reports whether the guidance panel is currently visible.
bool klaus_permission_guide_is_visible(void);

#ifdef KLAUS_PERMISSIONS_TESTING
#include <CoreGraphics/CoreGraphics.h>
CGRect klaus_permission_guide_target_frame(CGRect settings_frame, CGRect screen_visible_frame, double measured_height);
CGRect klaus_permission_guide_convert_cg_rect(CGRect cg_rect, CGRect screen_frame, CGRect screen_cg_bounds);
#endif
