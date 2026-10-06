**English** · [简体中文](README.md)

# dsh-import-newapi

Import the connection info copied from [New API](https://github.com/Calcium-Ion/new-api) as a new
provider of the `@deepseek-ai/dsh-llm-pi-ai` adapter in the current profile, and store the API key
in the DSH credentials file.

Repository: <https://github.com/Deanyu148/dsh-import-newapi>

- **Where it lives**: DSH settings panel → "New API Import" (right below "Models").
- **Connection info** is written to the current profile's `cordis.patch.yml`, under
  `config.providers.<provider id>` of the `llm-pi-ai` entry. Only new keys are added; no existing
  key or parent key is ever touched.
- **The API key** is written to `refs:` in `$DSH_HOME/.credentials.yaml`, with the ref name derived
  from the provider id.
- To hook up a second New API instance, just import again — it creates another provider.

## Installation

```bash
# Inside DSH: Settings → Plugins → Install, then enter the absolute path of this directory
# Or let the agent install this directory with plugin_manager install_bundle
```

Refresh the page afterwards and "New API Import" shows up in the settings sidebar.

## Usage

1. **Connection info**: paste the JSON copied from New API into the first box, for example
   `{"_type":"newapi_channel_conn","key":"sk-…","url":"https://…"}`.
   Once it is recognized, the site URL and the key are filled in for you; you can also type them by
   hand.
2. **Provider**: fill in the provider id (a candidate is suggested from the site URL), an optional
   display name, and the protocol. `baseURL` is derived from the protocol and can be overridden:
   - OpenAI Chat Completions / OpenAI Responses → `<site URL>/v1`
   - Anthropic Messages → `<site URL>` (the SDK appends `/v1/messages` itself)
3. **Models**: click "Fetch model list", filter with the search box, tick models one by one, or use
   "Select all / Invert / Select none" (those three buttons only apply to the current search
   results).
4. **Name and capacities**: every ticked model gets a row — the model id on the left (read-only),
   then the **name**, the context window, and the max output.
   - The name is the display name of that model (`models[].name`, **not** the id). It defaults to
     the name reported by the catalogue and can be edited per model. Leaving it empty, blank, or
     identical to the id means the key is not written at all.
   - Capacities accept forms like `256K` / `1M` (`K`/`M` are decimal, i.e. 1K = 1000,
     1M = 1000000, fractions allowed), or plain numbers. **Leaving them empty means the key is not
     written**, and the adapter or the built-in catalogue decides.
     Verified: `272K` → `272000`, `1.05M` → `1050000`, `384K` → `384000`.
5. **Input modalities and reasoning effort** (both optional): one card per ticked model.
   - **Input modalities**: tick `Text` / `Image`. Text is ticked by default, and Image is ticked by
     default when the catalogue reports that the model accepts images. Text only equals the
     adapter default, so **no `input` key is written**; ticking Image writes
     `input: [text, image]`; ticking nothing writes nothing.
   - **Reasoning effort**: this is `reasoningEfforts` from the template. Each model offers six
     levels `off / low / medium / high / xhigh / max` (the UI shows the level names in the current
     language). Once a level is ticked: the middle input is the **config key** (the level name by
     default, editable) and the right input is the **value sent to the gateway for that level**
     (same as the level name by default, editable).
     - `off` may have **a key with no value**: leaving it empty means "do not send this parameter
       when not thinking" (rendered as `off: null`; in YAML `off:` and `off: null` are the same
       empty value). Giving `off` a value sends that value.
     - Every ticked level other than `off` must have a value, and the key name must be one of the
       levels the adapter allows (`off / minimal / low / medium / high / xhigh / max`), so to use
       `minimal` just rename the key of one row.
     - Ticking only `off`, duplicate key names, an empty key name, or a non-`off` level without a
       value are all blocked before the import runs, with the reason shown.
     - **Ticking no level at all means `reasoningEfforts` is not written**, and the adapter plus the
       built-in catalogue decide what the model supports.
6. Click "Import". The expandable preview shows the provider object that is about to be written.

## Rules

- **Provider id**: starts with a lowercase ASCII letter and may only contain lowercase letters,
  digits and hyphens (`-`); a hyphen may not lead, trail, or repeat. An id that already exists is
  always refused — this plugin only adds, never overwrites.
- **Credential ref name**: the provider id uppercased, `-` replaced with `_`, plus a trailing
  `_API_KEY`. For example `example-api` → `EXAMPLE_API_API_KEY`,
  `example-api-2` → `EXAMPLE_API_2_API_KEY`.
