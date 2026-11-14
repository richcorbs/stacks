use gpui::{
    App, AppContext, Bounds, SharedString, TitlebarOptions, WindowBounds, WindowOptions, px, size,
};
use stacks_gpui_terminal_spike::app::SpikeApp;
use stacks_gpui_terminal_spike::host_ipc::host_socket_from_env_or_args;

fn main() {
    let host_mode = host_socket_from_env_or_args().is_some();
    gpui_platform::application().run(move |cx: &mut App| {
        cx.on_window_closed(|cx, _window_id| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(1120.0), px(720.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SharedString::from(if host_mode {
                        "Stacks · Native terminal"
                    } else {
                        "Stacks · GPUI terminal spike"
                    })),
                    appears_transparent: false,
                    traffic_light_position: None,
                }),
                // In host mode Stacks opens the window with `Cmd+T`, so start
                // hidden and unfocused. `SpikeApp` connects to the host socket
                // and keeps the AppKit window ordered out until then.
                focus: !host_mode,
                show: !host_mode,
                ..Default::default()
            },
            |window, cx| cx.new(|cx| SpikeApp::new(window, cx)),
        )
        .expect("open spike window");
        if !host_mode {
            cx.activate(true);
        }
    });
}
