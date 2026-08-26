namespace TokenTrackerWin;

internal static class Program
{
    // Stable per-user mutex name so a second launch just exits.
    private const string SingleInstanceMutexName = "TokenTracker.Windows.Tray.SingleInstance";

    [STAThread]
    private static void Main(string[] args)
    {
        // Windows launches us with the full tokentracker://… URL as an argument when a
        // deep link fires (OAuth callback). Extract it if present.
        var deepLink = FindDeepLink(args);
        var launchedAtStartup = args.Any(a =>
            string.Equals(a, LaunchAtStartup.StartupArgument, StringComparison.OrdinalIgnoreCase));
        Diag.Log("program", $"Main argc={args.Length} deepLink={(deepLink ?? "<none>")} startup={launchedAtStartup}");

        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var isNew);
        Diag.Log("program", $"mutex isNew={isNew}");
        if (!isNew)
        {
            // Already running: if launched to handle a deep link, hand it to the live
            // instance. Either way a second copy must exit (single-instance app).
            if (deepLink is not null)
            {
                var ok = SingleInstance.TryForwardToPrimary(deepLink);
                Diag.Log("program", $"forwarded deepLink to primary: {ok}");
            }
            return;
        }

        // Primary instance: make tokentracker:// point at this exe so the OAuth callback
        // (in the system browser) can deep-link the code back to us.
        UrlProtocol.EnsureRegistered();

        // A WPF Application instance gives the (WPF) dashboard window its resource /
        // dispatcher context. We never call its Run(); the WinForms message pump below
        // drives the shared STA thread (and the WPF Dispatcher rides on it). Explicit
        // shutdown mode so WPF doesn't tear itself down when the window is hidden.
        var wpfApp = new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnExplicitShutdown };

        // 全局异常兜底:托盘常驻进程不能因单次 UI 线程异常直接崩溃退出(用户表现为
        // "点击宠物后整个程序消失")。WebView2 runtime 进入坏状态时 Navigate /
        // ExecuteScriptAsync 可能抛 COMException,任何遗漏 try/catch 的路径都会沿
        // UI 线程上抛 —— 这里统一捕获、写日志、标记已处理,进程保活自愈。
        System.Windows.Threading.DispatcherUnhandledExceptionEventHandler OnWpfUnhandled =
            (_, e) =>
            {
                Diag.Log("crash", $"dispatcher unhandled: {e.Exception}");
                e.Handled = true;
            };
        wpfApp.Dispatcher.UnhandledException += OnWpfUnhandled;
        System.Threading.ThreadExceptionEventHandler OnWinFormsUnhandled =
            (_, e) => Diag.Log("crash", $"winforms thread exception: {e.Exception}");
        System.Windows.Forms.Application.ThreadException += OnWinFormsUnhandled;
        System.Windows.Forms.Application.SetUnhandledExceptionMode(
            System.Windows.Forms.UnhandledExceptionMode.CatchException);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Diag.Log("crash", $"appdomain unhandled (terminating={e.IsTerminating}): {e.ExceptionObject}");

        ApplicationConfiguration.Initialize();
        // Show the desktop pet on a normal launch (manual run or post-install), but stay
        // quietly in the tray when Windows auto-starts us at login or when we were only
        // spun up to relay an OAuth deep link (the pet then restores only if it was open
        // last exit). The dashboard no longer auto-opens — the pet is the visible presence.
        var showPetOnLaunch = deepLink is null && !launchedAtStartup;
        var ctx = new TrayApplicationContext(showPetOnLaunch);

        // Listen for deep links forwarded by secondary launches.
        using var listenerCts = new CancellationTokenSource();
        SingleInstance.StartListener(ctx.HandleDeepLink, listenerCts.Token);

        // Cold start via a deep link (app wasn't already running): handle it once ready.
        if (deepLink is not null) ctx.HandleDeepLink(deepLink);

        Application.Run(ctx);

        listenerCts.Cancel();
        GC.KeepAlive(mutex);
    }

    private static string? FindDeepLink(string[] args)
    {
        foreach (var a in args)
        {
            if (a.StartsWith(UrlProtocol.Scheme + "://", StringComparison.OrdinalIgnoreCase))
                return a;
        }
        return null;
    }
}
