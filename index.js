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



// Show the current queue state
app.get("/api/debug/queue", (req, res) => {
  res.json({
    queueLength: latestDataQueue.length,
    lastProcessedTimestamp: lastProcessedTimestamp,
    queueContents: latestDataQueue.slice(-5) // show last 5 items
  });
});

// Show historical data structure
app.get("/api/debug/historical", (req, res) => {
  res.json({
    historicalSensorData: Object.keys(historicalSensorData),
    devicesList: devicesList
  });
});

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


// New optimized endpoint for time-series data
app.get("/api/sensor-history", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const gasName = req.query.gasName;
    const timeRange = req.query.range || 'weekly'; // daily, weekly, monthly, yearly
    const limit = parseInt(req.query.limit) || 500; // Default to 500 points
    const continuationToken = req.query.token;

    // Calculate time window based on range
    const now = Date.now();
    let startTime = now;
    switch (timeRange.toLowerCase()) {
      case 'daily': startTime -= 86400000; break;
      case 'weekly': startTime -= 604800000; break;
      case 'monthly': startTime -= 2592000000; break;
      case 'yearly': startTime -= 31536000000; break;
      default: startTime -= 604800000; // Default to weekly
    }

    // Build optimized Cosmos DB query
    const querySpec = {
      query: `
        SELECT TOP @limit c._ts, c.Body 
        FROM c 
        WHERE c._ts >= @startTime
        ${deviceId ? `AND c.Body.ID = @deviceId` : ''}
        ORDER BY c._ts DESC
      `,
      parameters: [
        { name: '@limit', value: limit },
        { name: '@startTime', value: startTime / 1000 },
        ...(deviceId ? [{ name: '@deviceId', value: deviceId }] : [])
      ]
    };

    const options = {
      maxItemCount: limit,
      continuationToken
    };

    const { resources, hasMoreResults } = await container.items
      .query(querySpec, options)
      .fetchNext();

    // Process data efficiently
    const processedData = [];
    const uniqueTimestamps = new Set();

    resources.forEach(item => {
      try {
        const body = decodeBody(item.Body);
        if (!body?.Readings) return;

        const timestamp = item._ts * 1000; // Convert to milliseconds
        if (uniqueTimestamps.has(timestamp)) return; // Deduplicate

        uniqueTimestamps.add(timestamp);

        const readings = body.Readings
          .filter(r => !gasName || r.GasName === gasName)
          .map(r => ({
            timestamp,
            gasName: r.GasName,
            ppm: typeof r.PPM === 'number' ? r.PPM : 0,
            unit: r.Unit || 'ppm'
          }));

        if (readings.length) {
          processedData.push({
            timestamp,
            readings
          });
        }
      } catch (e) {
        console.error('Error processing item:', e);
      }
    });

    res.json({
      data: processedData.sort((a, b) => a.timestamp - b.timestamp), // Ensure chronological order
      hasMore: hasMoreResults,
      continuationToken: options.continuationToken,
      timeRange
    });

  } catch (error) {
    console.error("Error in /api/sensor-history:", error);
    res.status(500).json({ 
      error: "Failed to fetch historical data",
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




// Add this endpoint to your existing code
app.get("/api/latest-data", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    let result = null;

    // 1. First try to get from in-memory queue
    if (latestDataQueue.length > 0) {
      let filteredData = latestDataQueue;
      
      if (deviceId) {
        filteredData = latestDataQueue.filter(
          data => data.body && data.body.ID && data.body.ID.toString() === deviceId
        );
      }

      if (filteredData.length > 0) {
        result = filteredData[filteredData.length - 1];
      }
    }

    // 2. If no data in queue, fetch last available from Cosmos DB
    if (!result) {
      const query = deviceId 
        ? `SELECT TOP 1 * FROM c WHERE c.Body.ID = "${deviceId}" ORDER BY c._ts DESC`
        : `SELECT TOP 1 * FROM c ORDER BY c._ts DESC`;
      
      const { resources } = await container.items.query(query).fetchAll();

      if (resources && resources.length > 0) {
        const latestRecord = resources[0];
        result = {
          id: latestRecord.id,
          timestamp: latestRecord._ts,
          partitionKey: latestRecord.partitionKey,
          body: decodeBody(latestRecord.Body) || {}
        };

        // Update the queue with this fresh data
        latestDataQueue.push(result);
        updateHistoricalData(result);
      }
    }

    // 3. Return whatever we found (could be from queue or DB)
    if (result) {
      return res.json(result);
    }

    // 4. If absolutely no data exists anywhere
    return res.status(200).json({ 
      message: deviceId 
        ? `No data available for device ${deviceId} in queue or database`
        : "No data available in queue or database"
    });

  } catch (error) {
    console.error("❌ Error in /api/latest-data:", error);
    res.status(500).json({ 
      error: "Failed to fetch latest data",
      details: error.message 
    });
  }
});







////////// fetching the hourly , weekly and monthly /////////////////////////////////////



// Helper function to get the earliest timestamp in the database
async function getEarliestTimestamp() {
  try {
    const query = "SELECT TOP 1 c._ts FROM c ORDER BY c._ts ASC";
    const { resources } = await container.items.query(query).fetchAll();
    if (resources && resources.length > 0) {
      return resources[0]._ts * 1000; // Convert to milliseconds
    }
    return Date.now(); // Fallback to current time if no data
  } catch (error) {
    console.error("❌ Error fetching earliest timestamp:", error.message);
    return Date.now();
  }
}

// Endpoint for hourly data (last 24 hours, aggregated by hour)
app.get("/api/hourly-data", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const gasName = req.query.gasName;
    const limit = parseInt(req.query.limit) || 24; // Default to 24 hours
    const continuationToken = req.query.token;

    // Calculate time window (last 24 hours)
    const now = Date.now();
    const startTime = now - 86400000; // 24 hours in milliseconds

    // Build Cosmos DB query
    const querySpec = {
      query: `
        SELECT c._ts, c.Body 
        FROM c 
        WHERE c._ts >= @startTime
        ${deviceId ? `AND c.Body.ID = @deviceId` : ''}
        ORDER BY c._ts DESC
      `,
      parameters: [
        { name: '@startTime', value: startTime / 1000 },
        ...(deviceId ? [{ name: '@deviceId', value: deviceId }] : [])
      ]
    };

    const options = {
      maxItemCount: limit * 100, // Fetch more raw data to aggregate
      continuationToken
    };

    const { resources, hasMoreResults } = await container.items
      .query(querySpec, options)
      .fetchNext();

    // Process and aggregate data by hour
    const hourlyData = {};
    resources.forEach(item => {
      try {
        const body = decodeBody(item.Body);
        if (!body?.Readings) return;

        const timestamp = item._ts * 1000; // Convert to milliseconds
        const date = new Date(timestamp);
        // Round down to the start of the hour
        const hourStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();

        body.Readings
          .filter(r => !gasName || r.GasName === gasName)
          .forEach(r => {
            const ppm = typeof r.PPM === 'number' && isFinite(r.PPM) ? r.PPM : 0;
            if (!hourlyData[hourStart]) {
              hourlyData[hourStart] = {};
            }
            if (!hourlyData[hourStart][r.GasName]) {
              hourlyData[hourStart][r.GasName] = { sum: 0, count: 0, unit: r.Unit || 'ppm' };
            }
            hourlyData[hourStart][r.GasName].sum += ppm;
            hourlyData[hourStart][r.GasName].count += 1;
          });
      } catch (e) {
        console.error('Error processing item:', e);
      }
    });

    // Convert aggregated data to the required format
    const processedData = Object.keys(hourlyData).map(timestamp => {
      const readings = Object.keys(hourlyData[timestamp]).map(gas => ({
        timestamp: parseInt(timestamp),
        gasName: gas,
        ppm: hourlyData[timestamp][gas].sum / hourlyData[timestamp][gas].count,
        unit: hourlyData[timestamp][gas].unit
      }));
      return {
        timestamp: parseInt(timestamp),
        readings
      };
    }).sort((a, b) => a.timestamp - b.timestamp);

    // Apply limit after aggregation
    const limitedData = processedData.slice(0, limit);

    res.json({
      data: limitedData,
      hasMore: hasMoreResults,
      continuationToken: options.continuationToken,
      timeRange: 'hourly'
    });

  } catch (error) {
    console.error("Error in /api/hourly-data:", error);
    res.status(500).json({ 
      error: "Failed to fetch hourly data",
      details: error.message
    });
  }
});

