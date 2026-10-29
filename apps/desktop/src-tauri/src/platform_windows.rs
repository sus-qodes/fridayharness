//! The Windows calls the shell needs (the shell is Windows only in M9; ERRATA F36). Every
//! function has a fallback on other systems so the pure modules still build and test there.

use std::net::{Ipv4Addr, SocketAddrV4};

/// One row of the TCP table: local and remote endpoints and the owning process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcpRow {
    pub local: SocketAddrV4,
    pub remote: SocketAddrV4,
    pub pid: u32,
}

/// The pid of the process on the other end of the connection `local -> remote`: the row whose
/// local endpoint is our remote and whose remote endpoint is our local.
pub fn peer_pid_in(rows: &[TcpRow], local: SocketAddrV4, remote: SocketAddrV4) -> Option<u32> {
    let mut found = rows.iter().filter(|r| r.local == remote && r.remote == local);
    let first = found.next()?;
    // Two rows for one endpoint pair cannot be told apart: refuse rather than guess.
    if found.next().is_some() {
        return None;
    }
    Some(first.pid)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HWND, LPARAM, LRESULT, POINT, RECT, STILL_ACTIVE, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    use windows::Win32::Security::Credentials::{
        CredUIPromptForCredentialsW, CREDUI_FLAGS_ALWAYS_SHOW_UI, CREDUI_FLAGS_DO_NOT_PERSIST,
        CREDUI_FLAGS_EXCLUDE_CERTIFICATES, CREDUI_FLAGS_GENERIC_CREDENTIALS, CREDUI_FLAGS_KEEP_USERNAME,
        CREDUI_INFOW,
    };
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
        UOI_NAME,
    };
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyboardLayoutList, MapVirtualKeyExW, ToUnicodeEx, HKL, MAPVK_VK_TO_VSC, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, STYLESTRUCT, WM_STYLECHANGING,
        WS_EX_TOOLWINDOW,
    };

    pub fn pid_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        // SAFETY: plain Win32 calls; the handle is closed before returning.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code).is_ok();
            let _ = CloseHandle(h);
            ok && code == STILL_ACTIVE.0 as u32
        }
    }

    fn endpoint(addr: u32, port: u32) -> SocketAddrV4 {
        // Both are stored in network byte order; the port in the low 16 bits.
        SocketAddrV4::new(Ipv4Addr::from(u32::from_be(addr)), u16::from_be((port & 0xffff) as u16))
    }

    fn tcp_rows() -> Option<Vec<TcpRow>> {
        let mut size = 0u32;
        // SAFETY: the first call only asks for the size; the second fills a buffer of that size.
        unsafe {
            let _ = GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_CONNECTIONS, 0);
            for _ in 0..4 {
                let mut buf = vec![0u8; size as usize + 4096];
                size = buf.len() as u32;
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr().cast()),
                    &mut size,
                    false,
                    AF_INET.0 as u32,
                    TCP_TABLE_OWNER_PID_CONNECTIONS,
                    0,
                );
                if rc == 122 {
                    // ERROR_INSUFFICIENT_BUFFER: the table grew; try again with the new size.
                    continue;
                }
                if rc != 0 {
                    return None;
                }
                let count = u32::from_ne_bytes(buf[0..4].try_into().ok()?) as usize;
                let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
                if 4 + count * row_size > buf.len() {
                    return None;
                }
                let mut rows = Vec::with_capacity(count);
                for i in 0..count {
                    let p = buf.as_ptr().add(4 + i * row_size).cast::<MIB_TCPROW_OWNER_PID>();
                    let r = std::ptr::read_unaligned(p);
                    rows.push(TcpRow {
                        local: endpoint(r.dwLocalAddr, r.dwLocalPort),
                        remote: endpoint(r.dwRemoteAddr, r.dwRemotePort),
                        pid: r.dwOwningPid,
                    });
                }
                return Some(rows);
            }
            None
        }
    }

    pub fn tcp_peer_pid(local: SocketAddrV4, remote: SocketAddrV4) -> Option<u32> {
        peer_pid_in(&tcp_rows()?, local, remote)
    }

    /// True while the screen is locked (the input desktop is not the user's `Default` desktop).
    pub fn session_locked() -> bool {
        // SAFETY: plain Win32 calls; the desktop handle is closed before returning.
        unsafe {
            let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else {
                return true;
            };
            let mut name = [0u16; 64];
            let mut needed = 0u32;
            let ok = GetUserObjectInformationW(
                windows::Win32::Foundation::HANDLE(desk.0),
                UOI_NAME,
                Some(name.as_mut_ptr().cast()),
                (name.len() * 2) as u32,
                Some(&mut needed),
            )
            .is_ok();
            let _ = CloseDesktop(desk);
            if !ok {
                return false;
            }
            let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
            !String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Default")
        }
    }

    pub fn cursor_physical() -> Option<(i32, i32)> {
        let mut p = POINT::default();
        // SAFETY: `p` is a valid out pointer.
        unsafe { GetCursorPos(&mut p).ok()? };
        Some((p.x, p.y))
    }

    /// The character Ctrl+Alt(+Shift)+`vk` types on one of the installed keyboard layouts, if
    /// any: Windows reads Ctrl+Alt as AltGr, so such a global shortcut would take that character
    /// away from the user.
    pub fn ctrl_alt_types(vk: u16, shift: bool) -> Option<String> {
        let mut layouts = [HKL::default(); 64];
        // SAFETY: the buffer is valid for its length.
        let count = unsafe { GetKeyboardLayoutList(Some(&mut layouts[..])) };
        let count = usize::try_from(count).unwrap_or(0).min(layouts.len());
        let mut state = [0u8; 256];
        state[VK_CONTROL.0 as usize] = 0x80;
        state[VK_MENU.0 as usize] = 0x80;
        if shift {
            state[VK_SHIFT.0 as usize] = 0x80;
        }
        for &layout in &layouts[..count] {
            // SAFETY: plain Win32 calls with valid buffers.
            let scan = unsafe { MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC, Some(layout)) };
            let mut buf = [0u16; 8];
            // Flag 0x4 leaves the keyboard state alone (a dead key met here changes nothing).
            let n = unsafe { ToUnicodeEx(u32::from(vk), scan, &state, &mut buf, 0x4, Some(layout)) };
            let typed = match n {
                n if n < 0 => String::from_utf16_lossy(&buf[..1]),
                0 => continue,
                n => String::from_utf16_lossy(&buf[..(n as usize).min(buf.len())]),
            };
            if typed.chars().any(|c| !c.is_control()) {
                return Some(typed);
            }
        }
        None
    }

    fn hwnd(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    /// Limits the window to one rectangle of its own (client) pixels, or removes the limit. Outside
    /// the rectangle the window does not exist for the mouse: clicks reach the window beneath.
    pub fn set_window_region(raw: isize, rect: Option<(i32, i32, i32, i32)>) -> bool {
        // SAFETY: on success the system owns the region; on failure nothing is leaked that
        // matters (a GDI region handle of a few bytes).
        unsafe {
            match rect {
                Some((x, y, w, h)) => {
                    let rgn = CreateRectRgn(x, y, x + w.max(0), y + h.max(0));
                    SetWindowRgn(hwnd(raw), Some(rgn), true) != 0
                }
                None => SetWindowRgn(hwnd(raw), None, true) != 0,
            }
        }
    }

    const KEEP_TOOL_WINDOW_ID: usize = 0xF1D4;

    unsafe extern "system" fn keep_tool_window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_STYLECHANGING && wparam.0 as i32 == GWL_EXSTYLE.0 {
            // SAFETY: for WM_STYLECHANGING, lParam points at the STYLESTRUCT being applied.
            let s = lparam.0 as *mut STYLESTRUCT;
            if !s.is_null() {
                unsafe { (*s).styleNew |= WS_EX_TOOLWINDOW.0 };
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    /// Keeps `WS_EX_TOOLWINDOW` (out of Alt+Tab) on a window, whatever later rewrites its
    /// extended style: the windowing library recomputes the whole style on every flag change.
    pub fn keep_tool_window(raw: isize) -> bool {
        // SAFETY: the subclass procedure lives for the program; the window is ours.
        unsafe {
            let h = hwnd(raw);
            let ok: BOOL = SetWindowSubclass(h, Some(keep_tool_window_proc), KEEP_TOOL_WINDOW_ID, 0);
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
            ok.as_bool()
        }
    }

    /// The window that has the keyboard now (0 when none).
    pub fn foreground() -> isize {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        // SAFETY: a plain Win32 call.
        unsafe { GetForegroundWindow().0 as isize }
    }

    /// Gives the keyboard back to a window (allowed while this process has the foreground).
    pub fn set_foreground(raw: isize) {
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
        // SAFETY: plain Win32 calls; a stale handle is checked first.
        unsafe {
            if IsWindow(Some(hwnd(raw))).as_bool() {
                let _ = SetForegroundWindow(hwnd(raw));
            }
        }
    }

    /// Opens a file or a URI with its registered handler (`ShellExecuteW`, verb "open"): no
    /// command line is built, so nothing in the target is parsed as an argument.
    pub fn shell_open(target: &str) -> bool {
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let verb = wide("open");
        let file = wide(target);
        // SAFETY: both strings are NUL-terminated and outlive the call.
        let r = unsafe {
            ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(file.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
        };
        r.0 as isize > 32
    }

    /// The window's extended style (verification).
    #[cfg_attr(not(feature = "probe"), allow(dead_code))]
    pub fn ex_style(raw: isize) -> isize {
        // SAFETY: reads a window long of our own window.
        unsafe { GetWindowLongPtrW(hwnd(raw), GWL_EXSTYLE) }
    }

    /// Whether the window under a screen point is `raw` (or one of its children).
    #[cfg_attr(not(feature = "probe"), allow(dead_code))]
    pub fn window_at_is(x: i32, y: i32, raw: isize) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
        // SAFETY: plain Win32 calls.
        unsafe {
            let w = WindowFromPoint(POINT { x, y });
            if w.0.is_null() {
                return false;
            }
            GetAncestor(w, GA_ROOT).0 as isize == raw
        }
    }

    /// The window's rectangle on screen in physical pixels (verification).
    #[cfg_attr(not(feature = "probe"), allow(dead_code))]
    pub fn window_rect(raw: isize) -> Option<(i32, i32, i32, i32)> {
        use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
        let mut r = RECT::default();
        // SAFETY: `r` is a valid out pointer.
        unsafe { GetWindowRect(hwnd(raw), &mut r).ok()? };
        Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A string value of a key under `HKEY_CURRENT_USER`; None when either is missing.
    pub fn reg_get_string(subkey: &str, name: &str) -> Option<String> {
        let (key, value) = (wide(subkey), wide(name));
        let mut size = 0u32;
        // SAFETY: the first call only asks for the size; the second fills a buffer of that size.
        unsafe {
            let get = |data: Option<*mut core::ffi::c_void>, size: &mut u32| {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(value.as_ptr()),
                    RRF_RT_REG_SZ,
                    None,
                    data,
                    Some(size),
                )
            };
            if get(None, &mut size) != ERROR_SUCCESS {
                return None;
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
            size = (buf.len() * 2) as u32;
            if get(Some(buf.as_mut_ptr().cast()), &mut size) != ERROR_SUCCESS {
                return None;
            }
            let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        }
    }

    /// Writes a string value of a key under `HKEY_CURRENT_USER` (the key is created if missing).
    pub fn reg_set_string(subkey: &str, name: &str, data: &str) -> bool {
        let (key, value, text) = (wide(subkey), wide(name), wide(data));
        // SAFETY: every string is NUL-terminated and outlives the call; the size counts the NUL.
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(value.as_ptr()),
                REG_SZ.0,
                Some(text.as_ptr().cast()),
                (text.len() * 2) as u32,
            ) == ERROR_SUCCESS
        }
    }

    /// Removes a value of a key under `HKEY_CURRENT_USER`; true when it is gone (or never was).
    pub fn reg_delete_value(subkey: &str, name: &str) -> bool {
        let (key, value) = (wide(subkey), wide(name));
        // SAFETY: both strings are NUL-terminated and outlive the call.
        let rc = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(value.as_ptr())) };
        rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND
    }

    /// Windows' own credential prompt with a hidden password field; the user name is fixed. The
    /// secret is returned once and the prompt's buffer is cleared.
    pub fn prompt_secret(parent: Option<isize>, caption: &str, message: &str, user: &str) -> Option<String> {
        let caption_w = wide(&caption.chars().take(120).collect::<String>());
        let message_w = wide(&message.chars().take(1000).collect::<String>());
        let target_w = wide("Friday");
        let info = CREDUI_INFOW {
            cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
            hwndParent: parent.map(hwnd).unwrap_or_default(),
            pszMessageText: PCWSTR(message_w.as_ptr()),
            pszCaptionText: PCWSTR(caption_w.as_ptr()),
            hbmBanner: Default::default(),
        };
        let mut user_buf = [0u16; 514];
        for (i, c) in user.encode_utf16().take(512).enumerate() {
            user_buf[i] = c;
        }
        let mut pass_buf = [0u16; 257];
        let mut save = BOOL(0);
        let flags = CREDUI_FLAGS_GENERIC_CREDENTIALS
            | CREDUI_FLAGS_DO_NOT_PERSIST
            | CREDUI_FLAGS_KEEP_USERNAME
            | CREDUI_FLAGS_ALWAYS_SHOW_UI
            | CREDUI_FLAGS_EXCLUDE_CERTIFICATES;
        // SAFETY: every buffer is valid for its length and outlives the call.
        let rc = unsafe {
            CredUIPromptForCredentialsW(
                Some(&info),
                PCWSTR(target_w.as_ptr()),
                None,
                0,
                &mut user_buf,
                &mut pass_buf,
                Some(&mut save),
                flags,
            )
        };
        let end = pass_buf.iter().position(|c| *c == 0).unwrap_or(pass_buf.len());
        let secret = (rc.0 == 0).then(|| String::from_utf16_lossy(&pass_buf[..end]));
        for c in pass_buf.iter_mut() {
            // SAFETY: `c` is a valid, aligned, exclusive reference into `pass_buf`.
            unsafe { std::ptr::write_volatile(c, 0) };
        }
        secret.filter(|s| !s.is_empty())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn pid_alive(_pid: u32) -> bool {
        false
    }
    pub fn tcp_peer_pid(_local: SocketAddrV4, _remote: SocketAddrV4) -> Option<u32> {
        None
    }
    pub fn session_locked() -> bool {
        false
    }
    pub fn cursor_physical() -> Option<(i32, i32)> {
        None
    }
    pub fn ctrl_alt_types(_vk: u16, _shift: bool) -> Option<String> {
        None
    }
    pub fn set_window_region(_raw: isize, _rect: Option<(i32, i32, i32, i32)>) -> bool {
        false
    }
    pub fn keep_tool_window(_raw: isize) -> bool {
        false
    }
    pub fn ex_style(_raw: isize) -> isize {
        0
    }
    pub fn foreground() -> isize {
        0
    }
    pub fn shell_open(_target: &str) -> bool {
        false
    }
    pub fn set_foreground(_raw: isize) {}
    pub fn window_at_is(_x: i32, _y: i32, _raw: isize) -> bool {
        false
    }
    pub fn window_rect(_raw: isize) -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub fn prompt_secret(_parent: Option<isize>, _caption: &str, _message: &str, _user: &str) -> Option<String> {
        None
    }
    pub fn reg_get_string(_subkey: &str, _name: &str) -> Option<String> {
        None
    }
    pub fn reg_set_string(_subkey: &str, _name: &str, _data: &str) -> bool {
        false
    }
    pub fn reg_delete_value(_subkey: &str, _name: &str) -> bool {
        false
    }
}

