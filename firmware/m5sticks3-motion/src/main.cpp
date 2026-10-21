#include <Arduino.h>
#include <M5Unified.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <atomic>
#include <cmath>
#include <cstring>

static constexpr char SERVICE_UUID[] = "51b92800-d766-4aa7-b64d-3f1ab08b1260";
static constexpr char IMU_UUID[] = "51b92801-d766-4aa7-b64d-3f1ab08b1260";
static_assert(sizeof(float)==4, "BLE format requires float32");
static BLECharacteristic* imuCharacteristic;
static BLEServer* server;
static std::atomic<bool> connected{false};
static uint16_t sequence=0;
static uint32_t lastImu=0,lastSend=0,restartAt=0;
static float ax=0,ay=0,az=0;
static bool imuValid=false,previousConnected=false;

class Callbacks: public BLEServerCallbacks {
  void onConnect(BLEServer*) override { connected.store(true); }
  void onDisconnect(BLEServer*) override { connected.store(false); }
};

static void sendSample(uint32_t now) {
  // Exactly 20 bytes. ESP32-S3 uses little endian IEEE754 float32.
  uint8_t packet[20]={};
  const bool valid=imuValid && uint32_t(now-lastImu)<100;
  packet[0]=1;packet[1]=valid?1:0;
  packet[2]=uint8_t(sequence);packet[3]=uint8_t(sequence>>8);++sequence;
  std::memcpy(packet+4,&ax,4);std::memcpy(packet+8,&ay,4);std::memcpy(packet+12,&az,4);std::memcpy(packet+16,&now,4);
  imuCharacteristic->setValue(packet,sizeof(packet));
  if(connected.load())imuCharacteristic->notify();
  const float motion=fabsf(sqrtf(ax*ax+ay*ay+az*az)-1.0f);
  M5.Display.fillRect(0,30,240,105,TFT_BLACK);
  M5.Display.setCursor(4,35);
  M5.Display.setTextColor(connected.load()?TFT_GREEN:TFT_WHITE);
  M5.Display.printf("BLE: %s\n",connected.load()?"CONNECTED":"READY");
  M5.Display.setTextColor(TFT_WHITE);
  if(valid){M5.Display.printf("Move: %.3f G\n",motion);M5.Display.printf("X %+.2f Y %+.2f\nZ %+.2f",ax,ay,az);}
  else M5.Display.print("IMU: NO DATA");
}

void setup() {
  auto config=M5.config();
  M5.begin(config);
  Serial.begin(115200);
  M5.Display.setRotation(1);M5.Display.fillScreen(TFT_BLACK);M5.Display.setTextSize(2);M5.Display.setCursor(4,4);M5.Display.print("REON Motion");
  BLEDevice::init("M5StickS3-REON");
  server=BLEDevice::createServer();server->setCallbacks(new Callbacks());
  auto service=server->createService(SERVICE_UUID);
  imuCharacteristic=service->createCharacteristic(IMU_UUID,BLECharacteristic::PROPERTY_READ|BLECharacteristic::PROPERTY_NOTIFY);
  imuCharacteristic->addDescriptor(new BLE2902());
  uint8_t empty[20]={1,0};imuCharacteristic->setValue(empty,sizeof(empty));
  service->start();
  auto advertising=BLEDevice::getAdvertising();advertising->addServiceUUID(SERVICE_UUID);advertising->setScanResponse(true);advertising->setMinPreferred(0x06);advertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
  M5.Imu.setCalibration(0,0,0); // Do not smooth or automatically alter acceleration samples.
}

void loop() {
  M5.update();const uint32_t now=millis();
  if(M5.Imu.getType()!=m5::imu_none && M5.Imu.update()) {
    const auto sample=M5.Imu.getImuData();ax=sample.accel.x;ay=sample.accel.y;az=sample.accel.z;
    imuValid=std::isfinite(ax)&&std::isfinite(ay)&&std::isfinite(az);lastImu=now;
  }
  const bool isConnected=connected.load();
  if(!isConnected&&previousConnected)restartAt=now+300;
  if(restartAt&&!isConnected&&int32_t(now-restartAt)>=0){restartAt=0;server->startAdvertising();}
  previousConnected=isConnected;
  if(uint32_t(now-lastSend)>=200){lastSend=now;sendSample(now);}
  delay(2);
}