- **How it writes**: everything is submitted through DSH's own remotes (`settings.mutate` /
  `credentials.set`), so validation, locking, atomic writes and hot reload are the host's job. The
  plugin never edits files by itself (with the single textual exception described below).
- **When the key is already supplied by the environment** (`describe` reports `writable: false`),
  the import skips writing `.credentials.yaml`, says so, and still writes the provider.
- **An empty `refs: {}` is removed before anything is written**: the credentials provider works by
  parsing the file into a YAML document, changing one key in place, and rendering it back, so the
  existing formatting is mostly preserved. When the file contains nothing but an empty flow
  mapping, a new key can only be squeezed onto the same line
  (`refs: { EXAMPLE_API_API_KEY: sk-… }`). The host half deletes that line on mount and watches the
  file, so the provider creates a block mapping instead:

  ```yaml
  refs:
    EXAMPLE_API_API_KEY: sk-…
  ```

  Both forms are completely equivalent as far as the provider is concerned, so this is a pure
  textual tidy-up: the plugin only deletes an empty `refs: {}` line, never parses or generates
  YAML, and never reads or writes any key material (values are always written by
  `credentials.set`). The location is probed three times, most trustworthy first: the path the
  live credentials service reports → `$DSH_HOME/.credentials.yaml` → `<home>/.credentials.yaml`
  derived from the load base directory, finally falling back to `~/.dsh`; and only a file that
  really is a `version: 1` credentials document is ever touched.
- **Model entries only carry keys that have information**: no `name` when it is empty or identical
  to the id, no capacities when they are empty, no `input` when only Text is ticked, no
  `reasoningEfforts` when no level is ticked. The key order follows the template: `id`, `name`,
  `contextWindow`, `maxTokens`, `input`, `reasoningEfforts`.
- **The reasoning values** follow the adapter's `resolveModelReasoning` rules (every level except
  `off` needs a value, and a declared map needs at least one non-`off` level). Generated entries
  were checked against the profile's real `@deepseek-ai/schemastery` with the adapter's own schema
  (`lib/index.js:1001-1013`): `off: null` and the custom key `minimal` both validate, while unknown
  level keys and non-string values are rejected.
- **Note**: when config-editor writes, it re-renders the whole `config` block of that entry, so
  comments inside the `llm-pi-ai` entry's `config:` are lost. Comments of other entries are not
  affected.

## Development

```bash
node test/run.mjs
```

The offline test loads the real client bundle, hands it a mini React and a fake cordis context,
runs the whole import flow (paste → derive → fetch models → tick → fill names/capacities → tick
modalities → tick reasoning levels → submit) and asserts the payload handed to the host. The
`__internals` export at the end of `lib/client.js` exists for that purpose. The host half is covered
too: the empty `refs: {}` rewrite (including reproducing the provider's real write with the
profile's own `yaml`), the guard that only touches credentials documents, candidate path priority,
and mount-time normalization plus file watching.

After editing `lib/client.js` a **page refresh** is enough; after editing `lib/index.js` (the host
half) you **must restart DSH** — disabling and re-enabling the plugin with `plugin_manager` does not
re-import a host module (Node's ESM cache), whereas the browser half picks up a new bundle on every
refresh.

## Releasing (maintainers)

```bash
npm run release                 # checks → tests → publish latest (always the official registry)
npm run release -- --dry-run    # checks only, then prints the files that would be published
npm run release -- --tag beta   # publish under another dist-tag
npm run release -- --otp 123456 # one-time password for a 2FA account
```

`scripts/publish.mjs` runs these steps in order and stops with a clear reason as soon as one of them
is not satisfied:

1. checks the name, version and registry — the registry is hard-coded to
   **`https://registry.npmjs.org/`**, no mirror configuration is followed;
2. requires a clean Git working tree (`--skip-git-check` overrides it) and reports unpushed commits;
3. runs `node test/run.mjs` (`--skip-tests` overrides it, not recommended);
4. asks the registry API whether that version was already published — if it was, it only tells you
   to `npm version patch` and **never overwrites**;
5. runs `npm publish --registry https://registry.npmjs.org/`.

With a 2FA account you can pass `--otp` straight away, or run
`npm login --auth-type=web` first and then `npm run release`.

## Files

| File | Purpose |
| --- | --- |
| `lib/index.js` | Host half: mount-time self-check, normalizes an empty `refs: {}` into a block `refs:` section, and watches that file |
| `lib/client.js` | Browser half: the settings page and the import flow |
| `cordis.patch.yml` | Inserts this plugin's entry into the profile |
| `test/run.mjs` | Offline self-test: mini React + fake cordis context, runs the full import flow and asserts the payload |
| `scripts/publish.mjs` | Release script: tests → registry and version checks → `npm publish` |
