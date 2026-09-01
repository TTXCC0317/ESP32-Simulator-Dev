void setup() {
  Serial.begin(115200);
  analogReadResolution(12);       // 12-bit ADC
  analogWriteFrequency(2, 50);    // 舵机 50Hz
  analogWrite(2, 19);             // 初始 duty8bit=19 → 10bit 76 ≈ 90°
}

/* VP(GPIO36) 在 esp32:esp32 变体 pins_arduino.h 未提供宏（仅 lionbit 等板有），
   直接用数字 36，确保所有 DevKit 变体（esp32 / esp32-devkitc / esp32doit-devkit-v1…）
   arduino-cli compile 都能通过。ADC(Pin(36)) 引擎A也同一引脚编号对齐。 */
#ifndef VP
#define VP 36
#endif

void loop() {
  int v = analogRead(VP);           // 0–4095
  int d8 = map(v, 0, 4095, 6, 32);  // 8-bit 0–255 → glue ×4 → 10-bit 24–128，覆盖≈0°–≈180°
  d8 = max(6, min(32, d8));
  analogWrite(2, d8);
  Serial.printf("ADC: %d DUTY8: %d\n", v, d8);
  delay(50);
}
