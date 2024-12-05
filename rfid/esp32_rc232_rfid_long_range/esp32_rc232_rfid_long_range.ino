#include <WiFi.h>
#include <WebSocketsClient.h>

// UART Pins
#define TXD1 17
#define RXD1 16

// UART Configuration
const int bufferSize = 16; // Define the number of bytes to read
char buffer[bufferSize + 1]; // Buffer to store the data (+1 for null terminator)

// WiFi and WebSocket Config
#define ON_Board_LED 2  // On-board LED pin for ESP32

const char* ssid = "{ssid}"; // Change to your WiFi SSID
const char* password = "{password}"; // Change to your WiFi password

const char* computer_ip_address = "{computer_ip_address}"; // Change to your computer's IP address
const int port = 4000;
const char* path = "/vehicle";

WebSocketsClient webSocket;

// Function to handle WebSocket events
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("WebSocket disconnected");
      break;
    case WStype_CONNECTED:
      Serial.println("WebSocket connected");
      break;
    case WStype_TEXT:
      Serial.printf("WebSocket message received: %s\n", payload);
      break;
  }
}

void setup() {
  // Initialize UART
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, RXD1, TXD1);
  Serial.println("ESP32 UART + WebSocket");

  // Initialize WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(250);
  }
  Serial.println("\nConnected to WiFi");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  // Initialize WebSocket
  webSocket.begin(computer_ip_address, port, path);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);

  // Initialize LED
  pinMode(ON_Board_LED, OUTPUT);
  digitalWrite(ON_Board_LED, HIGH);
}

void loop() {
  webSocket.loop(); // Handle WebSocket communication

  if (Serial1.available() >= bufferSize) { // Check if enough data is available
    Serial1.readBytes(buffer, bufferSize);

    // Convert the buffer to hex data
    String hexData = "";
    for (int i = 10; i < bufferSize; i++) { // Adjust index range for desired bytes
      if ((uint8_t)buffer[i] < 0x10) hexData += "0"; // Add leading zero for single digit
      hexData += String((uint8_t)buffer[i], HEX); // Append hex byte to string
      if (i < bufferSize - 1) hexData += ""; // Add space between bytes (except the last one)
    }

    // Print and send the hex data
    Serial.print("Sending Hex Data: ");
    Serial.println(hexData);

    // Send the data to WebSocket
    webSocket.sendTXT(hexData);
  }
}
