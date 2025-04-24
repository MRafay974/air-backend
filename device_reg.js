//---------------API for register a device ---------------------//

// Add your IoT Hub connection string here
// const CONNECTION_STRING = 'HostName=AQI.azure-devices.net;SharedAccessKeyName=iothubowner;SharedAccessKey=QNXRhDNCjJ6/kAnGlIQL1hFHNLent5LQ9AIoTLngzo0=';
// const registryClient = Registry.fromConnectionString(CONNECTION_STRING);

// // Route to register a new device
// app.post("/api/register-device", async (req, res) => {
//     console.log("Received Request Body:", req.body); // Log the body

//     const { deviceId, deviceName } = req.body;

//     if (!deviceId || !deviceName) {
//         return res.status(400).json({ message: "deviceId and deviceName are required" });
//     }

//     try {
//         // Create the device in the IoT Hub
//         const deviceParams = {
//             deviceId,
//             status: 'enabled',  // Device status: enabled or disabled
//             deviceName,         // Optional: Name of the device
//         };

//         // Using 'create' method from the Registry client
//         const device = await registryClient.create(deviceParams); // No need for deviceId as the first argument
        
//         // Respond with success message
//         res.status(200).json({ message: 'Device registered successfully', deviceId });
//     } catch (error) {
//         console.error('Error registering device:', error.message);
//         res.status(500).json({ message: 'Error registering device', error: error.message });
//     }
// });
