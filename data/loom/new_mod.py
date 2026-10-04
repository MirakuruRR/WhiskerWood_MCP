# PAL_<Мод> как ModActions::CreateMod плагина WWModTools; параметры — JSON из WW_NEW_MOD_PARAMS.
# unreal.log в коммандлете pythonscript до stdout не доходит, поэтому итог пишется в result_path.
import json
import os
import re
import traceback

import unreal

CHUNK_MIN = 1
CHUNK_MAX = 300
PAL_CLASS = unreal.TopLevelAssetPath("/Script/Engine", "PrimaryAssetLabel")
PAK_RE = re.compile(r"^pakchunk(\d+)-Windows\.pak$", re.IGNORECASE)


def say(msg):
    unreal.log_warning("WWNewMod: " + msg)


def write_result(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def used_chunks(ar, out):
    used = set()
    flt = unreal.ARFilter(package_paths=["/Game"], recursive_paths=True, class_paths=[PAL_CLASS], recursive_classes=True)
    labels = []
    for data in ar.get_assets(flt):
        label = data.get_asset()
        if label is None:
            continue
        cid = label.get_editor_property("rules").get_editor_property("chunk_id")
        labels.append({"package": str(data.package_name), "chunk": cid})
        if cid > 0:
            used.add(cid)
    out["labels"] = labels

    paks_dir = os.path.join(
        unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()), "Windows", "Whiskerwood", "Content", "Paks"
    )
    paks = []
    if os.path.isdir(paks_dir):
        for name in os.listdir(paks_dir):
            m = PAK_RE.match(name)
            if m and int(m.group(1)) > 0:
                paks.append(int(m.group(1)))
                used.add(int(m.group(1)))
    out["pak_chunks"] = sorted(paks)
    return used


def remove_partial(asset_path, dir_path):
    try:
        if unreal.EditorAssetLibrary.does_asset_exist(asset_path):
            unreal.EditorAssetLibrary.delete_asset(asset_path)
    except Exception:
        pass
    try:
        if os.path.isdir(dir_path) and not os.listdir(dir_path):
            os.rmdir(dir_path)
    except Exception:
        pass


def create(params, out):
    mod = params["mod_name"]
    base = "/Game/Mods/" + mod
    pal_name = "PAL_" + mod
    asset_path = base + "/" + pal_name
    content_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_content_dir())
    mod_dir = os.path.join(content_dir, "Mods", mod)
    pal_file = os.path.join(mod_dir, pal_name + ".uasset")
    out["engine_version"] = str(unreal.SystemLibrary.get_engine_version())
    out["pal_object"] = asset_path
    out["pal_file"] = pal_file.replace("\\", "/")

    ar = unreal.AssetRegistryHelpers.get_asset_registry()
    ar.search_all_assets(True)
    ar.wait_for_completion()

    existing = ar.get_assets_by_path(base, recursive=True)
    if len(existing) > 0:
        out["stage"] = "exists"
        out["error"] = "в %s уже есть ассеты: %d" % (base, len(existing))
        return

    used = used_chunks(ar, out)
    out["used"] = sorted(used)
    cid = next((i for i in range(CHUNK_MIN, CHUNK_MAX + 1) if i not in used), -1)
    if cid < 0:
        out["stage"] = "no_free_chunk"
        out["error"] = "нет свободного ChunkId в %d..%d" % (CHUNK_MIN, CHUNK_MAX)
        return
    say("chunk %d, used %s" % (cid, sorted(used)))

    out["stage"] = "create"
    factory = unreal.DataAssetFactory()
    factory.set_editor_property("data_asset_class", unreal.PrimaryAssetLabel)
    label = unreal.AssetToolsHelpers.get_asset_tools().create_asset(pal_name, base, unreal.PrimaryAssetLabel, factory)
    if not isinstance(label, unreal.PrimaryAssetLabel):
        out["error"] = "create_asset не вернул PrimaryAssetLabel"
        remove_partial(asset_path, mod_dir)
        return

    rules = label.get_editor_property("rules")
    rules.set_editor_property("chunk_id", cid)
    rules.set_editor_property("cook_rule", unreal.PrimaryAssetCookRule.ALWAYS_COOK)
    label.set_editor_property("rules", rules)
    label.set_editor_property("label_assets_in_my_directory", True)

    out["stage"] = "save"
    saved = unreal.EditorAssetLibrary.save_loaded_asset(label, False)
    back = label.get_editor_property("rules")
    out["chunk"] = back.get_editor_property("chunk_id")
    out["cook_rule"] = str(back.get_editor_property("cook_rule"))
    out["label_assets_in_my_directory"] = bool(label.get_editor_property("label_assets_in_my_directory"))
    out["saved"] = bool(saved)
    out["pal_on_disk"] = os.path.isfile(pal_file)

    if not saved or not out["pal_on_disk"] or out["chunk"] != cid:
        out["error"] = "PAL не сохранён на диск" if not out["pal_on_disk"] or not saved else "ChunkId не применился"
        remove_partial(asset_path, mod_dir)
        return

    out["stage"] = "done"
    out["ok"] = True
    say("created %s chunk %d" % (asset_path, cid))


def main():
    params_path = os.environ.get("WW_NEW_MOD_PARAMS", "")
    with open(params_path, encoding="utf-8") as f:
        params = json.load(f)
    out = {"ok": False, "mod": params.get("mod_name"), "stage": "start"}
    try:
        create(params, out)
    except Exception:
        out["error"] = traceback.format_exc()
    write_result(params["result_path"], out)
    say("result %s: ok=%s" % (params["result_path"], out["ok"]))


main()
