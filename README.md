# Whiskerwood MCP

An MCP server that turns an AI assistant into a competent Whiskerwood modder.

Whiskerwood is an Unreal Engine 5.6 game modded through [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) Lua
scripts. Writing those scripts by hand means guessing at reflection names, hook paths and
engine quirks — and a wrong guess fails *silently*: the hook never fires, the mod loads
fine, nothing happens. This server removes the guessing. It builds a local index of the
game's reflection data, data tables and localisation, then exposes 34 tools that answer
"what is this class, what is the exact hook path, what does this key say in English" —
plus a live bridge into the running game for evaluating Lua, dumping the UI tree, taking
screenshots and reading crashes.

Everything runs locally. No network calls at runtime, no game data in this repository:
the index is built from **your** copy of the game.

## Requirements

| | |
|---|---|
| OS | Windows (the game, UE4SS and this toolchain are Windows-only) |
| Game | Whiskerwood — Steam AppID 2489330 |
| [Bun](https://bun.sh) | 1.3+ — runs the server and the build scripts |
| [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) | 3.0.1, installed into `Whiskerwood/Binaries/Win64` |
| Python 3 | unpacks `AssetRegistry.bin` out of the game pak |
| [.NET SDK 10](https://dotnet.microsoft.com/download) | builds the CUE4Parse sidecar that reads data tables |
| An MCP client | [Claude Code](https://claude.com/claude-code), or any client that speaks MCP over stdio |

## Quick start

```bash
git clone https://github.com/MirakuruRR/WhiskerWood_MCP
cd WhiskerWood_MCP
bun install
cp wwmcp.config.example.json wwmcp.config.json   # edit paths if autodetect misses
bun run doctor                                   # tells you exactly what is missing
```

`doctor` checks the toolchain, locates the game through Steam, verifies UE4SS, the bridge,
the dumps and the index, and prints the next command for anything that is not ready.

Using Claude Code? Just run **`/ww-setup`** after cloning — the skill walks the whole
installation with you, including the steps a script cannot do (installing UE4SS, capturing
dumps from inside a save, restarting the client). See [docs/SETUP.md](docs/SETUP.md) for
the manual route.

## What you get

- **[34 tools](docs/TOOLS.md)** — reflection lookup, verified hook paths, data tables,
  localisation, asset extraction, mod scaffolding and validation, hot deploy into the
  running game, crash reports, screenshots, UI tree dumps.
- **A shared knowledge base** — 396 curated notes on what actually works in this game:
  which engine idioms break here, which subsystems are dead ends, why a given hook was
  chosen. It ships with the repo and merges into your local memory without clobbering
  your own notes. See [docs/MEMORY.md](docs/MEMORY.md).
- **A Lua runtime library** (`data/lib/ww/`) that survives UE4SS's two load modes, caches
  expensive object lookups and keeps dev reloads from stacking hooks.

> The knowledge base is written in Russian, as is most of this project's internal
> documentation. Identifiers, tags and hook paths are language-neutral and search works
> across them; assistants read the prose fine. English entries are welcome.

## Where your mods live

This repo is the *tool*. Your mods live in their own repository next to it:

```
<anywhere>/
  WhiskerWood_MCP/     this repo
  WhiskerWood_Mods/    your mods — start from the template
```

[WhiskerWood_Mods](https://github.com/MirakuruRR/WhiskerWood_Mods) is a working example and
a usable template: seven shipped mods, the project rules an assistant should follow, and
the release layout. Point `modsRepo` in your config at wherever you keep yours — an empty
folder is fine, the runtime library comes from this repo.

## Contributing

Bug reports and mods welcome. If you learned something about the game that is not
derivable from the code — a subsystem that does not work, an idiom that breaks, a hook
that had to be chosen a particular way — export it and send it upstream:

```bash
bun run memory:export --local-only
```

That writes only your own notes, with personal paths replaced by placeholders. Attach the
file to a pull request and it reaches everyone on their next `git pull`.

## Legal

MIT licensed — see [LICENSE](LICENSE).

Not affiliated with, endorsed by or connected to Minakata Dynamics Co. Whiskerwood and its
assets belong to their respective owners. This repository ships **no game data**: every
index, dump and extracted asset is generated locally from a copy of the game you already
own.
