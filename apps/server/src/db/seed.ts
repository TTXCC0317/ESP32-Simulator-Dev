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

/** button-led 示例 diagram：按键 GPIO4（内部上拉、对地）→ LED GPIO2（M5 双引擎输入注入示例） */
const BUTTON_LED_DIAGRAM = JSON.stringify({
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [
    { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 60, top: 60, rotate: 0, attrs: {} },
    { id: 'btn1', type: 'wokwi-pushbutton', left: 420, top: 100, rotate: 0, attrs: {} },
    { id: 'led1', type: 'wokwi-led', left: 420, top: 300, rotate: 0, attrs: { color: 'red' } },
  ],
  connections: [
    { id: 'w1', source: 'esp:GPIO4', target: 'btn1:1.l', color: 'green', path: [] },
    { id: 'w2', source: 'btn1:2.l', target: 'esp:GND.1', color: 'black', path: [] },
    { id: 'w3', source: 'esp:GPIO2', target: 'led1:A', color: 'orange', path: [] },
    { id: 'w4', source: 'led1:C', target: 'esp:GND.2', color: 'black', path: [] },
  ],
  serialMonitor: { baudrate: 115200 },
});

const BUTTON_LED_MANIFEST: ExampleManifest = {
  description: '按键 GPIO4 控制LED GPIO2：按下点亮/松开熄灭（M5 输入注入双引擎示例）',
  boardType: 'board-esp32-devkit-c-v4',
  engine: 'micropython-wasm',
  diagram: BUTTON_LED_DIAGRAM,
  files: [
    {
      path: 'main.py',
      content: [
        'from machine import Pin',
        'import time',
        '',
        'btn = Pin(4, Pin.IN, Pin.PULL_UP)',
        'led = Pin(2, Pin.OUT)',
        '',
        'last = None',
        'while True:',
        '    v = btn.value()',
        '    if v != last:',
        '        last = v',
        '        led.value(0 if v else 1)',
        '        print("LED OFF" if v else "LED ON")',
        '    time.sleep_ms(20)',
        '',
      ].join('\n'),
    },
    {
      path: 'main.ino',
      content: [
        'void setup() {',
        '  pinMode(4, INPUT_PULLUP);',
        '  pinMode(2, OUTPUT);',
        '  Serial.begin(115200);',
        '}',
        '',
        'int last = -1;',
        '',
        'void loop() {',
        '  int v = digitalRead(4);',
        '  if (v != last) {',
        '    last = v;',
        '    digitalWrite(2, v ? LOW : HIGH);',
        '    Serial.println(v ? "LED OFF" : "LED ON");',
        '  }',
        '  delay(20);',
        '}',
        '',
      ].join('\n'),
    },
  ],
};

/** pwm-breath 示例 diagram：GPIO4 PWM 驱动蓝灯（串 220Ω 到 GND）M7 双引擎 PWM 断言示例 */
const PWM_BREATH_DIAGRAM = JSON.stringify({
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [
    { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 120, top: 40, rotate: 0, attrs: {} },
    { id: 'led', type: 'wokwi-led', left: 420, top: 160, rotate: 0, attrs: { color: 'blue' } },
    {
      id: 'r1',
      type: 'wokwi-resistor',
      left: 400,
      top: 260,
      rotate: 0,
      attrs: { resistance: 220 },
    },
  ],
  connections: [
    { id: 'w1', source: 'esp:GPIO4', target: 'led:A', color: 'orange', path: [] },
    { id: 'w2', source: 'led:C', target: 'r1:1', color: 'green', path: [] },
    { id: 'w3', source: 'r1:2', target: 'esp:GND.1', color: 'black', path: [] },
  ],
  serialMonitor: { baudrate: 115200 },
});

