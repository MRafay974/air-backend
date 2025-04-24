const express = require("express");
const { CosmosClient } = require("@azure/cosmos");

const router = express.Router();
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = process.env.DATABASE_ID;
const containerId = process.env.CONTAINER_ID;

const client = new CosmosClient({ endpoint, key });
const database = client.database(databaseId);
const container = database.container(containerId);

// Add a new user
router.post("/users", async (req, res) => {
  const { username, email, password, gender, phoneNumber, deviceId } = req.body;

  if (!username || !email || !password || !gender) {
    return res.status(400).json({ error: "Username, email, password, and gender are required" });
  }

  // Validate phone number if provided
  if (phoneNumber) {
    const phoneRegex = /^\+?\d{10,15}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ error: "Invalid phone number. Use 10-15 digits, optionally starting with +." });
    }
  }

  try {
    // Check if email is already used
    const { resources: existingUsers } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.email = @email",
        parameters: [{ name: "@email", value: email }],
      })
      .fetchAll();
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: "Email is already registered" });
    }

    // Check if deviceId is already assigned
    if (deviceId) {
      const { resources: usersWithDevice } = await container.items
        .query({
          query: "SELECT * FROM c WHERE c.deviceId = @deviceId",
          parameters: [{ name: "@deviceId", value: deviceId }],
        })
        .fetchAll();
      if (usersWithDevice.length > 0) {
        return res.status(400).json({ error: "This Device ID is already assigned to another user" });
      }
    }

    const newUser = {
      id: email,
      type: "user",
      username,
      email,
      password, // Note: In production, hash the password
      gender,
      phoneNumber: phoneNumber || null,
      deviceId: deviceId || null,
      createdAt: new Date().toISOString(),
    };

    const { resource: createdUser } = await container.items.create(newUser);
    res.status(201).json(createdUser);
  } catch (error) {
    console.error("❌ Error adding user:", error.message, error.stack);
    res.status(500).json({ error: "Failed to add user" });
  }
});

// Fetch all users
router.get("/users", async (req, res) => {
  try {
    const querySpec = {
      query: "SELECT * FROM c WHERE c.type = 'user'",
    };

    const { resources: users } = await container.items.query(querySpec).fetchAll();

    if (!users || users.length === 0) {
      return res.status(404).json({ message: "No users found" });
    }

    res.json(users);
  } catch (error) {
    console.error("❌ Error fetching users:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Delete a user
router.delete("/users/:email", async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    const { resources: users } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.email = @email",
        parameters: [{ name: "@email", value: email }],
      })
      .fetchAll();

    if (!users || users.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const userToDelete = users[0];
    await container.item(userToDelete.id).delete();
    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("Error deleting user:", error.message, error.stack);
    res.status(500).json({ message: "Failed to delete user", details: error.message });
  }
});

module.exports = router;