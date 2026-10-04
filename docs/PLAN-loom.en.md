# Plan: the MCP for the Loom pipeline

English copy of [PLAN-loom.md](PLAN-loom.md). The other docs it links to are in Russian.

A working document, not part of the public docs. Sources: [LOOM-PIPELINE.md](LOOM-PIPELINE.md)
and experiments run on 2026-10-03 against game 0.7.209.0, Loom 0.1.0 and the mod kit at patch 29.
The measurements are tied to these versions: after a patch, re-measure them instead of quoting.

## Status

Items 0 and A–K were implemented on 2026-10-03/04. Departures from the plan:
- D: `.lm` is parsed structurally (`src/utils/lm-parser.ts`) rather than with the tree-sitter-loom
  grammar, which there is no way to build here; on Loom's 45-file corpus the result matched the
  grammar.
- E: `ww_loom_build` has `cancel`; F: copying into `<saved>/mods` is a separate `install`, and
  `status` only reads.
- J: single and batch lifting share one module of fallbacks, `src/utils/lift-fallback.ts`.

Measured after the final pass: `ww_lift` lifts 16 of 17 hard BPs (9 before), lifting the whole
game in `setup` gives 917 of 932 BPs, 2959 bodies, 1053 stubs, about 40 s. The `.lm` templates
build with LoomBuild (5 of 5 `built`). A pak mod goes through cook → install → game → modlog.

Left to a person: checking the templates in the game (only the editor creates a PAL),
registering the server at user scope (`/ww-setup`), pull requests to Loom (section below).

## Concept

UE4SS and this MCP stay on the modder's machine for game reconnaissance and live debugging. The
mod itself is built with Loom into a plain `.pak`, and players don't need UE4SS.

Compared to LOOM-PIPELINE.md, the emphasis shifts in three places:

1. **Reconnaissance produces Loom.** `loom lift` turns a cooked Blueprint, given as CUE4Parse
   JSON, back into `.lm`, and the sidecar already has CUE4Parse. The AI reads the game's logic in
   the same language it writes the mod in.
2. **"What can I subscribe to or override" replaces "what do I hook".** Blueprints have no
   hooks, so `ww_verify_hook` answers a question Loom never asks. Without a tool of its own,
   reconnaissance ends in polling from Tick.
3. **UE4SS is the only debugger a pak mod has.** The game is a shipping build: there is no engine
   log, and Blueprint errors are swallowed. The loop "build → install → restart with a save →
   read the log" can run without clicks in the editor.

| | Responsible for |
|---|---|
| loom-mcp | the language: `docs`, `types`, `check`. Not duplicated |
| this MCP | game knowledge (index, lift, memory), building and installing the mod, live checks |
| UE4SS + bridge | reconnaissance and debugging on the modder's machine |

Our tools call `loom.exe` directly rather than going through loom-mcp: `check`, `sources` and
`build` have `--json`, and `lift` prints text.

## Verified before planning

The experiments used a throwaway exporter on the same CUE4Parse 1.2.2 as the sidecar, and the
`loom.exe` shipped in the kit.

