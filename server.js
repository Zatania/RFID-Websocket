const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dns = require('dns');
const os = require('os');
const db = require('./database');
const schedule = require('node-schedule');
const dayjs = require('dayjs');

const app = express();
const server = http.createServer(app);

// Create separate WebSocket servers for vehicle and user
const vehicleWSS = new WebSocket.Server({ noServer: true });
const userWSS = new WebSocket.Server({ noServer: true });

// create WebSocket server for real time logs
const logsWSS = new WebSocket.Server({ noServer: true });
const realtimeWSS = new WebSocket.Server({ noServer: true });

const PORT = 4000;

dns.lookup(os.hostname(), { family: 4 }, (err, add) => {
  if (err) {
    console.error(`DNS lookup error: ${err}`);
  } else {
    console.log(`Server IP Address: ${add}`);
  }
});

let esp32Client = null;
let notificationInterval = null;
let isCheckingNotifications = false; // Flag to track if notifications are being checked

const checkNotifications = async () => {
  if (isCheckingNotifications) {
    console.log('Notification check is already in progress, skipping this check...');
    return;
  }

  isCheckingNotifications = true;
  console.log('Checking notifications every 10 seconds...');

  try {
    const [notifications] = await db.query('SELECT * FROM notifications WHERE sms_status IN ("pending", "error")');

    if (notifications.length > 0) {
      console.log('Sending notifications to ESP32');

      for (let notification of notifications) {
        const notif = {
          phone_number: notification.phone_number,
          message: notification.message,
          notification_id: notification.id,
          type: "sms"
        };

        if (notification.sms_status === "sent") {
          console.log(`Skipping already processed notification: ${notification.id}`);
          continue;
        }

        console.log(`Sending notification: ${JSON.stringify(notif)}`);

        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          try {
            esp32Client.send(JSON.stringify(notif));

            // Wait for response with a timeout
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                reject(new Error('Response timeout after 10 seconds'));
              }, 10000); // 10 seconds timeout

              esp32Client.once('message', async (message) => {
                clearTimeout(timeout); // Clear the timeout on response
                try {
                  const response = JSON.parse(message);
                  if (response.type === "sms" && response.notification_id === notification.id) {
                    if (response.status === 'success') {
                      console.log(`Notification sent successfully: ${notif.phone_number}`);
                      await db.query('UPDATE notifications SET sms_status = ? WHERE id = ?', ['sent', notification.id]);
                    } else if (response.status === 'error') {
                      console.error(`Failed to send notification to ${notif.phone_number}: ${response.message}`);
                      await db.query('UPDATE notifications SET sms_status = ? WHERE id = ?', ['error', notification.id]);
                    }
                    resolve();
                  } else {
                    reject(new Error('Notification ID mismatch or unexpected response type'));
                  }
                } catch (err) {
                  reject(err);
                }
              });
            });
          } catch (error) {
            console.error(`Failed to process notification ${notification.id}:`, error);
            await db.query('UPDATE notifications SET sms_status = ? WHERE id = ?', ['error', notification.id]);
          }
        } else {
          console.log('ESP32 client is not connected. Skipping notification.');
          // Optionally update status to 'error' if needed
          await db.query('UPDATE notifications SET sms_status = ? WHERE id = ?', ['error', notification.id]);
        }
      }
    } else {
      console.log('No notifications to send');
    }
  } catch (error) {
    console.error('Error checking notifications:', error);
  }

  isCheckingNotifications = false; // Ensure flag is reset
};

