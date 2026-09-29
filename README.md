# Whiskerwood MCP

An MCP server for writing Lua mods for Whiskerwood (Unreal Engine 5.6) and injecting them
into the game through [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS).

It gives an AI assistant what it needs to write working mods instead of guessing: a local
index of the game's reflection data, data tables and localisation, verified hook paths,
mod scaffolding and validation, and a live bridge into the running game — hot deploy, Lua
evaluation, UI tree dumps, screenshots and crash reports. Tools are listed in
[docs/TOOLS.md](docs/TOOLS.md).

Everything runs locally. No game data in this repository: the index is built from **your**
copy of the game.

## Quick start

Clone the repo into any folder:

```bash
git clone https://github.com/MirakuruRR/WhiskerWood_MCP
```

This repo is the *tool*; your mods live next to it. The mods folder is created
automatically on first run:

```
<anywhere>/
  WhiskerWood_MCP/     this repo
  WhiskerWood_Mods/    your mods
```

Open `WhiskerWood_MCP` in any AI environment and run the **`/ww-setup`** skill. It walks
the whole installation with you: checks the toolchain, finds the game, installs UE4SS and
the bridge, connects the MCP server, captures dumps from inside a save and builds the
index. Run it again whenever `bun run doctor` reports a problem.

The manual route is in [docs/SETUP.md](docs/SETUP.md).

## Legal

MIT licensed — see [LICENSE](LICENSE).

Not affiliated with, endorsed by or connected to Minakata Dynamics Co. Whiskerwood and its
assets belong to their respective owners. This repository ships **no game data**: every
index, dump and extracted asset is generated locally from a copy of the game you already
own.