// Endpoint for weekly data (last 30 days, aggregated by day)
app.get("/api/weekly-data", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const gasName = req.query.gasName;
    const limit = parseInt(req.query.limit) || 30; // Default to 30 days
    const continuationToken = req.query.token;

    // Calculate time window (last 30 days)
    const now = Date.now();
    const startTime = now - 2592000000; // 30 days in milliseconds

    // Build Cosmos DB query
    const querySpec = {
      query: `
        SELECT c._ts, c.Body 
        FROM c 
        WHERE c._ts >= @startTime
        ${deviceId ? `AND c.Body.ID = @deviceId` : ''}
        ORDER BY c._ts DESC
      `,
      parameters: [
        { name: '@startTime', value: startTime / 1000 },
        ...(deviceId ? [{ name: '@deviceId', value: deviceId }] : [])
      ]
    };

    const options = {
      maxItemCount: limit * 100, // Fetch more raw data to aggregate
      continuationToken
    };

    const { resources, hasMoreResults } = await container.items
      .query(querySpec, options)
      .fetchNext();

    // Process and aggregate data by day
    const dailyData = {};
    resources.forEach(item => {
      try {
        const body = decodeBody(item.Body);
        if (!body?.Readings) return;

        const timestamp = item._ts * 1000; // Convert to milliseconds
        const date = new Date(timestamp);
        // Round down to the start of the day
        const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

        body.Readings
          .filter(r => !gasName || r.GasName === gasName)
          .forEach(r => {
            const ppm = typeof r.PPM === 'number' && isFinite(r.PPM) ? r.PPM : 0;
            if (!dailyData[dayStart]) {
              dailyData[dayStart] = {};
            }
            if (!dailyData[dayStart][r.GasName]) {
              dailyData[dayStart][r.GasName] = { sum: 0, count: 0, unit: r.Unit || 'ppm' };
            }
            dailyData[dayStart][r.GasName].sum += ppm;
            dailyData[dayStart][r.GasName].count += 1;
          });
      } catch (e) {
        console.error('Error processing item:', e);
      }
    });

    // Convert aggregated data to the required format
    const processedData = Object.keys(dailyData).map(timestamp => {
      const readings = Object.keys(dailyData[timestamp]).map(gas => ({
        timestamp: parseInt(timestamp),
        gasName: gas,
        ppm: dailyData[timestamp][gas].sum / dailyData[timestamp][gas].count,
        unit: dailyData[timestamp][gas].unit
      }));
      return {
        timestamp: parseInt(timestamp),
        readings
      };
    }).sort((a, b) => a.timestamp - b.timestamp);

    // Apply limit after aggregation
    const limitedData = processedData.slice(0, limit);

    res.json({
      data: limitedData,
      hasMore: hasMoreResults,
      continuationToken: options.continuationToken,
      timeRange: 'weekly'
    });

  } catch (error) {
    console.error("Error in /api/weekly-data:", error);
    res.status(500).json({ 
      error: "Failed to fetch weekly data",
      details: error.message
    });
  }
});