// Function to check if 'premiums' table 'end_date' is today then update 'status' to 'Expired' and insert into notifications table
const checkPremiumStatus = async () => {
  console.log('Checking premium statuses');
  try {
    const [premiums] = await db.query('SELECT * FROM premiums');

    if (!Array.isArray(premiums)) {
      throw new Error('Premiums data is not an array.');
    }

    const currentDate = new Date();
    for (const premium of premiums) {
      const expirationDate = new Date(premium.end_date);
      const timeDiff = expirationDate - currentDate;
      let newStatus;

      // Determine new status based on time difference
      if (timeDiff <= 0) {
        newStatus = 'Expired';
      } else {
        newStatus = 'Active';
      }

      // Update status only if it's different from the current status
      if (premium.status !== newStatus) {
        console.log(`Updating premium user ${premium.id} status to ${newStatus}`);
        await db.query('UPDATE premiums SET status = ? WHERE id = ?', [newStatus, premium.id]);
      }

      // Handle notifications for expired premiums
      if (newStatus === 'Expired') {
        const phone_number = premium.phone_number;
        const message = `Your premium subscription has expired. Please renew your subscription.`;

        // Insert notifications
        await db.query(
          'INSERT INTO notifications (phone_number, title, message, sms_status) VALUES (?, ?, ?, ?)',
          [phone_number, 'Premium Subscription Expiry', message, 'pending']
        );

        console.log(`Notification sent to ${phone_number} for premium status: ${newStatus}`);
      }

      // Handle notifications for premiums expiring in 14 days
      if (newStatus === 'Active') {
        const daysUntilExpiration = Math.ceil(timeDiff / (1000 * 60 * 60 * 24)); // Convert ms to days

        if (daysUntilExpiration <= 14 && daysUntilExpiration >= 1) {
          console.log(`Premium user ${premium.id} will expire in ${daysUntilExpiration} days`);
          const phone_number = premium.phone_number;
          
          // Check if a reminder was already sent today
          const [existingNotifications] = await db.query(
            'SELECT id FROM notifications WHERE phone_number = ? AND title = ? AND DATE(created_at) = CURDATE()',
            [phone_number, 'Premium Subscription Expiry Reminder']
          );

          if (existingNotifications.length === 0) {
            const message = `Your premium subscription will expire in ${daysUntilExpiration} ${daysUntilExpiration === 1 ? 'day' : 'days'}. Please renew to keep your benefits.`;
            
            await db.query(
              'INSERT INTO notifications (phone_number, title, message, sms_status) VALUES (?, ?, ?, ?)',
              [phone_number, 'Premium Subscription Expiry Reminder', message, 'pending']
            );
            
            console.log(`Reminder sent to ${phone_number}: ${message}`);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking premium statuses:', error);
  }
};

// Test CheckPremiumStatus function every second
/* setInterval(() => checkPremiumStatus(), 1000); */

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
      if (timeDiff <= 3 * 24 * 60 * 60 * 1000 && timeDiff > 24 * 60 * 60 * 1000) { // 3 days to 1 day
        newStatus = 'Expiring Soon';
      } else if (timeDiff <= 24 * 60 * 60 * 1000 && timeDiff > 0) { // 1 day to 0 days
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
            `
              SELECT * 
              FROM notifications 
              WHERE phone_number = ? 
              AND message = ? 
              AND DATE(created_at) = CURDATE()
            `,
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

// Schedule the task to run every 8 hours
schedule.scheduleJob('0 */8 * * *', () => {
  console.log('Running status check every 8 hours');
  checkVehicleStatuses();
  checkDriverLicense();
  checkPremiumStatus();
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

  const subprotocol = req.headers['sec-websocket-protocol'];
  console.log('Subprotocol:', subprotocol); // This will show the subprotocol (e.g., "esp32_subprotocol")

  // If subprotocol is "esp32_subprotocol", this is the ESP32 client
  if (subprotocol === "esp32_subprotocol") {
    esp32Client = ws;

    // Start an interval to check notifications every 10 seconds for ESP32 client
    if (notificationInterval) {
      clearInterval(notificationInterval); // Clear any existing interval
    }

    // Run the notification check only once every 10 seconds if the ESP32 is connected
    notificationInterval = setInterval(() => {
      console.log('Running periodic notification check for ESP32 client...');
      checkNotifications(); // This will send notifications to the ESP32 client
    }, 10000); // 10000 ms = 10 seconds
  }

  // Add new client to the array
  userClients.push(ws);

  ws.on('message', message => {
    console.log(`${message}`);
    // Broadcast the received message to all connected user clients
    userClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`${message}`);
      }
    });
  });

  ws.on('close', () => {
    console.log(`${ip} disconnected from /user WebSocket`);
    clearInterval(notificationInterval);
    // Remove client from the array
    const index = userClients.indexOf(ws);
    if (index > -1) {
      userClients.splice(index, 1);
    }

    // If ESP32 disconnected, reset esp32Client and clear the interval
    if (ws === esp32Client) {
      esp32Client = null;
      if (notificationInterval) {
        clearInterval(notificationInterval);  // Clear the interval when ESP32 disconnects
        console.log('Stopped notification check interval for ESP32 client');
      }
    }
  });
});

// Set an interval to check notifications every 10 seconds
setInterval(() => {
  console.log('Running periodic notification check...');
  checkNotifications();
}, 10000); // 10000 ms = 10 seconds

// Function to fetch logs from the database
const fetchLogs = async () => {
  try {
    const query = `
      SELECT
        pl.id AS log_id,
        ph.id AS history_id,
        CONCAT(a.first_name, ' ', a.last_name) as account_name,
        pl.action,
        pl.created_at
      FROM user_parking_logs pl
      JOIN user_parking_history ph ON pl.history_id = ph.id
      JOIN users a ON ph.user_id = a.id
      WHERE DATE(pl.created_at) = CURDATE()

      UNION ALL

      SELECT
        pl.id AS log_id,
        ph.id AS history_id,
        CONCAT(a.first_name, ' ', a.last_name) AS account_name,
        pl.action,
        pl.created_at
      FROM premium_parking_logs pl
      JOIN premium_parking_history ph ON pl.history_id = ph.id
      JOIN premiums a ON ph.premium_id = a.id
      WHERE DATE(pl.created_at) = CURDATE()

      UNION ALL

      SELECT
        pl.id AS log_id,
        ph.id AS history_id,
        CONCAT(a.first_name, ' ', a.last_name) AS account_name,
        pl.action,
        pl.created_at
      FROM visitor_parking_logs pl
      JOIN visitor_parking_history ph ON pl.history_id = ph.id
      JOIN visitors a ON ph.visitor_id = a.id
      WHERE DATE(pl.created_at) = CURDATE()

      ORDER BY created_at DESC;
    `;

    const [logs] = await db.query(query);

    // Format `created_at` using `dayjs`
    return logs.map(log => ({
      ...log,
      created_at: dayjs(log.created_at).format('MM/DD/YY hh:mm A'),
    }));
  } catch (error) {
    console.error('Error fetching logs:', error);
    return [];
  }
};

// Function to fetch parked vehicles from the database

const fetchParkedVehicles = async () => {
  try {
    const query = `
      SELECT
        ph.id AS history_id,
        users.id AS userId,
        'user_parking_history' AS table_name,
        CONCAT(users.first_name, ' ', users.last_name) AS full_name,
        vehicles.plate_number AS plate_number,
        ph.timestamp_in AS time_in,
        TIMESTAMPDIFF(SECOND, ph.timestamp_in, NOW()) AS elapsed_time_seconds,
        ph.status AS status
      FROM user_parking_history ph
      JOIN vehicles ON ph.vehicle_id = vehicles.id
      JOIN users ON ph.user_id = users.id
      WHERE ph.timestamp_out IS NULL

      UNION ALL

      SELECT
        ph.id AS history_id,
        premiums.id AS userId,
        'premium_parking_history' AS table_name,
        CONCAT(premiums.first_name, ' ', premiums.last_name) AS full_name,
        vehicles.plate_number AS plate_number,
        ph.timestamp_in AS time_in,
        TIMESTAMPDIFF(SECOND, ph.timestamp_in, NOW()) AS elapsed_time_seconds,
        ph.status AS status
      FROM premium_parking_history ph
      JOIN vehicles ON ph.vehicle_id = vehicles.id
      JOIN premiums ON ph.premium_id = premiums.id
      WHERE ph.timestamp_out IS NULL

      UNION ALL

      SELECT
        ph.id AS history_id,
        visitors.id AS userId,
        'visitor_parking_history' AS table_name,
        CONCAT(visitors.first_name, ' ', visitors.last_name) AS full_name,
        visitors.vehicle_plate_number AS plate_number,
        ph.timestamp_in AS time_in,
        TIMESTAMPDIFF(SECOND, ph.timestamp_in, NOW()) AS elapsed_time_seconds,
        ph.status AS status
      FROM visitor_parking_history ph
      JOIN visitors ON ph.visitor_id = visitors.id
      WHERE ph.timestamp_out IS NULL

      ORDER BY time_in DESC;
    `

    // Execute the query
    const [vehicles] = await db.query(query)

    // Loop through results to format rows and check for elapsed time > 8 hours
    for (const vehicle of vehicles) {
      const elapsedSeconds = vehicle.elapsed_time_seconds
      const hours = Math.floor(elapsedSeconds / 3600) // Convert seconds to hours
      const minutes = Math.floor((elapsedSeconds % 3600) / 60) // Get remaining minutes
      const formattedDuration = `${hours}h ${minutes}m`

      vehicle.elapsed_time = formattedDuration // Add formatted duration
      vehicle.time_in = dayjs(vehicle.time_in).format('hh:mm A')

      // If elapsed time exceeds 8 hours, update the status only for user and visitor parking histories
      if (
        hours >= 8 &&
        (vehicle.table_name === 'user_parking_history' || vehicle.table_name === 'visitor_parking_history')
      ) {
        if (vehicle.status === 'Parked') {
          const updateQuery = `
            UPDATE ${vehicle.table_name}
            SET status = 'Overparked'
            WHERE id = ? AND timestamp_out IS NULL
          `

          // Execute the update query
          await db.query(updateQuery, [vehicle.history_id])

          // Add a violation for overparking
          const violationNotes =
            'User have parked for 8 hours or more. Violation added for overparking. Thank you for parking with us.'
          await db.query('INSERT INTO violations (user_id, user_history_id, notes, status) VALUES (?, ?, ?, ?)', [
            vehicle.userId,
            vehicle.history_id,
            violationNotes,
            'Unresolved'
          ])

          // Add to notifications about violation
          const [users] = await db.query('SELECT * FROM users WHERE id = ?', [vehicle.userId]);
          const phone_number = users[0].phone_number

          const notifTitle = 'Overparked Violation'

          const notifMessage =
            'You have parked for 8 hours or more. A violation has been added to your account. Thank you for parking with us.'
          await db.query(
            'INSERT INTO notifications (phone_number, title, message, status, sms_status) VALUES (?, ?, ?, ?, ?)',
            [phone_number, notifTitle, notifMessage, 'unread', 'pending']
          )
        }
      } else if (
        hours < 8 &&
        (vehicle.table_name === 'user_parking_history' ||
          vehicle.table_name === 'premium_parking_history' ||
          vehicle.table_name === 'visitor_parking_history')
      ) {
        const updateQuery = `
          UPDATE ${vehicle.table_name}
          SET status = 'Parked'
          WHERE id = ? AND timestamp_out IS NULL
        `

        // Execute the update query
        await db.query(updateQuery, [vehicle.history_id])
      }
    }

    return vehicles
  } catch (error) {
    console.error('Error fetching parked vehicles:', error)

    return []
  }
}

// Function to send logs to all connected WebSocket clients
const sendLogsToClients = async () => {
  try {
    const logs = await fetchLogs();

    // Send the logs to each connected client
    logsWSS.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(logs));
      } else {
        console.log('Skipping closed WebSocket client');
      }
    });
  } catch (error) {
    console.error('Error sending logs to clients:', error);
  }
};

