require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 4000;

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// encode DB_PASS for special characters
const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(
  process.env.DB_PASS,
)}@cluster0.fnf7a.mongodb.net/parcelDB?retryWrites=true&w=majority&authSource=admin&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("parcelDB");
    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking");
    const ridersCollection = db.collection("riders");

    // =========================
    // CUSTOM MIDDLEWARES
    // =========================
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      const token = authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // optional admin middleware
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded?.email;

        if (!email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user || user.role !== "admin") {
          return res.status(403).send({ message: "Admin only access" });
        }

        next();
      } catch (error) {
        res.status(500).send({ message: "Failed to verify admin" });
      }
    };

    // =========================
    // USERS
    // =========================
    app.post("/users", async (req, res) => {
      try {
        const email = req.body.email;
        const userExists = await usersCollection.findOne({ email });

        if (userExists) {
          return res
            .status(200)
            .send({ message: "User already exists", inserted: false });
        }

        const user = {
          ...req.body,
          role: req.body.role || "user",
          created_at: req.body.created_at || new Date().toISOString(),
        };

        const result = await usersCollection.insertOne(user);
        res.send(result);
      } catch (error) {
        console.error("Error saving user:", error);
        res.status(500).send({ message: "Failed to save user" });
      }
    });

    // get user role
    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const user = await usersCollection.findOne({ email });

        res.send({
          email,
          role: user?.role || "user",
        });
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).send({ message: "Failed to get user role" });
      }
    });

    // =========================
    // RIDERS
    // =========================
    app.post("/riders", async (req, res) => {
      try {
        const riderData = req.body;

        const result = await ridersCollection.insertOne({
          ...riderData,
          status: riderData.status || "pending",
          created_at: riderData.created_at || new Date().toISOString(),
        });

        res.status(201).send(result);
      } catch (error) {
        console.error("Error saving rider application:", error);
        res.status(500).send({ message: "Failed to save rider application" });
      }
    });

    // GET all riders OR filter by status OR search by name
    // examples:
    // /riders
    // /riders?status=pending
    // /riders?status=active
    // /riders?status=deactivated
    // /riders?search=rahim
    // /riders?status=active&search=rahim
    app.get("/riders", async (req, res) => {
      try {
        const { status, search } = req.query;
        const query = {};

        if (status) {
          query.status = status;
        }

        if (search) {
          query.name = { $regex: search, $options: "i" };
        }

        const riders = await ridersCollection
          .find(query)
          .sort({ created_at: -1 })
          .toArray();

        res.send(riders);
      } catch (error) {
        console.error("Error fetching riders:", error);
        res.status(500).send({ message: "Failed to fetch riders" });
      }
    });

    // GET pending riders
    app.get("/riders/pending", async (req, res) => {
      try {
        const riders = await ridersCollection
          .find({ status: "pending" })
          .sort({ created_at: -1 })
          .toArray();

        res.send(riders);
      } catch (error) {
        console.error("Error fetching pending riders:", error);
        res.status(500).send({ message: "Failed to fetch pending riders" });
      }
    });

    // GET active riders with optional search by name
    // /riders/active
    // /riders/active?search=ra
    app.get("/riders/active", async (req, res) => {
      try {
        const { search } = req.query;

        const query = { status: "active" };

        if (search) {
          query.name = { $regex: search, $options: "i" };
        }

        const riders = await ridersCollection
          .find(query)
          .sort({ created_at: -1 })
          .toArray();

        res.send(riders);
      } catch (error) {
        console.error("Error fetching active riders:", error);
        res.status(500).send({ message: "Failed to fetch active riders" });
      }
    });

    // GET deactivated riders
    app.get("/riders/deactivated", async (req, res) => {
      try {
        const { search } = req.query;

        const query = { status: "deactivated" };

        if (search) {
          query.name = { $regex: search, $options: "i" };
        }

        const riders = await ridersCollection
          .find(query)
          .sort({ created_at: -1 })
          .toArray();

        res.send(riders);
      } catch (error) {
        console.error("Error fetching deactivated riders:", error);
        res.status(500).send({ message: "Failed to fetch deactivated riders" });
      }
    });

    // GET single rider by id
    app.get("/riders/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider id" });
        }

        const rider = await ridersCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!rider) {
          return res.status(404).send({ message: "Rider not found" });
        }

        res.send(rider);
      } catch (error) {
        console.error("Error fetching rider:", error);
        res.status(500).send({ message: "Failed to fetch rider" });
      }
    });

    // UPDATE rider status
    app.patch("/riders/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider id" });
        }

        if (!status) {
          return res.status(400).send({ message: "status is required" });
        }

        const allowedStatuses = [
          "pending",
          "active",
          "cancelled",
          "deactivated",
        ];

        if (!allowedStatuses.includes(status)) {
          return res.status(400).send({ message: "Invalid status value" });
        }

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status,
              updated_at: new Date().toISOString(),
            },
          },
        );

        res.send(result);
      } catch (error) {
        console.error("Error updating rider:", error);
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    // DEACTIVATE rider
    app.patch("/riders/deactivate/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider id" });
        }

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "deactivated",
              updated_at: new Date().toISOString(),
            },
          },
        );

        res.send({
          success: result.modifiedCount > 0,
          modifiedCount: result.modifiedCount,
          matchedCount: result.matchedCount,
          message:
            result.modifiedCount > 0
              ? "Rider deactivated successfully"
              : "No rider was updated",
        });
      } catch (error) {
        console.error("Error deactivating rider:", error);
        res.status(500).send({ message: "Failed to deactivate rider" });
      }
    });

    // ACTIVATE rider again
    app.patch("/riders/activate/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider id" });
        }

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "active",
              updated_at: new Date().toISOString(),
            },
          },
        );

        res.send({
          success: result.modifiedCount > 0,
          modifiedCount: result.modifiedCount,
          matchedCount: result.matchedCount,
          message:
            result.modifiedCount > 0
              ? "Rider activated successfully"
              : "No rider was updated",
        });
      } catch (error) {
        console.error("Error activating rider:", error);
        res.status(500).send({ message: "Failed to activate rider" });
      }
    });

    // DELETE rider
    app.delete("/riders/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider id" });
        }

        const result = await ridersCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Error deleting rider:", error);
        res.status(500).send({ message: "Failed to delete rider" });
      }
    });

    // =========================
    // PARCELS
    // =========================
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;

        if (userEmail && req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const query = userEmail ? { created_by: String(userEmail) } : {};

        const parcels = await parcelCollection
          .find(query)
          .sort({ creation_date: -1 })
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel id" });
        }

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel by id:", error);
        res.status(500).send({ message: "Failed to get parcel" });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error adding parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel id" });
        }

        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // =========================
    // TRACKING
    // =========================
    app.post("/tracking", async (req, res) => {
      try {
        const {
          tracking_id,
          parcel_id,
          status,
          message = "",
          location = "",
          updated_by = "",
        } = req.body;

        if (!tracking_id || typeof tracking_id !== "string") {
          return res.status(400).send({ message: "tracking_id is required" });
        }

        if (!status || typeof status !== "string") {
          return res.status(400).send({ message: "status is required" });
        }

        const doc = {
          tracking_id: tracking_id.trim(),
          parcel_id:
            parcel_id && ObjectId.isValid(parcel_id)
              ? new ObjectId(parcel_id)
              : null,
          status: status.trim(),
          message,
          location,
          updated_by,
          time: new Date(),
        };

        const result = await trackingCollection.insertOne(doc);

        if (doc.parcel_id) {
          await parcelCollection.updateOne(
            { _id: doc.parcel_id },
            {
              $set: {
                delivery_status: doc.status,
                updatedAt: new Date(),
              },
            },
          );
        }

        res.status(201).send({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error inserting tracking:", error);
        res.status(500).send({ message: "Failed to insert tracking update" });
      }
    });

    app.get("/tracking/:trackingId", async (req, res) => {
      try {
        const { trackingId } = req.params;

        if (!trackingId) {
          return res.status(400).send({ message: "trackingId is required" });
        }

        const tracking_id = trackingId.trim();

        const events = await trackingCollection
          .find({ tracking_id })
          .sort({ time: 1 })
          .toArray();

        if (!events.length) {
          return res.status(404).send({ message: "No tracking found" });
        }

        res.send({ tracking_id, events });
      } catch (error) {
        console.error("Error fetching tracking:", error);
        res.status(500).send({ message: "Failed to fetch tracking" });
      }
    });

    app.get("/tracking", async (req, res) => {
      try {
        const trackingId = req.query.trackingId;

        if (!trackingId || typeof trackingId !== "string") {
          return res
            .status(400)
            .send({ message: "trackingId query param is required" });
        }

        const tracking_id = trackingId.trim();

        const events = await trackingCollection
          .find({ tracking_id })
          .sort({ time: 1 })
          .toArray();

        if (!events.length) {
          return res.status(404).send({ message: "No tracking found" });
        }

        res.send({ tracking_id, events });
      } catch (error) {
        console.error("Error fetching tracking:", error);
        res.status(500).send({ message: "Failed to fetch tracking" });
      }
    });

    // =========================
    // STRIPE
    // =========================
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const amountInCents = Number(req.body.amountInCents);
        const parcelId = req.body.parcelId;
        const userEmail = req.body.userEmail || "";

        if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
          return res.status(400).json({ error: "Invalid amountInCents" });
        }

        if (parcelId && !ObjectId.isValid(parcelId)) {
          return res.status(400).json({ error: "Invalid parcelId" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          automatic_payment_methods: { enabled: true },
          metadata: {
            parcelId: parcelId || "",
            userEmail,
          },
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Error creating payment intent:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, transactionId, paymentMethod } =
          req.body;

        if (!parcelId || !ObjectId.isValid(parcelId)) {
          return res.status(400).send({ message: "Invalid parcelId" });
        }

        if (!transactionId) {
          return res.status(400).send({ message: "Missing transactionId" });
        }

        const pi = await stripe.paymentIntents.retrieve(transactionId);

        if (pi.status !== "succeeded") {
          return res.status(400).send({ message: "Payment not successful" });
        }

        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid", paidAt: new Date() } },
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const paymentDoc = {
          parcelId,
          email: email || null,
          amount: Number(amount) || 0,
          transactionId,
          paymentMethod: paymentMethod || pi.payment_method_types || [],
          paid_at: new Date(),
          paid_at_string: new Date().toISOString(),
        };

        const result = await paymentsCollection.insertOne(paymentDoc);

        res.send({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error saving payment:", error);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const query = email ? { email: String(email) } : {};

        const payments = await paymentsCollection
          .find(query)
          .sort({ paid_at: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB connected and pinged successfully!");
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Parcel Server is running");
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
