//function to add user in database 
async function addUser(user) {
    const database = client.database(databaseId);
    const container = database.container(containerId);
  
    // Generate unique user ID (or use a UUID library if you want)
    const userId = `user-${Date.now()}`;
  
    // Create user item to be stored in Cosmos DB
    const userItem = {
      id: userId,
      username: user.username,
      email: user.email,
      password: user.password, // Make sure to hash password in production
      partitionKey: "user", // Define partitionKey (it can be dynamic)
    };
  
    try {
      const { resource } = await container.items.create(userItem);
      return resource; // return the saved user
    } catch (error) {
      console.error("Error saving user:", error.message);
      throw new Error("Failed to register user");
    }
  }


  //------------------------now API for users----------------//
// API Route: Register User
// app.post("/api/register", async (req, res) => {
//     const { username, email, password } = req.body;
  
//     // Validation
//     if (!username || !email || !password) {
//       return res.status(400).json({ error: "All fields are required" });
//     }
  
//     try {
//       const newUser = await addUser(req.body);
//       res.status(201).json({ message: "User registered successfully", user: newUser });
//     } catch (error) {
//       res.status(500).json({ error: error.message });
//     }
//   });