//////////////////////////////// updated one with average ////////////
// Endpoint for last minute data (returns only the latest value)


// Endpoint for last minute data (returns average of last 5 points)
app.get("/api/last-minute-data", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const gasName = req.query.gasName;

    // Calculate time window (last 60 seconds)
    const now = Date.now();
    const startTime = now - 60000; // 60 seconds in milliseconds

    // Build Cosmos DB query to get the last 5 documents
    const querySpec = {
      query: `
        SELECT TOP 5 c._ts, c.Body 
        FROM c 
        WHERE c._ts >= @startTime
        ${deviceId ? `AND c.Body.ID = @deviceId` : ''}
        ORDER BY c._ts DESC
      `,
      parameters: [
        { name: '@startTime', value: startTime / 1000 },
        ...(deviceId ? [{ name: '@deviceId', value: deviceId }] : [])
      ]
    };

    const { resources } = await container.items.query(querySpec).fetchAll();

    if (resources.length === 0) {
      return res.status(404).json({ message: "No recent data found" });
    }

    // Process all data points to calculate averages
    const readingsMap = new Map();

    resources.forEach(item => {
      try {
        const body = decodeBody(item.Body);
        if (!body?.Readings) return;

        body.Readings.forEach(reading => {
          if (gasName && reading.GasName !== gasName) return;

          if (!readingsMap.has(reading.GasName)) {
            readingsMap.set(reading.GasName, {
              sum: 0,
              count: 0,
              unit: reading.Unit || 'ppm',
              timestamps: []
            });
          }

          const gasData = readingsMap.get(reading.GasName);
          if (typeof reading.PPM === 'number' && isFinite(reading.PPM)) {
            gasData.sum += reading.PPM;
            gasData.count++;
            gasData.timestamps.push(new Date(item._ts * 1000).toISOString());
          }
        });
      } catch (e) {
        console.error('Error processing item:', e);
      }
    });

    // Calculate averages and prepare response
    const averagedReadings = [];
    readingsMap.forEach((data, name) => {
      const averagePPM = data.count > 0 ? data.sum / data.count : 0;
      averagedReadings.push({
        GasName: name,
        PPM: Math.round(averagePPM * 100) / 100, // Round to 2 decimal places
        Unit: data.unit,
        timestamp: data.timestamps[0] || null
      });
    });

    if (averagedReadings.length === 0) {
      return res.status(404).json({ 
        message: gasName 
          ? `No readings found for gas ${gasName}` 
          : "No valid readings found"
      });
    }

    // Get the latest document as the base for the response
    const latestItem = resources[0];
    const latestBody = decodeBody(latestItem.Body);

    const response = {
      id: latestItem.id || "unknown",
      timestamp: latestItem._ts,
      body: {
        msgCount: latestBody.msgCount || resources.length,
        ID: latestBody.ID || (deviceId ? parseInt(deviceId) : 0),
        Type: latestBody.Type || 0,
        Readings: averagedReadings
      }
    };

    res.json(response);

  } catch (error) {
    console.error("Error fetching last minute data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});






















// Endpoint for last minute data (last 60 seconds, no aggregation)
app.get("/api/last-minute-dataaaa", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const gasName = req.query.gasName;
    const limit = parseInt(req.query.limit) || 60; // Default to 60 data points (1 per second)
    const continuationToken = req.query.token;

    // Calculate time window (last 60 seconds)
    const now = Date.now();
    const startTime = now - 60000; // 60 seconds in milliseconds

    // Build Cosmos DB query
    const querySpec = {
      query: `
        SELECT c._ts, c.Body 
        FROM c 
        WHERE c._ts >= @startTime
        ${deviceId ? `AND c.Body.ID = @deviceId` : ''}
        ORDER BY c._ts DESC
      `,
      parameters: [
        { name: '@startTime', value: startTime / 1000 },
        ...(deviceId ? [{ name: '@deviceId', value: deviceId }] : [])
      ]
    };

    const options = {
      maxItemCount: limit,
      continuationToken
    };

    const { resources, hasMoreResults } = await container.items
      .query(querySpec, options)
      .fetchNext();

    // Process data without aggregation (return raw data points)
    const processedData = [];
    resources.forEach(item => {
      try {
        const body = decodeBody(item.Body);
        if (!body?.Readings) return;

        const timestamp = item._ts * 1000; // Convert to milliseconds

        const readings = body.Readings
          .filter(r => !gasName || r.GasName === gasName)
          .map(r => ({
            timestamp,
            gasName: r.GasName,
            ppm: typeof r.PPM === 'number' && isFinite(r.PPM) ? r.PPM : 0,
            unit: r.Unit || 'ppm'
          }));

        if (readings.length) {
          processedData.push({
            timestamp,
            readings
          });
        }
      } catch (e) {
        console.error('Error processing item:', e);
      }
    });

    // Sort by timestamp (ascending)
    const sortedData = processedData.sort((a, b) => a.timestamp - b.timestamp);

    // Apply limit
    const limitedData = sortedData.slice(0, limit);

    res.json({
      data: limitedData,
      hasMore: hasMoreResults,
      continuationToken: options.continuationToken,
      timeRange: 'last-minute'
    });

  } catch (error) {
    console.error("Error in /api/last-minute-data:", error);
    res.status(500).json({ 
      error: "Failed to fetch last minute data",
      details: error.message
    });
  }
});


