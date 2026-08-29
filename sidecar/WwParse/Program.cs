using System.Text;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;

namespace WwParse;

internal static class Program
{
    private static int Main(string[] rawArgs)
    {
        Console.OutputEncoding = Encoding.UTF8;
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
            Console.Error.WriteLine("использование: WwParse --paks <dir> --usmap <file.usmap> --out <file.jsonl> [--prefix <vfs prefix>]");
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

    private static string ToAssetPath(string vfsPath)
    {
        var withoutExt = vfsPath[..vfsPath.LastIndexOf('.')];
        var marker = "/Content/";
        var at = withoutExt.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        return at < 0 ? "/" + withoutExt : "/Game/" + withoutExt[(at + marker.Length)..];
    }
}
