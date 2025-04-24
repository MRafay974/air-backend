require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { CosmosClient } = require("@azure/cosmos");
const userManagement = require("./userManagement");

// Load connection details from .env
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = process.env.DATABASE_ID;
const containerId = process.env.CONTAINER_ID;

// Verify Environment Variables
if (!endpoint || !key || !databaseId || !containerId) {
  console.error("❌ Missing environment variables. Check your .env file.");
  process.exit(1);
}

const client = new CosmosClient({ endpoint, key });
const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage for historical data (1 hour)
const historicalSensorData = {}; // Format: { sensorName: [{timestamp, ppm, deviceId}, ...], ... }
// In-memory storage for devices
const devicesList = {}; // Format: { deviceId: { id, status, timestamp }, ... }
let latestDataQueue = []; // Format: [{ id, timestamp, partitionKey, body: { ID, Readings } }, ...]
let lastProcessedTimestamp = 0;
const database = client.database(databaseId);
const container = database.container(containerId);

// Time window for considering a device active (30 seconds)
const ACTIVE_TIME_WINDOW = 30000; // 30 seconds in milliseconds

// Function to initialize the lastProcessedTimestamp from the most recent record
async function initializeLastProcessedTimestamp() {
  try {
    console.log("🔄 Initializing from most recent record...");
    const query = "SELECT TOP 1 c._ts FROM c ORDER BY c._ts DESC";
    const { resources } = await container.items.query(query).fetchAll();
    
    if (resources && resources.length > 0) {
      lastProcessedTimestamp = resources[0]._ts;
      console.log(`✅ Starting from last timestamp: ${lastProcessedTimestamp}`);
    } else {
      console.log("⚠️ No existing records found, starting from timestamp 0");
    }
  } catch (error) {
    console.error("❌ Error initializing timestamp:", error.message);
  }
}

// Function to fetch only new values from Cosmos DB in arrival order (FIFO)
async function getNewData() {
  try {
    const MAX_RECORDS = 1000; // Increase to ensure we get enough data for 1 hour
    const query = `SELECT * FROM c WHERE c._ts > ${lastProcessedTimestamp} ORDER BY c._ts ASC OFFSET 0 LIMIT ${MAX_RECORDS}`;
    
    const startTime = Date.now();
    console.log(`🔍 Fetching new data since timestamp ${lastProcessedTimestamp}...`);
    
    const { resources } = await container.items.query(query).fetchAll();
    
    const fetchTime = Date.now() - startTime;

    if (!resources || resources.length === 0) {
      console.warn("⚠️ No new data available in Cosmos DB.");
      return [];
    }

    console.log(`✅ Fetched ${resources.length} new records from Cosmos DB in ${fetchTime}ms.`);

    lastProcessedTimestamp = resources[resources.length - 1]._ts;

    return resources.map(item => {
      try {
        return {
          id: item.id,
          timestamp: item._ts,
          partitionKey: item.partitionKey,
          body: decodeBody(item.Body) || {},
        };
      } catch (error) {
        console.error(`❌ Error processing item ${item.id}:`, error.message);
        return null;
      }
    }).filter(item => item !== null);
  } catch (error) {
    console.error("❌ Error fetching new data:", error.message);
    return [];
  }
}

// Decode base64-encoded JSON Body with special value handling
function decodeBody(encodedBody) {
  try {
    const decodedString = Buffer.from(encodedBody, "base64").toString("utf-8");
    
    const sanitizedString = decodedString
      .replace(/"PPM"\s*:\s*inf/g, '"PPM": "Infinity"')
      .replace(/"PPM"\s*:\s*-inf/g, '"PPM": "-Infinity"')
      .replace(/"PPM"\s*:\s*nan/g, '"PPM": "NaN"');
    
    const parsed = JSON.parse(sanitizedString);
    
    if (parsed.Readings && Array.isArray(parsed.Readings)) {
      parsed.Readings.forEach(reading => {
        if (reading.PPM === "Infinity") reading.PPM = Infinity;
        else if (reading.PPM === "-Infinity") reading.PPM = -Infinity;
        else if (reading.PPM === "NaN") reading.PPM = NaN;
      });
    }
    
    return parsed;
  } catch (error) {
    console.error("❌ Error decoding body:", error.message);
    console.error("Problematic content:", Buffer.from(encodedBody, "base64").toString("utf-8").substring(0, 200) + "...");
    return null;
  }
}