// Endpoint for last hour data (last 60 minutes, no aggregation)
app.get("/api/last-hour-data", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const gasName = req.query.gasName;

    // Calculate time window (last 60 minutes)
    const now = Date.now();
    const startTime = now - 3600000; // 60 minutes in milliseconds

    // Build Cosmos DB query
    const querySpec = {
      query: `
        SELECT c._ts, c.Body 
        FROM c 
        WHERE c._ts >= @startTime
        ${deviceId ? `AND c.Body.ID = @deviceId` : ''}
        ORDER BY c._ts DESC
      `,
      parameters: [
        { name: '@startTime', value: startTime / 1000 },
        ...(deviceId ? [{ name: '@deviceId', value: deviceId }] : [])
      ]
    };

    const { resources } = await container.items
      .query(querySpec)
      .fetchAll(); // <-- fetch everything at once, no pagination

    // Process data without aggregation (return raw data points)
    const processedData = [];
    resources.forEach(item => {
      try {
        const body = decodeBody(item.Body);
        if (!body?.Readings) return;

        const timestamp = item._ts * 1000; // Convert to milliseconds

        const readings = body.Readings
          .filter(r => !gasName || r.GasName === gasName)
          .map(r => ({
            timestamp,
            gasName: r.GasName,
            ppm: typeof r.PPM === 'number' && isFinite(r.PPM) ? r.PPM : 0,
            unit: r.Unit || 'ppm'
          }));

        if (readings.length) {
          processedData.push({
            timestamp,
            readings
          });
        }
      } catch (e) {
        console.error('Error processing item:', e);
      }
    });

    // Sort by timestamp (ascending)
    const sortedData = processedData.sort((a, b) => a.timestamp - b.timestamp);

    res.json({
      data: sortedData,
      timeRange: 'last-hour'
    });

  } catch (error) {
    console.error("Error in /api/last-hour-data:", error);
    res.status(500).json({ 
      error: "Failed to fetch last hour data",
      details: error.message
    });
  }
});




