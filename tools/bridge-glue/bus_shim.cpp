/**
 * ESP32Sim 引擎B I2C/SPI 总线 shim（M8，03-§7.2.2）
 *
 * 通过同 mangled name 强定义覆盖 esp32 core 3.x 的 TwoWire / SPIClass 成员函数。
 * sketch 目标文件先链接 + --allow-multiple-definition → 本文件定义胜出。
 * 证据：M8 D2 探针 wire-shim 实测 "SHIM-BEGIN-CALLED", "ENDTX-ERR=0", "REQ-N=2"。
 *
 * 永不进入 ESP-IDF i2c_\* / spi_\* 驱动路径：QEMU 不模拟 I2C/SPI 外设 ->
 * 静默失败（Wire.begin/endTransmission 恒成功但无硬件交互；SPI.transfer 回显
 * 发送值）——比 M7 ADC panic 更隐蔽，glue 必须完全短路。
 *
 * 静态状态替代实例成员：TwoWire/SPIClass 在 sketch 通常只用单例（Wire / SPI），
 * 用文件作用域静态缓冲即可；忽略 this 指针（仍按 ABI 接收但不用）。
 * 未覆盖的方法（setBufferSize/getBusNum/onReceive/onRequest 等）落回 core 实现，
 * 但这些路径在传感器库典型使用中不进入 I2C/SPI 硬件寄存器，安全。
 *
 * 由 BuildService 在编译时写入 sketch 目录（与 esp32sim_bridge.c 同目录）。
 */

#include <Wire.h>
#include <SPI.h>
#include <Arduino.h>

#include "esp32sim_bridge.h"

/* ---- I2C shim 静态状态（单例，对应 Wire 全局对象） ---- */
static uint8_t s_i2c_addr = 0;
static uint8_t s_i2c_tx_buf[I2C_BUFFER_LENGTH];
static size_t  s_i2c_tx_len = 0;
static uint8_t s_i2c_rx_buf[I2C_BUFFER_LENGTH];
static size_t  s_i2c_rx_len = 0;
static size_t  s_i2c_rx_idx = 0;

/* ---- TwoWire 成员函数覆盖（仅声明在 Wire.h 的非 inline 方法） ---- */

bool TwoWire::begin(int sda, int scl, uint32_t frequency) {
  (void)sda; (void)scl; (void)frequency;  // QEMU 忽略引脚 mux
  s_i2c_tx_len = 0;
  s_i2c_rx_len = 0;
  s_i2c_rx_idx = 0;
  return true;  // 始终成功（glue 接管，永不进入 ESP-IDF i2c_* 路径）
}

bool TwoWire::end() { return true; }

bool TwoWire::setPins(int sda, int scl) {
  (void)sda; (void)scl;
  return true;
}

bool TwoWire::setClock(uint32_t freq) {
  (void)freq;
  return true;
}

void TwoWire::beginTransmission(uint8_t address) {
  s_i2c_addr = address;
  s_i2c_tx_len = 0;
}

size_t TwoWire::write(uint8_t data) {
  if (s_i2c_tx_len >= sizeof(s_i2c_tx_buf)) return 0;
  s_i2c_tx_buf[s_i2c_tx_len++] = data;
  return 1;
}

size_t TwoWire::write(const uint8_t *data, size_t quantity) {
  size_t wrote = 0;
  for (size_t i = 0; i < quantity; i++) {
    if (s_i2c_tx_len >= sizeof(s_i2c_tx_buf)) break;
    s_i2c_tx_buf[s_i2c_tx_len++] = data[i];
    wrote++;
  }
  return wrote;
}

uint8_t TwoWire::endTransmission(bool stopBit) {
  (void)stopBit;
  uint8_t rbuf[1];
  (void)br_i2c_txn(s_i2c_addr, 0,  // dir=0 写
                   s_i2c_tx_buf, (uint8_t)s_i2c_tx_len, rbuf, 0);
  /* 不清空 tx_buf：requestFrom 可用最近 write 的 register addr 作为读上下文
   *（典型 sensor 库：beginTransmission→write(reg)→endTransmission→requestFrom）。
   * 下一轮 beginTransmission 会清空。 */
  return 0;  // Arduino Wire: 0=success
}

uint8_t TwoWire::endTransmission() { return endTransmission(true); }

size_t TwoWire::requestFrom(uint8_t address, size_t len, bool stopBit) {
  (void)stopBit;
  if (len > sizeof(s_i2c_rx_buf)) len = sizeof(s_i2c_rx_buf);
  /* 读请求：wdata 为 register addr（通常 1 字节，由 beginTransmission + write 阶段填充）。
   * 宿主侧根据 DeviceSpec.registers 匹配 regAddr 决定回复字节数。 */
  size_t got = br_i2c_txn(address, 1,  // dir=1 读
                          s_i2c_tx_buf, (uint8_t)s_i2c_tx_len,
                          s_i2c_rx_buf, (uint8_t)len);
  s_i2c_rx_len = got;
  s_i2c_rx_idx = 0;
  s_i2c_tx_len = 0;  // 读后清 tx（典型 sensor 库每次读前重新 write regAddr）
  return got;
}

