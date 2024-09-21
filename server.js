const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dns = require('dns');
const os = require('os');
const db = require('./database');

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

// Function to check vehicle statuses
const checkVehicleStatuses = async () => {
  try {
    const [vehicles] = await db.query('SELECT * FROM vehicles');

    const currentDate = new Date();
    vehicles.forEach(vehicle => {
      const expirationDate = new Date(vehicle.registration_expiration);
      const timeDiff = expirationDate - currentDate;

      if (timeDiff <= 3 * 24 * 60 * 60 * 1000 && timeDiff > 0) {
        // If expiration is in 3 days
        vehicle.status = 'Expiring Soon';
      } else if (timeDiff <= 24 * 60 * 60 * 1000 && timeDiff > 0) {
        // If expiration is in 1 day
        vehicle.status = 'Expiring Today';
      } else if (timeDiff <= 0) {
        // If expired
        vehicle.status = 'Expired';
      } else {
        // If not expired
        vehicle.status = 'Registered';
      }

      console.log(`Updating vehicle ${vehicle.id} status to ${vehicle.status}`);
      db.query('UPDATE vehicles SET status = ? WHERE id = ?', [vehicle.status, vehicle.id]);
    });
  } catch (error) {
    console.error('Error checking vehicle statuses:', error);
  }
};

// Run the check every 6 hours (6 * 60 * 60 * 1000 milliseconds)
setInterval(checkVehicleStatuses, 6 * 60 * 60 * 1000);
/* setInterval(checkVehicleStatuses, 60000); */ //for testing

// WebSocket connection handling
socket.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.startsWith('::ffff:') ? req.socket.remoteAddress.slice(7) : req.socket.remoteAddress;
  console.log(`${ip} connected to server`);

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
