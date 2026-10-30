#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <wtsapi32.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wincrypt.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <functional>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <stdexcept>
#include <cstdint>
#include <cwctype>
#include <thread>
#include <tuple>
#include <vector>
#include <fcntl.h>
#include <io.h>

using namespace winrt;
using namespace winrt::Windows::Data::Json;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using Clock = std::chrono::steady_clock;

// This process performs one OS operation. No COM object or desktop state is
// shared with another request, the Electron UI thread, or a session owner.
static std::atomic<bool> cancelled{false};
static Clock::time_point started;
static double postedAt = 0;
static double operationDeadline = 118;
struct Cleanup { std::function<void()> run; ~Cleanup() { try { run(); } catch (...) {} } };
struct Handle { HANDLE value; ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct BString { BSTR value = nullptr; ~BString() { SysFreeString(value); } };
[[noreturn]] static void Fail(const char* reason) { throw std::runtime_error(reason); }
static void Check() {
    if (cancelled.load()) Fail("Computer Use operation was cancelled");
    if (std::chrono::duration<double>(Clock::now() - started).count() > operationDeadline) Fail("Computer Use native operation exceeded its deadline");
}
static void Require(HRESULT result, const char* message) { Check(); if (FAILED(result)) Fail(message); }
static double Now() { return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count(); }
static void Pause(int milliseconds) {
    auto end = Clock::now() + std::chrono::milliseconds(milliseconds);
    while (Clock::now() < end) { Check(); std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
}
static JsonValue S(std::wstring_view text) { return JsonValue::CreateStringValue(hstring(text)); }
static JsonValue N(double number) { return JsonValue::CreateNumberValue(number); }
static JsonValue B(bool value) { return JsonValue::CreateBooleanValue(value); }
static std::wstring Text(const JsonObject& object, const wchar_t* key, size_t limit = 4096, bool empty = false) {
    auto value = object.GetNamedValue(key, JsonValue::CreateNullValue());
    if (value.ValueType() != JsonValueType::String) { if (empty) return {}; Fail("Native string argument is missing"); }
    std::wstring text(value.GetString());
    if ((!empty && text.empty()) || text.size() > limit || text.find(L'\0') != std::wstring::npos) Fail("Invalid native string argument");
    return text;
}
static double Number(const JsonObject& object, const wchar_t* key, double low, double high) {
    auto value = object.GetNamedValue(key, JsonValue::CreateNullValue());
    if (value.ValueType() != JsonValueType::Number) Fail("Invalid native numeric argument");
    double result = value.GetNumber();
    if (!std::isfinite(result) || result < low || result > high) Fail("Native numeric argument is outside its range");
    return result;
}
static std::wstring Lower(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(), [](wchar_t c) { return static_cast<wchar_t>(towlower(c)); }); return value;
}
static std::wstring Canonical(const std::wstring& path) {
    Handle file{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
    if (file.value == INVALID_HANDLE_VALUE) Fail("Application path could not be read");
    std::wstring output(32768, L'\0'); DWORD length = GetFinalPathNameByHandleW(file.value, output.data(), static_cast<DWORD>(output.size()), FILE_NAME_NORMALIZED);
    if (!length || length >= output.size()) Fail("Application path could not be resolved"); output.resize(length);
    if (output.starts_with(L"\\\\?\\UNC\\")) output = L"\\\\" + output.substr(8);
    else if (output.starts_with(L"\\\\?\\")) output.erase(0, 4);
    return output;
}
static std::wstring ProcessPath(DWORD pid) {
    Handle process{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)};
    if (!process.value) return {};
    std::wstring path(32768, L'\0'); DWORD length = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process.value, 0, path.data(), &length)) return {};
    path.resize(length); try { return Canonical(path); } catch (...) { return {}; }
}
static std::wstring BaseName(const std::wstring& path) {
    auto offset = path.find_last_of(L"\\/"); auto name = offset == std::wstring::npos ? path : path.substr(offset + 1);
    if (Lower(name).ends_with(L".exe")) name.resize(name.size() - 4); return name;
}
struct AppWindow { HWND hwnd; DWORD pid; std::wstring path, title; };
static std::vector<AppWindow> AppWindows() {
    std::vector<AppWindow> result;
    if (!EnumWindows([](HWND hwnd, LPARAM parameter) -> BOOL {
        auto& rows = *reinterpret_cast<std::vector<AppWindow>*>(parameter);
        if ((!IsWindowVisible(hwnd) && !IsIconic(hwnd)) || GetWindow(hwnd, GW_OWNER)) return TRUE;
        wchar_t title[4096]{}; if (!GetWindowTextW(hwnd, title, 4096)) return TRUE;
        DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid); auto path = ProcessPath(pid);
        if (!path.empty()) rows.push_back({hwnd, pid, std::move(path), title});
        return rows.size() < 1024;
    }, reinterpret_cast<LPARAM>(&result)) && result.size() < 1024) Fail("Application enumeration failed");
    Check(); return result;
}
static JsonObject Identity(const std::wstring& path, const std::wstring& input, DWORD pid = 0) {
    JsonObject value; value.Insert(L"input", S(input)); value.Insert(L"name", S(BaseName(path))); value.Insert(L"path", S(path));
    if (pid) value.Insert(L"pid", N(pid)); return value;
}
static JsonObject Resolve(const std::wstring& input) {
    std::map<DWORD, AppWindow> matches; auto token = Lower(input);
    bool absolute = (input.size() > 2 && input[1] == L':') || input.starts_with(L"\\\\");
    std::wstring exact = absolute ? Canonical(input) : L"";
    for (const auto& window : AppWindows()) {
        if ((!exact.empty() && Lower(window.path) == Lower(exact)) || (exact.empty() && (Lower(window.title) == token || Lower(BaseName(window.path)) == Lower(BaseName(input))))) matches.emplace(window.pid, window);
    }
    if (matches.size() > 1) Fail("Application identity is ambiguous; use the exact application window title");
    if (matches.size() == 1) return Identity(matches.begin()->second.path, input, matches.begin()->first);
    if (exact.empty() && input.find_first_of(L"\\/:") == std::wstring::npos) {
        wchar_t directory[MAX_PATH]{}; if (GetSystemDirectoryW(directory, MAX_PATH)) {
            auto name = input + (Lower(input).ends_with(L".exe") ? L"" : L".exe");
            try { exact = Canonical(std::wstring(directory) + L"\\" + name); } catch (...) {}
        }
    }
    if (exact.empty() || !Lower(exact).ends_with(L".exe")) Fail("Application was not found; use its full executable path");
    // A process that has not created its first window must not be launched twice.
    Handle processes{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0)}; PROCESSENTRY32W entry{sizeof(entry)}; DWORD pending=0;
    if(processes.value!=INVALID_HANDLE_VALUE&&Process32FirstW(processes.value,&entry))do{
        if(Lower(BaseName(entry.szExeFile))==Lower(BaseName(exact))&&Lower(ProcessPath(entry.th32ProcessID))==Lower(exact)){
            if(pending&&pending!=entry.th32ProcessID)Fail("Application identity is ambiguous");pending=entry.th32ProcessID;}
    }while(Process32NextW(processes.value,&entry));
    if(pending)return Identity(exact,input,pending);
    return Identity(exact, input);
}
static DWORD VerifyApp(const JsonObject& identity) {
    auto pid = static_cast<DWORD>(Number(identity, L"pid", 1, INT32_MAX));
    if (Lower(ProcessPath(pid)) != Lower(Text(identity, L"path"))) Fail("Approved application identity changed; read fresh app state"); return pid;
}
static HWND WindowFor(DWORD pid) {
    HWND foreground = GetAncestor(GetForegroundWindow(), GA_ROOT), first = nullptr;
    for (const auto& window : AppWindows()) if (window.pid == pid) { if (window.hwnd == foreground) return foreground; if (!first) first = window.hwnd; }
    if (!first) Fail("Approved application has no capturable window"); return first;
}
static RECT WindowBounds(HWND window) {
    RECT rectangle{};
    if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &rectangle, sizeof(rectangle))) || rectangle.right <= rectangle.left || rectangle.bottom <= rectangle.top)
        Fail("Approved window bounds are unavailable");
    return rectangle;
}
static JsonObject Rectangle(const RECT& r) {
    JsonObject value; value.Insert(L"x", N(r.left)); value.Insert(L"y", N(r.top)); value.Insert(L"width", N(r.right-r.left)); value.Insert(L"height", N(r.bottom-r.top)); return value;
}
static bool SameBounds(const RECT& a, const RECT& b) { return EqualRect(&a, &b) != FALSE; }
static RECT ReadBounds(const JsonObject& r) {
    LONG x = static_cast<LONG>(Number(r,L"x",-1000000,1000000)), y = static_cast<LONG>(Number(r,L"y",-1000000,1000000));
    return {x,y,x+static_cast<LONG>(Number(r,L"width",1,100000)),y+static_cast<LONG>(Number(r,L"height",1,100000))};
}
static DWORD InteractiveSession() {
    DWORD session = 0; if (!ProcessIdToSessionId(GetCurrentProcessId(), &session) || !session) Fail("Computer Use requires an interactive user session");
    return session;
}
static void Desktop() {
    DWORD session=InteractiveSession();
    LPWSTR data = nullptr; DWORD bytes = 0;
    if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, WTSConnectState, &data, &bytes)) Fail("Interactive session state is unavailable");
    bool active = bytes >= sizeof(WTS_CONNECTSTATE_CLASS) && *reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(data) == WTSActive; WTSFreeMemory(data);
    if (!active) Fail("The interactive session is disconnected; reconnect and unlock the desktop");
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    if (!desktop) Fail("The input desktop is unavailable; unlock the screen before using Computer Use");
    Cleanup release{[&] { CloseDesktop(desktop); }}; wchar_t name[256]{}; DWORD needed = 0;
    if (!GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &needed) || Lower(name) != L"default") Fail("The desktop is locked or protected; automatic unlock is unavailable");
}
static void Presence(const JsonObject& args) {
    Desktop(); LASTINPUTINFO info{sizeof(info),0}; if (!GetLastInputInfo(&info)) Fail("User input presence could not be determined");
    double idle = static_cast<DWORD>(GetTickCount() - info.dwTime) / 1000.0;
    double own = std::max(postedAt, args.GetNamedNumber(L"lastOwnInputAt", 0));
    if (idle < 1.5 && (own <= 0 || idle + 0.2 < (Now()-own)/1000)) Fail("The user is interacting with this computer. Wait two seconds and try again");
}
static void Foreground(HWND window, DWORD pid) {
    Check(); DWORD current = 0; HWND front = GetAncestor(GetForegroundWindow(), GA_ROOT); GetWindowThreadProcessId(front, &current);
    if (front != window || current != pid) Fail("Approved application lost keyboard focus; read fresh app state");
}
static JsonObject Activate(const JsonObject& args) {
    Desktop(); if (args.GetNamedBoolean(L"inputAction",false)) Presence(args);
    auto identity = args.GetNamedObject(L"app"); DWORD pid = 0;
    if (identity.HasKey(L"pid")) pid = VerifyApp(identity);
    else {
        auto path = Canonical(Text(identity,L"path")); if (path != Text(identity,L"path")) Fail("Application changed after approval");
        SHELLEXECUTEINFOW info{sizeof(info)}; info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI; info.lpFile = path.c_str(); info.nShow = SW_SHOWNORMAL;
        if (!ShellExecuteExW(&info)) Fail("Approved application could not be opened"); Handle process{info.hProcess};
        auto end = Clock::now()+std::chrono::seconds(5);
        do { for (const auto& window : AppWindows()) if (Lower(window.path) == Lower(path)) { if (pid && pid != window.pid) Fail("Started application identity is ambiguous"); pid=window.pid; }
            if (pid) break; Pause(20);
        } while (Clock::now()<end);
        if (!pid) Fail("Approved application did not create a window before its deadline");
    }
    HWND window = WindowFor(pid); if (IsIconic(window)) ShowWindow(window,SW_RESTORE);
    SetForegroundWindow(window);
    auto end=Clock::now()+std::chrono::seconds(2);
    while (GetAncestor(GetForegroundWindow(),GA_ROOT)!=window && Clock::now()<end) Pause(10);
    Foreground(window,pid); return Identity(ProcessPath(pid),Text(identity,L"input"),pid);
}

