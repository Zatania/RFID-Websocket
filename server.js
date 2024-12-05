const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dns = require('dns');
const os = require('os');
const db = require('./database');
const schedule = require('node-schedule');

const app = express();
const server = http.createServer(app);

// Create separate WebSocket servers for vehicle and user
const vehicleWSS = new WebSocket.Server({ noServer: true });
const userWSS = new WebSocket.Server({ noServer: true });

const PORT = 4000;

dns.lookup(os.hostname(), { family: 4 }, (err, add) => {
  if (err) {
    console.error(`DNS lookup error: ${err}`);
  } else {
    console.log(`Server IP Address: ${add}`);
  }
});

// Function to check notification table and send out notifications to ESP32 if pending
const checkNotifications = async (ws) => {
  console.log('Checking notifications every minute');
  try {
    const [notifications] = await db.query('SELECT * FROM notifications WHERE sms_status = "pending"');

    if (notifications.length > 0) {
      console.log('Sending notifications to esp32');

      notifications.forEach(async (notification) => {
        // Construct the notification message
        const notif = {
          phone_number: notification.phone_number,
          message: notification.message
        };

        console.log(`Sending notification: ${JSON.stringify(notif)}`);

        // Send the notification to the ESP32
        ws.send(JSON.stringify(notif));

        // After sending the notification, update the status to 'sent'
        await db.query('UPDATE notifications SET sms_status = ? WHERE id = ?', ['sent', notification.id]);
      });
    } else {
      console.log('No notifications to send');
    }

  } catch (error) {
    console.error('Error checking notifications:', error);
  }
};

// Function to check vehicle statuses
const checkVehicleStatuses = async () => {
  try {
    const [vehicles] = await db.query('SELECT * FROM vehicles');
    if (!Array.isArray(vehicles)) {
      throw new Error('Vehicles data is not an array.');
    }

    const currentDate = new Date();
    for (const vehicle of vehicles) {
      const expirationDate = new Date(vehicle.registration_expiration);
      const timeDiff = expirationDate - currentDate;
      let newStatus;

      // Determine new status based on time difference
      if (timeDiff <= 3 * 24 * 60 * 60 * 1000 && timeDiff > 24 * 60 * 60 * 1000) {
        newStatus = 'Expiring Soon';
      } else if (timeDiff <= 24 * 60 * 60 * 1000 && timeDiff > 0) {
        newStatus = 'Expiring Today';
      } else if (timeDiff <= 0) {
        newStatus = 'Expired';
      } else {
        newStatus = 'Registered';
      }

      // Update status only if it's different from the current status
      if (vehicle.status !== newStatus) {
        console.log(`Updating vehicle ${vehicle.id} status to ${newStatus}`);
        await db.query('UPDATE vehicles SET status = ? WHERE id = ?', [newStatus, vehicle.id]);
      }

      // Handle notifications for expiring or expired vehicles
      if (['Expiring Soon', 'Expiring Today', 'Expired'].includes(newStatus)) {
        let user = null;

        // Retrieve associated user or premium user
        if (vehicle.user_id) {
          const [users] = await db.query('SELECT * FROM users WHERE id = ?', [vehicle.user_id]);
          if (users.length > 0) user = users[0];
        } else if (vehicle.premium_id) {
          const [premiums] = await db.query('SELECT * FROM premium_users WHERE id = ?', [vehicle.premium_id]);
          if (premiums.length > 0) user = premiums[0];
        }

        if (user) {
          const phone_number = user.phone_number;
          const messages = {
            'Expiring Soon': `Your vehicle with plate number ${vehicle.plate_number} is expiring soon. Please renew your registration.`,
            'Expiring Today': `Your vehicle with plate number ${vehicle.plate_number} is expiring today. Please renew your registration.`,
            'Expired': `Your vehicle with plate number ${vehicle.plate_number} has expired. Please renew your registration.`,
          };

          // Insert notifications, ensuring daily notifications for "Expiring Soon"
          const [existingNotifications] = await db.query(
            `SELECT * FROM notifications 
            WHERE phone_number = ? 
            AND message = ? 
            AND DATE(created_at) = CURDATE()`,
            [phone_number, messages[newStatus]]
          );

          if (existingNotifications.length === 0 || newStatus === 'Expiring Soon') {
            await db.query(
              'INSERT INTO notifications (phone_number, title, message, sms_status) VALUES (?, ?, ?, ?)',
              [phone_number, 'Vehicle Registration Expiry', messages[newStatus], 'pending']
            );
            console.log(`Notification sent to ${phone_number} for status: ${newStatus}`);
          }
        } else {
          console.log('No user or premium user associated with vehicle');
        }
      }
    }
  } catch (error) {
    console.error('Error checking vehicle statuses:', error);
  }
};