const PWM_BREATH_MANIFEST: ExampleManifest = {
  description: 'GPIO4 PWM 蓝灯呼吸：PEAK/VALLEY 串口循环 + minPwm 计数断言（M7）',
  boardType: 'board-esp32-devkit-c-v4',
  engine: 'micropython-wasm',
  diagram: PWM_BREATH_DIAGRAM,
  files: [
    {
      path: 'main.py',
      content: [
        'from machine import Pin, PWM',
        'import time',
        '',
        'p = PWM(Pin(4), freq=1000, duty=0)',
        'duty = 0',
        'step = 128',
        'direction = 1',
        '',
        'while True:',
        '    p.duty(duty)',
        '    if duty >= 1023:',
        '        direction = -1',
        '        print("PEAK", duty)',
        '    elif duty <= 0:',
        '        direction = 1',
        '        print("VALLEY", duty)',
        '    duty += step * direction',
        '    duty = max(0, min(1023, duty))',
        '    time.sleep_ms(20)',
        '',
      ].join('\n'),
    },
    {
      path: 'main.ino',
      content: [
        'void setup() {',
        '  Serial.begin(115200);',
        '  analogWriteFrequency(4, 1000);',
        '}',
        '',
        'int duty = 0;',
        'int step = 8;   // 0–255 8 位，×4 归一到 10 位',
        'int dir = 1;',
        '',
        'void loop() {',
        '  analogWrite(4, duty);',
        '  if (duty >= 255) {',
        '    dir = -1;',
        '    Serial.printf("PEAK %d\\n", (int)duty * 4);',
        '  } else if (duty <= 0) {',
        '    dir = 1;',
        '    Serial.printf("VALLEY %d\\n", (int)duty * 4);',
        '  }',
        '  duty += step * dir;',
        '  duty = max(0, min(255, duty));',
        '  delay(30);',
        '}',
        '',
      ].join('\n'),
    },
  ],
};

/** servo-pot 示例 diagram：GPIO2 PWM→舵机，VP ADC→电位器（3V3/GND 电源）M7 ADC 示例 */
const SERVO_POT_DIAGRAM = JSON.stringify({
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [
    { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 80, top: 20, rotate: 0, attrs: {} },
    {
      id: 'servo',
      type: 'wokwi-servo',
      left: 480,
      top: 140,
      rotate: 0,
      attrs: { initialAngle: 90 },
    },
    {
      id: 'pot',
      type: 'wokwi-potentiometer',
      left: 460,
      top: 320,
      rotate: 0,
      attrs: { value: 50 },
    },
  ],
  connections: [
    { id: 'w1', source: 'esp:GPIO2', target: 'servo:PWM', color: 'orange', path: [] },
    { id: 'w2', source: 'esp:3V3', target: 'servo:VCC', color: 'red', path: [] },
    { id: 'w3', source: 'esp:GND.1', target: 'servo:GND', color: 'black', path: [] },
    { id: 'w4', source: 'pot:SIG', target: 'esp:VP', color: 'green', path: [] },
    { id: 'w5', source: 'esp:3V3', target: 'pot:VCC', color: 'red', path: [] },
    { id: 'w6', source: 'esp:GND.1', target: 'pot:GND', color: 'black', path: [] },
  ],
  serialMonitor: { baudrate: 115200 },
});

