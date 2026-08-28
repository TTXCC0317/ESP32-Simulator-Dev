-- 0001_init.sql — 初始 schema（《01-总体设计方案》§6 全部表，含演进后的最终形态）
-- 所有表均含 created_at/updated_at（Unix 毫秒）；时间由应用层写入。

-- 工程主表
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,            -- nanoid
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  board_type  TEXT NOT NULL DEFAULT 'esp32-devkit-c-v4',
  engine      TEXT NOT NULL DEFAULT 'micropython-wasm',  -- 引擎A/B偏好
  diagram     TEXT NOT NULL,               -- diagram.json 全文
  thumbnail   TEXT,                        -- 画布截图 dataURL（PNG，约 4-10KB，04-§8 D3）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 工程源码文件（main.py / sketch 文件 / lib/*）
CREATE TABLE project_files (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,                -- 相对路径
  content    TEXT NOT NULL,
  UNIQUE(project_id, path)
);

-- 元件库（由 config/parts/*.json 启动时导入，只读缓存）
CREATE TABLE parts_catalog (
  type            TEXT PRIMARY KEY,        -- 如 'wokwi-led'
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,           -- mcu / sensor / display / io / power
  definition_json TEXT NOT NULL            -- 引脚/属性/渲染器/仿真行为描述
);

-- 板卡与引脚映射
CREATE TABLE board_pinmaps (
  board_type TEXT NOT NULL,
  pin_name   TEXT NOT NULL,                -- 'D13' / 'GPIO4'
  gpio_no    INTEGER NOT NULL,
  capabilities TEXT NOT NULL,              -- '["gpio","pwm","adc"]'
  x          INTEGER NOT NULL DEFAULT 0,   -- SVG 内引脚坐标（03-§2.2 BoardDefinition.pins）
  y          INTEGER NOT NULL DEFAULT 0,
  col        TEXT NOT NULL DEFAULT 'L',    -- 'L'（左列）/'R'（右列），05-§1.1.1
  PRIMARY KEY (board_type, pin_name, col)
);

-- 编译任务（引擎B）
CREATE TABLE builds (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  toolchain  TEXT NOT NULL,                -- arduino | esp-idf
  status     TEXT NOT NULL DEFAULT 'queued', -- queued|running|success|failed
  log        TEXT,
  artifact   TEXT,                         -- 产物相对路径
  pinned     INTEGER NOT NULL DEFAULT 0,   -- 用户固定保留（06-§4.1 磁盘清理跳过）
  created_at INTEGER NOT NULL,
  started_at INTEGER,                      -- 进入 running 时刻（02-§1.4 指标）
  finished_at INTEGER
);

-- 内置示例
CREATE TABLE examples (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  manifest_json TEXT NOT NULL              -- 指向内置工程模板
);

-- 应用设置（主题/语言/最近打开/ui.layout）
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 索引（01-§6）
CREATE INDEX idx_projects_updated ON projects(updated_at);
CREATE INDEX idx_builds_project_created ON builds(project_id, created_at);
CREATE INDEX idx_project_files_project ON project_files(project_id);
