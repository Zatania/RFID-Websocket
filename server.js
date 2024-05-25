const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dns = require('dns');
const os = require('os');

const app = express();
const server = http.createServer(app);
const socket = new WebSocket.Server({ server });
const PORT = 4000;

dns.lookup(os.hostname(), { family: 4 }, (err, add) => {
  if (err) {
    console.error(`DNS lookup error: ${err}`);
  } else {
    console.log(`Server IP Address: ${add}`);
  }
});

socket.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.startsWith('::ffff:') ? req.socket.remoteAddress.slice(7) : req.socket.remoteAddress;
  console.log(`${ip} connected to server`);

  /* ws.send(`${ip} connected to server`); */

  ws.on('message', message => {
    console.log(`Received: ${message}`);
    socket.clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(`${message}`);
      }
    });
    ws.send(`${message}`);
  });

  ws.on('close', () => {
    console.log(`${ip} disconnected from server`);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
