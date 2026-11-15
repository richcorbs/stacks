//! `stacks-tui` entry point: args, single-instance automation server, run loop.

use std::{io::Write, path::PathBuf, sync::Arc, time::Duration};

use crossterm::{
    event::{self, Event, KeyEvent},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};
use stacks_core::{
    automation::{self, AutomationHost},
    paths,
    store::CardStore,
};
use stacks_tui::{
    app::App,
    event::{CoreEvent, EventSender},
    headless,
    keys::Key,
    render,
};

struct Args {
    dump: bool,
    cols: u16,
    rows: u16,
    script: Option<PathBuf>,
    db: Option<PathBuf>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("stacks-tui: {error}");
        std::process::exit(1);
    }
}

fn usage() -> &'static str {
    "stacks-tui — keyboard-only Stacks client\n\
     \n\
     Usage: stacks-tui [--db PATH] [--dump-screen] [--cols N --rows N] [--script FILE]\n\
     \n\
       --db PATH        workflow.sqlite3 to read/write (default: shipped Stacks data)\n\
       --dump-screen    render once to stdout and exit (TestBackend)\n\
       --cols / --rows  size for --dump-screen / --script\n\
       --script FILE    replay keys: `key ctrl-p`, `type Arcasa`, `wait 200`,\n\
                        `assert contains …`, `resize 120 40`, `dump`\n\
       -h, --help       this help\n\
     \n\
     Single instance: stacks-tui serves automation.sock; a running Stacks (GUI or TUI)\n\
     makes this exit instead of becoming a second writer."
}

fn parse_args() -> Result<Option<Args>, String> {
    let mut args = Args {
        dump: false,
        cols: 120,
        rows: 40,
        script: None,
        db: None,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--dump-screen" => args.dump = true,
            "--cols" => {
                args.cols = iter
                    .next()
                    .ok_or_else(|| "--cols needs a number".to_string())?
                    .parse()
                    .map_err(|_| "--cols needs a number".to_string())?;
            }
            "--rows" => {
                args.rows = iter
                    .next()
                    .ok_or_else(|| "--rows needs a number".to_string())?
                    .parse()
                    .map_err(|_| "--rows needs a number".to_string())?;
            }
            "--script" => {
                args.script = Some(PathBuf::from(
                    iter.next()
                        .ok_or_else(|| "--script needs a path".to_string())?,
                ));
            }
            "--db" => {
                args.db = Some(PathBuf::from(
                    iter.next().ok_or_else(|| "--db needs a path".to_string())?,
                ));
            }
            other => return Err(format!("unknown argument {other:?}\n\n{}", usage())),
        }
    }
    Ok(Some(args))
}

fn run() -> Result<(), String> {
    let Some(args) = parse_args()? else {
        println!("{}", usage());
        return Ok(());
    };
    if let Some(db) = args.db.as_ref() {
        // Before any worker thread starts; every later read uses the same env.
        unsafe {
            std::env::set_var("STACKS_TUI_DB", db);
            if let Some(parent) = db.parent() {
                if !parent.as_os_str().is_empty() {
                    std::env::set_var("STACKS_TUI_DATA_DIR", parent);
                }
            }
        }
    }
    let store = Arc::new(CardStore::default_store());
    let board = match store.load_snapshot() {
        Ok(board) => Some(board),
        Err(error) => {
            eprintln!("stacks-tui: {error}");
            None
        }
    };
    let socket = automation_socket_path();
    let headless_mode = args.dump || args.script.is_some();
    let mut app = App::new(Arc::clone(&store), socket.clone(), board, headless_mode);

    if headless_mode {
        let mut cols = args.cols;
        let mut rows = args.rows;
        if let Some(script) = args.script.as_ref() {
            let text = std::fs::read_to_string(script)
                .map_err(|error| format!("could not read {}: {error}", script.display()))?;
            let lines = text.lines().map(str::to_string).collect::<Vec<_>>();
            headless::run_script(&mut app, &lines, &mut cols, &mut rows)?;
        }
        if args.dump || args.script.is_some() {
            print!("{}", headless::dump(&mut app, cols, rows));
            let _ = std::io::stdout().flush();
        }
        return Ok(());
    }

    let guard = automation::start(
        store.as_ref().clone(),
        Arc::new(TuiAutomationHost {
            sender: app.sender.clone(),
        }),
    )
    .or_else(|error| {
        Err(format!(
            "{error}\n\nQuit the other Stacks instance, or start with --dump-screen for an offline render."
        ))
    })?;

    let result = run_interactive(&mut app);
    drop(app);
    drop(guard);
    result
}

fn automation_socket_path() -> PathBuf {
    std::env::var_os("STACKS_TUI_AUTOMATION_SOCKET")
        .map(PathBuf::from)
        .or_else(|| paths::automation_socket_path().ok())
        .unwrap_or_else(|| std::env::temp_dir().join("stacks-tui-automation.sock"))
}

struct TuiAutomationHost {
    sender: EventSender,
}

impl AutomationHost for TuiAutomationHost {
    fn state_changed(&self, card_id: &str) {
        self.sender.send(CoreEvent::AutomationChanged {
            card_id: card_id.to_string(),
            message: "Pi reported a lifecycle change".into(),
        });
    }

    fn notify(&self, message: &str) {
        self.sender.notice(message.to_string());
    }
}

struct TerminalRestore;

impl Drop for TerminalRestore {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            std::io::stdout(),
            LeaveAlternateScreen,
            crossterm::event::DisableBracketedPaste,
            crossterm::cursor::Show
        );
    }
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(
        std::io::stdout(),
        LeaveAlternateScreen,
        crossterm::event::DisableBracketedPaste,
        crossterm::cursor::Show
    );
}

fn run_interactive(app: &mut App) -> Result<(), String> {
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        original_hook(info);
    }));
    enable_raw_mode().map_err(|error| error.to_string())?;
    let mut stdout = std::io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        crossterm::event::EnableBracketedPaste,
        crossterm::cursor::Hide,
        crossterm::terminal::SetTitle("Stacks TUI")
    )
    .map_err(|error| error.to_string())?;
    let _restore = TerminalRestore;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).map_err(|error| error.to_string())?;
    terminal.clear().map_err(|error| error.to_string())?;

    loop {
        if app.quit {
            break;
        }
        if event::poll(Duration::from_millis(30)).map_err(|error| error.to_string())? {
            match event::read().map_err(|error| error.to_string())? {
                Event::Key(KeyEvent {
                    code,
                    modifiers,
                    kind,
                    ..
                }) => {
                    if let Some(key) =
                        Key::from_event(KeyEvent::new_with_kind(code, modifiers, kind))
                    {
                        app.handle_key(key);
                    }
                }
                Event::Paste(text) => app.handle_paste(text),
                Event::Resize(_, _) => {}
                // Keyboard-only: mouse events are never enabled or handled.
                _ => {}
            }
        }
        app.tick();
        while let Some(core_event) = app.events.try_recv() {
            app.handle_core_event(core_event);
        }
        terminal
            .draw(|frame| render::draw(frame, app))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