// Function to normalize gas names to match frontend expectations
const normalizeGasName = (gasName) => {
  const upperGasName = (gasName || "").toUpperCase();

  const gasNameMap = {
    "Dust Concentrati": "DUST CONCENTRATION",
    "Alcohol": "ALCOHOL",
  };
  return gasNameMap[gasName] || gasName;
};

// Function to update the historical data and devices list
function updateHistoricalData(newData) {
  try {
    if (!newData?.body?.Readings) {
      console.warn("⚠️ Skipping update - No readings found in data:", newData);
      return;
    }

    const timestamp = Date.now();
    const deviceId = newData.body.ID.toString();

    devicesList[deviceId] = {
      id: deviceId,
      status: "active",
      timestamp: new Date(timestamp).toISOString(),
      lastActive: timestamp,
    };

    newData.body.Readings.forEach(reading => {
      const { GasName, PPM } = reading;
      
      const normalizedGasName = normalizeGasName(GasName);
      
      if (!normalizedGasName) {
        console.warn("⚠️ Skipping reading with missing GasName:", reading);
        return;
      }

      // Ensure reading has a timestamp
      reading.timestamp = reading.timestamp || new Date(timestamp).toISOString();

      if (!historicalSensorData[normalizedGasName]) {
        historicalSensorData[normalizedGasName] = [];
      }

      let sanitizedPPM = 0;
      if (typeof PPM === "number" && isFinite(PPM)) {
        sanitizedPPM = PPM;
      } else {
        console.warn(`⚠️ Replacing non-finite PPM value (${PPM}) with 0 for sensor ${normalizedGasName}`);
      }

      historicalSensorData[normalizedGasName].push({
        timestamp,
        ppm: sanitizedPPM,
        deviceId,
      });

      const ONE_HOUR_AGO = timestamp - 3600000;
      historicalSensorData[normalizedGasName] = historicalSensorData[normalizedGasName].filter(
        point => point.timestamp >= ONE_HOUR_AGO
      );
    });

    // Update the data in latestDataQueue to include timestamps
    latestDataQueue = latestDataQueue.map(item => {
      if (item.body.ID === deviceId) {
        item.body.Readings = item.body.Readings.map(reading => ({
          ...reading,
          timestamp: reading.timestamp || new Date(timestamp).toISOString(),
        }));
      }
      return item;
    });
  } catch (error) {
    console.error("❌ Error updating historical data or devices list:", error);
    console.error("Problematic data:", JSON.stringify(newData).substring(0, 200) + "...");
  }
}
// Function to update device statuses based on the last active time
function updateDeviceStatuses() {
  const currentTime = Date.now();
  Object.keys(devicesList).forEach(deviceId => {
    const lastActive = devicesList[deviceId].lastActive || 0;
    devicesList[deviceId].status =
      currentTime - lastActive <= ACTIVE_TIME_WINDOW ? "active" : "inactive";
  });
}

app.get("/api/all-data", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const continuationToken = req.query.token;
    
    const options = {
      maxItemCount: limit,
      continuationToken: continuationToken
    };
    
    const query = "SELECT c.id, c._ts, c.partitionKey, c.Body FROM c";
    const response = await container.items.query(query, options).fetchNext();
    
    // Process each item to decode the Body
    const decodedItems = response.resources.map(item => {
      try {
        return {
          id: item.id,
          timestamp: item._ts,
          partitionKey: item.partitionKey,
          decodedBody: decodeBody(item.Body) // Using your existing decodeBody function
        };
      } catch (decodeError) {
        console.error(`Failed to decode item ${item.id}:`, decodeError);
        return {
          id: item.id,
          error: "Failed to decode body",
          rawBody: item.Body // Include the raw body for debugging
        };
      }
    });

    res.json({
      items: decodedItems,
      continuationToken: response.continuationToken,
      hasMore: !!response.continuationToken
    });
    
  } catch (error) {
    console.error("Error in /api/all-data:", error);
    res.status(500).json({ 
      error: "Failed to fetch data",
      details: error.message
    });
  }
});


