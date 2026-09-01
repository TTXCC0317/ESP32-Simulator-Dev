void setup() {
  Serial.begin(115200);
  analogWriteFrequency(4, 1000);
}

int duty = 0;
int step = 8;   // 0–255 8 位，×4 归一到 10 位
int dir = 1;

void loop() {
  analogWrite(4, duty);
  if (duty >= 255) {
    dir = -1;
    Serial.printf("PEAK %d\n", (int)duty * 4);
  } else if (duty <= 0) {
    dir = 1;
    Serial.printf("VALLEY %d\n", (int)duty * 4);
  }
  duty += step * dir;
  duty = max(0, min(255, duty));
  delay(30);
}
