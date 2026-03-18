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

// Helpers
const normalizeEmail = (email = "") => email.trim().toLowerCase();

const escapeRegex = (text = "") => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

    // Indexes
    await usersCollection.createIndex({ email: 1 });
    await ridersCollection.createIndex({ email: 1 });
    await ridersCollection.createIndex({ status: 1 });
    await parcelCollection.createIndex({ created_by: 1 });
    await trackingCollection.createIndex({ tracking_id: 1 });

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
        console.error("Token verification error:", error);
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      try {
        const email = normalizeEmail(req.decoded?.email);

        if (!email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user || user.role !== "admin") {
          return res.status(403).send({ message: "Admin only access" });
        }

        next();
      } catch (error) {
        console.error("Error verifying admin:", error);
        res.status(500).send({ message: "Failed to verify admin" });
      }
    };

    // =========================
    // USERS
    // =========================
    app.post("/users", async (req, res) => {
      try {
        const rawEmail = req.body.email;

        if (!rawEmail) {
          return res.status(400).send({ message: "Email is required" });
        }

        const email = normalizeEmail(rawEmail);
        const userExists = await usersCollection.findOne({ email });

        if (userExists) {
          return res
            .status(200)
            .send({ message: "User already exists", inserted: false });
        }

        const now = new Date().toISOString();

        const user = {
          ...req.body,
          email,
          role: req.body.role || "user",
          created_at: req.body.created_at || now,
          updated_at: req.body.updated_at || now,
        };

        const result = await usersCollection.insertOne(user);
        res.send(result);
      } catch (error) {
        console.error("Error saving user:", error);
        res.status(500).send({ message: "Failed to save user" });
      }
    });

    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      try {
        const email = normalizeEmail(req.params.email);
        const requesterEmail = normalizeEmail(req.decoded.email);

        if (requesterEmail !== email) {
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
    // USERS ADMIN MANAGEMENT
    // =========================
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const rawSearch = req.query.search?.trim();

        if (!rawSearch) {
          return res.status(400).send({ message: "search query is required" });
        }

        const safeSearch = escapeRegex(rawSearch.toLowerCase());

        const users = await usersCollection
          .find({
            email: { $regex: safeSearch, $options: "i" },
          })
          .project({
            email: 1,
            role: 1,
            created_at: 1,
            updated_at: 1,
          })
          .sort({ created_at: -1 })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        console.error("Error searching users:", error);
        res.status(500).send({ message: "Failed to search users" });
      }
    });

    app.get("/users/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid user id" });
        }

        const user = await usersCollection.findOne(
          { _id: new ObjectId(id) },
          {
            projection: {
              email: 1,
              role: 1,
              created_at: 1,
              updated_at: 1,
            },
          },
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).send({ message: "Failed to fetch user" });
      }
    });

    app.patch(
      "/users/admin/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid user id" });
          }

          const targetUser = await usersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!targetUser) {
            return res.status(404).send({ message: "User not found" });
          }

          if (targetUser.role === "admin") {
            return res.send({
              success: false,
              matchedCount: 1,
              modifiedCount: 0,
              message: "User is already an admin",
            });
          }

          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                role: "admin",
                updated_at: new Date().toISOString(),
              },
            },
          );

          res.send({
            success: result.modifiedCount > 0,
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            message:
              result.modifiedCount > 0
                ? `${targetUser.email} is now an admin`
                : "User role was not updated",
          });
        } catch (error) {
          console.error("Error making admin:", error);
          res.status(500).send({ message: "Failed to update user role" });
        }
      },
    );

    app.patch(
      "/users/remove-admin/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid user id" });
          }

          const requesterEmail = normalizeEmail(req.decoded?.email);

          const targetUser = await usersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!targetUser) {
            return res.status(404).send({ message: "User not found" });
          }

          if (normalizeEmail(targetUser.email) === requesterEmail) {
            return res.status(400).send({
              message: "You cannot remove your own admin role",
            });
          }

          if (targetUser.role !== "admin") {
            return res.send({
              success: false,
              matchedCount: 1,
              modifiedCount: 0,
              message: "User is already a normal user",
            });
          }

          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                role: "user",
                updated_at: new Date().toISOString(),
              },
            },
          );

          res.send({
            success: result.modifiedCount > 0,
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            message:
              result.modifiedCount > 0
                ? `${targetUser.email} is no longer an admin`
                : "User role was not updated",
          });
        } catch (error) {
          console.error("Error removing admin:", error);
          res.status(500).send({ message: "Failed to remove admin role" });
        }
      },
    );

    // =========================
    // RIDERS
    // =========================
    app.post("/riders", verifyFBToken, async (req, res) => {
      try {
        const riderData = req.body;
        const email = normalizeEmail(req.decoded?.email);

        if (!email) {
          return res.status(400).send({ message: "User email not found" });
        }

        const existingRider = await ridersCollection.findOne({ email });

        if (existingRider) {
          return res.status(400).send({
            message: "Rider application already exists for this user",
          });
        }

        const now = new Date().toISOString();

        const result = await ridersCollection.insertOne({
          ...riderData,
          email,
          status: riderData.status || "pending",
          created_at: riderData.created_at || now,
          updated_at: now,
        });

        res.status(201).send(result);
      } catch (error) {
        console.error("Error saving rider application:", error);
        res.status(500).send({ message: "Failed to save rider application" });
      }
    });

    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { status, search } = req.query;
        const query = {};

        if (status) {
          query.status = status;
        }

        if (search) {
          query.name = { $regex: escapeRegex(search), $options: "i" };
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

    app.get(
      "/riders/active-by-district",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const district = req.query.district?.trim();

          if (!district) {
            return res
              .status(400)
              .send({ message: "district query is required" });
          }

          const riders = await ridersCollection
            .find({
              status: "active",
              district: { $regex: `^${escapeRegex(district)}$`, $options: "i" },
            })
            .project({
              name: 1,
              email: 1,
              phone: 1,
              district: 1,
              status: 1,
            })
            .sort({ created_at: -1 })
            .toArray();

          res.send(riders);
        } catch (error) {
          console.error("Error fetching active riders by district:", error);
          res
            .status(500)
            .send({ message: "Failed to fetch riders by district" });
        }
      },
    );

    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
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

    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { search } = req.query;

        const query = { status: "active" };

        if (search) {
          query.name = { $regex: escapeRegex(search), $options: "i" };
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

    app.get(
      "/riders/deactivated",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { search } = req.query;

          const query = { status: "deactivated" };

          if (search) {
            query.name = { $regex: escapeRegex(search), $options: "i" };
          }

          const riders = await ridersCollection
            .find(query)
            .sort({ created_at: -1 })
            .toArray();

          res.send(riders);
        } catch (error) {
          console.error("Error fetching deactivated riders:", error);
          res
            .status(500)
            .send({ message: "Failed to fetch deactivated riders" });
        }
      },
    );

    app.get("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
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

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status, role, email } = req.body;

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

        const rider = await ridersCollection.findOne({ _id: new ObjectId(id) });

        if (!rider) {
          return res.status(404).send({ message: "Rider not found" });
        }

        const riderUpdateResult = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status,
              updated_at: new Date().toISOString(),
            },
          },
        );

        let userUpdateResult = null;

        if (status === "active") {
          const userEmail = normalizeEmail(email || rider.email);

          if (!userEmail) {
            return res.status(400).send({
              message: "User email is required to update role",
            });
          }

          userUpdateResult = await usersCollection.updateOne(
            { email: userEmail },
            {
              $set: {
                role: role || "rider",
                updated_at: new Date().toISOString(),
              },
            },
          );
        }

        if (status === "cancelled") {
          const userEmail = normalizeEmail(email || rider.email);

          if (userEmail) {
            userUpdateResult = await usersCollection.updateOne(
              { email: userEmail },
              {
                $set: {
                  role: "user",
                  updated_at: new Date().toISOString(),
                },
              },
            );
          }
        }

        res.send({
          success: true,
          modifiedCount: riderUpdateResult.modifiedCount,
          matchedCount: riderUpdateResult.matchedCount,
          userModifiedCount: userUpdateResult?.modifiedCount || 0,
          message:
            status === "active"
              ? "Rider approved and user role updated to rider"
              : `Rider status updated to ${status}`,
        });
      } catch (error) {
        console.error("Error updating rider:", error);
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    app.patch(
      "/riders/deactivate/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
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

          const riderResult = await ridersCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                status: "deactivated",
                updated_at: new Date().toISOString(),
              },
            },
          );

          let userResult = null;

          if (rider.email) {
            userResult = await usersCollection.updateOne(
              { email: normalizeEmail(rider.email) },
              {
                $set: {
                  role: "user",
                  updated_at: new Date().toISOString(),
                },
              },
            );
          }

          res.send({
            success: riderResult.modifiedCount > 0,
            modifiedCount: riderResult.modifiedCount,
            matchedCount: riderResult.matchedCount,
            userModifiedCount: userResult?.modifiedCount || 0,
            message:
              riderResult.modifiedCount > 0
                ? "Rider deactivated successfully"
                : "No rider was updated",
          });
        } catch (error) {
          console.error("Error deactivating rider:", error);
          res.status(500).send({ message: "Failed to deactivate rider" });
        }
      },
    );

    app.patch(
      "/riders/activate/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
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

          const riderResult = await ridersCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                status: "active",
                updated_at: new Date().toISOString(),
              },
            },
          );

          let userResult = null;

          if (rider.email) {
            userResult = await usersCollection.updateOne(
              { email: normalizeEmail(rider.email) },
              {
                $set: {
                  role: "rider",
                  updated_at: new Date().toISOString(),
                },
              },
            );
          }

          res.send({
            success: riderResult.modifiedCount > 0,
            modifiedCount: riderResult.modifiedCount,
            matchedCount: riderResult.matchedCount,
            userModifiedCount: userResult?.modifiedCount || 0,
            message:
              riderResult.modifiedCount > 0
                ? "Rider activated successfully"
                : "No rider was updated",
          });
        } catch (error) {
          console.error("Error activating rider:", error);
          res.status(500).send({ message: "Failed to activate rider" });
        }
      },
    );

    app.delete("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
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
        const userEmail = req.query.email
          ? normalizeEmail(req.query.email)
          : null;
        const requesterEmail = normalizeEmail(req.decoded.email);

        if (userEmail && requesterEmail !== userEmail) {
          const requester = await usersCollection.findOne({
            email: requesterEmail,
          });
          if (!requester || requester.role !== "admin") {
            return res.status(403).send({ message: "Forbidden access" });
          }
        }

        const query = userEmail ? { created_by: userEmail } : {};

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

    app.get(
      "/parcels/ready-for-assignment",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const parcels = await parcelCollection
            .find({
              payment_status: "paid",
              delivery_status: "not_collected",
            })
            .sort({ creation_date: -1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.error("Error fetching parcels ready for assignment:", error);
          res.status(500).send({
            message: "Failed to fetch parcels ready for assignment",
          });
        }
      },
    );

    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
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

        const requesterEmail = normalizeEmail(req.decoded.email);
        const requester = await usersCollection.findOne({
          email: requesterEmail,
        });
        const parcelOwnerEmail = normalizeEmail(parcel.created_by || "");

        if (
          requester?.role !== "admin" &&
          requesterEmail !== parcelOwnerEmail
        ) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel by id:", error);
        res.status(500).send({ message: "Failed to get parcel" });
      }
    });

    app.post("/parcels", verifyFBToken, async (req, res) => {
      try {
        const requesterEmail = normalizeEmail(req.decoded.email);
        const newParcel = {
          ...req.body,
          created_by: requesterEmail,
          creation_date: req.body.creation_date || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error adding parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    app.patch(
      "/parcels/assign-rider/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { riderId } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid parcel id" });
          }

          if (!ObjectId.isValid(riderId)) {
            return res.status(400).send({ message: "Invalid rider id" });
          }

          const parcel = await parcelCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!parcel) {
            return res.status(404).send({ message: "Parcel not found" });
          }

          const rider = await ridersCollection.findOne({
            _id: new ObjectId(riderId),
          });

          if (!rider) {
            return res.status(404).send({ message: "Rider not found" });
          }

          if (rider.status !== "active") {
            return res
              .status(400)
              .send({ message: "Only active riders can be assigned" });
          }

          const parcelUpdateResult = await parcelCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                delivery_status: "in-transit",
                assigned_rider_id: rider._id.toString(),
                assigned_rider_name: rider.name || "",
                assigned_rider_email: rider.email || "",
                assigned_rider_phone: rider.phone || rider.contact || "",
                assigned_at: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
          );

          const riderUpdateResult = await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            {
              $set: {
                work_status: "in-delivery",
                updated_at: new Date().toISOString(),
              },
            },
          );

          res.send({
            success: true,
            parcelModifiedCount: parcelUpdateResult.modifiedCount,
            riderModifiedCount: riderUpdateResult.modifiedCount,
            message: "Rider assigned successfully",
          });
        } catch (error) {
          console.error("Error assigning rider:", error);
          res.status(500).send({ message: "Failed to assign rider" });
        }
      },
    );

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
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

        const requesterEmail = normalizeEmail(req.decoded.email);
        const requester = await usersCollection.findOne({
          email: requesterEmail,
        });
        const parcelOwnerEmail = normalizeEmail(parcel.created_by || "");

        if (
          requester?.role !== "admin" &&
          requesterEmail !== parcelOwnerEmail
        ) {
          return res.status(403).send({ message: "Forbidden access" });
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
    app.post("/tracking", verifyFBToken, verifyAdmin, async (req, res) => {
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
          updated_by: updated_by || normalizeEmail(req.decoded?.email || ""),
          time: new Date(),
        };

        const result = await trackingCollection.insertOne(doc);

        if (doc.parcel_id) {
          await parcelCollection.updateOne(
            { _id: doc.parcel_id },
            {
              $set: {
                delivery_status: doc.status,
                updatedAt: new Date().toISOString(),
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
    app.post("/create-checkout-session", verifyFBToken, async (req, res) => {
      try {
        const amountInCents = Number(req.body.amountInCents);
        const parcelId = req.body.parcelId;
        const userEmail = normalizeEmail(req.decoded?.email || "");

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

    app.post("/payments", verifyFBToken, async (req, res) => {
      try {
        const { parcelId, amount, transactionId, paymentMethod } = req.body;
        const email = normalizeEmail(req.decoded?.email || "");

        if (!parcelId || !ObjectId.isValid(parcelId)) {
          return res.status(400).send({ message: "Invalid parcelId" });
        }

        if (!transactionId) {
          return res.status(400).send({ message: "Missing transactionId" });
        }

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const requester = await usersCollection.findOne({ email });
        const parcelOwnerEmail = normalizeEmail(parcel.created_by || "");

        if (requester?.role !== "admin" && email !== parcelOwnerEmail) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const pi = await stripe.paymentIntents.retrieve(transactionId);

        if (pi.status !== "succeeded") {
          return res.status(400).send({ message: "Payment not successful" });
        }

        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
              paidAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const paymentDoc = {
          parcelId,
          email,
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
        const email = normalizeEmail(req.query.email || "");
        const requesterEmail = normalizeEmail(req.decoded.email);

        if (requesterEmail !== email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const payments = await paymentsCollection
          .find({ email })
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