| What | Result |
|---|---|
| lift of every game BP, as is | 166 of 930 (18%). Almost none of the refusals are about logic: widget trees with nested user widgets (205 BPs), class and component defaults, unsupported EX tokens |
| lift with preprocessing and fallbacks (item A) | readable `.lm` for at least 820 of 930 (88%). Exporting every BP to JSON takes 10 s, lifting as is takes 16 s in 12 processes, the pass with fallbacks about 30 s |
| functions with tokens lift can't read yet | 666 of 4429 (15%): `EX_SwitchValue` 395, `EX_VectorConst` 278, `EX_RotationConst` 40, `EX_CallMulticastDelegate` 36, `EX_TransformConst` 8. Because of them, 191 of 521 event graphs can't be lifted at all |
| large UI BPs | `BP_PlayHud` lifts only with stubs, and 42 of its 60 bodies are empty: for now it's a skeleton, and the bodies come from `ww_get_bytecode` |
| lift versus disassembly | `ProblemSummaryBannerWidget.GetToolTipWidget`: `ww_get_bytecode` gives 8000 characters of EX_*, truncated, with `Problem Type` as bytes 0..14; lift gives about 80 lines with `EProblemSummaryType.*` and the tooltip keys |
| `ReadScriptData` | without `provider.ReadScriptData = true`, CUE4Parse leaves the bytecode out of the JSON, and lift silently returns empty bodies |
| Workshop mods | lift works: one mod's `BP_Startup` came out as 144 lines registering options, editing DataTables and building class references. Mods from the old kit were cooked with 5.6: CUE4Parse needs `GAME_UE5_6`, and their `.uplugin` has no `EngineVersion` |
| Blueprint access | 160 of the 1431 SystemCore/ProjectArco functions are missing from `types.json`: UE4SS can call them, Loom can't. `AgentEnterable.AssignWorkerToSlot` is `UFUNCTION()` without BlueprintCallable; `ArcoHUD.DrawArcPlan` is BlueprintCallable in the UE4SS dump but absent from the kit's stubs |
| kit versus index | all 1271 kit functions match the 0.7.209.0 index in their parameters, 0 differences |
| `types.json` coverage | 46 of the 940 registry BPs are missing: the main menu, `Config_*Mule`, `BP_ArcoGameInstance`. A build loads them, but `check` can't see them before one |
| Cook & Install | RunUAT BuildCookRun with fixed arguments (`<kit>/…/WWModTools/Private/ModActions.cpp`) plus a copy of `pakchunk<Id>-Windows.pak`. Scriptable without the UI |
| building from the editor | `ULoomLibrary.BuildBlueprints(bForce)` returns the JSON report and is reachable from Python and Remote Control. Both plugins ship with the kit's engine but aren't enabled in its `.uproject` |
| modlog | `LogMessage` lines carry no timestamps; only the loader's lines do. A session can only be cut by file offset |
| `loom types` | on a miss it suggests up to 20 type names containing the query; there is no member search (a correction to LOOM-PIPELINE.md) |
| connection | the whiskerwood server is registered only in this repository's `.mcp.json`, with a relative path; a session opened in the kit doesn't have it |

## Order of work

| Batch | Items | Why |
|---|---|---|
| 0 | 0 (foundation) | decisions shared by every item: without them, each item invents its own |
| 1 | A (lift), B (Blueprint layer) | cheap: the sidecar already reads bytecode and `types.json` is ready. They change the quality of reconnaissance the most |
| 2 | E (build), G (modlog), D (validation) | feedback without reading logs by hand |
| 3 | F (install), C (live checks) | an autonomous loop and debugging of the mod |
| 4 | H (reaction points) | the most valuable in substance, but it joins data from three sources and needs care |
| 5 | I (snapshots), J (lifting the whole game), K (toolsets, prompts, connection) | safety net and convenience. The connection part of K is cheap and can be done at any time |

---

## 0. Foundation: decisions shared by all items

**Problem.** Items A–K rely on the same things: where the kit and the engine are, how external
programs are run, what to do with operations that take minutes, how path forms map onto each other,
and where writing is allowed. Unless these are settled first, each item will invent its own.

**Change.**
1. **Config and finding the kit.**
   - A new key, `kitDir`: the kit's root, holding its `.uproject`. It is optional: without it the
     Loom tools answer `kit_not_configured` with a hint about `/ww-setup`, and everything else
     works as before.
   - The engine is found without config: the GUID in `EngineAssociation` of the kit's `.uproject`
     → `reg query "HKCU\Software\Epic Games\Unreal Engine\Builds" /v <GUID>` → the build's root;
     `<engine>` is its `Engine` subfolder. The `engineDir` key is only a manual override.
   - `savedDir` defaults to `%LOCALAPPDATA%/<basename(gameDir)>/Saved`, by the same rule that
     already gives `saveDir`.
   - Derived paths live in one place: `loom.exe`
     (`<kit>/Plugins/LoomEditor/Binaries/ThirdParty/Loom/Win64/`), `UnrealEditor-Cmd.exe` and
     `UnrealPak.exe` (`<engine>/Binaries/Win64/`), `RunUAT.bat` (`<engine>/Build/BatchFiles/`),
     `types.json` and `report.json` (`<kit>/Intermediate/Loom/`), the editor log
     `<kit>/Saved/Logs/Whiskerwood.log`, `<saved>/Logs/modlog.txt`, `<saved>/mods/`.
   - `doctor` shows a Loom section: which of these were found, and how the engine was found
     (registry or key). A missing kit is a warning, not an error.
   - `/ww-setup` asks for the kit's path and writes `kitDir`.