size_t TwoWire::requestFrom(uint8_t address, size_t len) {
  return requestFrom(address, len, true);
}

int TwoWire::available() { return (int)(s_i2c_rx_len - s_i2c_rx_idx); }

int TwoWire::read() {
  if (s_i2c_rx_idx >= s_i2c_rx_len) return -1;
  return s_i2c_rx_buf[s_i2c_rx_idx++];
}

int TwoWire::peek() {
  if (s_i2c_rx_idx >= s_i2c_rx_len) return -1;
  return s_i2c_rx_buf[s_i2c_rx_idx];
}

void TwoWire::flush() {
  s_i2c_rx_len = 0;
  s_i2c_rx_idx = 0;
}

/* ---- SPI shim 静态状态 ---- */
static uint8_t s_spi_cs = 0;       // SS pin（用作 cs 标识）
static bool s_spi_in_txn = false;

/* ---- SPIClass 成员函数覆盖 ---- */

bool SPIClass::begin(int8_t sck, int8_t miso, int8_t mosi, int8_t ss) {
  (void)sck; (void)miso; (void)mosi;
  s_spi_cs = (uint8_t)ss;
  s_spi_in_txn = false;
  return true;
}

void SPIClass::end() {}

void SPIClass::setHwCs(bool use) { (void)use; }
void SPIClass::setSSInvert(bool invert) { (void)invert; }
void SPIClass::setBitOrder(uint8_t bitOrder) { (void)bitOrder; }
void SPIClass::setDataMode(uint8_t dataMode) { (void)dataMode; }
void SPIClass::setFrequency(uint32_t freq) { (void)freq; }
void SPIClass::setClockDivider(uint32_t clockDiv) { (void)clockDiv; }

uint32_t SPIClass::getClockDivider() { return 0; }

void SPIClass::beginTransaction(SPISettings settings) {
  (void)settings;  // QEMU 忽略时钟/位序/模式
  s_spi_in_txn = true;
}

void SPIClass::endTransaction() {
  s_spi_in_txn = false;
}

uint8_t SPIClass::transfer(uint8_t data) {
  uint8_t rx[1];
  (void)br_spi_txn(s_spi_cs, &data, 1, rx, 1);
  return rx[0];
}

uint16_t SPIClass::transfer16(uint16_t data) {
  uint8_t tx[2] = {(uint8_t)(data >> 8), (uint8_t)(data & 0xff)};
  uint8_t rx[2] = {0, 0};
  (void)br_spi_txn(s_spi_cs, tx, 2, rx, 2);
  return (uint16_t)(((uint16_t)rx[0] << 8) | rx[1]);
}

uint32_t SPIClass::transfer32(uint32_t data) {
  uint8_t tx[4] = {(uint8_t)(data >> 24), (uint8_t)(data >> 16),
                   (uint8_t)(data >> 8),  (uint8_t)(data & 0xff)};
  uint8_t rx[4] = {0, 0, 0, 0};
  (void)br_spi_txn(s_spi_cs, tx, 4, rx, 4);
  return ((uint32_t)rx[0] << 24) | ((uint32_t)rx[1] << 16) |
         ((uint32_t)rx[2] << 8) | rx[3];
}

void SPIClass::transfer(void *data, uint32_t size) {
  if (size == 0) return;
  uint8_t *buf = (uint8_t *)data;
  /* 分块（glue 单帧 payload 上限 255 字节） */
  uint8_t rx[64];
  uint32_t off = 0;
  while (off < size) {
    uint8_t chunk = (uint8_t)((size - off > 64) ? 64 : (size - off));
    size_t got = br_spi_txn(s_spi_cs, buf + off, chunk, rx, chunk);
    for (uint8_t i = 0; i < got; i++) buf[off + i] = rx[i];
    off += chunk;
  }
}

void SPIClass::transferBytes(const uint8_t *data, uint8_t *out, uint32_t size) {
  if (size == 0) return;
  uint8_t rx[64];
  uint32_t off = 0;
  while (off < size) {
    uint8_t chunk = (uint8_t)((size - off > 64) ? 64 : (size - off));
    size_t got = br_spi_txn(s_spi_cs, data + off, chunk, rx, chunk);
    for (uint8_t i = 0; i < got; i++) out[off + i] = rx[i];
    off += chunk;
  }
}