static std::wstring Clean(std::wstring text) {
    if (text.size()>4096) text.resize(4096);
    for(auto& c:text) if(c==L'\r'||c==L'\n') c=L' '; return text;
}
static std::wstring Property(IUIAutomationElement* element, HRESULT (STDMETHODCALLTYPE IUIAutomationElement::*getter)(BSTR*)) {
    Check(); BString text; if (FAILED((element->*getter)(&text.value)) || !text.value) return {}; return Clean({text.value,SysStringLen(text.value)});
}
template<typename T> static com_ptr<T> Pattern(IUIAutomationElement* element, PATTERNID id) {
    Check(); com_ptr<IUnknown> value; if(FAILED(element->GetCurrentPattern(id,value.put()))||!value) return {};
    return value.try_as<T>();
}
static std::wstring RuntimeId(IUIAutomationElement* element) {
    SAFEARRAY* array=nullptr; if(FAILED(element->GetRuntimeId(&array))||!array) return {};
    Cleanup release{[&]{SafeArrayDestroy(array);}}; LONG first=0,last=-1;
    if(SafeArrayGetDim(array)!=1||FAILED(SafeArrayGetLBound(array,1,&first))||FAILED(SafeArrayGetUBound(array,1,&last))||last-first>63) return {};
    std::wstring output;
    for(LONG index=first;index<=last;index++){LONG part=0;if(FAILED(SafeArrayGetElement(array,&index,&part)))return {};output+=L":"+std::to_wstring(part);}
    return output;
}
static JsonObject Describe(IUIAutomationElement* element,const std::wstring& path,int depth) {
    JsonObject value; value.Insert(L"path",S(path));value.Insert(L"depth",N(depth));
    auto name=Property(element,&IUIAutomationElement::get_CurrentName), role=Property(element,&IUIAutomationElement::get_CurrentLocalizedControlType);
    value.Insert(L"title",S(name));value.Insert(L"name",S(name));value.Insert(L"role",S(role));value.Insert(L"roleDescription",S(role));
    auto runtime=RuntimeId(element); auto id=Property(element,&IUIAutomationElement::get_CurrentAutomationId);
    if(id.size()>3000)id.resize(3000);value.Insert(L"identifier",S(id+L" [uia"+runtime+L"]"));
    BOOL enabled=FALSE,focused=FALSE,password=TRUE;
    if(SUCCEEDED(element->get_CurrentIsEnabled(&enabled)))value.Insert(L"enabled",B(enabled!=FALSE));
    if(SUCCEEDED(element->get_CurrentHasKeyboardFocus(&focused)))value.Insert(L"focused",B(focused!=FALSE));
    element->get_CurrentIsPassword(&password);
    auto writable=Pattern<IUIAutomationValuePattern>(element,UIA_ValuePatternId); BOOL readonly=TRUE;
    if(writable)writable->get_CurrentIsReadOnly(&readonly);
    value.Insert(L"settable",B(writable&&readonly==FALSE));
    if(writable&&!password){BString raw;if(SUCCEEDED(writable->get_CurrentValue(&raw.value))&&raw.value)value.Insert(L"value",S(Clean({raw.value,SysStringLen(raw.value)})));}
    if(password)value.Insert(L"subrole",S(L"password"));
    JsonArray actions;
    auto add=[&](const wchar_t* raw,const wchar_t* label){JsonObject action;action.Insert(L"raw",S(raw));action.Insert(L"description",S(label));actions.Append(action);};
    if(Pattern<IUIAutomationInvokePattern>(element,UIA_InvokePatternId))add(L"Invoke",L"Invoke");
    if(Pattern<IUIAutomationTogglePattern>(element,UIA_TogglePatternId))add(L"Toggle",L"Toggle");
    if(Pattern<IUIAutomationExpandCollapsePattern>(element,UIA_ExpandCollapsePatternId)){add(L"Expand",L"Expand");add(L"Collapse",L"Collapse");}
    if(Pattern<IUIAutomationSelectionItemPattern>(element,UIA_SelectionItemPatternId))add(L"Select",L"Select");
    value.Insert(L"actions",actions);RECT bounds{};if(SUCCEEDED(element->get_CurrentBoundingRectangle(&bounds))&&bounds.right>bounds.left&&bounds.bottom>bounds.top)value.Insert(L"bounds",Rectangle(bounds));return value;
}
static void Walk(IUIAutomationTreeWalker* walker,IUIAutomationElement* element,const std::wstring& path,int depth,int nativeDepth,JsonArray& rows,size_t& text,size_t& visited) {
    Check();if(rows.Size()>=500||depth>8||nativeDepth>32||text>50000||++visited>2000)return;
    auto row=Describe(element,path,depth);com_ptr<IUIAutomationElement> child;
    walker->GetFirstChildElement(element,child.put());
    CONTROLTYPEID type=0;element->get_CurrentControlType(&type);
    // Native paths retain every UIA edge. Empty single-child layout containers
    // do not consume the separate semantic depth budget for usable controls.
    if(nativeDepth>0&&child&&(type==UIA_GroupControlTypeId||type==UIA_PaneControlTypeId)&&Text(row,L"title",4096,true).empty()
        &&Text(row,L"value",4096,true).empty()&&row.GetNamedArray(L"actions").Size()==0&&!row.GetNamedBoolean(L"focused",false)){
        com_ptr<IUIAutomationElement> sibling;
        if(SUCCEEDED(walker->GetNextSiblingElement(child.get(),sibling.put()))&&!sibling){Walk(walker,child.get(),path+L".0",depth,nativeDepth+1,rows,text,visited);return;}
    }
    text+=row.Stringify().size();row.Insert(L"index",S(std::to_wstring(rows.Size())));rows.Append(row);size_t sibling=0;
    while(child&&rows.Size()<500&&text<=50000&&visited<2000){Walk(walker,child.get(),path+L"."+std::to_wstring(sibling++),depth+1,nativeDepth+1,rows,text,visited);com_ptr<IUIAutomationElement> next;
        if(FAILED(walker->GetNextSiblingElement(child.get(),next.put())))break;child=std::move(next);}
}
static com_ptr<IUIAutomationElement> Element(IUIAutomation* automation,HWND window,const JsonObject& expected) {
    auto path=Text(expected,L"path",256);if(!path.starts_with(L"w0"))Fail("Element belongs to another window");
    com_ptr<IUIAutomationElement> element;Require(automation->ElementFromHandle(window,element.put()),"Approved accessibility root is unavailable");
    com_ptr<IUIAutomationTreeWalker> walker;Require(automation->get_ControlViewWalker(walker.put()),"Accessibility walker is unavailable");
    size_t offset=2,depth=0;
    while(offset<path.size()){if(path[offset++]!=L'.'||++depth>32)Fail("Invalid accessibility path");size_t end=path.find(L'.',offset);auto token=path.substr(offset,end-offset);
        if(token.empty()||token.size()>4||token.find_first_not_of(L"0123456789")!=std::wstring::npos)Fail("Invalid accessibility path");
        int index=std::stoi(token);if(index>1024)Fail("Accessibility path exceeds its limit");com_ptr<IUIAutomationElement> child;
        Require(walker->GetFirstChildElement(element.get(),child.put()),"Element path changed; read fresh app state");
        for(int i=0;i<index&&child;i++){com_ptr<IUIAutomationElement> next;Require(walker->GetNextSiblingElement(child.get(),next.put()),"Element path changed");child=std::move(next);}
        if(!child)Fail("Element path is unavailable; read fresh app state");element=std::move(child);offset=end==std::wstring::npos?path.size():end;}
    auto fresh=Describe(element.get(),path,0);
    if(RuntimeId(element.get()).empty())Fail("Element has no stable native identity; use a fresh screenshot coordinate instead");
    for(auto key:{L"role",L"subrole",L"title",L"identifier"})if(Text(fresh,key,4096,true)!=Text(expected,key,4096,true))Fail("Element identity changed; read fresh app state");
    if(!fresh.GetNamedBoolean(L"enabled",false))Fail("The requested element is disabled");return element;
}