2. **`utils/loom.ts` is the only place external programs are run** (`loom.exe`,
   `UnrealEditor-Cmd`, `RunUAT`, `UnrealPak`): a timeout, killing the process tree when it expires
   (`taskkill /T /F`), JSON parsing, and errors of the form `not_configured | not_found | timeout |
   exit_code | crash` with the tail of stderr.
   - On failure, `loom check --json` and `loom build --json` print JSON and exit with 1: that is a
     result, not a failure to run.
   - `loom lift` prints text (`wrote …`, `could not lift …`) and exits with 1 when it refuses; on a
     stack overflow the process dies without output, which is the separate `crash` outcome.
3. **Long operations are jobs.** A cook or a headless build takes minutes, and the first cook
   outlasts any reasonable call timeout. So: jobs, and blocking calls only for short operations
   (lift, check, status).
   - `utils/jobs.ts` and `scripts/job-runner.ts`: the tool starts the runner as a detached
     process; the runner starts the program, writes its output to `state/jobs/<id>.log`, and its
     exit code and timing to `state/jobs/<id>.json`. The job survives a restart of the MCP server,
     and its status is read from the file.
   - The tool owns its jobs: `action: start | status | cancel` and a `job_id`, like `session_id` in
     `ww_trace_calls`. `status` parses progress out of the log, as `ParseUATLine` does in
     WWModTools.
   - One job per kit at a time: a cook and a headless build write into the same project. A second
     `start` answers `busy` with the running job's id.
   - `cancel` is `taskkill /T /F` on the runner: RunUAT spawns AutomationTool and
     UnrealEditor-Cmd.
   - The last N jobs are kept, as `LOG_KEEP` does for logs.
4. **Paths.** One mapping between the forms:
   - index (`SystemCore.ModAPI.WriteDataTableValue`,
     `ProblemSummaryBannerWidget.ProblemSummaryBannerWidget_C.GetToolTipWidget`);
   - `hook_path` (`/Script/SystemCore.ModAPI:WriteDataTableValue`);
   - Loom: a type's path in `types.json` (`/Script/SystemCore.ModAPI`,
     `/Game/UI/BP_PlayHud.BP_PlayHud_C`) and the short name in a source (`ModAPI`, `BP_PlayHud`:
     `_C` is dropped when the rest matches the asset's name, the `short_name` rule in Loom's
     `project.rs`);
   - the asset path (`/Game/UI/BP_PlayHud`) and the path in the pak for CUE4Parse
     (`Whiskerwood/Content/UI/BP_PlayHud.uasset`).

   Extend `scripts/parsers/path-forms.ts` and `findObject` in `tools/common.ts` rather than
   writing this in each tool. `/Game/Mods/…` paths are recognized separately and never looked up
   in the index: the live tools resolve them (item C). A short name can be ambiguous; then return
   the candidates, not the first match.
5. **Toolsets.** Every `registerTool` and prompt gets a group: `recon` (15 tools, `ww_lua_api` and
   `ww_verify_hook` included), `live` (11), `lua` (6), `memory` (4), `loom` (the new ones).
   `createServer` registers only the groups enabled in the config's `toolsets`. By default all are
   enabled, so existing setups don't change. Which groups Loom mode needs is item K.
6. **Write boundaries.** The server's new write zones: `state/lift/`, `state/jobs/`,
   `state/backup/` (inside the sandbox) and `<saved>/mods/<Mod>`, through a separate `PathSandbox`
   used only by `ww_loom_install`, which checks that the target is exactly the current mod's
   folder. The server never writes into `<kit>/Content` or `<kit>/Plugins`. A separate category is
   the processes the server starts: LoomBuild and RunUAT write into the kit (`Content/Mods`,
   `Intermediate`, `Saved`, `Windows`). All of this goes into the «Границы» (Boundaries) section of
   ARCHITECTURE.md in one edit.
7. **Format and wrappers.** New tools answer through `renderAiText` / `errorText`
   (`utils/ai-text.ts`), like the rest. Tools that don't need the index (build, install, kit
   status) get a wrapper that doesn't fail on a stale profile, like `wrapBridge`. Lift and the
   Blueprint layer go through the regular one: they need the current game version, and a `.usmap`
   from the previous version silently yields empty or wrong data.

**Check.**
- `bun run typecheck`, `bun run doctor`: a Loom section with the paths found; without `kitDir`, a
  warning.
- `bun run smoke` with the default config: the same 36 tools; with `toolsets` without `lua`, 30.
- `loom sources --project <kit> --json` through `utils/loom.ts` returns the kit's sources.
- A job on a harmless command (waiting a few seconds): `start`, `status` while it runs, `status`
  after a server restart, `cancel`.
