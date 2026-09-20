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
            _ => Fail($"неизвестная команда: {verb} (ожидались data | xref)"),
        };
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 2;
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

        using var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_6), StringComparer.OrdinalIgnoreCase);
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

        using var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_6), StringComparer.OrdinalIgnoreCase);
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
