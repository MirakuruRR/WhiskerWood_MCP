using System.Collections;
using System.Reflection;
using System.Text;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Kismet;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;

namespace WwParse;

internal static class Program
{
    private static int Main(string[] rawArgs)
    {
        Console.OutputEncoding = Encoding.UTF8;
        var verb = "data";
        var args = rawArgs;
        if (rawArgs.Length > 0 && !rawArgs[0].StartsWith("--", StringComparison.Ordinal))
        {
            verb = rawArgs[0];
            args = rawArgs[1..];
        }
        return verb switch
        {
            "data" => RunData(args),
            "xref" => RunXref(args),
            "json" => RunJson(args),
            "jsonbatch" => RunJsonBatch(args),
            _ => Fail($"неизвестная команда: {verb} (ожидались data | xref | json | jsonbatch)"),
        };
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 2;
    }

    private static EGame? EngineOf(string usmap)
    {
        var m = System.Text.RegularExpressions.Regex.Match(Path.GetFileName(usmap), @"-(\d+)\.(\d+)\.\d+-\d+\+");
        if (m.Success && Enum.TryParse<EGame>($"GAME_UE{m.Groups[1].Value}_{m.Groups[2].Value}", out var game)) return game;
        Console.Error.WriteLine($"версия движка не определяется по имени .usmap (ждём <Game>-5.8.3-0+...): {usmap}");
        return null;
    }

    /// <summary>Версия движка для чтения пака: у игры — из имени .usmap (EngineOf), у мода — из
    /// EngineVersion его .uplugin. Моды старого кита собраны 5.6 и EngineVersion не пишут вовсе.</summary>
    private static EGame? EngineFor(string usmap, string? uplugin, string? engine)
    {
        if (!string.IsNullOrEmpty(engine))
        {
            if (Enum.TryParse<EGame>(engine, out var named)) return named;
            Console.Error.WriteLine($"неизвестная версия движка: {engine}");
            return null;
        }
        if (uplugin is null) return EngineOf(usmap);
        if (!File.Exists(uplugin))
        {
            Console.Error.WriteLine($".uplugin не найден: {uplugin}");
            return null;
        }
        string? version;
        try
        {
            version = (JsonConvert.DeserializeObject<Dictionary<string, object?>>(File.ReadAllText(uplugin)) ?? [])
                .GetValueOrDefault("EngineVersion") as string;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($".uplugin не разобран ({uplugin}): {e.Message}");
            return null;
        }
        if (string.IsNullOrWhiteSpace(version)) return EGame.GAME_UE5_6;
        var parts = version.Split('.');
        var name = parts.Length >= 2 ? $"GAME_UE{parts[0]}_{parts[1]}" : $"GAME_UE{parts[0]}_0";
        if (Enum.TryParse<EGame>(name, out var fromPlugin)) return fromPlugin;
        Console.Error.WriteLine($".uplugin называет версию {version}, которой нет в CUE4Parse: {uplugin}");
        return null;
    }

    private static int RunJson(string[] rawArgs)
    {
        string? paks = null, usmap = null, asset = null, output = null, uplugin = null, engine = null;
        for (var i = 0; i < rawArgs.Length; i++)
        {
            switch (rawArgs[i])
            {
                case "--paks": paks = rawArgs[++i]; break;
                case "--usmap": usmap = rawArgs[++i]; break;
                case "--asset": asset = rawArgs[++i]; break;
                case "--out": output = rawArgs[++i]; break;
                case "--uplugin": uplugin = rawArgs[++i]; break;
                case "--engine": engine = rawArgs[++i]; break;
                default:
                    Console.Error.WriteLine($"неизвестный аргумент: {rawArgs[i]}");
                    return 2;
            }
        }

        if (paks is null || usmap is null || asset is null || output is null)
        {
            Console.Error.WriteLine("использование: WwParse json --paks <dir> --usmap <file.usmap> --asset <путь> --out <file.json> [--uplugin <file.uplugin>] [--engine GAME_UE5_6]");
            return 2;
        }
        if (!Directory.Exists(paks)) { Console.Error.WriteLine($"каталог паков не найден: {paks}"); return 2; }
        if (!File.Exists(usmap)) { Console.Error.WriteLine($".usmap не найден: {usmap}"); return 2; }
        if (EngineFor(usmap, uplugin, engine) is not { } game) return 2;

        using var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, new VersionContainer(game), StringComparer.OrdinalIgnoreCase);
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(usmap, StringComparer.OrdinalIgnoreCase);
        // Без этого UStruct.ScriptBytecode всегда пуст, и lift молча выдаёт пустые тела.
        provider.ReadScriptData = true;
        provider.Initialize();
        provider.Mount();