// Add this endpoint to your existing code
// app.get("/api/latest-data", async (req, res) => {
//   try {
//     const deviceId = req.query.deviceId;
//     let result = null;

//     // 1. First try to get from in-memory queue
//     if (latestDataQueue.length > 0) {
//       let filteredData = latestDataQueue;
      
//       if (deviceId) {
//         filteredData = latestDataQueue.filter(
//           data => data.body && data.body.ID && data.body.ID.toString() === deviceId
//         );
//       }

//       if (filteredData.length > 0) {
//         result = filteredData[filteredData.length - 1];
//       }
//     }

//     // 2. If no data in queue, fetch last available from Cosmos DB
//     if (!result) {
//       const query = deviceId 
//         ? `SELECT TOP 1 * FROM c WHERE c.Body.ID = "${deviceId}" ORDER BY c._ts DESC`
//         : `SELECT TOP 1 * FROM c ORDER BY c._ts DESC`;
      
//       const { resources } = await container.items.query(query).fetchAll();

//       if (resources && resources.length > 0) {
//         const latestRecord = resources[0];
//         result = {
//           id: latestRecord.id,
//           timestamp: latestRecord._ts,
//           partitionKey: latestRecord.partitionKey,
//           body: decodeBody(latestRecord.Body) || {}
//         };

