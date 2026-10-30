#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint64_t left, right, modifiers, held[4];
    bool blocked, fired;
} KlausAppshotShortcut;

// A shortcut is one bare left-and-right modifier chord, rearmed after full release.
static inline bool KlausAppshotShortcutStep(KlausAppshotShortcut *state, uint64_t flags, int key, bool down, bool flagsChanged) {
    if (!flagsChanged && key >= 0 && key < 256) {
        uint64_t bit = UINT64_C(1) << (key % 64);
        if (down) state->held[key / 64] |= bit;
        else state->held[key / 64] &= ~bit;
    }
    bool held = state->held[0] || state->held[1] || state->held[2] || state->held[3];
    uint64_t modifiers = flags & state->modifiers;
    if (modifiers == 0 && !held) { state->blocked = false; state->fired = false; return false; }
    if (held || (modifiers & ~(state->left | state->right)) != 0) state->blocked = true;
    if (!flagsChanged || state->blocked || state->fired || (modifiers & (state->left | state->right)) != (state->left | state->right)) return false;
    state->fired = true;
    return true;
}
