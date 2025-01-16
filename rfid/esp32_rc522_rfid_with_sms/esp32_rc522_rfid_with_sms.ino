#include <WiFi.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#define SS_PIN 5     // SS/SDA connected to GPIO 5
#define RST_PIN 0   // RST connected to GPIO D0 (GPIO 16)
MFRC522 mfrc522(SS_PIN, RST_PIN);  // Create MFRC522 instance

#define ON_Board_LED 2  // On-board LED pin for ESP32

const char* ssid = "{ssid}"; // Change to your WiFi SSID
const char* password = "{password}"; // Change to your WiFi password

const char* computer_ip_address = "{computer_ip_address}"; // Change to your computer's IP address
const int port = 4000;
const char* path = "/user";

int readsuccess;
byte readcard[4];
char str[32] = "";
String StrUID;

WebSocketsClient webSocket;

void setup() {
  Serial.begin(115200);
  
  // SPI configuration for ESP32
  SPI.begin(18, 19, 23);  // SCK=18, MISO=19, MOSI=23
  mfrc522.PCD_Init();

  delay(500);

  WiFi.begin(ssid, password);
  Serial.println("");
  
  pinMode(ON_Board_LED, OUTPUT); 
  digitalWrite(ON_Board_LED, HIGH);

  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    digitalWrite(ON_Board_LED, LOW);
    delay(250);
    digitalWrite(ON_Board_LED, HIGH);
    delay(250);
  }
  digitalWrite(ON_Board_LED, HIGH);
  Serial.println("");
  Serial.print("Successfully connected to: ");
  Serial.println(ssid);
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  Serial.println("Please tag a card or keychain to see the UID!");
  Serial.println("");

  // Initialize WebSocket client and set up event handlers
  webSocket.begin(computer_ip_address, port, path);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void loop() {
  webSocket.loop();
  readsuccess = getid();

  if (readsuccess) {
    digitalWrite(ON_Board_LED, LOW);
    Serial.print(StrUID);
    webSocket.sendTXT(StrUID); // Send UID over WebSocket connection
    delay(1000);
    digitalWrite(ON_Board_LED, HIGH);
  }
}

int getid() {  
  if (!mfrc522.PICC_IsNewCardPresent()) {
    return 0;
  }
  if (!mfrc522.PICC_ReadCardSerial()) {
    return 0;
  }
  
  Serial.print("THE UID OF THE SCANNED CARD IS: ");
  for (int i = 0; i < 4; i++) {
    readcard[i] = mfrc522.uid.uidByte[i];
    array_to_string(readcard, 4, str);
    StrUID = str;
  }
  mfrc522.PICC_HaltA();
  return 1;
}

void array_to_string(byte array[], unsigned int len, char buffer[]) {
  for (unsigned int i = 0; i < len; i++) {
    byte nib1 = (array[i] >> 4) & 0x0F;
    byte nib2 = (array[i] >> 0) & 0x0F;
    buffer[i * 2 + 0] = nib1 < 0xA ? '0' + nib1 : 'A' + nib1 - 0xA;
    buffer[i * 2 + 1] = nib2 < 0xA ? '0' + nib2 : 'A' + nib2 - 0xA;
  }
  buffer[len * 2] = '\0';
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("WebSocket disconnected");
      break;
    case WStype_CONNECTED:
      Serial.println("WebSocket connected");
      break;
    case WStype_TEXT: {
      Serial.printf("Received text: %s\n", payload);

      // Try to parse the received message as JSON
      StaticJsonDocument<200> doc;
      DeserializationError error = deserializeJson(doc, payload);

      if (error) {
        // If JSON parsing failed, assume it's an RFID UID (string)
        Serial.println("Received RFID UID: ");
        Serial.println((char*)payload);
        // If this is a UID, just print or handle it accordingly
        break;
      }

      // If it's JSON, extract the phone number and message
      const char* phoneNumber = doc["phone_number"];
      const char* message = doc["message"];

      // Handle sending SMS
      Serial.println("Sending SMS...");
      Serial.printf("Phone: %s, Message: %s\n", phoneNumber, message);

      // Send SMS via GSM module
      sendSMS(phoneNumber, message);
      bool smsStatus = sendSMS(phoneNumber, message);
      sendWebSocketResponse(smsStatus, smsStatus ? "SMS sent successfully." : "SMS failed to send.");
    } break;
  }
}

void sendSMS(const char* phoneNumber, const char* message) {
  Serial.println("Initializing SMS...");

  // Begin communication with SIM900A
  Serial2.begin(9600, SERIAL_8N1, 16, 17); // RX=16, TX=17 (adjust pins if needed)
  
  delay(1000);
  Serial2.println("AT"); // Send AT command to check communication
  delay(100);
  if (Serial2.find("OK")) {
    Serial.println("SIM900A is ready.");
  } else {
    Serial.println("Failed to connect to SIM900A.");
    return;
  }

  // Set SMS to text mode
  Serial2.println("AT+CMGF=1"); 
  delay(100);
  if (Serial2.find("OK")) {
    Serial.println("Text mode set.");
  } else {
    Serial.println("Failed to set text mode.");
    return;
  }

  // Set recipient phone number
  Serial2.print("AT+CMGS=\"");
  Serial2.print(phoneNumber);
  Serial2.println("\"");
  delay(100);
  
  // Send the SMS message
  Serial2.print(message);
  delay(100);
  
  // End the SMS with CTRL+Z (ASCII 26)
  Serial2.write(26);
  delay(5000); // Give it some time to send
  
  if (Serial2.find("OK")) {
    Serial.println("SMS sent successfully!");
  } else {
    Serial.println("Failed to send SMS.");
  }
}

void sendWebSocketResponse(bool success, const char* message) {
  StaticJsonDocument<200> responseDoc;
  responseDoc["status"] = success ? "success" : "error";
  responseDoc["message"] = message;

  String response;
  serializeJson(responseDoc, response);

  webSocket.sendTXT(response);
  Serial.printf("Sent WebSocket response: %s\n", response.c_str());
}