pub use imp::*;

/// The raw window handle of a Tauri window (0 when it has none).
pub fn raw_hwnd<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> isize {
    #[cfg(windows)]
    {
        win.hwnd().map(|h| h.0 as isize).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = win;
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(port: u16) -> SocketAddrV4 {
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)
    }

    #[test]
    fn the_peer_is_the_row_seen_from_the_other_side() {
        let rows = [
            TcpRow { local: ep(50000), remote: ep(4310), pid: 7 },  // our side
            TcpRow { local: ep(4310), remote: ep(50000), pid: 42 }, // the daemon's side
            TcpRow { local: ep(4310), remote: ep(50001), pid: 42 },
        ];
        assert_eq!(peer_pid_in(&rows, ep(50000), ep(4310)), Some(42));
        assert_eq!(peer_pid_in(&rows, ep(50002), ep(4310)), None);
        let twice = [rows[1], TcpRow { pid: 9, ..rows[1] }];
        assert_eq!(peer_pid_in(&twice, ep(50000), ep(4310)), None);
    }

    #[test]
    fn our_own_process_is_alive_and_pid_zero_is_not() {
        assert!(!pid_alive(0));
        #[cfg(windows)]
        assert!(pid_alive(std::process::id()));
    }

    #[cfg(windows)]
    #[test]
    fn a_real_loopback_connection_is_attributed_to_its_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _server = listener.accept().unwrap();
        let local = match client.local_addr().unwrap() {
            std::net::SocketAddr::V4(a) => a,
            _ => unreachable!(),
        };
        assert_eq!(tcp_peer_pid(local, ep(port)), Some(std::process::id()));
    }

    #[cfg(windows)]
    #[test]
    fn user_registry_values_are_written_read_and_removed() {
        // A scratch key of this test's own, never the Run key; removed (values and all) at the end.
        struct Scratch(Vec<u16>);
        impl Drop for Scratch {
            fn drop(&mut self) {
                use windows::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};
                // SAFETY: a NUL-terminated name of the key this test created.
                let _ = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, windows::core::PCWSTR(self.0.as_ptr())) };
            }
        }
        let key = format!(r"Software\dev.friday.desktop-test-{}", std::process::id());
        let _scratch = Scratch(key.encode_utf16().chain(std::iter::once(0)).collect());
        let line = r#""C:\Program Files\Friday ünï\friday-desktop.exe""#;
        assert_eq!(reg_get_string(&key, "Friday"), None);
        assert!(reg_set_string(&key, "Friday", line));
        assert_eq!(reg_get_string(&key, "Friday").as_deref(), Some(line));
        assert!(reg_set_string(&key, "Friday", r#""C:\b.exe""#));
        assert_eq!(reg_get_string(&key, "Friday").as_deref(), Some(r#""C:\b.exe""#));
        assert!(reg_delete_value(&key, "Friday"));
        assert_eq!(reg_get_string(&key, "Friday"), None);
        assert!(reg_delete_value(&key, "Friday"), "removing a missing value succeeds");
    }
}