        var key = FindAsset(provider, asset);
        if (key is null) { Console.Error.WriteLine($"ассет не найден среди паков {paks}: {asset}"); return 2; }

        List<UObject> exports;
        try
        {
            exports = provider.LoadPackage(key).GetExports().ToList();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"пакет не прочитан ({key}): {e.Message}");
            return 1;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        File.WriteAllText(output, JsonConvert.SerializeObject(exports), new UTF8Encoding(false));
        Console.Error.WriteLine($"WwParse json: {key}, экспортов {exports.Count}, движок {game}, {new FileInfo(output).Length} байт");
        return 0;
    }

    /// <summary>Пакетный экспорт: паки монтируются один раз, дальше по списку ассетов пишется по JSON на
    /// пакет (подъём всей игры одним пакетом — пункт J). Список — файл, по пути в строке; в каталоге
    /// остаётся manifest.jsonl с соответствием «ассет — файл — число экспортов».</summary>
    private static int RunJsonBatch(string[] rawArgs)
    {
        string? paks = null, usmap = null, assets = null, outDir = null, uplugin = null, engine = null;
        var limit = 0;
        for (var i = 0; i < rawArgs.Length; i++)
        {
            switch (rawArgs[i])
            {
                case "--paks": paks = rawArgs[++i]; break;
                case "--usmap": usmap = rawArgs[++i]; break;
                case "--assets": assets = rawArgs[++i]; break;
                case "--out-dir": outDir = rawArgs[++i]; break;
                case "--limit": limit = int.Parse(rawArgs[++i]); break;
                case "--uplugin": uplugin = rawArgs[++i]; break;
                case "--engine": engine = rawArgs[++i]; break;
                default:
                    Console.Error.WriteLine($"неизвестный аргумент: {rawArgs[i]}");
                    return 2;
            }
        }

        if (paks is null || usmap is null || assets is null || outDir is null)
        {
            Console.Error.WriteLine("использование: WwParse jsonbatch --paks <dir> --usmap <file.usmap> --assets <список.txt> --out-dir <dir> [--limit N] [--uplugin <file.uplugin>] [--engine GAME_UE5_6]");
            return 2;
        }
        if (!Directory.Exists(paks)) { Console.Error.WriteLine($"каталог паков не найден: {paks}"); return 2; }
        if (!File.Exists(usmap)) { Console.Error.WriteLine($".usmap не найден: {usmap}"); return 2; }
        if (!File.Exists(assets)) { Console.Error.WriteLine($"список ассетов не найден: {assets}"); return 2; }
        if (EngineFor(usmap, uplugin, engine) is not { } game) return 2;

        var wanted = File.ReadAllLines(assets)
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && !l.StartsWith("#", StringComparison.Ordinal))
            .ToList();
        if (limit > 0 && wanted.Count > limit) wanted = wanted.Take(limit).ToList();

        Directory.CreateDirectory(outDir);
        using var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, new VersionContainer(game), StringComparer.OrdinalIgnoreCase);
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(usmap, StringComparer.OrdinalIgnoreCase);
        provider.ReadScriptData = true;
        provider.Initialize();
        provider.Mount();

        var manifest = Path.Combine(outDir, "manifest.jsonl");
        using var writer = new StreamWriter(manifest, false, new UTF8Encoding(false));
        var written = 0;
        var failed = 0;
        var started = Environment.TickCount64;

        for (var i = 0; i < wanted.Count; i++)
        {
            var asset = wanted[i];
            var key = FindAsset(provider, asset);
            if (key is null)
            {
                failed++;
                writer.WriteLine(JsonConvert.SerializeObject(new { kind = "asset", index = i, asset, file = (string?)null, exports = 0, error = "ассет не найден среди паков" }));
                continue;
            }

            List<UObject> exports;
            try
            {
                exports = provider.LoadPackage(key).GetExports().ToList();
            }
            catch (Exception e)
            {
                failed++;
                writer.WriteLine(JsonConvert.SerializeObject(new { kind = "asset", index = i, asset, file = (string?)null, exports = 0, error = e.Message }));
                continue;
            }

            var file = Path.Combine(outDir, i + ".json");
            File.WriteAllText(file, JsonConvert.SerializeObject(exports), new UTF8Encoding(false));
            written++;
            writer.WriteLine(JsonConvert.SerializeObject(new { kind = "asset", index = i, asset, file = Path.GetFileName(file), exports = exports.Count, error = (string?)null }));
        }

        var ms = Environment.TickCount64 - started;
        writer.WriteLine(JsonConvert.SerializeObject(new { kind = "summary", requested = wanted.Count, written, failed, ms, engine = game.ToString() }));
        writer.Flush();

        Console.Error.WriteLine($"WwParse jsonbatch: ассетов {wanted.Count}, выгружено {written}, ошибок {failed}, движок {game}, {ms} мс");
        return failed > 0 && written == 0 ? 1 : 0;
    }

    /// <summary>Ключ ассета в провайдере: путь /Game/... или готовый ключ пака, с расширением и без;
    /// если по пути не нашлось — по имени файла, когда такое имя в паках одно.</summary>
    private static string? FindAsset(DefaultFileProvider provider, string asset)
    {
        var raw = asset.Replace('\\', '/').Trim();
        foreach (var ext in new[] { ".uasset", ".umap", ".uexp", ".ubulk", ".uptnl" })
        {
            if (raw.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) { raw = raw[..^ext.Length]; break; }
        }
        // объектная форма "/Game/UI/BP_X.BP_X_C" — берём сам пакет
        var dot = raw.LastIndexOf('.');
        if (dot > raw.LastIndexOf('/')) raw = raw[..dot];

        var key = raw.TrimStart('/');
        if (key.StartsWith("Game/", StringComparison.OrdinalIgnoreCase)) key = "Whiskerwood/Content/" + key["Game/".Length..];
        else if (key.StartsWith("Engine/", StringComparison.OrdinalIgnoreCase)) key = "Engine/Content/" + key["Engine/".Length..];

        var files = provider.Files.Keys.ToList();
        var exact = files.FirstOrDefault(k => k.Equals(key + ".uasset", StringComparison.OrdinalIgnoreCase))
                    ?? files.FirstOrDefault(k => k.Equals(key, StringComparison.OrdinalIgnoreCase));
        if (exact is not null) return exact;

        var name = key.Split('/').Last();
        var byName = files.Where(k => k.EndsWith("/" + name + ".uasset", StringComparison.OrdinalIgnoreCase)).ToList();
        if (byName.Count == 1) return byName[0];
        if (byName.Count > 1) Console.Error.WriteLine($"имя {name} есть в нескольких паках: {string.Join(", ", byName.Take(10))}");
        return null;
    }

    private static int RunData(string[] rawArgs)
    {
        string? paks = null, usmap = null, output = null, prefix = "Whiskerwood/Content/Data/";
        for (var i = 0; i < rawArgs.Length; i++)
        {
            switch (rawArgs[i])
            {
                case "--paks": paks = rawArgs[++i]; break;
                case "--usmap": usmap = rawArgs[++i]; break;
                case "--out": output = rawArgs[++i]; break;
                case "--prefix": prefix = rawArgs[++i]; break;
                default:
                    Console.Error.WriteLine($"неизвестный аргумент: {rawArgs[i]}");
                    return 2;
            }
        }

        if (paks is null || usmap is null || output is null)
        {
            Console.Error.WriteLine("использование: WwParse [data] --paks <dir> --usmap <file.usmap> --out <file.jsonl> [--prefix <vfs prefix>]");
            return 2;
        }
        if (!Directory.Exists(paks)) { Console.Error.WriteLine($"каталог паков не найден: {paks}"); return 2; }
        if (!File.Exists(usmap)) { Console.Error.WriteLine($".usmap не найден: {usmap}"); return 2; }
        if (EngineOf(usmap) is not { } game) return 2;

        using var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, new VersionContainer(game), StringComparer.OrdinalIgnoreCase);
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(usmap, StringComparer.OrdinalIgnoreCase);
        provider.Initialize();
        provider.Mount();

        var candidates = provider.Files.Keys
            .Where(k => k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && k.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .OrderBy(k => k, StringComparer.OrdinalIgnoreCase)
            .ToList();

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        using var writer = new StreamWriter(output, false, new UTF8Encoding(false));

        var tables = 0;
        var objects = 0;
        var rows = 0;
        var failures = new List<object>();

        foreach (var key in candidates)
        {
            try
            {
                var package = provider.LoadPackage(key);
                foreach (var export in package.GetExports())
                {
                    if (export is UDataTable table)
                    {
                        var payload = new Dictionary<string, object?>(table.RowMap.Count);
                        foreach (var (name, row) in table.RowMap) payload[name.Text] = row;
                        writer.WriteLine(JsonConvert.SerializeObject(new
                        {
                            kind = "table",
                            name = export.Name,
                            assetPath = ToAssetPath(key),
                            rowStruct = table.RowStructName,
                            rowCount = table.RowMap.Count,
                            rows = payload,
                        }));
                        tables++;
                        rows += table.RowMap.Count;
                        continue;
                    }
                    // Data-ассеты вроде ArcoGameTunes: не DataTable, но баланс лежит там же
                    if (export.Name.StartsWith("Default__", StringComparison.Ordinal)) continue;
                    if (export.ExportType.EndsWith("GeneratedClass", StringComparison.Ordinal)) continue;
                    writer.WriteLine(JsonConvert.SerializeObject(new
                    {
                        kind = "object",
                        name = export.Name,
                        assetPath = ToAssetPath(key),
                        rowStruct = export.ExportType,
                        properties = export,
                    }));
                    objects++;
                    rows++;
                }
            }
            catch (Exception e)
            {
                failures.Add(new { file = key, error = e.Message });
            }
        }

        writer.WriteLine(JsonConvert.SerializeObject(new
        {
            kind = "summary",
            scanned = candidates.Count,
            tables,
            objects,
            rows,
            failed = failures.Count,
            failures,
        }));
        writer.Flush();

        Console.Error.WriteLine($"WwParse: файлов {candidates.Count}, таблиц {tables}, data-ассетов {objects}, строк {rows}, ошибок {failures.Count}");
        return failures.Count > 0 && tables == 0 ? 1 : 0;
    }

    private static int RunXref(string[] rawArgs)
    {
        string? paks = null, usmap = null, output = null, prefix = "Whiskerwood/Content/";
        for (var i = 0; i < rawArgs.Length; i++)
        {
            switch (rawArgs[i])
            {
                case "--paks": paks = rawArgs[++i]; break;
                case "--usmap": usmap = rawArgs[++i]; break;
                case "--out": output = rawArgs[++i]; break;
                case "--prefix": prefix = rawArgs[++i]; break;
                default:
                    Console.Error.WriteLine($"неизвестный аргумент: {rawArgs[i]}");
                    return 2;
            }
        }

        if (paks is null || usmap is null || output is null)
        {
            Console.Error.WriteLine("использование: WwParse xref --paks <dir> --usmap <file.usmap> --out <file.jsonl> [--prefix <vfs prefix>]");
            return 2;
        }
        if (!Directory.Exists(paks)) { Console.Error.WriteLine($"каталог паков не найден: {paks}"); return 2; }
        if (!File.Exists(usmap)) { Console.Error.WriteLine($".usmap не найден: {usmap}"); return 2; }
        if (EngineOf(usmap) is not { } game) return 2;

        using var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, new VersionContainer(game), StringComparer.OrdinalIgnoreCase);
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(usmap, StringComparer.OrdinalIgnoreCase);
        // Бытовое имя гейта в CUE4Parse: без него UStruct.ScriptBytecode всегда пуст, даже для
        // экспортов с полноценным телом функции — грабля, съевшая полдня на разведке этого пункта.
        provider.ReadScriptData = true;
        provider.Initialize();
        provider.Mount();

        var candidates = provider.Files.Keys
            .Where(k => k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && k.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .OrderBy(k => k, StringComparer.OrdinalIgnoreCase)
            .ToList();

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        using var writer = new StreamWriter(output, false, new UTF8Encoding(false));

        var edges = new Dictionary<(string caller, string calleeName, string? calleePath, string kind), int>();
        var failures = new List<object>();
        var functionsScanned = 0;
        var bytecodeLines = 0;

        foreach (var key in candidates)
        {
            IPackage package;
            try
            {
                package = provider.LoadPackage(key);
            }
            catch (Exception e)
            {
                failures.Add(new { file = key, error = e.Message });
                continue;
            }

            IEnumerable<UObject> exports;
            try
            {
                exports = package.GetExports();
            }
            catch (Exception e)
            {
                failures.Add(new { file = key, error = e.Message });
                continue;
            }

            foreach (var export in exports)
            {
                string callerRaw;
                try { callerRaw = NormalizeRawPath(export.GetPathName()); }
                catch { continue; }

                // Этап 1: дешёвые ссылки на уровне типизированных полей экспорта (SuperStruct,
                // ComponentTemplate и т.п.) — не только вызовы, но и «кто вообще упоминает X».
                foreach (var fpi in DirectRefs(export))
                {
                    ResolvedObject? refTarget;
                    try { refTarget = fpi.ResolvedObject; } catch { continue; }
                    if (refTarget is null) continue;
                    string? refPath;
                    try { refPath = NormalizeRawPath(refTarget.GetPathName()); } catch { refPath = null; }
                    AddEdge(edges, callerRaw, refTarget.Name.Text, refPath, "ref");
                }

                if (export is not UFunction fn || fn.ScriptBytecode is not { Length: > 0 } bytecode) continue;
                functionsScanned++;

                var calls = new List<(string kind, FPackageIndex? stackNode, FName? virtualName)>();
                var visited = new HashSet<object>();
                foreach (var e in bytecode) CollectCalls(e, calls, visited, 0);

                foreach (var c in calls)
                {
                    string calleeName;
                    string? calleePath = null;
                    if (c.virtualName is { } vn)
                    {
                        calleeName = vn.Text;
                    }
                    else if (c.stackNode is { } sn)
                    {
                        ResolvedObject? ro;
                        try { ro = sn.ResolvedObject; } catch { ro = null; }
                        if (ro is null) continue;
                        calleeName = ro.Name.Text;
                        try { calleePath = NormalizeRawPath(ro.GetPathName()); } catch { /* оставляем null */ }
                    }
                    else continue;

                    AddEdge(edges, callerRaw, calleeName, calleePath, c.kind);
                }

                var disasm = new StringBuilder();
                for (var i = 0; i < bytecode.Length; i++)
                {
                    disasm.Append('[').Append(i).Append("] ");
                    RenderExpr(bytecode[i], disasm, 0);
                }
                writer.WriteLine(JsonConvert.SerializeObject(new
                {
                    kind = "bytecode",
                    functionPath = callerRaw,
                    exprCount = bytecode.Length,
                    disasm = disasm.ToString(),
                }));
                bytecodeLines++;
            }
        }

        foreach (var (key, count) in edges)
        {
            writer.WriteLine(JsonConvert.SerializeObject(new
            {
                kind = "call",
                callerPath = key.caller,
                calleeName = key.calleeName,
                calleePath = key.calleePath,
                callKind = key.kind,
                count,
            }));
        }

        writer.WriteLine(JsonConvert.SerializeObject(new
        {
            kind = "summary",
            scanned = candidates.Count,
            functionsScanned,
            bytecodeLines,
            edges = edges.Count,
            failed = failures.Count,
            failures,
        }));
        writer.Flush();

        Console.Error.WriteLine(
            $"WwParse xref: файлов {candidates.Count}, функций с байткодом {functionsScanned}, рёбер {edges.Count}, ошибок {failures.Count}");
        return failures.Count > 0 && edges.Count == 0 ? 1 : 0;
    }

    private static void AddEdge(
        Dictionary<(string caller, string calleeName, string? calleePath, string kind), int> edges,
        string caller, string calleeName, string? calleePath, string kind)
    {
        var key = (caller, calleeName, calleePath, kind);
        edges[key] = edges.GetValueOrDefault(key) + 1;
    }

    /// <summary>Типизированные поля экспорта, которые сами по себе ссылки на другой объект
    /// (SuperStruct у классов, ComponentTemplate/ChildNodes у SCS_Node и т.п.) — без рекурсии
    /// в граф пакета, только собственные поля самого экспорта.</summary>
    private static IEnumerable<FPackageIndex> DirectRefs(UObject export)
    {
        foreach (var f in export.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            object? val;
            try { val = f.GetValue(export); } catch { continue; }
            switch (val)
            {
                case FPackageIndex { IsNull: false } fpi:
                    yield return fpi;
                    break;
                case IEnumerable en and not string:
                    foreach (var item in en)
                    {
                        if (item is FPackageIndex { IsNull: false } fpi2) yield return fpi2;
                    }
                    break;
            }
        }
    }

    /// <summary>Рекурсивный сбор вызовов из дерева Kismet-выражений через рефлексию — не завязан
    /// на исчерпывающий список из ~80 подтипов EX_*. Рекурсия ограничена namespace'ом
    /// CUE4Parse.UE4.Kismet, поэтому в граф пакета/провайдера (FPackageIndex.Owner и т.п.) не уходит.</summary>
    private static void CollectCalls(
        object? node,
        List<(string kind, FPackageIndex? stackNode, FName? virtualName)> outCalls,
        HashSet<object> visited,
        int depth)
    {
        if (node is null || depth > 60) return;
        if (!visited.Add(node)) return;

        if (node is KismetExpression ke)
        {
            switch (ke)
            {
                case EX_CallMath cm: outCalls.Add(("math", cm.StackNode, null)); break;
                case EX_LocalFinalFunction lff: outCalls.Add(("local_final", lff.StackNode, null)); break;
                case EX_LocalVirtualFunction lvf: outCalls.Add(("local_virtual", null, lvf.VirtualFunctionName)); break;
                case EX_FinalFunction ff: outCalls.Add(("final", ff.StackNode, null)); break;
                case EX_VirtualFunction vf: outCalls.Add(("virtual", null, vf.VirtualFunctionName)); break;
            }
        }

        var type = node.GetType();
        if (type.Namespace != "CUE4Parse.UE4.Kismet") return;
        foreach (var f in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            object? val;
            try { val = f.GetValue(node); } catch { continue; }
            if (val is null) continue;
            if (val is IEnumerable en and not string)
            {
                foreach (var item in en)
                {
                    if (item is not null) CollectCalls(item, outCalls, visited, depth + 1);
                }
            }
            else
            {
                CollectCalls(val, outCalls, visited, depth + 1);
            }
        }
    }

    private const int MaxDisasmDepth = 25;
    private const int MaxInlineStringLen = 80;

    /// <summary>Линейный дизасм одного statement'а: имя токена + скалярные поля инлайном, вложенные
    /// Kismet-выражения — на следующей строке с отступом. Не привязан к конкретным подтипам EX_* —
    /// та же рефлексия, что и в CollectCalls, поэтому не расходится с ней при появлении новых токенов.</summary>
    private static void RenderExpr(KismetExpression e, StringBuilder sb, int indent)
    {
        var inline = new List<string>();
        var children = new List<KismetExpression>();
        if (indent < MaxDisasmDepth)
        {
            foreach (var f in e.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                object? val;
                try { val = f.GetValue(e); } catch { continue; }
                switch (val)
                {
                    case null: break;
                    case KismetExpression child: children.Add(child); break;
                    case FPackageIndex fpi:
                        var refName = DescribeRef(fpi);
                        if (refName != null) inline.Add($"{f.Name}={refName}");
                        break;
                    case FName fname: inline.Add($"{f.Name}={fname.Text}"); break;
                    case string str: inline.Add($"{f.Name}=\"{Truncate(str)}\""); break;
                    case bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double:
                        inline.Add($"{f.Name}={val}");
                        break;
                    case Enum en: inline.Add($"{f.Name}={en}"); break;
                    case IEnumerable en2 and not string:
                        foreach (var item in en2)
                        {
                            if (item is KismetExpression kc) { children.Add(kc); continue; }
                            // FKismetSwitchCase[] и подобные обёртки — заглянуть на один уровень внутрь
                            if (item is null) continue;
                            foreach (var f2 in item.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
                            {
                                object? v2;
                                try { v2 = f2.GetValue(item); } catch { continue; }
                                if (v2 is KismetExpression kc2) children.Add(kc2);
                            }
                        }
                        break;
                }
            }
        }

        sb.Append(e.GetType().Name);
        if (inline.Count > 0) sb.Append(' ').Append(string.Join(' ', inline));
        sb.Append('\n');
        var pad = new string(' ', (indent + 1) * 2);
        foreach (var child in children)
        {
            sb.Append(pad);
            RenderExpr(child, sb, indent + 1);
        }
    }

    private static string? DescribeRef(FPackageIndex fpi)
    {
        if (fpi.IsNull) return null;
        try
        {
            var ro = fpi.ResolvedObject;
            if (ro is null) return null;
            return NormalizeRawPath(ro.GetPathName());
        }
        catch
        {
            return null;
        }
    }

    private static string Truncate(string s) => s.Length > MaxInlineStringLen ? s[..MaxInlineStringLen] + "…" : s;

    /// <summary>Приводит GetPathName() (либо адрес /Script/-пакета, либо VFS-путь вида
    /// "Whiskerwood/Content/...") к тому же "/Game/..." виду, что и остальной сайдкар (см. ToAssetPath),
    /// чтобы TS-сторона могла прогнать его через тот же normalizeDumpPath, что и живой дамп UE4SS.</summary>
    private static string NormalizeRawPath(string uePath)
    {
        if (uePath.StartsWith("/", StringComparison.Ordinal)) return uePath;
        const string marker = "/Content/";
        var at = uePath.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        return at < 0 ? "/" + uePath : "/Game/" + uePath[(at + marker.Length)..];
    }

    private static string ToAssetPath(string vfsPath)
    {
        var withoutExt = vfsPath[..vfsPath.LastIndexOf('.')];
        var marker = "/Content/";
        var at = withoutExt.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        return at < 0 ? "/" + withoutExt : "/Game/" + withoutExt[(at + marker.Length)..];
    }
}
