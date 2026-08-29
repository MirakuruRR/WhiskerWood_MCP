export const INDEX_SCHEMA_VERSION = 3

export const INDEX_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE profile_meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

CREATE TABLE objects (
  path          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  package       TEXT NOT NULL,
  outer_path    TEXT,
  name          TEXT NOT NULL,
  dump_index    INTEGER,
  super_path    TEXT,
  is_blueprint  INTEGER NOT NULL DEFAULT 0,
  hook_path     TEXT,
  hook_path_status TEXT NOT NULL DEFAULT 'ok',
  object_path   TEXT
);
CREATE INDEX objects_kind_idx    ON objects(kind);
CREATE INDEX objects_package_idx ON objects(package, kind);
CREATE INDEX objects_outer_idx   ON objects(outer_path);
CREATE INDEX objects_name_idx    ON objects(name COLLATE NOCASE);
CREATE INDEX objects_super_idx   ON objects(super_path);
CREATE INDEX objects_hook_idx    ON objects(hook_path);
CREATE INDEX objects_object_path_idx ON objects(object_path);

CREATE TABLE bp_classes (
  path          TEXT PRIMARY KEY,
  package       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  asset_path    TEXT,
  object_path   TEXT,
  resolution    TEXT NOT NULL,
  candidates    TEXT
);
CREATE INDEX bp_classes_asset_idx ON bp_classes(asset_path);

CREATE TABLE properties (
  owner_path    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  offset        INTEGER NOT NULL,
  prop_kind     TEXT NOT NULL,
  name          TEXT NOT NULL,
  type_name     TEXT,
  inner_type    TEXT,
  type_source   TEXT NOT NULL,
  PRIMARY KEY (owner_path, ordinal)
);
CREATE INDEX properties_name_idx ON properties(name COLLATE NOCASE);
CREATE INDEX properties_type_idx ON properties(type_name);

CREATE TABLE function_params (
  function_path TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  offset        INTEGER NOT NULL,
  prop_kind     TEXT NOT NULL,
  name          TEXT NOT NULL,
  type_name     TEXT,
  inner_type    TEXT,
  type_source   TEXT NOT NULL,
  is_return     INTEGER NOT NULL DEFAULT 0,
  is_out        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (function_path, ordinal)
);

CREATE TABLE enum_values (
  enum_path     TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  value         INTEGER NOT NULL,
  PRIMARY KEY (enum_path, ordinal)
);

CREATE TABLE datatables (
  name          TEXT PRIMARY KEY,
  asset_path    TEXT NOT NULL,
  row_struct    TEXT,
  row_count     INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'datatable'
);
CREATE TABLE datatable_rows (
  table_name    TEXT NOT NULL,
  row_name      TEXT NOT NULL,
  row_json      TEXT NOT NULL,
  PRIMARY KEY (table_name, row_name)
);
CREATE INDEX datatable_rows_name_idx ON datatable_rows(row_name COLLATE NOCASE);

CREATE TABLE loc_entries (
  key           TEXT NOT NULL,
  lang          TEXT NOT NULL,
  text          TEXT NOT NULL,
  PRIMARY KEY (key, lang)
);
CREATE INDEX loc_lang_idx ON loc_entries(lang);

CREATE TABLE assets (
  asset_path    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  class_name    TEXT,
  in_pak        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX assets_name_idx  ON assets(name COLLATE NOCASE);
CREATE INDEX assets_class_idx ON assets(class_name);

CREATE TABLE lua_api (
  symbol        TEXT PRIMARY KEY,
  signature     TEXT NOT NULL,
  category      TEXT NOT NULL,
  summary       TEXT NOT NULL,
  example       TEXT,
  pitfalls      TEXT,
  status        TEXT NOT NULL
);
CREATE TABLE exec_commands (
  name          TEXT PRIMARY KEY,
  args          TEXT,
  summary       TEXT
);
CREATE TABLE source_paths (
  path          TEXT PRIMARY KEY,
  module        TEXT NOT NULL
);

CREATE TABLE objects_fts_src (
  rowid   INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  path    TEXT NOT NULL,
  package TEXT NOT NULL,
  kind    TEXT NOT NULL
);
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  name, path, package, kind,
  content='objects_fts_src', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE loc_fts USING fts5(
  key, text, content='loc_entries', content_rowid='rowid'
);
`

export interface ObjectRow {
  path: string
  kind: string
  package: string
  outer_path: string | null
  name: string
  dump_index: number | null
  super_path: string | null
  is_blueprint: number
  hook_path: string | null
  hook_path_status: 'ok' | 'bp_asset_unresolved' | 'bp_asset_ambiguous'
  object_path: string | null
}

export interface PropertyRow {
  owner_path: string
  ordinal: number
  offset: number
  prop_kind: string
  name: string
  type_name: string | null
  inner_type: string | null
  type_source: string
}

export interface FunctionParamRow extends PropertyRow {
  function_path: string
  is_return: number
  is_out: number
}

export interface BpClassRow {
  path: string
  package: string
  kind: string
  asset_path: string | null
  object_path: string | null
  resolution: 'ok' | 'not_found' | 'ambiguous'
  candidates: string | null
}

export interface AssetRow {
  asset_path: string
  name: string
  class_name: string | null
  in_pak: number
}

export interface EnumValueRow {
  enum_path: string
  ordinal: number
  name: string
  value: number
}

export interface FtsSrcRow {
  rowid: number
  name: string
  path: string
  package: string
  kind: string
}
