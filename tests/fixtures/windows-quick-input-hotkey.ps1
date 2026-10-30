$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class KlausQuickInputHotkey {
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
  [DllImport("user32.dll")]
  static extern bool CloseDesktop(IntPtr handle);
  [DllImport("user32.dll")]
  static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint count, IntPtr inputs, int size);

  static uint Send(ushort[] keys, bool releaseOnly) {
    int size = IntPtr.Size == 8 ? 40 : 28;
    int keyOffset = IntPtr.Size == 8 ? 8 : 4;
    int count = releaseOnly ? keys.Length : keys.Length * 2;
    var bytes = new byte[size * count];
    for (int i = 0; i < count; i++) {
      bool up = releaseOnly || i >= keys.Length;
      ushort key = keys[up ? count - i - 1 : i];
      BitConverter.GetBytes(1u).CopyTo(bytes, i * size);
      BitConverter.GetBytes(key).CopyTo(bytes, i * size + keyOffset);
      BitConverter.GetBytes(up ? 2u : 0u).CopyTo(bytes, i * size + keyOffset + 4);
    }
    IntPtr buffer = Marshal.AllocHGlobal(bytes.Length);
    try { Marshal.Copy(bytes, 0, buffer, bytes.Length); return SendInput((uint)count, buffer, size); }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  public static string Run() {
    int session = Process.GetCurrentProcess().SessionId;
    if (session == 0) throw new InvalidOperationException("Interactive hotkey acceptance requires a user desktop session");
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "The input desktop is unavailable; do not bypass a locked desktop");
    string name;
    try {
      var value = new StringBuilder(256); uint needed;
      if (!GetUserObjectInformation(desktop, 2, value, 512, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
      name = value.ToString();
    } finally { CloseDesktop(desktop); }
    if (!String.Equals(name, "Default", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The input desktop is not the ordinary user desktop: " + name);
    ushort[] keys = { 0x11, 0x12, 0x10, 0x79 }; // Control, Alt, Shift, F10.
    foreach (ushort key in keys) if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new InvalidOperationException("A fixture hotkey key is already held; leave user input untouched");
    uint inserted = Send(keys, false);
    if (inserted != 8) {
      int error = Marshal.GetLastWin32Error(); Send(keys, true);
      throw new Win32Exception(error, "Native input was not delivered: " + inserted + "/8");
    }
    return "hotkeySessionId=" + session + ";inputDesktop=" + name + ";nativeInputs=" + inserted;
  }
}
'@
[KlausQuickInputHotkey]::Run()