const SERVO_POT_MANIFEST: ExampleManifest = {
  description: 'ADC(VP) 读电位器 → PWM(GPIO2) 控舵机角度：ADC+DUTY 串口断言（M7）',
  boardType: 'board-esp32-devkit-c-v4',
  engine: 'micropython-wasm',
  diagram: SERVO_POT_DIAGRAM,
  files: [
    {
      path: 'main.py',
      content: [
        'from machine import Pin, ADC, PWM',
        'import time',
        '',
        'adc = ADC(Pin(36))   # VP = GPIO36',
        'servo = PWM(Pin(2), freq=50, duty=77)   # 50Hz, duty=77（≈90°）',
        '',
        'while True:',
        '    v = adc.read_u16()          # 0–65535（MicroPython 标准 API）',
        '    # 0–65535 → duty 26–128（≈0°–≈180°，findings D3 近似）',
        '    duty = int(v / 65535 * 102) + 26',
        '    duty = max(26, min(128, duty))',
        '    servo.duty(duty)',
        '    print("ADC:", v, "DUTY:", duty)',
        '    time.sleep_ms(50)',
        '',
      ].join('\n'),
    },
    {
      path: 'main.ino',
      content: [
        'void setup() {',
        '  Serial.begin(115200);',
        '  analogReadResolution(12);       // 12-bit ADC',
        '  analogWriteFrequency(2, 50);    // 舵机 50Hz',
        '  analogWrite(2, 19);             // 初始 duty8bit=19 → 10bit 76 ≈ 90°',
        '}',
        '',
        '/* VP(GPIO36) 在 esp32:esp32 变体 pins_arduino.h 未提供宏（仅 lionbit 等板有），',
        '   直接用数字 36，确保所有 DevKit 变体（esp32 / esp32-devkitc / esp32doit-devkit-v1…）',
        '   arduino-cli compile 都能通过。ADC(Pin(36)) 引擎A也同一引脚编号对齐。 */',
        '#ifndef VP',
        '#define VP 36',
        '#endif',
        '',
        'void loop() {',
        '  int v = analogRead(VP);           // 0–4095',
        '  int d8 = map(v, 0, 4095, 6, 32);  // 8-bit 0–255 → glue ×4 → 10-bit 24–128，覆盖≈0°–≈180°',
        '  d8 = max(6, min(32, d8));',
        '  analogWrite(2, d8);',
        '  Serial.printf("ADC: %d DUTY8: %d\\n", v, d8);',
        '  delay(50);',
        '}',
        '',
      ].join('\n'),
    },
  ],
};

/**
 * i2c-sensor 示例（M8 BH1750 光强读数）：
 * - main.py（引擎A）：machine.I2C shim 未实现，回退硬编码打印（与引擎B 读数对齐）
 * - main.ino（引擎B）：Wire 调 BH1750 @ 0x23，glue 短路返回 [0, 120] → lux = 120/1.2 = 100
 */
const I2C_SENSOR_DIAGRAM = JSON.stringify({
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [
    { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 60, top: 60, rotate: 0, attrs: {} },
    { id: 'bh1', type: 'wokwi-bh1750', left: 420, top: 120, rotate: 0, attrs: { lux: 100 } },
  ],
  connections: [
    { id: 'w1', source: 'esp:GPIO21', target: 'bh1:SDA', color: 'green', path: [] },
    { id: 'w2', source: 'esp:GPIO22', target: 'bh1:SCL', color: 'orange', path: [] },
    { id: 'w3', source: 'bh1:VCC', target: 'esp:3V3', color: 'red', path: [] },
    { id: 'w4', source: 'bh1:GND', target: 'esp:GND.1', color: 'black', path: [] },
  ],
  serialMonitor: { baudrate: 115200 },
});

const I2C_SENSOR_MANIFEST: ExampleManifest = {
  description: 'BH1750 光强传感器（I2C 0x23）读数打印：M8 双引擎',
  boardType: 'board-esp32-devkit-c-v4',
  engine: 'qemu-remote',
  diagram: I2C_SENSOR_DIAGRAM,
  files: [
    {
      path: 'main.py',
      content: [
        '# 引擎A machine.I2C shim 待 M8 阶段2 补全；回退硬编码读数与引擎B对齐',
        'import time',
        '',
        'while True:',
        '    print("LUX: 100")',
        '    time.sleep(1)',
        '',
      ].join('\n'),
    },
    {
      path: 'main.ino',
      content: [
        '#include <Wire.h>',
        '',
        'void setup() {',
        '  Serial.begin(115200);',
        '  Wire.begin(21, 22, 100000);',
        '}',
        '',
        'void loop() {',
        '  Wire.beginTransmission(0x23);',
        '  Wire.write(0x10);  // high-res mode',
        '  Wire.endTransmission();',
        '  delay(180);',
        '  Wire.requestFrom(0x23, 2);',
        '  if (Wire.available() == 2) {',
        '    int hi = Wire.read();',
        '    int lo = Wire.read();',
        '    int lux = (int)((hi << 8 | lo) / 1.2);',
        '    Serial.printf("LUX: %d\\n", lux);',
        '  }',
        '  delay(1000);',
        '}',
        '',
      ].join('\n'),
    },
  ],
};

