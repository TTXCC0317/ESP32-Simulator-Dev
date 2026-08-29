import type { Db } from './client';

/**
 * 种子数据（01-§6.1 + 02-§4 M3"启动种子"）：向 examples 表登记内置示例（幂等）。
 * 示例不直接落 projects——用户在新建工程时选择示例，由 POST /api/projects {exampleId}
 * 从 manifest 实例化（01-§6.1："生产部署不自动跑种子工程"）。
 */

export interface ExampleManifest {
  description: string;
  boardType: string;
  engine: string;
  diagram: string;
  files: Array<{ path: string; content: string }>;
}

/**
 * blink 示例 manifest（01-§6.1）：diagram 为 CircuitDoc 格式（03-§2.1，与 projects.diagram
 * 同构，createProject 直接实例化；web 端 replaceDoc zod 校验可直接通过）。
 */
const BLINK_DIAGRAM = JSON.stringify({
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [
    { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 60, top: 60, rotate: 0, attrs: {} },
    { id: 'led1', type: 'wokwi-led', left: 420, top: 120, rotate: 0, attrs: { color: 'red' } },
  ],
  connections: [
    { id: 'w1', source: 'esp:GPIO4', target: 'led1:A', color: 'green', path: [] },
    { id: 'w2', source: 'led1:C', target: 'esp:GND.1', color: 'black', path: [] },
  ],
  serialMonitor: { baudrate: 115200 },
});

const BLINK_MANIFEST: ExampleManifest = {
  description: 'GPIO4 → LED 每秒闪烁（引擎A/引擎B 双端对齐的第一个示例）',
  boardType: 'board-esp32-devkit-c-v4',
  engine: 'micropython-wasm',
  diagram: BLINK_DIAGRAM,
  files: [
    {
      path: 'main.py',
      content: [
        'from machine import Pin',
        'import time',
        '',
        'led = Pin(4, Pin.OUT)',
        '',
        'while True:',
        '    led.value(1)',
        '    print("LED ON")',
        '    time.sleep(1)',
        '    led.value(0)',
        '    print("LED OFF")',
        '    time.sleep(1)',
        '',
      ].join('\n'),
    },
    {
      path: 'main.ino',
      content: [
        'void setup() {',
        '  pinMode(4, OUTPUT);',
        '  Serial.begin(115200);',
        '}',
        '',
        'void loop() {',
        '  digitalWrite(4, HIGH);',
        '  Serial.println("LED ON");',
        '  delay(1000);',
        '  digitalWrite(4, LOW);',
        '  Serial.println("LED OFF");',
        '  delay(1000);',
        '}',
        '',
      ].join('\n'),
    },
  ],
};

const BUILT_IN_EXAMPLES: Array<{
  id: string;
  name: string;
  category: string;
  manifest: ExampleManifest;
}> = [{ id: 'blink', name: 'blink（LED 闪烁）', category: 'starter', manifest: BLINK_MANIFEST }];

/** 幂等写入 examples 表；返回本次新增的示例 id 列表 */
export function seedExamples(db: Db): string[] {
  const inserted: string[] = [];
  const insert = db.prepare(
    'INSERT OR IGNORE INTO examples (id, name, category, manifest_json) VALUES (?, ?, ?, ?)',
  );
  for (const ex of BUILT_IN_EXAMPLES) {
    const r = insert.run(ex.id, ex.name, ex.category, JSON.stringify(ex.manifest));
    if (r.changes > 0) inserted.push(ex.id);
  }
  return inserted;
}