static std::string Base64(const BYTE* bytes,DWORD length) {
    DWORD size=0; if(!CryptBinaryToStringA(bytes,length,CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,nullptr,&size))Fail("Capture encoding failed");
    std::string result(size,'\0');if(!CryptBinaryToStringA(bytes,length,CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,result.data(),&size))Fail("Capture encoding failed");
    while(!result.empty()&&result.back()=='\0')result.pop_back();return result;
}
static JsonObject Capture(HWND window,const RECT& bounds) {
    Desktop();if(!GraphicsCaptureSession::IsSupported())Fail("Windows Graphics Capture is unavailable");
    auto interop=get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();GraphicsCaptureItem item{nullptr};
    Require(interop->CreateForWindow(window,guid_of<GraphicsCaptureItem>(),put_abi(item)),"Approved window capture is unavailable");
    auto size=item.Size();if(size.Width!=bounds.right-bounds.left||size.Height!=bounds.bottom-bounds.top||size.Width<1||size.Height<1||size.Width>16384||size.Height>16384||static_cast<int64_t>(size.Width)*size.Height>16000000)
        Fail("Approved window capture geometry changed; read fresh app state");
    com_ptr<ID3D11Device> d3d;com_ptr<ID3D11DeviceContext> context;
    Require(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,d3d.put(),nullptr,context.put()),"Window capture device is unavailable");
    auto dxgi=d3d.as<IDXGIDevice>();com_ptr<IInspectable> inspectable;
    Require(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(),inspectable.put()),"Window capture device interop failed");
    auto device=inspectable.as<IDirect3DDevice>();
    auto pool=Direct3D11CaptureFramePool::CreateFreeThreaded(device,DirectXPixelFormat::B8G8R8A8UIntNormalized,2,size);
    auto session=pool.CreateCaptureSession(item);Cleanup release{[&]{session.Close();pool.Close();}};
    if(winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession",L"IsCursorCaptureEnabled"))session.IsCursorCaptureEnabled(false);
    session.StartCapture();Direct3D11CaptureFrame frame{nullptr};auto end=Clock::now()+std::chrono::seconds(3);
    while(!(frame=pool.TryGetNextFrame())){if(Clock::now()>=end)Fail("Approved window did not produce a capture frame");Pause(10);}
    Cleanup closeFrame{[&]{frame.Close();}};auto content=frame.ContentSize();
    // Fractional DPI can leave one undefined edge pixel in the allocated WGC
    // surface. Keep the exact window guard, and publish only the valid crop.
    if(!SameBounds(bounds,WindowBounds(window))||content.Width<1||content.Height<1||content.Width>size.Width||content.Height>size.Height||size.Width-content.Width>1||size.Height-content.Height>1)
        throw std::runtime_error("Approved window resized during capture: expected "+std::to_string(size.Width)+"x"+std::to_string(size.Height)+", received "+std::to_string(content.Width)+"x"+std::to_string(content.Height));
    auto access=frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();com_ptr<ID3D11Texture2D> texture;
    Require(access->GetInterface(__uuidof(ID3D11Texture2D),texture.put_void()),"Window frame texture is unavailable");
    D3D11_TEXTURE2D_DESC descriptor{};texture->GetDesc(&descriptor);descriptor.Usage=D3D11_USAGE_STAGING;descriptor.BindFlags=0;descriptor.MiscFlags=0;descriptor.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
    com_ptr<ID3D11Texture2D> staging;Require(d3d->CreateTexture2D(&descriptor,nullptr,staging.put()),"Window frame allocation failed");context->CopyResource(staging.get(),texture.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};Require(context->Map(staging.get(),0,D3D11_MAP_READ,0,&mapped),"Window frame could not be read");Cleanup unmap{[&]{context->Unmap(staging.get(),0);}};
    auto factory=create_instance<IWICImagingFactory>(CLSID_WICImagingFactory);com_ptr<IWICBitmap> bitmap;
    Require(factory->CreateBitmapFromMemory(static_cast<UINT>(content.Width),static_cast<UINT>(content.Height),GUID_WICPixelFormat32bppBGRA,mapped.RowPitch,mapped.RowPitch*static_cast<UINT>(content.Height),static_cast<BYTE*>(mapped.pData),bitmap.put()),"Window bitmap encoding failed");
    double scale=std::min(1.0,2560.0/std::max(content.Width,content.Height));UINT width=static_cast<UINT>(std::max(1L,std::lround(content.Width*scale))),height=static_cast<UINT>(std::max(1L,std::lround(content.Height*scale)));
    com_ptr<IWICBitmapSource> source=bitmap.as<IWICBitmapSource>();com_ptr<IWICBitmapScaler> scaler;
    if(scale<1){Require(factory->CreateBitmapScaler(scaler.put()),"Window image scaler is unavailable");Require(scaler->Initialize(bitmap.get(),width,height,WICBitmapInterpolationModeFant),"Window image scaling failed");source=scaler.as<IWICBitmapSource>();}
    com_ptr<IStream> stream;Require(CreateStreamOnHGlobal(nullptr,TRUE,stream.put()),"Window image buffer failed");com_ptr<IWICBitmapEncoder> encoder;
    Require(factory->CreateEncoder(GUID_ContainerFormatPng,nullptr,encoder.put()),"PNG encoder is unavailable");Require(encoder->Initialize(stream.get(),WICBitmapEncoderNoCache),"PNG initialization failed");
    com_ptr<IWICBitmapFrameEncode> image;Require(encoder->CreateNewFrame(image.put(),nullptr),"PNG frame creation failed");Require(image->Initialize(nullptr),"PNG frame initialization failed");
    Require(image->SetSize(width,height),"PNG dimensions failed");auto format=GUID_WICPixelFormat32bppBGRA;Require(image->SetPixelFormat(&format),"PNG format failed");
    Require(image->WriteSource(source.get(),nullptr),"PNG frame encoding failed");Require(image->Commit(),"PNG frame commit failed");Require(encoder->Commit(),"PNG commit failed");
    STATSTG stat{};Require(stream->Stat(&stat,STATFLAG_NONAME),"PNG size is unavailable");if(!stat.cbSize.QuadPart||stat.cbSize.QuadPart>15*1024*1024)Fail("Window capture exceeds its byte limit");
    HGLOBAL memory=nullptr;Require(GetHGlobalFromStream(stream.get(),&memory),"PNG buffer is unavailable");auto bytes=static_cast<const BYTE*>(GlobalLock(memory));if(!bytes)Fail("PNG buffer is unavailable");
    Cleanup unlock{[&]{GlobalUnlock(memory);}};JsonObject result;result.Insert(L"data",S(to_hstring(Base64(bytes,static_cast<DWORD>(stat.cbSize.QuadPart)))));
    result.Insert(L"mimeType",S(L"image/png"));result.Insert(L"width",N(width));result.Insert(L"height",N(height));
    result.Insert(L"bounds",Rectangle({bounds.left,bounds.top,bounds.left+content.Width,bounds.top+content.Height}));return result;
}
static JsonObject State(const JsonObject& args) {
    Desktop();auto identity=args.GetNamedObject(L"app");DWORD pid=VerifyApp(identity);HWND window=WindowFor(pid);RECT bounds=WindowBounds(window);
    auto automation=create_instance<IUIAutomation>(CLSID_CUIAutomation);com_ptr<IUIAutomationElement> root;Require(automation->ElementFromHandle(window,root.put()),"Approved accessibility root is unavailable");
    com_ptr<IUIAutomationTreeWalker> walker;Require(automation->get_ControlViewWalker(walker.put()),"Accessibility walker is unavailable");
    JsonArray rows;size_t budget=0,visited=0;Walk(walker.get(),root.get(),L"w0",0,0,rows,budget,visited);auto image=Capture(window,bounds);
    VerifyApp(identity);if(window!=WindowFor(pid)||!SameBounds(bounds,WindowBounds(window)))Fail("Approved window moved during capture; request fresh state");
    JsonObject value;value.Insert(L"app",Identity(ProcessPath(pid),Text(identity,L"input"),pid));value.Insert(L"windowId",N(static_cast<double>(reinterpret_cast<UINT_PTR>(window))));
    value.Insert(L"bounds",Rectangle(bounds));value.Insert(L"elements",rows);value.Insert(L"screenshot",image);return value;
}

