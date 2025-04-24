require("dotenv").config();
const { CosmosClient } = require("@azure/cosmos");

// Load connection details from .env
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = process.env.DATABASE_ID;
const containerId = process.env.CONTAINER_ID;

const client = new CosmosClient({ endpoint, key });

async function testConnection() {
    try {
        const { database } = await client.databases.createIfNotExists({ id: databaseId });
        const { container } = await database.containers.createIfNotExists({ id: containerId });

        console.log("✅ Connected to Azure Cosmos DB (NoSQL API)");
    } catch (error) {
        console.error("❌ Connection error:", error.message);
    }
}

testConnection();