void SPIClass::transferBits(uint32_t data, uint32_t *out, uint8_t bits) {
  /* 以字节为单位传输，最后一字节右对齐 */
  uint8_t nbytes = (uint8_t)((bits + 7) / 8);
  uint8_t tx[4];
  uint8_t rx[4] = {0, 0, 0, 0};
  for (uint8_t i = 0; i < nbytes; i++) {
    tx[i] = (uint8_t)(data >> ((nbytes - 1 - i) * 8));
  }
  (void)br_spi_txn(s_spi_cs, tx, nbytes, rx, nbytes);
  uint32_t val = 0;
  for (uint8_t i = 0; i < nbytes; i++) val = (val << 8) | rx[i];
  /* 按剩余位左对齐：高位 bit 数与 bits 不一致时左移 */
  uint8_t unused = (uint8_t)(nbytes * 8 - bits);
  if (out) *out = val << unused;
}

void SPIClass::write(uint8_t data) {
  uint8_t rx[1];
  (void)br_spi_txn(s_spi_cs, &data, 1, rx, 1);
}

void SPIClass::write16(uint16_t data) {
  uint8_t tx[2] = {(uint8_t)(data >> 8), (uint8_t)(data & 0xff)};
  uint8_t rx[2];
  (void)br_spi_txn(s_spi_cs, tx, 2, rx, 2);
}

void SPIClass::write32(uint32_t data) {
  uint8_t tx[4] = {(uint8_t)(data >> 24), (uint8_t)(data >> 16),
                   (uint8_t)(data >> 8),  (uint8_t)(data & 0xff)};
  uint8_t rx[4];
  (void)br_spi_txn(s_spi_cs, tx, 4, rx, 4);
}

void SPIClass::writeBytes(const uint8_t *data, uint32_t size) {
  if (size == 0) return;
  uint8_t rx[64];
  uint32_t off = 0;
  while (off < size) {
    uint8_t chunk = (uint8_t)((size - off > 64) ? 64 : (size - off));
    (void)br_spi_txn(s_spi_cs, data + off, chunk, rx, chunk);
    off += chunk;
  }
}

void SPIClass::writePixels(const void *data, uint32_t size) {
  writeBytes((const uint8_t *)data, size);
}

void SPIClass::writePattern(const uint8_t *data, uint8_t size, uint32_t repeat) {
  for (uint32_t i = 0; i < repeat; i++) writeBytes(data, size);
}

/* ---- M8 后续：DHT22 辅助 shim ----
 *
 * DHT22 不走 I2C/SPI 总线（role=signal.io），用 GPIO 单总线协议。
 * 真实时序：MCU 拉低 20ms → 释放 20–40µs → DHT22 拉低 80µs → 释放 80µs →
 *   40bit 数据（每 bit：拉低 50µs → 释放 26–28µs=0, 70µs=1）
 *
 * 本 shim 完全短路 GPIO 时序：直接调 br_dht22_txn(pin) 发 TLV 帧请求宿主，
 * 宿主根据设备表配置（Inspector 滑杆注入默认 temperature=22, humidity=50）回复。
 *
 * sketch 用法（替代 Adafruit DHT / SimpleDHT）：
 *   #include "esp32sim_bridge.h"
 *   float t, h;
 *   if (esp32sim_dht22_read(DHTPIN, &t, &h)) { ... }
 *
 * 也可以集成到 DHT 库（需按库的具体实现拦截对应的 read 方法）——
 * 本文件暂只提供通用辅助入口。
 */

extern "C" int esp32sim_dht22_read(uint8_t pin, float *out_temp_c, float *out_hum_pct) {
  uint16_t temp_raw = 0, hum_raw = 0;
  if (!br_dht22_txn(pin, &temp_raw, &hum_raw)) {
    return 0;
  }
  /* temp_raw: 16-bit, 最高位=符号（1=负温），低 15 位 = |temp| × 10
   * hum_raw:  16-bit 无符号 = humidity × 10 */
  if (out_temp_c != NULL) {
    int16_t signed_raw = (int16_t)temp_raw;  /* 最高位扩展为符号 */
    *out_temp_c = (float)signed_raw / 10.0f;
  }
  if (out_hum_pct != NULL) {
    *out_hum_pct = (float)hum_raw / 10.0f;
  }
  return 1;
}

/* 简化版本：只返回温度（不关心湿度时用） */
extern "C" int esp32sim_dht22_read_temp(uint8_t pin, float *out_temp_c) {
  return esp32sim_dht22_read(pin, out_temp_c, NULL);
}

/* 简化版本：只返回湿度 */
extern "C" int esp32sim_dht22_read_hum(uint8_t pin, float *out_hum_pct) {
  return esp32sim_dht22_read(pin, NULL, out_hum_pct);
}
