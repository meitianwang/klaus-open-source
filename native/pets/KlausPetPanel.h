#include <stdbool.h>

bool klaus_pet_panel_configure(void *view);
bool klaus_pet_panel_focus(void *view, bool active);

#include <stdint.h>
int32_t klaus_pet_capture_active_application(void);
bool klaus_pet_restore_active_application(int32_t pid);
uint32_t klaus_pet_observe_outside_clicks(void *view, void (*callback)(void *, int32_t), void *context);
void klaus_pet_stop_outside_clicks(uint32_t token);

uint32_t klaus_pet_begin_window_drag(void *view, double pointer_x, double pointer_y, bool has_origin_bounds, double x, double y, double width, double height, void (*callback)(void *, double, double, bool, bool), void *context);
void klaus_pet_stop_window_drag(uint32_t token);

uint32_t klaus_pet_input_observer_count(void);

uint32_t klaus_appshot_observe_shortcut(uint32_t modifier, void (*callback)(void *), void *context);
void klaus_appshot_stop_shortcut(uint32_t token);

int32_t klaus_pet_window_number(void *view);