- `findObject` resolves `ModAPI`, `/Script/SystemCore.ModAPI` and `SystemCore.ModAPI` to the same
  index object; a `/Game/Mods/…` path is marked as a mod path.

**Files.** `config.ts`, `wwmcp.config.example.json`, `utils/loom.ts` (new), `utils/jobs.ts`
(new), `scripts/job-runner.ts` (new), `scripts/parsers/path-forms.ts`, `tools/common.ts`,
`server.ts`, `prompts.ts`, `scripts/doctor.ts`, `.claude/skills/ww-setup/SKILL.md`,
`docs/SETUP.md`, `docs/ARCHITECTURE.md`, `docs/TOOLS.md`.

**Risk.** A detached process on Windows: check that a cook survives a restart of the MCP server
and that `cancel` kills the whole tree. Finding the engine through the registry works only on
Windows, like the rest of the server (`taskkill`, game window captures).

## A. `ww_lift`: a game or Workshop BP → `.lm`

**Problem.** The logic of the game's BPs is visible only as EX_* disassembly from
`ww_get_bytecode`: long, truncated, with enums as numbers. The AI translates it into Loom in its
head and makes mistakes.

**Change.**
1. A `json` verb for the sidecar: `WwParse json --paks <dir> --usmap <file> --asset <vfs> --out <file>`.
   Inside, `provider.ReadScriptData = true` and `JsonConvert.SerializeObject(package.GetExports())`.
   The engine version for the game comes from the `.usmap` name, as in `EngineOf`; for a Workshop
   mod, from `EngineVersion` in its `.uplugin`, and `GAME_UE5_6` when it has none.
2. A scratch Loom project in `state/lift/<game version>/`: `Lift.uproject` containing `{}` and a
   copy of `<kit>/Intermediate/Loom/types.json`. Run `loom.exe lift <json> --project <project>`;
   the output lands in its `Content/`. **Never lift into `<kit>/Content`:** LoomBuild would build
   such a source on top of the game's BP in the kit.
