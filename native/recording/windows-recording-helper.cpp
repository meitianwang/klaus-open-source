#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string_view>
#include <utility>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <deque>
#include <fcntl.h>
#include <io.h>
#include <set>
#include <string>
#include <thread>

using namespace winrt;
using namespace winrt::Windows::Data::Json;
static auto Str(std::wstring_view value) { return JsonValue::CreateStringValue(hstring(value)); }
static auto Num(double value) { return JsonValue::CreateNumberValue(value); }
static auto Bool(bool value) { return JsonValue::CreateBooleanValue(value); }
[[noreturn]] static void Fatal(const char* reason) { fprintf(stderr, "recording-helper: %s\n", reason); fflush(stderr); std::_Exit(2); }
static bool Visible() {
    USEROBJECTFLAGS flags{};
    return GetUserObjectInformationW(GetProcessWindowStation(), UOI_FLAGS, &flags, static_cast<DWORD>(sizeof(flags)), nullptr) && (flags.dwFlags & WSF_VISIBLE);
}
static com_ptr<IUIAutomation> Automation() {
    com_ptr<IUIAutomation> result;
    CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(result.put()));
    return result;
}
static JsonObject Capabilities(bool access, bool input) {
    JsonObject caps, permissions;
    caps.Insert(L"version", Num(1)); caps.Insert(L"supported", Bool(true));
    permissions.Insert(L"accessibility", Bool(access)); permissions.Insert(L"inputMonitoring", Bool(input));
    caps.Insert(L"permissions", permissions); return caps;
}
static void Print(const std::string& line) {
    if (fwrite(line.data(), 1, line.size(), stdout) != line.size() || fputc('\n', stdout) == EOF || fflush(stdout)) Fatal("stdout-write-failed");
}
static constexpr UINT Input = WM_APP + 1, Command = WM_APP + 2, StopPump = WM_APP + 3;
static DWORD formatterId;
static std::atomic<unsigned> pending{0};
static std::atomic<bool> hooksReady{false};
struct Raw { HWND window; UINT kind; POINT point{}; DWORD key = 0; unsigned modifiers = 0; };
static void Post(UINT message, LPARAM payload) {
    if (++pending > 256 || !PostThreadMessageW(formatterId, message, 0, payload)) Fatal("native-input-backpressure");
}
static const wchar_t* Named(DWORD key) {
    switch (key) {
        case VK_RETURN: return L"Return"; case VK_TAB: return L"Tab"; case VK_ESCAPE: return L"Escape";
        case VK_HOME: return L"Home"; case VK_END: return L"End"; case VK_PRIOR: return L"PageUp"; case VK_NEXT: return L"PageDown";
        case VK_DELETE: return L"ForwardDelete"; case VK_LEFT: return L"ArrowLeft"; case VK_RIGHT: return L"ArrowRight";
        case VK_UP: return L"ArrowUp"; case VK_DOWN: return L"ArrowDown"; default: return nullptr;
    }
}
static const wchar_t* Symbol(DWORD key) {
    switch (key) {
        case VK_SPACE: return L"Space"; case VK_BACK: return L"Delete";
        case VK_OEM_1: return L"Semicolon"; case VK_OEM_PLUS: return L"Equals"; case VK_OEM_COMMA: return L"Comma";
        case VK_OEM_MINUS: return L"Minus"; case VK_OEM_PERIOD: return L"Period"; case VK_OEM_2: return L"Slash";
        case VK_OEM_3: return L"Grave"; case VK_OEM_4: return L"LeftBracket"; case VK_OEM_5: return L"Backslash";
        case VK_OEM_6: return L"RightBracket"; case VK_OEM_7: return L"Quote"; default: return nullptr;
    }
}
static unsigned modifiers = 0;
static LRESULT CALLBACK KeyHook(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION) {
        const auto& key = *reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
        const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        unsigned bit = 0;
        switch (key.vkCode) {
            case VK_LCONTROL: bit = 1; break; case VK_RCONTROL: bit = 2; break;
            case VK_LMENU: bit = 4; break; case VK_RMENU: bit = 8; break;
            case VK_LWIN: bit = 16; break; case VK_RWIN: bit = 32; break;
            case VK_LSHIFT: bit = 64; break; case VK_RSHIFT: bit = 128; break;
        }
        if (bit) { if (down) modifiers |= bit; else modifiers &= ~bit; }
        else if (down && !(key.flags & LLKHF_INJECTED)) {
            const auto vk = key.vkCode;
            const bool symbol = Symbol(vk) || (vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9');
            // Right Alt can be AltGr, which enters printable characters.
            const bool command = (modifiers & 63) && !(modifiers & 8);
            if (Named(vk) || (command && (symbol || (vk >= VK_F1 && vk <= VK_F12))))
                Post(Input, reinterpret_cast<LPARAM>(new Raw{GetForegroundWindow(), WM_KEYDOWN, {}, vk, modifiers}));
            else if (symbol || (vk >= VK_NUMPAD0 && vk <= VK_DIVIDE) || vk == VK_PACKET)
                Post(Input, reinterpret_cast<LPARAM>(new Raw{GetForegroundWindow(), WM_CHAR}));
        }
    }
    return CallNextHookEx(nullptr, code, message, data);
}
static LRESULT CALLBACK MouseHook(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION && (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP || message == WM_RBUTTONDOWN)) {
        const auto& mouse = *reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
        if (!(mouse.flags & LLMHF_INJECTED)) Post(Input, reinterpret_cast<LPARAM>(new Raw{GetForegroundWindow(), static_cast<UINT>(message), mouse.pt}));
    }
    return CallNextHookEx(nullptr, code, message, data);
}
static DWORD StartHooks() {
    auto threadId = std::make_shared<std::atomic<DWORD>>(0);
    std::thread([threadId] {
        MSG message{}; PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
        const auto mouse = SetWindowsHookExW(WH_MOUSE_LL, MouseHook, GetModuleHandleW(nullptr), 0);
        const auto keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, KeyHook, GetModuleHandleW(nullptr), 0);
        hooksReady = mouse && keyboard;
        threadId->store(GetCurrentThreadId()); threadId->notify_one();
        while (GetMessageW(&message, nullptr, 0, 0) > 0 && message.message != StopPump) {}
        if (mouse) UnhookWindowsHookEx(mouse);
        if (keyboard) UnhookWindowsHookEx(keyboard);
    }).detach();
    threadId->wait(0); return threadId->load();
}
static std::wstring Lower(std::wstring value) { for (auto& c : value) c = static_cast<wchar_t>(towlower(c)); return value; }
static std::wstring Executable(DWORD pid) {
    const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return {};
    std::wstring path(32768, L'\0'); DWORD length = static_cast<DWORD>(path.size());
    const auto ok = QueryFullProcessImageNameW(process, 0, path.data(), &length); CloseHandle(process);
    if (!ok) return {};
    path.resize(length); return path.substr(path.find_last_of(L"\\/") + 1);
}
static JsonObject Point(POINT point) { JsonObject result; result.Insert(L"x", Num(point.x)); result.Insert(L"y", Num(point.y)); return result; }
static JsonObject Target(IUIAutomation* automation, POINT point, DWORD pid) {
    JsonObject target;
    com_ptr<IUIAutomationElement> element; int owner = 0;
    if (automation && SUCCEEDED(automation->ElementFromPoint(point, element.put())) && element &&
        SUCCEEDED(element->get_CurrentProcessId(&owner)) && static_cast<DWORD>(owner) == pid) {
        BSTR role = nullptr;
        if (SUCCEEDED(element->get_CurrentLocalizedControlType(&role)) && role)
            target.Insert(L"role", Str(std::wstring_view(role, SysStringLen(role)).substr(0, 128)));
        SysFreeString(role);
        // Accessible names can contain user data. Do not expose the original name.
        BSTR name = nullptr;
        if (SUCCEEDED(element->get_CurrentName(&name)) && name && SysStringLen(name)) target.Insert(L"title", Str(L"[redacted]"));
        SysFreeString(name);
    }
    return target;
}
struct Recorder {
    com_ptr<IUIAutomation> automation;
    hstring id;
    double generation = 0, seq = 0, flight = 0;
    ULONGLONG began = GetTickCount64(), sent = 0, duration = 1800000;
    size_t bytes = 0;
    unsigned suppressed = 0;
    bool ending = false, terminal = false, burst = false, down = false;
    DWORD hookThread = 0, pid = 0;
    HWND window = nullptr;
    POINT origin{};
    std::wstring exe, name, title;
    std::set<DWORD> allowed;
    std::set<std::wstring> blocked, excluded;
    std::deque<std::pair<double, std::string>> queue;
    void Send() {
        if (flight || queue.empty()) return;
        flight = queue.front().first; sent = GetTickCount64(); bytes -= queue.front().second.size();
        Print(queue.front().second); queue.pop_front();
    }
    void Emit(JsonObject obj) {
        obj.Insert(L"recordingId", JsonValue::CreateStringValue(id)); obj.Insert(L"generation", Num(generation)); obj.Insert(L"seq", Num(++seq));
        auto line = to_string(obj.Stringify()); bytes += line.size();
        if (bytes > 1024 * 1024 || queue.size() >= 256) Fatal("event-queue-limit");
        queue.emplace_back(seq, std::move(line)); Send();
    }
    JsonObject App() { JsonObject app; app.Insert(L"name", Str(name)); app.Insert(L"bundleId", Str(exe)); return app; }
    JsonObject Event(std::wstring_view type, bool context = true) {
        JsonObject event; event.Insert(L"type", Str(type)); event.Insert(L"ts", Num(static_cast<double>(GetTickCount64() - began)));
        if (context) { event.Insert(L"app", App()); event.Insert(L"window", Str(title)); }
        return event;
    }
    void EventOut(JsonObject event) { JsonObject frame; frame.Insert(L"type", Str(L"event")); frame.Insert(L"event", event); Emit(frame); }
    bool Focus(HWND hwnd, bool input) {
        DWORD owner = 0; if (hwnd) GetWindowThreadProcessId(hwnd, &owner);
        if (!owner || owner == GetCurrentProcessId() || (!allowed.empty() && !allowed.contains(owner))) return false;
        if (owner != pid) {
            pid = owner; name = Executable(pid); exe = Lower(name);
            if (exe.ends_with(L".exe")) name.resize(name.size() - 4);
            if (name.empty()) name = L"Application";
            window = nullptr; title.clear(); burst = down = false;
        }
        if (exe.empty()) return false;
        for (const auto& token : blocked) if (exe.find(token) != std::wstring::npos || Lower(name).find(token) != std::wstring::npos) {
            if (input) ++suppressed;
            if (excluded.insert(exe).second) EventOut(Event(L"recording.excludedApp"));
            return false;
        }
        wchar_t text[513]{}; GetWindowTextW(hwnd, text, 513);
        if (hwnd != window || title != text) {
            window = hwnd; title = text; burst = down = false;
            EventOut(Event(L"window.changed"));
        }
        return true;
    }
    void Format(const Raw& raw) {
        if (ending || id.empty() || !Focus(raw.window, true)) return;
        if (raw.kind == WM_CHAR) {
            ++suppressed; if (!burst) EventOut(Event(L"secureInput")); burst = true; return;
        }
        burst = false;
        if (raw.kind == WM_KEYDOWN) {
            auto event = Event(L"keyboard.shortcut");
            std::wstring key;
            if (const auto named = Named(raw.key)) key = named;
            else if (const auto symbol = Symbol(raw.key)) key = symbol;
            else if (raw.key >= VK_F1 && raw.key <= VK_F12) key = L"F" + std::to_wstring(raw.key - VK_F1 + 1);
            else key.assign(1, static_cast<wchar_t>(raw.key));
            JsonArray mods;
            if (raw.modifiers & 3) mods.Append(Str(L"control"));
            if (raw.modifiers & 12) mods.Append(Str(L"option"));
            if (raw.modifiers & 48) mods.Append(Str(L"command"));
            if (raw.modifiers & 192) mods.Append(Str(L"shift"));
            event.Insert(L"key", Str(key)); event.Insert(L"modifiers", mods); EventOut(event); return;
        }
        if (raw.kind == WM_LBUTTONDOWN) { origin = raw.point; down = true; return; }
        const bool right = raw.kind == WM_RBUTTONDOWN;
        if (!right && !down) return;
        const bool drag = !right && std::hypot(static_cast<double>(raw.point.x) - origin.x, static_cast<double>(raw.point.y) - origin.y) > 8;
        auto event = Event(right ? L"mouse.context_menu" : drag ? L"mouse.drag" : L"mouse.click");
        event.Insert(L"target", Target(automation.get(), raw.point, pid));
        if (!right) {
            down = false; event.Insert(L"button", Str(L"left")); event.Insert(L"clickCount", Num(1));
            if (drag) { event.Insert(L"origin", Point(origin)); event.Insert(L"destination", Point(raw.point)); }
        }
        EventOut(event);
    }
    void Finish(hstring mode, hstring reason) {
        if (ending) return;
        ending = true; if (hookThread) PostThreadMessageW(hookThread, StopPump, 0, 0);
        if (hooksReady) { auto event = Event(L"session.ended", false); event.Insert(L"discarded", Bool(mode == L"discard")); EventOut(event); }
        JsonObject frame; frame.Insert(L"type", Str(L"ended")); frame.Insert(L"mode", Str(mode)); frame.Insert(L"reason", Str(reason));
        frame.Insert(L"suppressedEventCount", Num(suppressed)); terminal = true; Emit(frame);
    }
    static double Integer(double value, double max) {
        if (!std::isfinite(value) || value < 1 || value > max || std::floor(value) != value) Fatal("integer-invalid");
        return value;
    }
    void Policy(const JsonObject& cmd) {
        const auto apps = cmd.GetNamedArray(L"blockedApps"), pids = cmd.GetNamedArray(L"allowedProcessIds");
        if (apps.Size() > 256 || pids.Size() > 32) Fatal("policy-invalid");
        blocked.clear(); allowed.clear(); burst = down = false; window = nullptr; title.clear();
        for (const auto& entry : apps) {
            auto token = entry.GetString(); if (token.size() > 256) Fatal("policy-invalid");
            if (!token.empty()) blocked.insert(Lower(std::wstring(token)));
        }
        for (const auto& entry : pids) allowed.insert(static_cast<DWORD>(Integer(entry.GetNumber(), INT32_MAX)));
    }
    void Handle(const JsonObject& cmd) {
        const auto type = cmd.GetNamedString(L"type");
        if (type == L"start") {
            if (!id.empty()) Fatal("recording-already-started");
            id = cmd.GetNamedString(L"recordingId");
            if (id.empty() || id.size() > 128 || std::wstring_view(id).find_first_not_of(L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::wstring_view::npos) Fatal("identity-invalid");
            generation = Integer(cmd.GetNamedNumber(L"generation"), 9007199254740991.0);
            duration = static_cast<ULONGLONG>(Integer(cmd.GetNamedNumber(L"maxDurationMs", 1800000), 1800000));
            Policy(cmd); began = GetTickCount64();
            if (Visible() && automation) hookThread = StartHooks();
            if (!hooksReady) { Finish(L"error", L"windows-input-monitoring-or-accessibility-unavailable"); return; }
            JsonObject ready; ready.Insert(L"type", Str(L"ready")); ready.Insert(L"capabilities", Capabilities(true, true)); Emit(ready);
            auto event = Event(L"session.started", false); event.Insert(L"ts", Num(0)); EventOut(event); return;
        }
        if (id.empty() || id != cmd.GetNamedString(L"recordingId") || generation != cmd.GetNamedNumber(L"generation")) Fatal("identity-mismatch");
        if (type == L"ack") {
            if (!flight || flight != cmd.GetNamedNumber(L"seq")) Fatal("event-ack-order");
            if (terminal && flight == seq) std::_Exit(0);
            flight = 0; Send();
        } else if (type == L"stop") {
            auto mode = cmd.GetNamedString(L"mode"), reason = cmd.GetNamedString(L"reason");
            if ((mode != L"stop" && mode != L"discard") || reason.empty() || reason.size() > 128) Fatal("stop-invalid");
            Finish(mode, reason);
        } else if (type == L"policy") {
            if (ending) return;
            Policy(cmd); JsonObject frame; frame.Insert(L"type", Str(L"policy")); frame.Insert(L"operationId", Str(cmd.GetNamedString(L"operationId"))); Emit(frame);
        } else Fatal("command-invalid");
    }
    void Tick() {
        const auto now = GetTickCount64();
        if (flight && now - sent >= 5000) Fatal("event-ack-timeout");
        if (id.empty()) { if (now - began >= 10000) Fatal("start-timeout"); return; }
        if (ending) return;
        if (now - began >= duration) Finish(L"stop", L"duration-limit");
        else Focus(GetForegroundWindow(), false);
    }
};
int main(int argc, char** argv) {
    if (argc != 1 && (argc != 2 || strcmp(argv[1], "--capabilities"))) Fatal("unexpected arguments");
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    try {
        init_apartment(apartment_type::multi_threaded);
        Recorder recorder; if (Visible()) recorder.automation = Automation();
        if (argc == 2) { Print(to_string(Capabilities(static_cast<bool>(recorder.automation), Visible()).Stringify())); return 0; }
        MSG message{}; PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE); formatterId = GetCurrentThreadId();
        if (!SetTimer(nullptr, 0, 250, nullptr)) Fatal("timer-unavailable");
        std::thread([] {
            auto line = new std::string;
            for (int ch; (ch = getchar()) != EOF;) {
                if (ch == '\n') { Post(Command, reinterpret_cast<LPARAM>(line)); line = new std::string; }
                else { if (line->size() >= 65536) Fatal("stdin-line-limit"); line->push_back(static_cast<char>(ch)); }
            }
            delete line; Fatal("host-input-closed");
        }).detach();
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            if (message.message == Command) {
                --pending; const std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(message.lParam));
                recorder.Handle(JsonObject::Parse(to_hstring(*line)));
            } else if (message.message == Input) {
                --pending; const std::unique_ptr<Raw> raw(reinterpret_cast<Raw*>(message.lParam)); recorder.Format(*raw);
            }
            recorder.Tick();
        }
    } catch (...) { Fatal("native-operation-failed"); }
    Fatal("formatter-pump-stopped");
}
