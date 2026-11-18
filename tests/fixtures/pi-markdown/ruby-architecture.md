

Good instinct. Let's think about where Ruby helps, hurts, or is neutral:

| Component | TypeScript advantage? | Ruby viable? |
|---|---|---|
| **Web server + UI** (Hono) | None — Sinatra is simpler | ✅ **Better** — Sinatra is the OG minimal web framework |
| **SQLite + DB** | None — `sequel` or raw `sqlite3` gem are great | ✅ Equal |
| **SSE streaming** | None — Sinatra can stream fine | ✅ Equal |
| **Blueprint state machine** | None — just a loop with a hash | ✅ Equal |
| **Daytona SDK** | ⚠️ They ship TypeScript + Python SDKs | 🟡 Use the **Python SDK via subprocess**, or just **hit their REST API directly** |
| **Pi SDK** | ⚠️ Pi is a Node.js SDK/CLI | 🟡 Shell out to `pi --mode print` or `pi --mode rpc` |

The two dependencies that are TypeScript-native (Daytona SDK, Pi SDK) don't actually need to be in-process. Both have clean subprocess/API interfaces:

- **Pi** has `pi --mode print --message "do the thing"` and `pi --mode rpc` (JSON over stdin/stdout) — purpose-built for exactly this
- **Daytona** has a REST API behind the SDK — every SDK call is just an HTTP request to `api.daytona.io`

So the revised design: **Ruby everywhere, shell out to `pi` CLI, hit Daytona REST API directly with `net/http` or `httpx`.**

### Revised Architecture

```
minions-lite/
├── Gemfile
├── config.ru
├── app.rb              # Sinatra app — routes, views, SSE
├── worker.rb           # Background thread — runs blueprints
├── blueprint.rb        # State machine
├── daytona.rb          # Thin wrapper around Daytona REST API
├── agent.rb            # Thin wrapper around `pi` CLI
├── minions.db          # SQLite (auto-created)
└── .env                # DAYTONA_API_KEY, ANTHROPIC_API_KEY
```

**Gemfile** — 4 gems:

```ruby
source "https://rubygems.org"

gem "sinatra"
gem "puma"
gem "sqlite3"
gem "dotenv"
```

### `daytona.rb` — REST API wrapper (~60 lines)

No SDK needed. Daytona's API is straightforward:

```ruby
require "net/http"
require "json"

class Daytona
  API_BASE = "https://api.daytona.io/api"

  def initialize(api_key)
    @api_key = api_key
  end

  def create_sandbox(image: "ubuntu:latest")
    post("/sandboxes", { image: image, language: "ruby" })
  end

  def exec(sandbox_id, command, cwd: "/workspace")
    post("/sandboxes/#{sandbox_id}/process/exec", {
      command: command,
      cwd: cwd
    })
  end

  def read_file(sandbox_id, path)
    get("/sandboxes/#{sandbox_id}/files?path=#{URI.encode_www_form_component(path)}")
  end

  def write_file(sandbox_id, path, content)
    post("/sandboxes/#{sandbox_id}/files?path=#{URI.encode_www_form_component(path)}", content)
  end

  def delete_sandbox(sandbox_id)
    delete("/sandboxes/#{sandbox_id}")
  end

  private

  def headers
    { "Authorization" => "Bearer #{@api_key}", "Content-Type" => "application/json" }
  end

  def post(path, body)
    uri = URI("#{API_BASE}#{path}")
    req = Net::HTTP::Post.new(uri, headers)
    req.body = body.is_a?(String) ? body : body.to_json
    resp = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
    JSON.parse(resp.body) rescue resp.body
  end

  def get(path)
    uri = URI("#{API_BASE}#{path}")
    resp = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http|
      http.request(Net::HTTP::Get.new(uri, headers))
    }
    JSON.parse(resp.body) rescue resp.body
  end

  def delete(path)
    uri = URI("#{API_BASE}#{path}")
    Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http|
      http.request(Net::HTTP::Delete.new(uri, headers))
    }
  end
end
```

### `agent.rb` — Pi CLI wrapper (~30 lines)

The beautiful part — pi's print mode was made for this:

