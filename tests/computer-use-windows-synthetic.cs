using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class ComputerUseSyntheticApp
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        if (!new DirectoryInfo(root).Name.StartsWith("klaus-computer-use-windows-", StringComparison.Ordinal))
            throw new InvalidOperationException("An isolated Computer Use fixture directory is required");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new Form { Text = "Klaus CU Windows Native Fixture", Width = 520, Height = 340,
            StartPosition = FormStartPosition.Manual, Left = 420, Top = 220 })
        using (var timer = new Timer { Interval = 60000 })
        {
            form.Controls.Add(new Label { Text = "Only synthetic fixture content", AutoSize = true, Left = 30, Top = 35 });
            form.Controls.Add(new TextBox { Text = "Synthetic native field", AccessibleName = "Native fixture field", Left = 30, Top = 85, Width = 300 });
            form.Shown += delegate {
                File.WriteAllText(Path.Combine(root, "native-fixture.json"), "{\"pid\":" + Process.GetCurrentProcess().Id + "}");
                timer.Start();
            };
            timer.Tick += delegate { form.Close(); };
            Application.Run(form);
        }
    }
}
