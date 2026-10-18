# @avsbhq/cli

Command line tool for the [A vs B](https://app.avsb.cloud) platform.

Clone experiments and edit variation code in your own editor, manage project scripts, create metrics and metric bindings, push datasets, and generate TypeScript types for your feature flags.

## Install

```bash
npm install -g @avsbhq/cli
```

Verify the installation:

```bash
avsb --version
```

Node.js 18 or later is required.

## Authentication

The CLI authenticates with a **personal access token**.

### Step 1: Create a token

1. Log in to the [A vs B dashboard](https://app.avsb.cloud)
2. Go to **Account Settings** (click your avatar in the top bar)
3. Open the **Personal Access Tokens** tab
4. Click **Create token**, give it a name (for example "CLI access"), and confirm
5. Copy the token immediately. It is shown once and never again.

> You need the Owner, Admin, or Developer role in the organization to create a token.

### Step 2a: Save the token on your machine

```bash
avsb login
```

You are prompted to paste the token. That is the only question: the CLI reads the script and style languages for each experiment from the platform, so it never asks you to choose them.

### Step 2b: Or skip the prompt (scripts, CI, containers)

```bash
# save it without a prompt
avsb login --token "$AVSB_TOKEN" --no-input

# or set the variable and skip `avsb login` altogether
export AVSB_TOKEN=avsb_pat_...
avsb codegen --project 42
```

| Variable | Effect |
|----------|--------|
| `AVSB_TOKEN` | Used as the token for every command, in place of the saved login |
| `AVSB_API_URL` | Platform base URL. Defaults to `https://app.avsb.cloud` |

Precedence for the token: `--token` (on `avsb login` only), then `AVSB_TOKEN`, then the saved login, then the prompt. `--no-input` turns a missing token into an error instead of a prompt, so a CI job never hangs.

### Where the token is stored

`avsb login` writes `~/.avsb/config.json` with file mode 0600. It is **plain-text JSON on every operating system**: no macOS Keychain, no Windows Credential Manager, no encryption. Anything that can read your user account's files can read the token. The file holds one entry per organization you have logged in to, the active organization, and the platform base URL.

Treat it like a password, and prefer `AVSB_TOKEN` where you would not want a token written to disk.

```bash
avsb whoami      # which account and organization does this token reach?
avsb logout      # delete every saved login from this machine
```

`avsb logout` deletes the file. If `AVSB_TOKEN` is still set in your shell, the CLI says so, because commands would keep working.

## Quick start

### Set up a project (one command)

```bash
avsb init               # in your own application's folder
```

Detects your framework from `package.json`, links or creates a project, writes
the SDK key into the environment file that framework reads, writes a working
example, and waits for your app's first check-in so the terminal tells you it
worked. Nothing it writes overwrites anything, and every prompt has a flag.

### Experiments

```bash
avsb login              # 1. authenticate
avsb clone EXP-42       # 2. clone an experiment
cd homepage-hero-test   # 3. the folder is named after the experiment
avsb dev                # 4. live reload through the Chrome extension
avsb push               # 5. push your changes back
```

### Project scripts

```bash
avsb project pull PRJ-10
cd project-10
avsb project dev
avsb project push
```

### Feature flags

```bash
avsb flags list --project PRJ-10
avsb flags toggle checkout_v2 --env production --off
```

### Typed feature flags

```bash
avsb codegen --project 42 --env production
avsb codegen                     # inside a cloned or pulled folder
```

## Commands

Every command group the CLI ships. All of them need a token already in place (see Authentication) except `avsb login`, which supplies one, plus `avsb logout`, `avsb status` and `avsb agents-md`, which only touch local files, and `avsb completion`, which only prints a script.

### Setup

| Command | Description |
| ------- | ----------- |
| `avsb init` | Set this project up and prove it works. `-p, --project`, `--create <name>`, `-e, --env`, `--framework`, `--flag`, `-d, --dir`, `--install`, `--no-env-file`, `--no-example`, `--example-path`, `--codegen`, `--codegen-output`, `--wait <seconds>`, `--no-wait`, `--require-heartbeat`, `--no-input`, `--json` |
| `avsb agents-md install` | Write an A vs B section into `CLAUDE.md` and `AGENTS.md` so coding agents know the commands, the credentials, and how a flag is read. `--claude`, `--agents`, `--print`, `-d, --dir`, `-p, --project`, `-e, --env`, `--json` |

The `agents-md` section sits between markers, so re-running the command replaces
it instead of adding a second copy.

### Account and organization

| Command | Description |
| ------- | ----------- |
| `avsb login` | Save a personal access token. `--token <t>`, `--no-input`, `-u, --url <url>` |
| `avsb logout` | Delete the saved logins on this machine |
| `avsb whoami` | Show the account email, organization, role, API URL, and where the token came from |
| `avsb org` | Show the active organization and the token source |
| `avsb org list` | List the organizations this token can reach |
| `avsb org switch [org]` | Choose which organization commands use. Accepts a short id, an id, or a name; prompts when given nothing. `--no-input` |

Personal access tokens belong to a user, not to one organization, so a single token usually reaches every organization your account belongs to. `avsb org switch` records your choice in `~/.avsb/config.json`, and keeps one token per organization, so logging in with another account's token adds a login rather than replacing one.

### Experiments

| Command | Description |
| ------- | ----------- |
| `avsb clone <experiment>` | Clone an experiment locally. Accepts a dashboard URL, `EXP-42`, or `42` |
| `avsb status` | Show what the local manifest says about this experiment |
| `avsb dev` | Watch local files and hot reload through the Chrome extension |
| `avsb pull` | Overwrite local files with the platform's current code. `-f, --force` |
| `avsb push` | Compile and upload local code. `-f, --force`, `--publish`, `--no-publish` |

### Project scripts

| Command | Description |
| ------- | ----------- |
| `avsb project pull <project>` | Pull a project script. Accepts `PRJ-42` or `42`. `-f, --force` |
| `avsb project push` | Compile and push the project script. `-f, --force` |
| `avsb project dev` | Watch the project script and hot reload through the extension |

### Feature flags

Flag commands call the public API with the same personal access token, so nothing extra is needed.

| Command | Description |
| ------- | ----------- |
| `avsb flags list` | List flags: id, key, type, status, and which environments serve them. `--limit <n>`, `--cursor <c>` |
| `avsb flags get <flag>` | One flag with its variations and environments. Accepts the key, `12`, or the id |
| `avsb flags create <key>` | Create a flag. `--type`, `--variation <key>=<value>` (repeatable), `--default <key>`, `--name`, `--description` |
| `avsb flags update <flag>` | Rename or re-describe a flag. `--name`, `--description` (`""` clears it), `--key`, `--if-match <version>`, `--force` |
| `avsb flags toggle <flag>` | Start or stop serving one environment. `--env <key>` plus `--on` or `--off` |

`toggle` is idempotent: asking for the state it is already in succeeds and reports that nothing changed, so an incident script can fire it blind. `update` reads the flag first and sends its version back, so a concurrent change is refused (exit code 4) instead of overwritten.

The API addresses a flag by short id or id, not by key, so a key is matched inside the project first and the match is printed (`Matched key checkout_v2 to FLG-12`). Passing the short id skips that lookup.

### Experiments (read)

| Command | Description |
| ------- | ----------- |
| `avsb experiments list` | List experiments: id, status, name, last change. `--limit <n>`, `--cursor <c>` |

### Getting around

| Command | Description |
| ------- | ----------- |
| `avsb open [target]` | Open a dashboard page. Targets: `dashboard`, `experiments`, `flags`, `environments`, `metrics`, `datasets`, `settings`, `snippet`, `docs`, `tokens`, `EXP-<id>`, `PRJ-<id>`. `--url` prints instead of opening |
| `avsb completion <shell>` | Print a completion script for `bash`, `zsh`, or `fish` |

### Metrics

Tracking definitions: what counts as a click, a pageview, or a custom event.

| Command | Description |
| ------- | ----------- |
| `avsb metrics list` | List metrics. `--type <CLICK\|PAGEVIEW\|CUSTOM>`, `--include-archived` |
| `avsb metrics create` | Create a metric. `--type`, `--name`, `--description`, `--selector`, `--page-url`, `--url-match`, `--match-mode`, `--key`, `--has-value` |
| `avsb metrics update <metricId>` | Update a metric. Same field flags, plus `--no-has-value` |
| `avsb metrics archive <metricId>` | Archive a metric, keeping its history |
| `avsb metrics unarchive <metricId>` | Restore an archived metric |
| `avsb metrics delete <metricId>` | Delete a metric. Refused while metric bindings reference it. `-f, --force` |

Every metrics command accepts `--project <PRJ-42 or 42>`, and falls back to the project in the local manifest when you are inside a cloned folder. A `<metricId>` can be `MET-17`, `17`, or the long ID.

### Metric bindings

Analysis-side wrappers: how a metric is measured in an experiment.

| Command | Description |
| ------- | ----------- |
| `avsb metric-bindings list` | List bindings. `--library`, `--search <text>`, `--include-archived`, `--limit <n>` |
| `avsb metric-bindings create` | Create a binding. `--measure`, `--direction`, `--name`, `--description`, `--metric`, `--numerator-metric`, `--denominator-metric`, `--composition <json>`, `--component <bindingId:weight>`, `--percentile`, `--value-source`, `--winsorize-upper`, `--winsorize-lower` |
| `avsb metric-bindings update <id>` | Update a binding (`MBD-8`, `8`, or the long ID). Same flags, plus `--library` / `--no-library` |
| `avsb metric-bindings archive <id>` | Archive a binding |
| `avsb metric-bindings unarchive <id>` | Restore an archived binding |
| `avsb metric-bindings delete <id>` | Delete a binding. Refused while experiments attach it. `-f, --force` |

Measures: `UNIQUE_CONVERSIONS_PER_VISITOR`, `TOTAL_EVENTS`, `UNIQUE_VISITORS_WHO_FIRED`, `TOTAL_VALUE_PER_VISITOR`, `TOTAL_VALUE`, `PERCENTILE`, `RATE`, `COMPOSITE`. Directions: `INCREASE`, `DECREASE`.

### Datasets

| Command | Description |
| ------- | ----------- |
| `avsb datasets list` | List the project's datasets |
| `avsb datasets push <slug> <file.ndjson>` | Create a version, upload, and commit. `--label <text>`, `--activate`, `--timeout <seconds>` |
| `avsb datasets activate <slug> <version>` | Activate a committed version (`12` or `v12`) |
| `avsb datasets rollback <slug>` | Re-activate the previous live version. `-f, --force` |

### Typed flags

| Command | Description |
| ------- | ----------- |
| `avsb codegen` | Generate TypeScript types from a published datafile. `-p, --project <project>` (defaults to the local manifest), `-e, --env <key>` (default `production`), `-o, --output <path>` (default `./src/generated/flags.ts`), `-m, --manifest <path>`, `--no-augment`, `--check`, `--watch`, `--interval <seconds>` |
| `avsb find-refs` | Find flag keys in your source and compare them with the platform. `-p, --project <project>`, `-d, --dir <path>`, `-i, --ignore <pattern>`, `--max-files <count>`, `--strict`, `--json` |

The generated file declares `FlagKey` (a union of your flag keys), `FlagValues` (booleans, numbers, string-literal unions, and `unknown` for JSON flags, which you narrow yourself), and `ContextSchema` (one entry per context kind, each with `key: string` plus your registered attributes).

`--project` accepts `PRJ-42`, `42`, or a dashboard URL. Inside a folder created by `avsb project pull` or `avsb clone`, leave it out: the project comes from `.avsb-project.json`, then `.avsb.json`, and the run says which file it read.

### Webhooks

| Command | Description |
| ------- | ----------- |
| `avsb listen` | Watch this project's webhook deliveries and forward a copy to a local URL. `--project <project>`, `--forward <url>` (must start with `http://` or `https://`, anything else exits 2), `--print-secret-hint` |
| `avsb trigger [event]` | Send a sample webhook event to this project's webhooks. `--project <project>`, `--webhook <id>`, `--list` |

## Output for scripts

Every read command takes `--json` and prints exactly one document on stdout:

```json
{ "ok": true, "command": "flags list", "data": [], "meta": { "page": { "nextCursor": null, "hasMore": false } } }
```

`data` is the platform's own response body, unchanged; anything about the response rather than the resource (a page cursor, a resource version) rides in `meta`.

A failure prints the same envelope with the platform's own error inside it:

```json
{ "ok": false, "command": "flags toggle", "error": { "code": "not_found", "message": "Flag not found", "status": 404, "docUrl": "..." } }
```

Codes starting with `cli_` mean the CLI stopped before asking the platform. Results always go to stdout and everything else to stderr, so redirecting stdout leaves a valid document and still shows you the problem. `--quiet` prints the result only: rows, a completion script or a URL still print, progress notes and headings do not. `AVSB_JSON=1` and `AVSB_QUIET=1` do the same for a whole script.

Exit codes:

| Code | Meaning |
| ---- | ------- |
| `0` | Success |
| `1` | The command ran and failed |
| `2` | The command was called wrongly (unknown option, missing argument, bad value) |
| `3` | Not logged in, or the platform rejected the token |
| `4` | The resource changed or refuses the change: re-read it and retry |

## Experiment workflow

### Clone

Fetches the experiment and scaffolds a local folder. Script and style languages come from the experiment's own settings on the platform.

```bash
avsb clone EXP-42
avsb clone 42
avsb clone https://app.avsb.cloud/projects/42/experiments/300015
```

### Dev

Starts a file watcher and a local WebSocket server for the A vs B Chrome extension. It takes the first free port between 4400 and 4409 and prints the one it took.

```bash
avsb dev
```

Press `Ctrl+C` to stop.

### Push

Compiles your TypeScript and SCSS locally, then uploads the source and the compiled output. Compile errors are reported with file, line, and column, and nothing is uploaded until they are fixed.

Before uploading, the CLI hashes the platform's copy and warns you if it changed since your last sync. When the experiment is running or paused, it offers to publish the change immediately; `--publish` and `--no-publish` answer that question up front, which is what a CI job wants.

```bash
avsb push
avsb push --force   # skip the remote-change check
avsb push --publish # publish without the question
```

### Pull

Replaces your local variation files with the platform's current code, after warning you about local edits it would overwrite.

```bash
avsb pull
avsb pull --force
```

### Status

Prints what the local manifest holds: experiment name, `EXP-` id, status, variation count, script and style languages, when you last synced, and the platform URL. It does not contact the platform, so it does not report whether the platform copy has moved on. `avsb push` is what detects that.

```bash
avsb status
```

## Project script workflow

Project scripts run on every page where your snippet is active, independent of any experiment.

```bash
avsb project pull PRJ-10   # or: avsb project pull 10
avsb project push          # --force to skip the conflict check
avsb project dev
```

`project pull` creates `project-<id>/`:

```text
project-10/
  project.ts              # or project.js, matching the project's language
  .avsb-project.json      # manifest (project metadata, do not delete)
  tsconfig.json           # TypeScript projects only
  avsb.d.ts               # type definitions for the avsb API, TypeScript projects only
```

Re-running `project pull` updates the existing folder in place, whether you run it from inside `project-<id>/` or from the folder that holds it; it never creates a nested copy. If your local script has edits it asks first, and `--force` overwrites them without asking.

## Cloned experiment structure

```text
homepage-hero-test/
  .avsb.json              # manifest (experiment metadata, do not delete)
  tsconfig.json           # TypeScript experiments only
  avsb.d.ts               # TypeScript experiments only: the window.avsb API
  variation-code.d.ts     # TypeScript experiments only: options, activate, track
  trigger.ts              # trigger code: when the experiment activates. Editable, and pushed by `avsb push`
  control/
    control.ts            # control variation script
    control.scss          # control variation styles
  variant-a/
    variant-a.ts          # variant script
    variant-a.scss        # variant styles
```

File extensions follow the experiment's language settings (`.js` or `.ts`, `.css` or `.scss`).

The two `.d.ts` files are copies of the published `@avsbhq/snippet-types` declarations, so editor hints match what the snippet actually ships. `avsb pull` rewrites them, so upgrading the CLI upgrades the types. Do not edit them.

## When a command is refused

A valid token is not always enough:

- **The organization is suspended.** Commands that read or change data are refused until the suspension is lifted. `avsb login`, `avsb whoami`, and `avsb org` keep working so you can see where you are pointed.
- **The feature is switched off for the organization.** Experiment commands are refused while web experiments are off.

Both cases fail with a short message saying why.

## Uninstall

```bash
npm uninstall -g @avsbhq/cli
```

## Requirements

- Node.js >= 18