//         // Update the queue with this fresh data
//         latestDataQueue.push(result);
//         updateHistoricalData(result);
//       }
//     }

//     // 3. Return whatever we found (could be from queue or DB)
//     if (result) {
//       return res.json(result);
//     }

//     // 4. If absolutely no data exists anywhere
//     return res.status(200).json({ 
//       message: deviceId 
//         ? `No data available for device ${deviceId} in queue or database`
//         : "No data available in queue or database"
//     });

//   } catch (error) {
//     console.error("❌ Error in /api/latest-data:", error);
//     res.status(500).json({ 
//       error: "Failed to fetch latest data",
//       details: error.message 
//     });
//   }
// });






/// applying different changes for Open House
// Health check endpoint to verify API is running
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "API is running correctly",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/latest-data", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;

    // Validate deviceId if provided
    if (deviceId && !/^[a-zA-Z0-9-_]+$/.test(deviceId)) {
      return res.status(400).json({
        status: "ERROR",
        error: "Invalid deviceId format",
      });
    }

    // Query Cosmos DB for the 500th record from the last
    const querySpec = {
      query: deviceId
        ? "SELECT * FROM c WHERE c.Body.ID = @deviceId ORDER BY c._ts DESC OFFSET 499 LIMIT 1"
        : "SELECT * FROM c ORDER BY c._ts DESC OFFSET 499 LIMIT 1",
      parameters: deviceId ? [{ name: "@deviceId", value: deviceId }] : [],
    };

    console.log(`Executing query for ${deviceId ? `deviceId: ${deviceId}` : "all devices"} to fetch 500th record from the last`);

    const { resources } = await container.items.query(querySpec).fetchAll();

    let result = null;
    if (resources && resources.length > 0) {
      const targetRecord = resources[0];
      result = {
        id: targetRecord.id,
        timestamp: targetRecord._ts,
        partitionKey: targetRecord.partitionKey,
        body: decodeBody(targetRecord.Body) || {},
      };

      // Update the in-memory queue (optional, as a cache)
      latestDataQueue = latestDataQueue.filter(
        (data) => data.body && data.body.ID && data.body.ID.toString() !== deviceId
      ); // Remove old data for this device
      latestDataQueue.push(result); // Add new data

      // Limit queue size to prevent memory issues
      const MAX_QUEUE_SIZE = 100;
      if (latestDataQueue.length > MAX_QUEUE_SIZE) {
        latestDataQueue.shift();
      }

      // Update historical data (assuming this function exists)
      updateHistoricalData(result);

      console.log(`Successfully fetched 500th record for ${deviceId ? `deviceId: ${deviceId}` : "all devices"}`);

      // Return the result with status message
      return res.json({
        status: "SUCCESS",
        message: `Fetched 500th record from the last${deviceId ? ` for device ${deviceId}` : ""}`,
        data: result,
      });
    }

    console.log(`No data found at 500th position for ${deviceId ? `deviceId: ${deviceId}` : "all devices"}`);

    // Return no-data message with status
    return res.status(200).json({
      status: "NO_DATA",
      message: deviceId
        ? `No data available for device ${deviceId} at the 500th position from the last`
        : "No data available at the 500th position from the last in database",
    });

  } catch (error) {
    console.error("❌ Error in /api/latest-data:", error);
    return res.status(500).json({
      status: "ERROR",
      error: "Failed to fetch data at 500th position from the last",
      details: error.message,
    });
  }
});