```ruby
class Agent
  def initialize(sandbox_id:, daytona:)
    @sandbox_id = sandbox_id
    @daytona = daytona
  end

  # Run pi inside the Daytona sandbox, fully unattended
  def prompt(message)
    # pi --mode print sends one prompt, gets the full response, exits
    # We run it *inside* the sandbox so its bash/read/write tools
    # operate on the sandbox filesystem directly
    result = @daytona.exec(@sandbox_id, <<~SH, cwd: "/workspace")
      export ANTHROPIC_API_KEY=#{ENV["ANTHROPIC_API_KEY"]}
      pi --mode print --no-session --message #{shell_escape(message)}
    SH
    result
  end

  private

  def shell_escape(s)
    "'" + s.gsub("'", "'\\''") + "'"
  end
end
```

That's it. Pi runs inside the sandbox with full tool access to the sandbox filesystem. No custom tools needed. No SDK bridging. Pi's `bash` tool runs commands in the sandbox. Pi's `read`/`write`/`edit` tools touch sandbox files. It just works.

### `blueprint.rb` — State machine (~80 lines)

```ruby
class Blueprint
  def initialize(agent:, daytona:, sandbox_id:, task:, repo_url:, branch:, &log_block)
    @agent = agent
    @daytona = daytona
    @sandbox_id = sandbox_id
    @task = task
    @repo_url = repo_url
    @branch = branch
    @log = log_block
    @data = {}
  end

  NODES = %i[clone_repo implement lint fix_lint test fix_tests push]

  def run
    current = :clone_repo
    until current == :done
      @log.call("▶ #{current}")
      current = send(current)
    end
  end

  private

  def exec(cmd)
    @daytona.exec(@sandbox_id, cmd, cwd: "/workspace")
  end

  # --- Deterministic nodes ---

  def clone_repo
    exec("git clone #{@repo_url} /workspace 2>&1 || true")
    exec("git checkout -b minion/#{@branch}")
    @log.call("✓ Repo cloned")
    :implement
  end

  def lint
    result = exec("npm run lint 2>&1; echo EXIT:$?")
    if result.include?("EXIT:0")
      @log.call("✓ Lint passed")
      :test
    else
      @data[:lint_errors] = result
      @data[:lint_retries] = (@data[:lint_retries] || 0) + 1
      return :test if @data[:lint_retries] > 2  # give up after 2 tries
      @log.call("✗ Lint failed, asking agent to fix")
      :fix_lint
    end
  end

  def test
    result = exec("npm test 2>&1; echo EXIT:$?")
    if result.include?("EXIT:0")
      @log.call("✓ Tests passed")
      :push
    else
      @data[:test_errors] = result
      @data[:test_retries] = (@data[:test_retries] || 0) + 1
      return :push if @data[:test_retries] > 1  # Stripe's rule: at most 2 rounds
      @log.call("✗ Tests failed, asking agent to fix (attempt #{@data[:test_retries]}/1)")
      :fix_tests
    end
  end

  def push
    exec('git add -A && git commit -m "minion: automated changes" && git push origin HEAD')
    @log.call("✓ Pushed")
    :done
  end

  # --- Agent nodes ---

  def implement
    @agent.prompt("You are in /workspace. Complete this task:\n\n#{@task}\n\n" \
                  "Read relevant files first, understand the code, then make changes.")
    @log.call("✓ Implementation complete")
    :lint
  end

  def fix_lint
    @agent.prompt("Fix these lint errors, nothing else:\n\n#{@data[:lint_errors]}")
    @log.call("✓ Lint fix attempt complete")
    :lint
  end

  def fix_tests
    @agent.prompt("Fix these test failures:\n\n#{@data[:test_errors]}")
    @log.call("✓ Test fix attempt complete")
    :test
  end
end
```

### `app.rb` — Sinatra app (~90 lines)