3. Preprocess the JSON: drop the `Hex` keys (CUE4Parse writes them into colors, and the lifter
   refuses them) and zero floats whose magnitude is below 1e-4 (Loom's printer writes them in
   exponent notation, which its parser can't read back).
4. Fall back in a loop until it succeeds, with a limit of about 40 iterations. A stubbed function
   gets `ScriptBytecode = [EX_Return, EX_EndOfScript]`.
   - before the first run, stub the functions whose bytecode holds `EX_SwitchValue`,
     `EX_VectorConst`, `EX_RotationConst`, `EX_TransformConst` or `EX_CallMulticastDelegate`;
   - `reading the widget tree` or a stack overflow → delete `WidgetTree.Properties.RootWidget`;
   - `function X:` or `event X:` → stub X. Events that enter a stubbed ubergraph fail with
     `an event graph with no entry jump` and are stubbed the same way;
   - `reading the event graph` → stub `ExecuteUbergraph_*`;
   - `component C's F` → delete F from the `C_GEN_VARIABLE` export;
   - `default X` or `a default for X` → delete X from the CDO;
   - `the lifted source does not parse: L:C` → find the enclosing `fn | on | event` in the
     printed text (the error includes it) and stub it.
5. Mark every stubbed function in the output: `// not lifted: <reason> → ww_get_bytecode <path>`.
   Otherwise the AI will believe the body really is empty. When the widget tree was dropped, say
   that `ww_ui_tree` shows the layout.
6. Cache by (game version, asset), cleared together with the profile.
7. `ww_get_bytecode` stays as the fallback; its description points to `ww_lift` first.

**Files.** `sidecar/WwParse/Program.cs`, `tools/lift.ts` (new), `utils/loom.ts` (from item 0),
`server.ts`, `docs/TOOLS.md`.

**Risk.** Lift 0.1.0 is all or nothing per package, hence the fallbacks. Until `EX_SwitchValue` is
supported upstream, large UI BPs come out mostly as skeletons. Lifted Workshop mods are a local
reference only: they don't go into the seed, and other people's code isn't redistributed.

## B. A Blueprint layer in the index tools

**Problem.** UE4SS sees and calls everything; Loom reaches only what Blueprints can. The AI finds
a function through the index or `ww_game_eval`, writes Loom, and learns it's a dead end at
`check`, or even later. In LOOM-PIPELINE.md, confirming through `loom types` is a manual step,
and it gets forgotten.

**Change.**
1. `utils/loom-types.ts`: read `<kit>/Intermediate/Loom/types.json` (about 10 MB, 11 thousand
   classes) with an mtime cache, and map index paths to Loom ones (`SystemCore.ModAPI` ↔
   `/Script/SystemCore.ModAPI`, `X_C` ↔ `/Game/.../X.X_C`).
2. `ww_get_function`: a `bp` field (`callable | pure | latent | world_context | internal |
   deprecated | editor_only | not_callable | not_in_types`), a `dir` on each parameter
   (`in | ref | out`), and `loom_call`, a ready-made Loom call:
   - static functions through the class name;
   - instance methods through the class's static getter when it has one (`ModAPI.GetModAPI()`),
     otherwise `<object>.Method(...)`;
   - WorldContext and hidden pins removed, out parameters as fields of the result, names with
     spaces in backticks.

   Example: `ModAPI.GetModAPI().WriteDataTableValue(datatableName, rowId, ColumnName, valueStringified) -> bool`.
   The tool's description gets the rule "don't assemble the call yourself, copy `loom_call`", as
   for `hook_path`.
3. `ww_get_type`: fields get `bp: read | read_only | edit_only | hidden`, methods get the status
   from step 2. A game BP missing from `types.json` is marked "will be loaded at build time".
4. `ww_find_symbol`, `ww_search_members`: a `bp` column and a `bp_only` filter.
5. Without `types.json` (the kit isn't configured or has never built), the field is left out with
   a hint, and the tool doesn't fail.

**Files.** `utils/loom-types.ts` (new), `tools/get-function.ts`, `tools/get-type.ts`,
`tools/find-symbol.ts`, `tools/search-members.ts`, `server.ts`.

**Risk.** `types.json` is a snapshot of what the kit's editor had loaded. For game BPs, "not in
types" doesn't mean "can't be called": `not_in_types` and `not_callable` must stay distinct.

## C. Live checks in Blueprint terms

**Problem.** A cook with a restart takes minutes; a live call takes seconds. But a chain proven in
Lua may be one Loom can't repeat.

**Change.**
1. `ww_call` with `bp_only: true` refuses functions whose status is anything but
   `callable | pure`, and its reply prints the same call in Loom. A chain such as
   `GetArcoSys → GetResearchInfo → ResearchState.activeResearch` is checked live and moved into
   the mod one to one.
2. `ww_game_eval`: after the run, a warning lists the members the chunk touched that Blueprints
   can't reach (names from the chunk's text, checked against item B).
3. `/Game/Mods/<Mod>/...` paths in `ww_trace_calls`, `ww_call` and `ww_ui_tree`. The game's
   index doesn't have them, so the signature comes live through the bridge (UFunction
   reflection) or from the mod's cooked pak through the `json` verb. Only full paths: every mod
   has a `BP_MapLoad_C`.

**Files.** `tools/call-function.ts`, `tools/trace-calls.ts`, `tools/ui-tree.ts`,
`tools/game-eval.ts`, `tools/common.ts`, `bridge/WWBridge/Scripts/main.lua` (if the live signature
needs a bridge command).

**Risk.** Hooking a mod's BP functions through this bridge hasn't been tried yet. Spike it first,
one call at a time.

## D. `ww_loom_validate`: check plus game rules

**Problem.** `check` sees only the source. Kit and game pitfalls show up in the game, where the
mod "just doesn't work".

**Change.**
1. Run `loom.exe check --project <kit> --json` and translate the errors. `missing` naming game
   BPs is not an error: LoomBuild loads them.