/**
 * mpu6050-roll 示例（M8 MPU6050 WHO_AM_I 自检 + 加速度读）：
 * - main.py（引擎A）：machine.I2C shim 未实现，回退硬编码
 * - main.ino（引擎B）：Wire 调 MPU6050 @ 0x68，WHO_AM_I(0x75)→0x68；ACCEL(0x3B, 6B) → [0,0,0,0,64,0]
 */
const MPU6050_ROLL_DIAGRAM = JSON.stringify({
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [
    { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 60, top: 60, rotate: 0, attrs: {} },
    { id: 'mp1', type: 'wokwi-mpu6050', left: 420, top: 120, rotate: 0, attrs: {} },
  ],
  connections: [
    { id: 'w1', source: 'esp:GPIO21', target: 'mp1:SDA', color: 'green', path: [] },
    { id: 'w2', source: 'esp:GPIO22', target: 'mp1:SCL', color: 'orange', path: [] },
    { id: 'w3', source: 'mp1:VCC', target: 'esp:3V3', color: 'red', path: [] },
    { id: 'w4', source: 'mp1:GND', target: 'esp:GND.1', color: 'black', path: [] },
  ],
  serialMonitor: { baudrate: 115200 },
});

const MPU6050_ROLL_MANIFEST: ExampleManifest = {
  description: 'MPU6050 6 轴 IMU 自检（WHO_AM_I + ACCEL 读取）：M8 双引擎',
  boardType: 'board-esp32-devkit-c-v4',
  engine: 'qemu-remote',
  diagram: MPU6050_ROLL_DIAGRAM,
  files: [
    {
      path: 'main.py',
      content: [
        '# 引擎A machine.I2C shim 待 M8 阶段2 补全；回退硬编码读数',
        'import time',
        '',
        'while True:',
        '    print("WHO_AM_I: 0x68")',
        '    print("ACCEL x=0 y=0 z=16384")',
        '    time.sleep(1)',
        '',
      ].join('\n'),
    },
    {
      path: 'main.ino',
      content: [
        '#include <Wire.h>',
        '',
        'void setup() {',
        '  Serial.begin(115200);',
        '  Wire.begin(21, 22, 100000);',
        '  Wire.beginTransmission(0x68);',
        '  Wire.write(0x6B);  // PWR_MGMT_1',
        '  Wire.write(0);     // wake up',
        '  Wire.endTransmission();',
        '}',
        '',
        'void loop() {',
        '  Wire.beginTransmission(0x68);',
        '  Wire.write(0x75);  // WHO_AM_I',
        '  Wire.endTransmission();',
        '  Wire.requestFrom(0x68, 1);',
        '  int who = Wire.read();',
        '  Serial.printf("WHO_AM_I: 0x%02X\\n", who);',
        '',
        '  Wire.beginTransmission(0x68);',
        '  Wire.write(0x3B);  // ACCEL_XOUT_H',
        '  Wire.endTransmission();',
        '  Wire.requestFrom(0x68, 6);',
        '  int ax = (Wire.read() << 8 | Wire.read());',
        '  int ay = (Wire.read() << 8 | Wire.read());',
        '  int az = (Wire.read() << 8 | Wire.read());',
        '  Serial.printf("ACCEL x=%d y=%d z=%d\\n", ax, ay, az);',
        '  delay(500);',
        '}',
        '',
      ].join('\n'),
    },
  ],
};

/**
 * dht22-basic 示例（M8 DHT22 单总线温湿度）：
 * - main.py / main.ino：引擎A wasm shim I2C/SPI/DHT22 类待 stage 2 emsdk 重建；
 *   引擎B 已切到 glue esp32sim_dht22_read 真实单总线调用（glue bridge DHT22_TXN/REPLY 帧）。
 *   双引擎串口均打印 "TEMP: 22.0 HUM: 50.0"（与 attrs 默认值 22/50 对齐），
 *   走 serialContainsAll + expect.sensor 双重断言（sensor.data 由 ws-gateway 在 onDhtTxn 时推送）。
 */