// Handle logs WebSocket connections
logsWSS.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.startsWith('::ffff:') ? req.socket.remoteAddress.slice(7) : req.socket.remoteAddress;
  console.log(`${ip} connected to /logs WebSocket`);
  
  // Set interval for sending logs
  const intervalId = setInterval(async () => {
    try {
      console.log('Sending logs to clients...');
      await sendLogsToClients();
    } catch (error) {
      console.error('Error sending logs:', error);
    }
  }, 5000); // Send logs every 5 seconds

  // Handle close event
  ws.on('close', () => {
    console.log(`${ip} disconnected from /logs WebSocket`);
    clearInterval(intervalId); // Clear the interval when the client disconnects
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clearInterval(intervalId); // Clear the interval on error to prevent resource leak
  });
});

// Function to send logs to all connected WebSocket clients
const sendParkedVehiclestoClients = async () => {
  try {
    const logs = await fetchParkedVehicles();

    // Send the logs to each connected client
    realtimeWSS.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(logs));
      } else {
        console.log('Skipping closed WebSocket client');
      }
    });
  } catch (error) {
    console.error('Error sending logs to clients:', error);
  }
};

// Handle realtime parked vehicles WebSocket connections
realtimeWSS.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.startsWith('::ffff:') ? req.socket.remoteAddress.slice(7) : req.socket.remoteAddress;
  console.log(`${ip} connected to /realtime WebSocket`);
  
  // Set interval for sending logs
  const intervalId = setInterval(async () => {
    try {
      console.log('Sending realtime parked vehicles to clients...');
      await sendParkedVehiclestoClients();
    } catch (error) {
      console.error('Error sending realtime parked vehicles:', error);
    }
  }, 5000); // Send realtime parked vehicles every 5 seconds

  // Handle close event
  ws.on('close', () => {
    console.log(`${ip} disconnected from /realtime WebSocket`);
    clearInterval(intervalId); // Clear the interval when the client disconnects
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clearInterval(intervalId); // Clear the interval on error to prevent resource leak
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
  } else if (pathname === '/logs') {
    logsWSS.handleUpgrade(request, socket, head, (ws) => {
      logsWSS.emit('connection', ws, request);
    });
  } else if (pathname === '/realtime') {
    realtimeWSS.handleUpgrade(request, socket, head, (ws) => {
      realtimeWSS.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