```ruby
require "sinatra"
require "sqlite3"
require "json"
require "dotenv/load"
require_relative "daytona"
require_relative "agent"
require_relative "blueprint"

DB = SQLite3::Database.new("minions.db")
DB.results_as_hash = true
DB.execute <<-SQL
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_url TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    log TEXT DEFAULT '',
    branch TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
SQL

STREAMS = {}  # run_id => [queue, queue, ...]

get "/" do
  @runs = DB.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 50")
  erb :index
end

post "/runs" do
  branch = "minion-#{Time.now.to_i}"
  DB.execute("INSERT INTO runs (repo_url, task, branch) VALUES (?, ?, ?)",
             [params[:repo_url], params[:task], branch])
  id = DB.last_insert_row_id
  Thread.new { run_blueprint(id) }
  redirect "/runs/#{id}"
end

get "/runs/:id" do
  @run = DB.execute("SELECT * FROM runs WHERE id = ?", params[:id]).first
  erb :show
end

get "/runs/:id/events" do
  content_type "text/event-stream"
  stream(:keep_open) do |out|
    queue = Queue.new
    (STREAMS[params[:id].to_i] ||= []) << queue
    loop do
      data = queue.pop
      out << "data: #{data}\n\n"
    end
  rescue IOError
    # client disconnected
  end
end

def append_log(id, msg)
  DB.execute("UPDATE runs SET log = log || ? WHERE id = ?", ["#{msg}\n", id])
  (STREAMS[id] || []).each { |q| q << msg }
end

def run_blueprint(id)
  run = DB.execute("SELECT * FROM runs WHERE id = ?", id).first
  DB.execute("UPDATE runs SET status = 'running' WHERE id = ?", id)

  daytona = Daytona.new(ENV["DAYTONA_API_KEY"])
  sandbox = daytona.create_sandbox
  sandbox_id = sandbox["id"]
  append_log(id, "✓ Sandbox #{sandbox_id} created")

  # Install pi in the sandbox
  daytona.exec(sandbox_id, "npm install -g @mariozechner/pi-coding-agent")

  agent = Agent.new(sandbox_id: sandbox_id, daytona: daytona)

  blueprint = Blueprint.new(
    agent: agent, daytona: daytona, sandbox_id: sandbox_id,
    task: run["task"], repo_url: run["repo_url"], branch: run["branch"]
  ) { |msg| append_log(id, msg) }

  blueprint.run
  DB.execute("UPDATE runs SET status = 'done' WHERE id = ?", id)
  append_log(id, "🎉 Done!")

rescue => e
  DB.execute("UPDATE runs SET status = 'failed' WHERE id = ?", id)
  append_log(id, "💥 Error: #{e.message}")
ensure
  daytona.delete_sandbox(sandbox_id) if sandbox_id
end
```

### Views — inline ERB

**`views/index.erb`**:
```erb
<html><head><title>Minions</title></head>
<body style="font-family:monospace; max-width:800px; margin:40px auto">
  <h1>🤖 Minions</h1>
  <form method="POST" action="/runs">
    <input name="repo_url" placeholder="git@github.com:you/repo.git" style="width:100%%" required /><br/><br/>
    <textarea name="task" rows="4" style="width:100%%" placeholder="Describe the task..." required></textarea><br/><br/>
    <button type="submit">Launch Minion</button>
  </form>
  <hr/>
  <% @runs.each do |r| %>
    <div style="border:1px solid #ccc; padding:12px; margin:8px 0">
      <a href="/runs/<%= r["id"] %>"><b>#<%= r["id"] %></b></a>
      [<%= r["status"] %>]
      <div style="font-size:0.9em"><%= r["task"][0..120] %></div>
    </div>
  <% end %>
</body></html>
```

**`views/show.erb`**:
```erb
<html><head><title>Run #<%= @run["id"] %></title></head>
<body style="font-family:monospace; max-width:800px; margin:40px auto">
  <h1><a href="/">←</a> Run #<%= @run["id"] %> [<%= @run["status"] %>]</h1>
  <p><b>Task:</b> <%= @run["task"] %></p>
  <pre id="log" style="background:#111;color:#0f0;padding:16px;max-height:600px;overflow:auto"><%= @run["log"] %></pre>
  <% unless ["done", "failed"].include?(@run["status"]) %>
  <script>
    const es = new EventSource('/runs/<%= @run["id"] %>/events');
    es.onmessage = (e) => {
      const el = document.getElementById('log');
      el.textContent += e.data + '\n';
      el.scrollTop = el.scrollHeight;
    };
  </script>
  <% end %>
</body></html>
```

### Final tally

| | |
|---|---|
| **Language** | Ruby, all of it |
| **Gems** | 4 (`sinatra`, `puma`, `sqlite3`, `dotenv`) |
| **Files** | 6 Ruby + 2 ERB |
| **Lines of code** | ~350 total |
| **External deps** | Daytona REST API (no SDK), `pi` CLI (installed in sandbox) |
| **No Node.js in your codebase** | Correct. Pi runs inside the sandbox only. |

The key realization: **pi doesn't need to be in your process**. It's a CLI tool. Run it where the code lives (inside the sandbox), talk to it via Daytona's exec API, and your orchestrator stays pure Ruby. Stripe's Minions work the same way — the agent harness runs on the devbox, not on the control plane.