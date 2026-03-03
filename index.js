require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 4000;

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// ✅ FIX: encode DB_PASS for special characters
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
    const parcelCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking"); // ✅ ADDED

    // GET: All parcels OR parcels by user (created_by), sorted by latest
    app.get("/parcels", async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { created_by: String(userEmail) } : {};
        const options = { sort: { createdAt: -1 } };

        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // GET: Specific parcel by id
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

    // POST: add a new parcel
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

    // DELETE: a parcel by id
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

    /**
     * ✅ TRACKING: Insert a tracking event (status update)
     * Body: { tracking_id, parcel_id(optional), status, message(optional), location(optional), updated_by(optional) }
     */
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

        // Optional: update parcel latest delivery status if parcel_id exists
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

    /**
     * ✅ TRACKING: Get tracking events by trackingId (timeline)
     * Returns events sorted old -> new
     */
    app.get("/tracking/:trackingId", async (req, res) => {
      try {
        const { trackingId } = req.params;
        if (!trackingId) {
          return res.status(400).send({ message: "trackingId is required" });
        }

        const tracking_id = trackingId.trim();

        const events = await trackingCollection
          .find({ tracking_id }, { sort: { time: 1 } })
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

    /**
     * ✅ TRACKING: Get tracking events by query param
     * /tracking?trackingId=TRK-123
     */
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
          .find({ tracking_id }, { sort: { time: 1 } })
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

    /**
     * ✅ Create PaymentIntent (pi_..._secret_...)
     */
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

    /**
     * ✅ record payment + mark parcel paid
     */
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

    /**
     * ✅ Get payment history (user or all), latest first
     */
    app.get("/payments", async (req, res) => {
      try {
        const email = req.query.email;
        const query = email ? { email: String(email) } : {};
        const payments = await paymentsCollection
          .find(query, { sort: { paid_at: -1 } })
          .toArray();
        res.send(payments);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB connected and pinged successfully!");
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