app.get("/test", async (req, res) => {
  try {
    const { resources } = await container.items.query("SELECT TOP 1 * FROM c").fetchAll();
    res.json(resources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/ping",(req,res)=>{
  res.json("Hello World");
})
// API Route: Serve the latest available data from queue, filter by deviceId if provided
app.get("/api/data", (req, res) => {
  try {
    const deviceId = req.query.deviceId;

    if (latestDataQueue.length === 0) {
      return res.status(200).json({ message: "No new data available yet" });
    }

    let filteredData = latestDataQueue;
    if (deviceId) {
      filteredData = latestDataQueue.filter(data => data.body && data.body.ID && data.body.ID.toString() === deviceId);
    }

    if (filteredData.length === 0) {
      return res.status(200).json({ message: `No new data available for device ${deviceId}` });
    }

    const latestData = filteredData[filteredData.length - 1];
    res.json(latestData);
  } catch (error) {
    console.error("❌ API Error:", error.message);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// API Route: Serve historical data for the last hour, filter by deviceId if provided
app.get("/api/historical-data", (req, res) => {
  try {
    const sensorName = req.query.sensor;
    const deviceId = req.query.deviceId;
    const MAX_POINTS = 720; // Enough points for 1 hour at 5-second intervals (3600 / 5 = 720)
    const ONE_HOUR_MS = 3600000; // 1 hour in milliseconds

    if (sensorName) {
      if (!historicalSensorData[sensorName]) {
        return res.status(404).json({ message: `No historical data for sensor ${sensorName}` });
      }

      let filteredData = historicalSensorData[sensorName];
      if (deviceId) {
        filteredData = filteredData.filter(data => data.deviceId === deviceId);
      }

      if (filteredData.length === 0) {
        return res.status(404).json({ message: `No historical data for sensor ${sensorName} with deviceId ${deviceId}` });
      }

      const now = Date.now();
      let recentData = filteredData.filter(data => now - data.timestamp <= ONE_HOUR_MS);

      recentData = recentData
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_POINTS);

      const formattedData = recentData.map(data => ({
        timestamp: new Date(data.timestamp).toISOString(),
        ppm: data.ppm
      }));

      return res.json({
        sensor: sensorName,
        data: formattedData,
      });
    }

    const filteredHistoricalData = {};
    Object.keys(historicalSensorData).forEach(sensorName => {
      let sensorData = historicalSensorData[sensorName];
      if (deviceId) {
        sensorData = sensorData.filter(data => data.deviceId === deviceId);
      }

      if (sensorData.length === 0) {
        filteredHistoricalData[sensorName] = [];
        return;
      }

      const now = Date.now();
      let recentData = sensorData.filter(data => now - data.timestamp <= ONE_HOUR_MS);

      recentData = recentData
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_POINTS);

      filteredHistoricalData[sensorName] = recentData.map(data => ({
        timestamp: new Date(data.timestamp).toISOString(),
        ppm: data.ppm
      }));
    });

    res.json(filteredHistoricalData);
  } catch (error) {
    console.error("❌ API Error:", error.message);
    res.status(500).json({ error: "Failed to fetch historical data" });
  }
});

// Updated API Route: Serve only ACTIVE devices 
app.get("/api/devices", async (req, res) => {
  try {
    console.log("Fetching devices...");
    updateDeviceStatuses();
    
    const deviceId = req.query.deviceId;

    if (deviceId) {
      if (!devicesList[deviceId]) {
        return res.status(404).json({ message: `Device with ID ${deviceId} not found` });
      }

      console.log(`Device with ID ${deviceId} fetched:`, devicesList[deviceId]);
      res.json(devicesList[deviceId]);
    } else {
      const deviceArray = Object.values(devicesList).filter(device => device.status === "active");
      console.log(`Fetched ${deviceArray.length} active devices:`, deviceArray);

      if (deviceArray.length === 0) {
        return res.status(200).json([]);
      }

      res.json(deviceArray);
    }
  } catch (error) {
    console.error("Error fetching devices:", error.message);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

app.use("/api", userManagement);

// Start Express Server
const PORT = 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  
  await initializeLastProcessedTimestamp();
  
  setInterval(async () => {
    try {
      const newData = await getNewData();
      if (newData.length > 0) {
        latestDataQueue.push(...newData);
        newData.forEach(data => updateHistoricalData(data));
        updateDeviceStatuses();
        console.log("📡 New data added to queue:", newData);
        console.log("Updated devices list:", devicesList);
      }
    } catch (error) {
      console.error("❌ Error processing new data:", error);
    }
  }, 5000);
});