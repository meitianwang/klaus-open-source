#include <assert.h>
#include <stdio.h>
#include "../pets/KlausAppshotShortcut.h"

int main(void) {
    KlausAppshotShortcut state = {.left = 1, .right = 2, .modifiers = 15};
    assert(!KlausAppshotShortcutStep(&state, 1, -1, false, true));
    assert(KlausAppshotShortcutStep(&state, 3, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 3, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 2, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 3, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 0, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 2, -1, false, true));
    assert(KlausAppshotShortcutStep(&state, 3, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 0, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 5, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 3, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 0, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 0, 7, true, false));
    assert(!KlausAppshotShortcutStep(&state, 3, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 3, 7, false, false));
    assert(!KlausAppshotShortcutStep(&state, 0, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 1, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 1, 99, true, false));
    assert(!KlausAppshotShortcutStep(&state, 1, 99, false, false));
    assert(!KlausAppshotShortcutStep(&state, 3, -1, false, true));
    assert(!KlausAppshotShortcutStep(&state, 0, -1, false, true));
    assert(KlausAppshotShortcutStep(&state, 3, -1, false, true));
    KlausAppshotShortcut shift = {.left = 16, .right = 32, .modifiers = 63};
    assert(!KlausAppshotShortcutStep(&shift, 16, -1, false, true));
    assert(KlausAppshotShortcutStep(&shift, 48, -1, false, true));
    assert(!KlausAppshotShortcutStep(&shift, 0, -1, false, true));
    assert(!KlausAppshotShortcutStep(&shift, 17, -1, false, true));
    assert(!KlausAppshotShortcutStep(&shift, 48, -1, false, true));
    puts("appshot-shortcut: 27 assertions passed");
    return 0;
}
