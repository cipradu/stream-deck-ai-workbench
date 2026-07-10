# AI Workbench

A local macOS **Stream Deck plugin** that puts live AI‑tooling **usage** and account **balances** on your Stream Deck keys — subscription/plan usage for AI coding tools, and remaining balance or month‑to‑date spend for a range of AI API vendors — each with an at‑a‑glance gauge, reset countdown, and green/amber/red thresholds.

![AI Workbench on a Stream Deck XL](assets/preview.jpg)

*A fully configured Stream Deck XL running AI Workbench — sample data, not real account values.*

> **Personal / educational project.** It is **not affiliated with, endorsed by, or supported by** any of the vendors it integrates with. It talks to each vendor's own APIs using **your own credentials**, and several providers rely on **undocumented endpoints** that can change or break at any time. See [Disclaimers](#disclaimers--legal) before using or distributing it.

---

## What it is

AI Workbench is a self‑hosted Stream Deck plugin you build and install yourself (there is no marketplace release). It adds two action types to Stream Deck:

- **Usage** — how much of an AI coding tool's plan window you've consumed, as a percentage gauge with a countdown to the next reset.
- **Balance** — an AI API vendor's remaining balance, or its month‑to‑date/current‑period spend, plainly labeled.

Each key polls on an interval, renders a compact SVG (value, gauge or amount, a context line, a reset/coverage marker, and a "last checked" clock), and colors itself by optional thresholds.

## Supported providers

### Usage

| Provider | Windows / categories | What the key shows |
| --- | --- | --- |
| **Claude Code** | 5‑hour · Weekly · Fable · Credits | % of the plan window used (gauge + reset countdown). **Fable** = weekly usage for that model. **Credits** = extra‑usage *spend* against your monthly cap, with off / out‑of‑credits states. |
| **Codex** | 5‑hour · Weekly · Credits · Resets | % of the window used. **Credits** = reset‑credit balance. **Resets** = available reset‑credit count + a countdown to the earliest credit's expiry. |
| **z.ai Coding Plan** | 5‑hour · MCP tools (monthly) | % of the window used. |
| **MiniMax** | 5‑hour · Weekly | % of the window used. |

### Balance

| Vendor | Shows | Unit |
| --- | --- | --- |
| **Anthropic** | month‑to‑date spend | USD |
| **OpenAI** | month‑to‑date spend | USD |
| **Exa** | month‑to‑date spend | USD |
| **RunPod** | current‑period spend | USD |
| **Speechmatics** | used audio time | hours |
| **Moonshot** | remaining balance | USD |
| **DeepSeek** | remaining balance | USD |
| **Deepgram** | remaining balance | USD |
| **fal.ai** | remaining balance | USD |
| **Tavily** | remaining credits | credits |
| **Jina** | remaining tokens | tokens |
| **ElevenLabs** | remaining characters | characters |

Exact fields come from each vendor's own billing/usage API; some vendors expose only spend/usage history rather than a remaining balance, which is why those keys show spend.

## How it's displayed

- **Usage keys** render a **progress‑bar gauge**, the percentage, a **used / remaining** context line, and a **countdown to the next reset**.
- **Balance keys** render the amount with its unit (money, credits, tokens, characters, or hours), or a spend total for spend‑only vendors.
- **Claude Code Credits** (extra‑usage spend) renders the % of your monthly cap consumed with a `$used / $cap` line; when the feature is off or out of credits it shows a neutral status word instead of a misleading gauge.
- **Codex Resets** renders the reset‑credit count with a countdown to the earliest expiry.
- **Severity colors** are **direction‑aware**: usage/spend keys go **amber → red** as the number *rises*, remaining‑balance keys go amber → red as the number *falls*. Percentage‑usage windows have sensible defaults (amber at 80%, red at 90%); every key also accepts optional **amber/red thresholds** you set yourself, and the Claude Code spend guard's thresholds are entered as plain amounts.

## Requirements

- **macOS 14+**
- **Elgato Stream Deck software 7.1+** (and a Stream Deck device, or the virtual device)
- To build from source: **Node 24+** and **pnpm 11**

## Install (build from source)

There is no marketplace build; you compile the plugin and link it into Stream Deck with Elgato's CLI.

