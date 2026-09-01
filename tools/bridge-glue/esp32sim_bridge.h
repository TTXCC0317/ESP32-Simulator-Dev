#ifndef ESP32SIM_BRIDGE_H
#define ESP32SIM_BRIDGE_H

/**
 * ESP32Sim 引擎B HAL 桥 glue 公共接口（M8，03-§7.2.2）
 *
 * 由 bus_shim.cpp（TwoWire/SPIClass 成员覆盖）调用，提供 I2C/SPI 事务
 * 经 TLV 变长帧发送到宿主（TS 侧 QemuGpioBridge）并阻塞等待回复。
 *
 * 单通道语义：同一时刻只允许一个 in-flight 事务（bridge 单 UART 通道，
 * s_reply 单槽）——shim 必须串行调用（TwoWire/SPIClass 默认即串行）。
 */

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * M8 I2C 事务（TwoWire::endTransmission / requestFrom 内部调用）：
 * - dir=0 写：发送 wdata[wlen] 到 addr，宿主记录写入（回复通常 0 字节）
 * - dir=1 读：发送 wdata[wlen]（通常 1 字节 register addr），宿主查
 *   DeviceSpec.registers 匹配 size 后回复 N 字节
 * 阻塞等待 SENSOR_REPLY（50ms 超时，超时返回 0）
 * 返回 rbuf 实际接收字节数
 */
size_t br_i2c_txn(uint8_t addr, uint8_t dir, const uint8_t *wdata, uint8_t wlen,
                  uint8_t *rbuf, uint8_t rlen_cap);

/**
 * M8 SPI 事务（SPIClass::transfer 内部调用）：
 * 全双工：发送 wdata[wlen]，宿主查 SpiDeviceSpec 回复同长 rdata
 * 阻塞等待 SPI_REPLY（50ms 超时，超时返回 0）
 * 返回 rbuf 实际接收字节数
 */
size_t br_spi_txn(uint8_t cs, const uint8_t *wdata, uint8_t wlen,
                  uint8_t *rbuf, uint8_t rlen_cap);

/**
 * M8 后续：DHT22 单总线请求（DHT 库 shim 内部调用）：
 * 简化协议：不模拟 20ms 拉低 start / 40µs 位级时序，直接给 raw 值
 * tempRaw = Math.round(temperature * 10)（最高位=符号）
 * humRaw  = Math.round(humidity * 10)
 * 返回 1 成功，0 超时/失败
 */
int br_dht22_txn(uint8_t pin, uint16_t *out_temp_raw, uint16_t *out_hum_raw);

#ifdef __cplusplus
}
#endif

#endif /* ESP32SIM_BRIDGE_H */