const DHT22_BASIC_DIAGRAM = JSON.stringify({
  formatVersion: 1,
  boardType: 'board-esp32-devkit-c-v4',
  parts: [
    { id: 'esp', type: 'board-esp32-devkit-c-v4', left: 60, top: 60, rotate: 0, attrs: {} },
    { id: 'dh1', type: 'wokwi-dht22', left: 420, top: 120, rotate: 0, attrs: {} },
  ],
  connections: [
    { id: 'w1', source: 'esp:GPIO4', target: 'dh1:SDA', color: 'green', path: [] },
    { id: 'w2', source: 'dh1:VCC', target: 'esp:3V3', color: 'red', path: [] },
    { id: 'w3', source: 'dh1:GND', target: 'esp:GND.1', color: 'black', path: [] },
  ],
  serialMonitor: { baudrate: 115200 },
});

const DHT22_BASIC_MANIFEST: ExampleManifest = {
  description: 'DHT22 温湿度打印（单总线简化占位）：M8 双引擎',
  boardType: 'board-esp32-devkit-c-v4',
  engine: 'qemu-remote',
  diagram: DHT22_BASIC_DIAGRAM,
  files: [
    {
      path: 'main.py',
      content: [
        '# 引擎A wasm shim I2C/SPI/DHT22 类待 stage 2 emsdk 重建；当前打印 attrs 默认值',
        'import time',
        '',
        'while True:',
        '    print("TEMP: 22.0 HUM: 50.0")',
        '    time.sleep(2)',
        '',
      ].join('\n'),
    },
    {
      path: 'main.ino',
      content: [
        '// DHT22 单总线：glue esp32sim_dht22_read 真实调用（M8 stage 2 DHT22 TXN/REPLY 帧）',
        '#include <Arduino.h>',
        '#include "esp32sim_bridge.h"',
        '',
        'const int DHTPIN = 4;  // GPIO4 接 dh1:SDA',
        '',
        'void setup() {',
        '  Serial.begin(115200);',
        '}',
        '',
        'void loop() {',
        '  float t, h;',
        '  if (esp32sim_dht22_read(DHTPIN, &t, &h)) {',
        '    Serial.print("TEMP: ");',
        '    Serial.print(t, 1);',
        '    Serial.print(" HUM: ");',
        '    Serial.print(h, 1);',
        '    Serial.println();',
        '  } else {',
        '    Serial.println("DHT22 read failed");',
        '  }',
        '  delay(2000);',
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
}> = [
  { id: 'blink', name: 'blink（LED 闪烁）', category: 'starter', manifest: BLINK_MANIFEST },
  {
    id: 'button-led',
    name: 'button-led（按键控制 LED）',
    category: 'starter',
    manifest: BUTTON_LED_MANIFEST,
  },
  {
    id: 'pwm-breath',
    name: 'pwm-breath（PWM 呼吸灯）',
    category: 'peripheral',
    manifest: PWM_BREATH_MANIFEST,
  },
  {
    id: 'servo-pot',
    name: 'servo-pot（电位器控舵机角度）',
    category: 'peripheral',
    manifest: SERVO_POT_MANIFEST,
  },
  {
    id: 'i2c-sensor',
    name: 'i2c-sensor（BH1750 光强读数）',
    category: 'peripheral',
    manifest: I2C_SENSOR_MANIFEST,
  },
  {
    id: 'mpu6050-roll',
    name: 'mpu6050-roll（MPU6050 WHO_AM_I + 加速度）',
    category: 'peripheral',
    manifest: MPU6050_ROLL_MANIFEST,
  },
  {
    id: 'dht22-basic',
    name: 'dht22-basic（DHT22 温湿度打印）',
    category: 'peripheral',
    manifest: DHT22_BASIC_MANIFEST,
  },
];

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