2. Check the mod's `.lm` files, parsed with the tree-sitter-loom grammar from `<loom-src>` rather
   than a hand-written parser:
   - the header `blueprint X : P at /Game/Mods/<Mod>/X` matches the file; the folder, the
     `.uplugin` and the future pak share one name; `PAL_<Mod>` exists;
   - `LogMessage` without the mod's prefix;
   - `\n` in a variable's default value;
   - inheriting from a game widget (an empty `Loom_Canvas` over the parent's tree);
   - overriding a function that returns a value;
   - assigning `DeprecateSlateVector2D` fields (`SlateBrush.ImageSize`);
   - touching the world in `BP_MapLoad`'s `ReceiveBeginPlay` before `onLoadingFinished`;
   - pitfall entries in memory with tags act as triggers, through the same mechanism as in
     `ww_validate_mod`.
3. Check the references to game classes, functions and fields against the index: present in the
   kit but absent from the game means the stubs drifted after a patch.

**Files.** `tools/loom-validate.ts` (new), `utils/loom.ts`, `utils/lm-parser.ts` (new,
tree-sitter-loom), `tools/memory-common.ts`, `server.ts`.

## E. `ww_loom_build`: the build and its report

**Problem.** A build's outcome sits in `report.json` and `Whiskerwood.log`, and nothing reads them
automatically. A failed build can crash the editor on the next one.

**Change.**
1. `action: status`: the last `report.json` and the tail of `LogLoomBuild` / `LogLoom` from
   `<kit>/Saved/Logs/Whiskerwood.log`, without building.
2. `action: build`.
   - The editor has the kit open: saving an `.lm` starts the build (DirectoryWatcher, 0.5 s).
     The AI saves the file itself, and the tool waits for a `report.json` newer than its start.
   - The editor is closed: `UnrealEditor-Cmd <uproject> -run=LoomBuild -unattended -nosplash
     -nullrhi -nopause -stdout [-force] -report=<file>`. Starting the editor without its UI takes
     minutes, so this is a job from item 0.
   - Before starting, look for an editor process with this `.uproject` on its command line: two
     builds of one project must never run at once.
3. Known failures come with the fix:
   - `failed` in the applier: the next build can die on the `FindObject<UBlueprint>` assert, so
     delete the autosave from `<kit>/Saved/Autosaves` first;
   - `failed, N errors, 0 Blueprints` is a failure at the source level and safe.
4. Later, if Remote Control or Python is enabled in the kit: call
   `ULoomLibrary.BuildBlueprints(bForce)` directly and get the report synchronously, `force` with
   the editor open included. Enabling the plugins changes the kit's `.uproject`, which is the
   user's call.

**Files.** `tools/loom-build.ts` (new), `utils/loom.ts`, `server.ts`.

## F. `ww_loom_install`: cook → `Saved/mods`

**Problem.** Cook & Install exists only in the editor's context menu, so the loop needs a person
on every iteration.

**Change.**
1. RunUAT with the WWModTools arguments: `BuildCookRun -project=<uproject> -platform=Win64
   -clientconfig=Shipping -build -cook -stage -pak -archive -archivedirectory=<kit>
   -nocompileeditor -installed -iterativecooking -cookincremental -nop4 -utf8output -unattended
   -WaitForUATMutex`. The cook takes minutes, so it is a job from item 0
   (`action: start | status | install | cancel`; `status` only reads, `install` copies).
2. Find the mod's chunk without the editor: the `pakchunk<N>-Windows.pak` in
   `<kit>/Windows/Whiskerwood/Content/Paks` that holds `/Game/Mods/<Mod>/` (`UnrealPak -List` or
   CUE4Parse).
3. Copy to `<saved>/mods/<Mod>/<Mod>.pak`, plus the `.uplugin` from `Content/Mods/<Mod>/`; the
   previous version goes to `state/backup/`, as with `ww_install_mod`.
4. Checks: the pak holds only `/Game/Mods/<Mod>/…`; it is smaller than 123,999,999 bytes (the
   loader's limit, recorded in memory); the `.uplugin`, the folder and the pak share one name;
   `EngineVersion` is `5.8`.
5. The reply says what was installed and suggests `ww_game_process restart save=… wait_for=world`:
   pak mods load only when the game starts.

**Files.** `tools/loom-install.ts` (new), `utils/loom.ts`, `server.ts`, `docs/ARCHITECTURE.md`.

**Risk.** A new write boundary, `<saved>/mods/<Mod>`, of the same kind as `<ue4ssDir>/Mods` for
`ww_install_mod`.

## G. modlog in `ww_game_log`

**Problem.** The modlog is the only channel out of the game. `LogMessage` lines have no
timestamps, so a session can't be cut by time, and loader failures (`Not loading mod`, the size
limit) get lost among the mods' lines.

**Change.**
1. `source: ue4ss | modlog`; the modlog is `<saved>/Logs/modlog.txt` (not `Logs/modlog.txt`, as
   the kit's README says).
2. On start, `ww_game_process` records the modlog's size in `ProcessState`, and `since: session`
   reads from that offset. Don't rotate the file: it belongs to the game.
3. Loader lines go in a separate warnings block; the `mod` filter matches the `<Mod>:` prefix the
   kit uses.

**Files.** `tools/game-log.ts`, `utils/mod-log.ts` (new), `utils/game-process.ts`,
`tools/game-process.ts`, `server.ts`.

## H. `ww_event_surface`: what to subscribe to and what to override

**Problem.** Blueprints have no hooks. The question "what do I hook", which `ww_verify_hook`
answers, becomes "what can I subscribe to or override" in Loom. Without a tool, the answer is
polling from Tick, as in the port described in LOOM-PIPELINE.md.

**Change.** For a class or subsystem, list the reaction points, most preferred first:
1. ModAPI delegates (`onLoadingFinished`, `onBuildingSpawned`, `onWhiskerSpawned`,
   `onOptionChanged`, `onDayStart`) with their signatures for `bind`;
2. `BlueprintAssignable` dispatchers of the class itself and of the objects in its fields, with
   their signatures (`multicast_delegate` and `signature` in `types.json`);
3. events a subclass can override (the `event` flag in `types.json`), and whether the game will
   spawn that subclass. That comes from where the class appears in `datatable_rows` and in xref's
   `ref` edges. A DataTable reference means the class can be swapped through
   `ModAPI.WriteDataTableValue`, as is done with `GridActor` in `GridactorDefs_Sync`; memory has an
   entry on it;
4. as a last resort, polling from Tick with `bTickEvenWhenPaused` and `TG_PostUpdateWork`.

Each point comes with a hint for checking it live: `ww_trace_calls` on the event's UFunction shows
whether it fires, and when.

**Files.** `tools/event-surface.ts` (new), `utils/loom-types.ts`, `server.ts`, `docs/TOOLS.md`.

**Risk.** The graph of objects reachable through fields grows fast, so depth 1 and a limit.
Finding a class in `datatable_rows` is a substring search, so those hits are candidates, not
facts.

## I. Reconciling the three snapshots of the game

**Problem.** The index is taken from the live game, the kit's stubs from the patch its maintainers
chose, and `types.json` from the kit's editor. If the kit falls behind after a patch, Loom builds
the mod against old signatures, and it breaks on the player's machine. This is the same principle
as "the profile is tied to the game version" in ARCHITECTURE.md.

**Change.**
1. `ww_loom_status` (or a section of `ww_index_status`) and `doctor`:
   - the kit's `GameInstallDirectory.txt` points to `gameDir`;
   - the mtime of `types.json` against the mtime of the game's pak;
   - the Loom version in `<kit>/Intermediate/Loom/ops/build.json` (the `version` field, written
     by `loom build`) against the plugin's `VersionName` in
     `<kit>/Plugins/LoomEditor/LoomEditor.uplugin`; `loom.exe` has no `--version`;
   - whether the editor is open, and the last `report.json`.
2. A diff of `types.json` against the index for native classes: what the kit has and the game
   doesn't, and what the UE4SS dump marks BlueprintCallable but the kit lacks. There is nowhere to
   read the kit's version from (only commits like "Update to patch 29"), so rely on the diff, not
   on a number.
3. The `ww:fix-after-patch` prompt gets a step running this diff for Loom mods.

**Files.** `tools/loom-status.ts` (new) or `tools/index-status.ts`, `scripts/doctor.ts`,
`prompts.ts`.

## J. Lifting the whole game while building the index, and code search

**Problem.** Lifting on request answers "what does BP X do", not "where in the game is Y done".

**Change.**
1. A `bun run setup` step after xref: export every BP to JSON and lift them as one batch, so the
   BPs see each other, with the fallbacks from item A. About a minute.
2. The output goes to `dist/games/<version>/lift/`, plus an FTS table of functions: path, name,
   text. `profile_meta` records the sha of the `types.json` the lift ran against.
3. `ww_lift` gets a `pattern` mode, a search over the game's code: function, line, snippet.
4. Without a kit the step is skipped, with a note in `profile_meta`, and the profile's acceptance
   checks don't depend on it.

**Files.** `scripts/setup.ts`, `scripts/index-lift.ts` (new), `schema.ts` (table,
`INDEX_SCHEMA_VERSION`), `tools/lift.ts`.

## K. Toolsets, prompts, connection

**Change.**
1. Which toolsets Loom mode uses (the mechanism is in item 0): switch off `lua`, that is
   `ww_scaffold_mod`, `ww_generate_hook`, `ww_validate_mod`, `ww_deploy_mod`, `ww_package_mod`,
   `ww_install_mod`. Otherwise the model sees nearly 50 tools once loom-mcp is added. `ww_lua_api`
   and `ww_verify_hook` stay in `recon`: `ww_game_eval` and tracing need them.
2. Prompts: `ww:new-loom-mod` (the workflow below) and `ww:port-to-loom` (each `RegisterHook` of a
   Lua mod → a reaction point through `ww_event_surface` → Loom).
3. `.lm` templates as a resource and in the prompt, without a tool of their own: `BP_Startup`
   (DataTables, options), `BP_MapLoad` (`onLoadingFinished`, Tick), a HUD overlay that puts its
   widget back every frame, `BP_MainMenuLoad`. Only the editor creates the PAL ("New mod..."), and
   `ww_loom_validate` checks that everything matches.
4. Connection: `/ww-setup` offers to register the whiskerwood server at user scope, with absolute
   paths and `WWMCP_CONFIG`, next to loom-mcp in `~/.claude.json`. Otherwise a session opened in
   the kit doesn't have it.

**Files.** `server.ts`, `config.ts`, `prompts.ts`, `data/templates/loom/` (new),
`.claude/skills/ww-setup/SKILL.md`, `docs/SETUP.md`.

---

## How the AI works on a Loom mod

```
ww_memory_wakeup → ww_memory_search        what is already known, Loom pitfalls included
ww_loom_status                             kit, types.json, versions, editor
ww_find_symbol / ww_find_asset → ww_lift   how the game does it, already in Loom
ww_event_surface                           what to subscribe to, what to override
ww_get_function (loom_call) / loom types   the exact call and Blueprint access
ww_call bp_only / ww_trace_calls           check the chain live in seconds
loom docs → .lm → ww_loom_validate         check + game rules, down to zero
ww_loom_build → ww_loom_install            Blueprint → .pak in Saved/mods
ww_game_process restart save=…             a pak loads only at startup
ww_game_log modlog / ww_ui_tree / trace    did the mod work, its own functions
ww_memory_add                              decisions and pitfalls
```

## Upstream to Loom

Loom is a public mirror, and pull requests go there (`CONTRIBUTING.md` in `<loom-src>`). Most
useful first:
1. `EX_SwitchValue`, Vector / Rotator / Transform constants and `EX_CallMulticastDelegate` in
   lift: 15% of the game's functions and 37% of its event graphs;
2. user widgets in a widget tree (`native_class` looks only among engine classes): at least 205
   BPs;
3. stubbing and marking one function instead of refusing the whole package;
4. printer bugs: floats in exponent notation, an expression printed as a statement of its own
   (`an expression on its own does nothing`);
5. the stack overflow on some widget trees;
6. the `Hex` key in colors from CUE4Parse's JSON;
7. the five applier and compiler pitfalls from LOOM-PIPELINE.md.

## Deferred, and not doing

- **Publishing to the Workshop** (the folder, `.vdf`, checking the pak) isn't needed for now. The
  upload through steamcmd, with its login and Steam Guard, is always run by a person anyway.
- **`ww_loom_eval`** (translating a Loom snippet into Lua to run live): out parameters, structs and
  casts don't translate one to one. `ww_call bp_only` covers the main case.
- **Hot reloading a pak mod**: the pak is mounted at startup, and Blueprint classes don't reload
  in a shipping build. The loop is a restart with a save.
- **Synthesizing `types.json` entries for the missing game BPs**: LoomBuild loads them itself
  through `missing`, and the file's format may change between Loom versions.

## Loose ends shared by all items

- The "36 tools" counter: `docs/ARCHITECTURE.md:22`, `docs/TOOLS.md:3`; after item 0, broken
  down by toolset.
- `docs/TOOLS.md`: cards for the new tools and a Loom block in its workflow section. The note
  that there is no BP node graph and never will be stays true; next to it, say that `ww_lift`
  gives a readable body.
- LOOM-PIPELINE.md: the correction about `loom types` suggesting names on a miss; its section on
  how this MCP can close the gaps becomes a link to this plan.
- Memory: the pitfalls from LOOM-PIPELINE.md and from this plan (`ReadScriptData`, `Hex`, exponent
  notation, 5.6 in old mods, functions Blueprints can't reach) go in through `ww_memory_add`,
  without `mod_name` and with tags. Don't name specific mods in the text: such entries don't go
  into the seed.
- J needs the index rebuilt: `ww_index_release`, then `bun run setup --force`.
- Before handing in each item: `bun run typecheck` and `bun run doctor`.
