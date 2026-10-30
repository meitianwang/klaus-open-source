param([Parameter(Mandatory=$true)][string]$Identity,[Parameter(Mandatory=$true)][ValidateSet('legacy','mutex-only','send')][string]$Mode,[string]$MessagePath='',[Parameter(Mandatory=$true)][string]$ControlPath,[int]$Tag=1542)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
if ($Identity -notmatch '^ai\.klaus\.instance-fixture\.[a-zA-Z0-9.-]+$') { throw 'An isolated fixture identity is required' }
# A protocol peer, not an application implementation. Only public synthetic bytes
# and this fixture's hidden window/mutex are accessible to the test process.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class InstancePeer {
  delegate IntPtr Procedure(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Class { public uint size; public uint style; public Procedure procedure; public int clsExtra; public int wndExtra; public IntPtr instance; public IntPtr icon; public IntPtr cursor; public IntPtr background; public string menu; public string name; public IntPtr smallIcon; }
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd; public uint message; public UIntPtr wparam; public IntPtr lparam; public uint time; public int x; public int y; public uint extra; }
  [StructLayout(LayoutKind.Sequential)] struct Copy { public UIntPtr tag; public uint size; public IntPtr data; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateMutexW(IntPtr security,bool owner,string name);
  [DllImport("kernel32.dll")] static extern bool ReleaseMutex(IntPtr mutex);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClassExW(ref Class value);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex,string cls,string title,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool UnregisterClassW(string name,IntPtr instance);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW(string cls,string title);
  [DllImport("user32.dll")] static extern bool PeekMessageW(out Message message,IntPtr window,uint min,uint max,uint remove);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr window,uint message,IntPtr wparam,ref Copy copy,uint flags,uint timeout,out UIntPtr result);
  static Procedure callback = Receive;
  static IntPtr Receive(IntPtr window,uint message,IntPtr wparam,IntPtr lparam) {
    if (message==74) {
      var copy=(Copy)Marshal.PtrToStructure(lparam,typeof(Copy));
      if (copy.tag.ToUInt64()!=1542 || copy.size>32768 || copy.size==0) return IntPtr.Zero;
      var bytes=new byte[copy.size]; Marshal.Copy(copy.data,bytes,0,bytes.Length);
      Console.WriteLine("INSTANCE {\"type\":\"wire\",\"base64\":\""+Convert.ToBase64String(bytes)+"\"}");
      return new IntPtr(1);
    }
    return DefWindowProcW(window,message,wparam,lparam);
  }
  public static void Run(string identity,string mode,string encoded,int tag,string control) {
    if (mode=="send") {
      var window=FindWindowW(identity+"-sic",identity+"-siw"); if(window==IntPtr.Zero) throw new Exception("fixture window missing");
      var bytes=Convert.FromBase64String(encoded); var memory=Marshal.AllocHGlobal(bytes.Length);
      try {
        Marshal.Copy(bytes,0,memory,bytes.Length); var copy=new Copy {tag=new UIntPtr((uint)tag),size=(uint)bytes.Length,data=memory}; UIntPtr accepted;
        var sent=SendMessageTimeoutW(window,74,IntPtr.Zero,ref copy,2|1|32,1000,out accepted);
        Console.WriteLine("INSTANCE {\"type\":\"sent\",\"accepted\":"+accepted.ToUInt64()+",\"completed\":"+(sent!=IntPtr.Zero?"true":"false")+"}");
      } finally {Marshal.FreeHGlobal(memory);} return;
    }
    var mutex=CreateMutexW(IntPtr.Zero,true,identity+"-sim");
    if(mutex==IntPtr.Zero || Marshal.GetLastWin32Error()==183) throw new Exception("fixture mutex conflict");
    IntPtr hwnd=IntPtr.Zero; var module=GetModuleHandleW(null); bool registered=false;
    try {
      if(mode=="legacy") {
        var cls=new Class {size=(uint)Marshal.SizeOf(typeof(Class)),procedure=callback,instance=module,name=identity+"-sic"};
        if(RegisterClassExW(ref cls)==0) throw new Exception("fixture class failure"); registered=true;
        hwnd=CreateWindowExW(0x08000000|0x80,identity+"-sic",identity+"-siw",0x80000000,0,0,0,0,IntPtr.Zero,IntPtr.Zero,module,IntPtr.Zero);
        if(hwnd==IntPtr.Zero) throw new Exception("fixture window failure");
      }
      Console.WriteLine("INSTANCE {\"type\":\"ready\"}");
      // Console.In.ReadLineAsync can synchronously block on .NET Framework.
      // A private bounded control file keeps this thread pumping WM_COPYDATA.
      var until=DateTime.UtcNow.AddSeconds(20);
      while(DateTime.UtcNow<until) {
        var input=System.IO.File.ReadAllText(control); if(input.Length>16384) throw new Exception("fixture control bound");
        if(input.Contains("close\n")) break;
        Message message; while(PeekMessageW(out message,IntPtr.Zero,0,0,1)) DispatchMessageW(ref message); Thread.Sleep(5);
      }
    } finally { if(hwnd!=IntPtr.Zero) DestroyWindow(hwnd); ReleaseMutex(mutex); CloseHandle(mutex); if(registered) UnregisterClassW(identity+"-sic",module); }
  }
}
'@
$encoded=if($MessagePath){[Convert]::ToBase64String([IO.File]::ReadAllBytes($MessagePath))}else{''}
[InstancePeer]::Run($Identity,$Mode,$encoded,$Tag,$ControlPath)