static void Send(std::vector<INPUT>& inputs,bool cleanup=false,UINT* accepted=nullptr) {
    if(!cleanup)Check();UINT count=SendInput(static_cast<UINT>(inputs.size()),inputs.data(),sizeof(INPUT));if(accepted)*accepted=count;postedAt=Now();
    if(count!=inputs.size()&&!cleanup)Fail("Native input was only partially accepted or blocked by desktop/UIPI restrictions; it was not retried");
}
static INPUT Key(WORD key,DWORD flags=0,WORD unicode=0,HKL layout=nullptr) {
    INPUT input{};input.type=INPUT_KEYBOARD;input.ki.dwFlags=flags;input.ki.dwExtraInfo=0x4b435541;
    if(flags&KEYEVENTF_UNICODE)input.ki.wScan=unicode;
    else{
        UINT scan=MapVirtualKeyExW(key,MAPVK_VK_TO_VSC_EX,layout?layout:GetKeyboardLayout(0));
        if(!scan)Fail("The requested key has no native scan code in the target keyboard layout");
        input.ki.wScan=static_cast<WORD>(scan&0xff);input.ki.dwFlags|=KEYEVENTF_SCANCODE;
        if((scan&0xff00)==0xe000)input.ki.dwFlags|=KEYEVENTF_EXTENDEDKEY;
    }
    return input;
}
static void ReleaseKeys(const std::vector<INPUT>& events,UINT accepted) {
    std::map<std::tuple<WORD,WORD,DWORD>,INPUT> held;
    for(UINT i=0;i<accepted;i++){const auto& event=events[i];if(event.type!=INPUT_KEYBOARD)continue;auto id=std::make_tuple(event.ki.wVk,event.ki.wScan,event.ki.dwFlags&(KEYEVENTF_EXTENDEDKEY|KEYEVENTF_UNICODE));
        if(event.ki.dwFlags&KEYEVENTF_KEYUP)held.erase(id);else{auto release=event;release.ki.dwFlags|=KEYEVENTF_KEYUP;held[id]=release;}}
    std::vector<INPUT> releases;for(const auto& [id,event]:held){(void)id;releases.push_back(event);}if(!releases.empty())Send(releases,true);
}
static INPUT Pointer(POINT point,DWORD flags,DWORD data=0) {
    int x=GetSystemMetrics(SM_XVIRTUALSCREEN),y=GetSystemMetrics(SM_YVIRTUALSCREEN),w=GetSystemMetrics(SM_CXVIRTUALSCREEN),h=GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if(w<2||h<2||point.x<x||point.y<y||point.x>=x+w||point.y>=y+h)Fail("Input point is outside the virtual screen");
    INPUT input{};input.type=INPUT_MOUSE;input.mi.dx=static_cast<LONG>(std::llround((point.x-x)*65535.0/(w-1)));input.mi.dy=static_cast<LONG>(std::llround((point.y-y)*65535.0/(h-1)));
    input.mi.dwFlags=flags|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK;input.mi.mouseData=data;input.mi.dwExtraInfo=0x4b435541;return input;
}
static POINT Point(const JsonObject& value,const RECT& window) {
    double x=Number(value,L"x",window.left,window.right),y=Number(value,L"y",window.top,window.bottom);
    if(x>=window.right||y>=window.bottom)Fail("Input point is outside the approved window");
    POINT p{static_cast<LONG>(std::floor(x)),static_cast<LONG>(std::floor(y))};
    if(!PtInRect(&window,p))Fail("Input point is outside the approved window");return p;
}
static void PointerTarget(HWND window,DWORD pid,POINT point) {
    Foreground(window,pid);HWND target=GetAncestor(WindowFromPoint(point),GA_ROOT);
    if(target!=window)Fail("Another window covers the requested point; read fresh app state");
}
static void Mouse(HWND window,DWORD pid,POINT point,const std::wstring& button,int count) {
    for(int key:{VK_LBUTTON,VK_RBUTTON,VK_MBUTTON,VK_XBUTTON1,VK_XBUTTON2})if(GetAsyncKeyState(key)&0x8000)Fail("A mouse button is already held; leave physical input untouched");
    PointerTarget(window,pid,point);DWORD down=MOUSEEVENTF_LEFTDOWN,up=MOUSEEVENTF_LEFTUP;
    if(button==L"right"){down=MOUSEEVENTF_RIGHTDOWN;up=MOUSEEVENTF_RIGHTUP;}else if(button==L"middle"){down=MOUSEEVENTF_MIDDLEDOWN;up=MOUSEEVENTF_MIDDLEUP;}else if(button!=L"left")Fail("Unsupported mouse button");
    for(int i=0;i<count;i++){PointerTarget(window,pid,point);UINT accepted=0;std::vector<INPUT> events{Pointer(point,MOUSEEVENTF_MOVE),Pointer(point,down),Pointer(point,up)};
        Cleanup cleanup{[&]{if(accepted==2){std::vector<INPUT> release{Pointer(point,up)};Send(release,true);}}};Send(events,false,&accepted);Pause(50);}
}
static bool Extended(WORD key) { return key==VK_LEFT||key==VK_RIGHT||key==VK_UP||key==VK_DOWN||key==VK_HOME||key==VK_END||key==VK_PRIOR||key==VK_NEXT||key==VK_DELETE||key==VK_LWIN; }
static WORD KeyCode(const std::wstring& name) {
    static const std::map<std::wstring,int> known{{L"return",VK_RETURN},{L"enter",VK_RETURN},{L"tab",VK_TAB},{L"escape",VK_ESCAPE},{L"esc",VK_ESCAPE},{L"space",VK_SPACE},
        {L"backspace",VK_BACK},{L"delete",VK_DELETE},{L"forwarddelete",VK_DELETE},{L"left",VK_LEFT},{L"right",VK_RIGHT},{L"up",VK_UP},{L"down",VK_DOWN},
        {L"home",VK_HOME},{L"end",VK_END},{L"pageup",VK_PRIOR},{L"pagedown",VK_NEXT},{L",",VK_OEM_COMMA},{L".",VK_OEM_PERIOD},{L"/",VK_OEM_2},{L";",VK_OEM_1},
        {L"'",VK_OEM_7},{L"[",VK_OEM_4},{L"]",VK_OEM_6},{L"\\",VK_OEM_5},{L"=",VK_OEM_PLUS},{L"-",VK_OEM_MINUS},{L"`",VK_OEM_3},
        {L"shift",VK_SHIFT},{L"ctrl",VK_CONTROL},{L"control",VK_CONTROL},{L"controlormeta",VK_CONTROL},{L"alt",VK_MENU},{L"option",VK_MENU},
        {L"super",VK_LWIN},{L"meta",VK_LWIN},{L"cmd",VK_LWIN},{L"command",VK_LWIN},
        {L"shift_l",VK_LSHIFT},{L"shift_r",VK_RSHIFT},{L"control_l",VK_LCONTROL},{L"control_r",VK_RCONTROL},
        {L"alt_l",VK_LMENU},{L"alt_r",VK_RMENU},{L"super_l",VK_LWIN},{L"super_r",VK_RWIN},{L"meta_l",VK_LWIN},{L"meta_r",VK_RWIN},
        {L"kp_enter",VK_RETURN},{L"kp_equal",VK_OEM_NEC_EQUAL},{L"kp_multiply",VK_MULTIPLY},{L"kp_add",VK_ADD},{L"kp_subtract",VK_SUBTRACT},
        {L"kp_decimal",VK_DECIMAL},{L"kp_divide",VK_DIVIDE},{L"clear",VK_CLEAR},{L"help",VK_HELP},{L"caps_lock",VK_CAPITAL}};
    if(auto found=known.find(name);found!=known.end())return static_cast<WORD>(found->second);
    if(name.size()==1&&((name[0]>=L'a'&&name[0]<=L'z')||(name[0]>=L'0'&&name[0]<=L'9')))return static_cast<WORD>(towupper(name[0]));
    if(name.size()>=2&&name[0]==L'f'&&name.substr(1).find_first_not_of(L"0123456789")==std::wstring::npos){int n=std::stoi(name.substr(1));if(n>=1&&n<=20)return static_cast<WORD>(VK_F1+n-1);}
    if(name.size()==4&&name.starts_with(L"kp_")&&name[3]>=L'0'&&name[3]<=L'9')return static_cast<WORD>(VK_NUMPAD0+name[3]-L'0');
    Fail("Unsupported keyboard key");
}
static void Press(HWND window,DWORD pid,const std::wstring& specification,double duration=0) {
    std::vector<std::wstring> parts;size_t offset=0;
    for(;;){auto end=specification.find(L'+',offset);parts.push_back(specification.substr(offset,end-offset));if(end==std::wstring::npos)break;offset=end+1;}
    auto name=parts.back();parts.pop_back();std::vector<WORD> modifiers;
    HKL layout=GetKeyboardLayout(GetWindowThreadProcessId(window,nullptr));WORD key;
    if(name==L"plus"||(name.size()==1&&name[0]>=33&&name[0]<=126)) {
        SHORT mapped=VkKeyScanExW(name==L"plus"?L'+':name[0],layout);
        if(mapped==-1)Fail("The current keyboard layout cannot produce this key");
        key=LOBYTE(mapped);BYTE required=HIBYTE(mapped);
        if(required&1)modifiers.push_back(VK_SHIFT);if(required&2)modifiers.push_back(VK_CONTROL);if(required&4)modifiers.push_back(VK_MENU);
    } else key=KeyCode(name);
    if(name==L"kp_equal"&&(MapVirtualKeyExW(key,MAPVK_VK_TO_CHAR,layout)&0xffff)!=L'=')Fail("The target keyboard layout does not expose keypad equal");
    for(auto& modifierName:parts){WORD value=0;if(modifierName==L"ctrl"||modifierName==L"control"||modifierName==L"controlormeta")value=VK_CONTROL;
        else if(modifierName==L"alt"||modifierName==L"option")value=VK_MENU;else if(modifierName==L"shift")value=VK_SHIFT;
        else if(modifierName==L"super"||modifierName==L"meta"||modifierName==L"cmd"||modifierName==L"command")value=VK_LWIN;
        else if(modifierName==L"shift_l"||modifierName==L"shift_r"||modifierName==L"control_l"||modifierName==L"control_r"||modifierName==L"alt_l"||modifierName==L"alt_r"||modifierName==L"super_l"||modifierName==L"super_r"||modifierName==L"meta_l"||modifierName==L"meta_r")value=KeyCode(modifierName);
        else Fail("Unsupported keyboard modifier");
        if(std::find(modifiers.begin(),modifiers.end(),value)==modifiers.end())modifiers.push_back(value);}
    for(WORD value:{static_cast<WORD>(VK_SHIFT),static_cast<WORD>(VK_CONTROL),static_cast<WORD>(VK_MENU),static_cast<WORD>(VK_LWIN),static_cast<WORD>(VK_RWIN),key})
        if(GetAsyncKeyState(value)&0x8000)Fail("A required input key is already held; leave physical input untouched");
    std::vector<INPUT> events;
    for(WORD value:modifiers)events.push_back(Key(value,Extended(value)?KEYEVENTF_EXTENDEDKEY:0,0,layout));
    bool extended=Extended(key)||name==L"kp_enter";
    events.push_back(Key(key,extended?KEYEVENTF_EXTENDEDKEY:0,0,layout));events.push_back(Key(key,KEYEVENTF_KEYUP|(extended?KEYEVENTF_EXTENDEDKEY:0),0,layout));
    for(auto it=modifiers.rbegin();it!=modifiers.rend();++it)events.push_back(Key(*it,KEYEVENTF_KEYUP|(Extended(*it)?KEYEVENTF_EXTENDEDKEY:0),0,layout));
    std::vector<INPUT> down(events.begin(),events.begin()+static_cast<std::ptrdiff_t>(modifiers.size()+1)),up(events.begin()+static_cast<std::ptrdiff_t>(modifiers.size()+1),events.end());
    UINT accepted=0;Cleanup cleanup{[&]{ReleaseKeys(down,accepted);}};Foreground(window,pid);Send(down,false,&accepted);Pause(static_cast<int>(duration*1000));Foreground(window,pid);Send(up);accepted=0;
}
static void Type(HWND window,DWORD pid,const std::wstring& text) {
    for(int key:{VK_SHIFT,VK_CONTROL,VK_MENU,VK_LWIN,VK_RWIN})if(GetAsyncKeyState(key)&0x8000)Fail("An input modifier is already held; leave physical input untouched");
    for(size_t offset=0;offset<text.size();){Foreground(window,pid);size_t count=std::min<size_t>(20,text.size()-offset);
        if(text[offset]==L'\r'||text[offset]==L'\n'){wchar_t newline=text[offset++];Press(window,pid,L"return");if(newline==L'\r'&&offset<text.size()&&text[offset]==L'\n')offset++;continue;}
        for(size_t i=0;i<count;i++)if(text[offset+i]==L'\r'||text[offset+i]==L'\n'){count=i;break;}
        if(offset+count<text.size()&&IS_HIGH_SURROGATE(text[offset+count-1]))count--;std::vector<INPUT> events;
        for(size_t i=0;i<count;i++){WORD character=static_cast<WORD>(text[offset+i]);events.push_back(Key(0,KEYEVENTF_UNICODE,character));events.push_back(Key(0,KEYEVENTF_UNICODE|KEYEVENTF_KEYUP,character));}
        UINT accepted=0;Cleanup cleanup{[&]{ReleaseKeys(events,accepted);}};Send(events,false,&accepted);offset+=count;}
}
static void SelectText(IUIAutomationElement* element,const JsonObject& args) {
    BOOL password=TRUE;element->get_CurrentIsPassword(&password);if(password)Fail("Secure fields do not expose selectable text");
    auto pattern=Pattern<IUIAutomationTextPattern>(element,UIA_TextPatternId);if(!pattern)Fail("This field does not expose native text selection");
    com_ptr<IUIAutomationTextRange> all;Require(pattern->get_DocumentRange(all.put()),"Text field range is unavailable");
    auto text=Text(args,L"text",50000),prefix=Text(args,L"prefix",50000,true),suffix=Text(args,L"suffix",50000,true),selection=Text(args,L"selection");
    auto match=prefix+text+suffix;BString needle;needle.value=SysAllocStringLen(match.data(),static_cast<UINT>(match.size()));if(!needle.value)Fail("Text selection allocation failed");
    com_ptr<IUIAutomationTextRange> found;Require(all->FindText(needle.value,FALSE,FALSE,found.put()),"Text selection lookup failed");if(!found)Fail("Selection text is no longer present");
    com_ptr<IUIAutomationTextRange> tail;Require(all->Clone(tail.put()),"Text range could not be copied");
    Require(tail->MoveEndpointByRange(TextPatternRangeEndpoint_Start,found.get(),TextPatternRangeEndpoint_Start),"Text range boundary is unavailable");int moved=0;
    Require(tail->MoveEndpointByUnit(TextPatternRangeEndpoint_Start,TextUnit_Character,1,&moved),"Text range boundary is unavailable");com_ptr<IUIAutomationTextRange> another;
    Require(tail->FindText(needle.value,FALSE,FALSE,another.put()),"Text selection uniqueness check failed");if(another)Fail("Selection text is ambiguous; provide its prefix and suffix");
    if(!prefix.empty()){Require(found->MoveEndpointByUnit(TextPatternRangeEndpoint_Start,TextUnit_Character,static_cast<int>(prefix.size()),&moved),"Text selection start failed");if(moved!=static_cast<int>(prefix.size()))Fail("Text selection offset changed");}
    if(!suffix.empty()){Require(found->MoveEndpointByUnit(TextPatternRangeEndpoint_End,TextUnit_Character,-static_cast<int>(suffix.size()),&moved),"Text selection end failed");if(moved!=-static_cast<int>(suffix.size()))Fail("Text selection offset changed");}
    if(selection==L"cursor_before")Require(found->MoveEndpointByRange(TextPatternRangeEndpoint_End,found.get(),TextPatternRangeEndpoint_Start),"Text cursor placement failed");
    else if(selection==L"cursor_after")Require(found->MoveEndpointByRange(TextPatternRangeEndpoint_Start,found.get(),TextPatternRangeEndpoint_End),"Text cursor placement failed");
    else if(selection!=L"text")Fail("Unsupported text selection mode");
    Require(element->SetFocus(),"Text field could not receive focus");Require(found->Select(),"Native text selection failed");
}
static void Secondary(IUIAutomationElement* element,const std::wstring& action) {
    if(action==L"Invoke"){auto p=Pattern<IUIAutomationInvokePattern>(element,UIA_InvokePatternId);if(p){Require(p->Invoke(),"Native Invoke failed; action was not retried");return;}}
    if(action==L"Toggle"){auto p=Pattern<IUIAutomationTogglePattern>(element,UIA_TogglePatternId);if(p){Require(p->Toggle(),"Native Toggle failed; action was not retried");return;}}
    if(action==L"Expand"||action==L"Collapse"){auto p=Pattern<IUIAutomationExpandCollapsePattern>(element,UIA_ExpandCollapsePatternId);if(p){Require(action==L"Expand"?p->Expand():p->Collapse(),"Native expansion failed; action was not retried");return;}}
    if(action==L"Select"){auto p=Pattern<IUIAutomationSelectionItemPattern>(element,UIA_SelectionItemPatternId);if(p){Require(p->Select(),"Native Select failed; action was not retried");return;}}
    Fail("Element no longer exposes the requested secondary action");
}
static JsonObject Action(const JsonObject& args) {
    Presence(args);auto identity=args.GetNamedObject(L"app");DWORD pid=VerifyApp(identity);HWND window=WindowFor(pid);Foreground(window,pid);RECT bounds=WindowBounds(window);
    auto expected=static_cast<UINT_PTR>(Number(args,L"windowId",1,9007199254740991));
    if(reinterpret_cast<UINT_PTR>(window)!=expected||!SameBounds(bounds,ReadBounds(args.GetNamedObject(L"windowBounds"))))Fail("Approved window changed; read fresh app state before sending input");
    auto automation=create_instance<IUIAutomation>(CLSID_CUIAutomation);com_ptr<IUIAutomationElement> element;
    if(args.HasKey(L"element"))element=Element(automation.get(),window,args.GetNamedObject(L"element"));auto name=Text(args,L"name");
    if(name==L"click"){
        if(args.HasKey(L"key")||args.HasKey(L"duration"))Fail("Computer Use click key and duration are unavailable on Windows");
        auto button=Text(args,L"mouse_button");int count=static_cast<int>(Number(args,L"click_count",1,5));
        auto invoke=element?Pattern<IUIAutomationInvokePattern>(element.get(),UIA_InvokePatternId):com_ptr<IUIAutomationInvokePattern>{};
        if(invoke&&count==1&&button==L"left"){Foreground(window,pid);Require(invoke->Invoke(),"Native Invoke failed; action was not retried");}
        else{POINT point{};if(element){RECT r{};Require(element->get_CurrentBoundingRectangle(&r),"Element bounds are unavailable");point={(r.left+r.right)/2,(r.top+r.bottom)/2};if(!PtInRect(&bounds,point))Fail("Element is outside the approved window");}
            else point=Point(args.GetNamedObject(L"point"),bounds);Mouse(window,pid,point,button,count);}
    }else if(name==L"perform_secondary_action"){if(!element)Fail("An accessibility element is required");Foreground(window,pid);Secondary(element.get(),Text(args,L"action",512));
    }else if(name==L"set_value"){
        if(!element)Fail("An accessibility element is required");auto pattern=Pattern<IUIAutomationValuePattern>(element.get(),UIA_ValuePatternId);BOOL readonly=TRUE;
        if(!pattern||FAILED(pattern->get_CurrentIsReadOnly(&readonly))||readonly)Fail("Element value is not writable");auto value=Text(args,L"value",50000,true);Foreground(window,pid);
        BString text;text.value=SysAllocStringLen(value.data(),static_cast<UINT>(value.size()));if(!text.value)Fail("Value allocation failed");
        Require(pattern->SetValue(text.value),"Native value write failed; action was not retried");
    }else if(name==L"select_text"){if(!element)Fail("An accessibility element is required");Foreground(window,pid);SelectText(element.get(),args);
    }else if(name==L"press_key")Press(window,pid,Text(args,L"key",128),args.HasKey(L"duration")?Number(args,L"duration",0,30):0);
    else if(name==L"type_text")Type(window,pid,Text(args,L"text",50000,true));
    else if(name==L"scroll"){
        if(!element)Fail("An accessibility element is required");auto direction=Text(args,L"direction");double pages=Number(args,L"pages",0.1,10);
        if(direction!=L"up"&&direction!=L"down"&&direction!=L"left"&&direction!=L"right")Fail("Unsupported scroll direction");
        auto scroll=Pattern<IUIAutomationScrollPattern>(element.get(),UIA_ScrollPatternId);
        if(scroll&&std::floor(pages)==pages){for(int i=0;i<static_cast<int>(pages);i++){Foreground(window,pid);Require(scroll->Scroll(direction==L"left"?ScrollAmount_LargeDecrement:direction==L"right"?ScrollAmount_LargeIncrement:ScrollAmount_NoAmount,
            direction==L"up"?ScrollAmount_LargeDecrement:direction==L"down"?ScrollAmount_LargeIncrement:ScrollAmount_NoAmount),"Native scroll failed; action was not retried");}}
        else{RECT r{};Require(element->get_CurrentBoundingRectangle(&r),"Scroll element bounds are unavailable");POINT point{(r.left+r.right)/2,(r.top+r.bottom)/2};if(!PtInRect(&bounds,point))Fail("Scroll element is outside the approved window");PointerTarget(window,pid,point);
            LONG delta=static_cast<LONG>(std::lround(pages*WHEEL_DELTA));if(direction==L"down"||direction==L"left")delta=-delta;
            std::vector<INPUT> events{Pointer(point,MOUSEEVENTF_MOVE),Pointer(point,direction==L"left"||direction==L"right"?MOUSEEVENTF_HWHEEL:MOUSEEVENTF_WHEEL,static_cast<DWORD>(delta))};Send(events);}
    }else if(name==L"drag"){
        for(int key:{VK_LBUTTON,VK_RBUTTON,VK_MBUTTON,VK_XBUTTON1,VK_XBUTTON2})if(GetAsyncKeyState(key)&0x8000)Fail("A mouse button is already held; leave physical input untouched");
        POINT from=Point(args.GetNamedObject(L"from"),bounds),to=Point(args.GetNamedObject(L"to"),bounds);PointerTarget(window,pid,from);PointerTarget(window,pid,to);
        POINT current=from;UINT accepted=0;Cleanup release{[&]{if(accepted==2){std::vector<INPUT> input{Pointer(current,MOUSEEVENTF_LEFTUP)};Send(input,true);}}};
        std::vector<INPUT> begin{Pointer(from,MOUSEEVENTF_MOVE),Pointer(from,MOUSEEVENTF_LEFTDOWN)};Send(begin,false,&accepted);
        for(int i=1;i<=10;i++){Presence(args);Foreground(window,pid);current={from.x+(to.x-from.x)*i/10,from.y+(to.y-from.y)*i/10};PointerTarget(window,pid,current);std::vector<INPUT> move{Pointer(current,MOUSEEVENTF_MOVE)};Send(move);Pause(15);}
    }else Fail("Unknown Computer Use input operation");
    Pause(120);JsonObject result;result.Insert(L"applied",B(true));return result;
}
static JsonObject ListApps() {
    JsonArray apps;std::set<DWORD> seen;for(const auto& window:AppWindows())if(seen.insert(window.pid).second){auto value=Identity(window.path,BaseName(window.path),window.pid);value.Insert(L"running",B(true));apps.Append(value);if(apps.Size()>=80)break;}
    JsonObject result;result.Insert(L"apps",apps);return result;
}
static std::string Line(size_t limit) {
    std::string text;char c;while(std::cin.get(c)){if(c=='\n')break;if(text.size()>=limit)Fail("Native input exceeds its byte limit");text.push_back(c);}return text;
}
int main() {
    _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);std::ios::sync_with_stdio(false);started=Clock::now();
    try { init_apartment(apartment_type::multi_threaded); } catch (...) { std::cout << "{\"ok\":false,\"error\":\"Windows COM initialization failed\"}\n"; return 2; }
    JsonObject response;
    try {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        auto request=JsonObject::Parse(to_hstring(Line(256*1024)));for(auto key:{L"resourceId",L"operationId",L"generation",L"sequence"})response.Insert(key,request.GetNamedValue(key));
        Text(request,L"resourceId");Text(request,L"operationId");Number(request,L"generation",1,9007199254740991);Number(request,L"sequence",1,9007199254740991);
        // EOF or any later control frame cancels this one private operation. The
        // host keeps stdin open and waits for the actual process/stdio close.
        std::thread([]{try{Line(1024);}catch(...){}cancelled.store(true);}).detach();
        auto method=Text(request,L"method");auto args=request.GetNamedObject(L"args");JsonObject result;
        if(method==L"action"&&Text(args,L"name")==L"press_key"&&args.HasKey(L"duration"))operationDeadline=std::max(operationDeadline,13+Number(args,L"duration",0,30));
        if(method==L"capabilities"){InteractiveSession();auto automation=create_instance<IUIAutomation>(CLSID_CUIAutomation);result.Insert(L"version",N(1));result.Insert(L"supported",B(automation&&GraphicsCaptureSession::IsSupported()));}
        else if(method==L"resolve")result=Resolve(Text(args,L"input"));else if(method==L"activate")result=Activate(args);else if(method==L"state")result=State(args);
        else if(method==L"action")result=Action(args);else if(method==L"listApps")result=ListApps();else Fail("Unknown Computer Use native method");
        Check();response.Insert(L"ok",B(true));response.Insert(L"result",result);
    }catch(const std::exception& error){response.Insert(L"ok",B(false));response.Insert(L"error",S(to_hstring(error.what())));}
    catch(const hresult_error& error){response.Insert(L"ok",B(false));response.Insert(L"error",S(L"Computer Use OS call failed (HRESULT "+std::to_wstring(static_cast<uint32_t>(error.code().value))+L")"));}
    catch(...){response.Insert(L"ok",B(false));response.Insert(L"error",S(L"Computer Use native operation failed"));}
    response.Insert(L"postedAt",N(postedAt));auto output=to_string(response.Stringify());if(output.size()>24*1024*1024)return 3;
    std::cout<<output<<'\n';std::cout.flush();return std::cout.good()?0:4;
}