```sh
# 1. Clone and install workspace dependencies
git clone https://github.com/cipradu/stream-deck-ai-workbench.git
cd stream-deck-ai-workbench
pnpm install

# 2. Build every package + the Stream Deck bundle
pnpm run build

# 3. Link the built plugin into Stream Deck and run it (Elgato Stream Deck CLI,
#    installed as a dev dependency; run `pnpm exec streamdeck --help` for all commands)
pnpm exec streamdeck validate apps/streamdeck/com.blackice.ai-workbench.sdPlugin
pnpm exec streamdeck link     apps/streamdeck/com.blackice.ai-workbench.sdPlugin
pnpm exec streamdeck dev       # enable developer mode (lets a linked plugin be reloaded)
pnpm exec streamdeck restart  com.blackice.ai-workbench
```

The plugin runs on the Node runtime bundled with Stream Deck. After editing plugin source, rebuild and `streamdeck restart` to reload the running plugin.

## Configuration

Each Stream Deck key is configured from its **Property Inspector**:

1. Add a **Usage** or **Balance** action to a key.
2. Pick the **provider / vendor**.
3. For usage keys, pick the **window / category** (e.g. 5‑hour, Weekly, Credits, Resets, Fable).
4. For keyed providers, paste the **API key** (see below).
5. Optionally set **amber / red thresholds** and the **refresh interval** (seconds).

## Credentials & security

- **Local‑source usage providers are read‑only.** Claude Code's credential is read from the macOS **Keychain**, and Codex's from `~/.codex/auth.json`. The plugin reads these to display *your own* usage and **never modifies them**.
- **API keys** (z.ai, MiniMax, and every Balance vendor) are entered in the Property Inspector and stored in **Stream Deck's encrypted global settings** — never in per‑action settings (which can be exported as plaintext).
- **Some Balance vendors require privileged keys.** For example, reading Anthropic organization spend requires an **admin API key**, which carries broad organization privileges. Only provide keys whose scope you are comfortable with, and prefer the narrowest key a vendor offers.
- **Bring your own keys, and never commit them.** Secrets, tokens, account identifiers, and raw vendor responses are kept out of logs and rendered output by design.

## Architecture

An Effect‑centered TypeScript **pnpm monorepo**. Cross‑cutting concerns live behind central boundaries so provider adapters stay thin:

- `packages/contracts` — plain‑TypeScript public types.
- `packages/provider-registry` — the provider/action‑family catalog (windows, units, severity strategy, credential class).
- `packages/settings` · `validation` · `errors` · `logging` · `http` · `scheduler` · `display` — the central settings, edge‑validation, typed‑error, sanitizing‑log, HTTP, retry/backoff, and rendering boundaries.
- `packages/runtime-foundation` — Effect runtime composition and safe Promise bridges.
- `packages/action-usage` · `action-balance` · `provider-adapters` — action‑family semantics and per‑provider adapters.
- `apps/streamdeck` — the Stream Deck SDK shell, manifest, Property Inspectors, renderer, and composition root.

## Development

```sh
pnpm run build              # build all packages + the plugin bundle
pnpm test                   # vitest (unit tests, no live vendor calls)
pnpm run typecheck          # tsc across all packages
```

Tests run entirely offline — no live provider calls, credential reads, or device mutation.

**Install‑safety policy.** This workspace hardens pnpm's supply‑chain settings in `pnpm-workspace.yaml` — dependency build scripts are blocked unless explicitly vetted (`allowBuilds`), and versions resolve from the committed lockfile. `msgpackr-extract`, an optional native accelerator pulled in transitively by the Stream Deck SDK, is intentionally **not** built; `msgpackr` falls back to a pure‑JS path that easily handles the plugin's small control messages. If you add a dependency whose installer runs a build script, pnpm pauses and asks you to record a `true`/`false` decision for it (in `allowBuilds`) before the install completes.

## Disclaimers & legal

- **No affiliation.** This project is independent and is **not affiliated with, endorsed, sponsored, or supported by** any of the vendors named above. All product names, logos, and trademarks are the property of their respective owners; they are used here only to identify the service each key monitors.
- **Undocumented / unofficial endpoints.** Several providers are read through endpoints that are not part of a public, documented API. They may change, rate‑limit, or break without notice.
- **Local OAuth credentials.** The Claude Code and Codex usage providers read OAuth tokens that those tools store on your machine, to show *your own* usage. Those tokens are intended for the official apps; using them from other software may conflict with a provider's Terms of Service. **Use at your own discretion and risk**, and review the relevant vendor's terms before relying on it.
- **No warranty.** This software is provided "as is," without warranty of any kind. You are responsible for how you use it and for compliance with each vendor's terms.

## License

Released under the **MIT License** — see [LICENSE.md](LICENSE.md).