// Function to check driver's license expiration
const checkDriverLicense = async () => {
  try {
    const [licenses] = await db.query('SELECT * FROM drivers_licenses');

    if (!Array.isArray(licenses)) {
      throw new Error('Driver licenses data is not an array.');
    }

    const currentDate = new Date();
    for (const license of licenses) {
      const expirationDate = new Date(license.expiration);
      const timeDiff = expirationDate - currentDate;
      let status;

      // Determine new status based on time difference
      if (timeDiff <= 3 * 24 * 60 * 60 * 1000 && timeDiff > 24 * 60 * 60 * 1000) {
        status = 'Expiring Soon';
      } else if (timeDiff <= 24 * 60 * 60 * 1000 && timeDiff > 0) {
        status = 'Expiring Today';
      } else if (timeDiff <= 0) {
        status = 'Expired';
      } else {
        status = 'Valid';
      }

      // Skip if status is 'Valid'
      if (status === 'Valid') {
        console.log(`License ID ${license.id} is valid. No action needed.`);
        continue;
      }

      if (license.user_id) {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [license.user_id]);
        if (users.length > 0) {
          const phone_number = users[0].phone_number;
          const messages = {
            'Expiring Soon': `Your driver's license is expiring soon. Please renew your license.`,
            'Expiring Today': `Your driver's license is expiring today. Please renew your license.`,
            'Expired': `Your driver's license has expired. Please renew your license.`,
          };

          // Insert notifications, ensuring daily notifications for "Expiring Soon"
          const [existingNotifications] = await db.query(
            `SELECT * FROM notifications 
            WHERE phone_number = ? 
            AND message = ? 
            AND DATE(created_at) = CURDATE()`,
            [phone_number, messages[status]]
          );

          if (existingNotifications.length === 0 || status === 'Expiring Soon') {
            await db.query(
              'INSERT INTO notifications (phone_number, title, message, sms_status) VALUES (?, ?, ?, ?)',
              [phone_number, 'Driver License Expiry', messages[status], 'pending']
            );
            console.log(`Notification sent to ${phone_number} for status: ${status}`);
          }
        } else {
          console.log('No user associated with driver license');
        }
      } else if (license.premium_id) {
        const [premiums] = await db.query('SELECT * FROM premium_users WHERE id = ?', [license.premium_id]);
        if (premiums.length > 0) {
          const phone_number = premiums[0].phone_number;
          const messages = {
            'Expiring Soon': `Your driver's license is expiring soon. Please renew your license.`,
            'Expiring Today': `Your driver's license is expiring today. Please renew your license.`,
            'Expired': `Your driver's license has expired. Please renew your license.`,
          };

          // Insert notifications, ensuring daily notifications for "Expiring Soon"
          const [existingNotifications] = await db.query(
            `SELECT * FROM notifications 
            WHERE phone_number = ? 
            AND message = ? 
            AND DATE(created_at) = CURDATE()`,
            [phone_number, messages[status]]
          );

          if (existingNotifications.length === 0 || status === 'Expiring Soon') {
            await db.query(
              'INSERT INTO notifications (phone_number, title, message, sms_status) VALUES (?, ?, ?, ?)',
              [phone_number, 'Driver License Expiry', messages[status], 'pending']
            );
            console.log(`Notification sent to ${phone_number} for status: ${status}`);
          }
        } else {
          console.log('No premium user associated with driver license');
        }
      }
    }
  } catch (error) {
    console.error('Error checking driver license statuses:', error);
  }
};

// Schedule the task to run at 5:00 AM daily
schedule.scheduleJob('0 5 * * *', () => {
  console.log('Running vehicle status check at 5:00 AM');
  checkVehicleStatuses();
  checkDriverLicense();
});

// Store connected clients
const vehicleClients = [];
const userClients = [];

// Handle vehicle WebSocket connections
vehicleWSS.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.startsWith('::ffff:') ? req.socket.remoteAddress.slice(7) : req.socket.remoteAddress;
  console.log(`${ip} connected to /vehicle WebSocket`);

  // Add new client to the array
  vehicleClients.push(ws);

  ws.on('message', message => {
    console.log(`[Vehicle] Received: ${message}`);
    // Broadcast the received message to all connected vehicle clients
    vehicleClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`${message}`);
      }
    });
  });

  ws.on('close', () => {
    console.log(`${ip} disconnected from /vehicle WebSocket`);
    // Remove client from the array
    const index = vehicleClients.indexOf(ws);
    if (index > -1) {
      vehicleClients.splice(index, 1);
    }
  });
});

// Handle user WebSocket connections
userWSS.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.startsWith('::ffff:') ? req.socket.remoteAddress.slice(7) : req.socket.remoteAddress;
  console.log(`${ip} connected to /user WebSocket`);

  // Add new client to the array
  userClients.push(ws);

  // Start the notification check every minute for this user
  setInterval(() => checkNotifications(ws), 30000); // Check every minute

  ws.on('message', message => {
    console.log(`[User] Received: ${message}`);
    // Broadcast the received message to all connected user clients
    userClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`${message}`);
      }
    });
  });

  ws.on('close', () => {
    console.log(`${ip} disconnected from /user WebSocket`);
    // Remove client from the array
    const index = userClients.indexOf(ws);
    if (index > -1) {
      userClients.splice(index, 1);
    }
  });
});


// Upgrade HTTP connections to WebSocket based on the URL path
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;

  if (pathname === '/vehicle') {
    vehicleWSS.handleUpgrade(request, socket, head, (ws) => {
      vehicleWSS.emit('connection', ws, request);
    });
  } else if (pathname === '/user') {
    userWSS.handleUpgrade(request, socket, head, (ws) => {
      userWSS.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
