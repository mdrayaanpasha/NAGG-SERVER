

// = = = = = = = = = = = = = = LIBRARIES = = = = = = = = = = = = = = 
import express, { Request, Response, NextFunction } from "express";
import axios from "axios";
import pg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import cors from "cors";
dotenv.config();


// = = = = = = = = = = = = = = DB CONFIG = = = = = = = = = = = = = = 
const {Pool}  =pg;
const pool = new Pool({ connectionString : process.env.DATABASE_URL});
pool.connect()
.then(()=>{
  console.log("✅ Connected to PostgreSQL");
})
.catch((err)=>{
  console.error("❌ Database connection error:", err);
});

// = = = = = = = = = = = = = = SERVER INSTANCE = = = = = = = = = = = = = = 
const app = express();
const PORT : number = parseInt(process.env.PORT || "5000",10);


// = = = = = = = = = = = = = = MIDDLE WARE = = = = = = = = = = = = = = 
app.use(helmet())
app.use(express.json());
app.use(cors())
app.use(rateLimit({
  windowMs: 10 * 60 * 1000,
  max:100,
  message: "Too many requests Bro ..."
}))

// = = = = = = = = = = = = = = HELPER FUNCTION = = = = = = = = = = = = = = 
const generateToken = (userId:number,email:string):string=>{
  return jwt.sign({
    userId,email
  },process.env.JWT_SECRET!)

}

const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET!) as { userId: number; email: string };
    next();
  } catch (error) {
    return res.status(403).json({ message: "Invalid token" });
  }
};

// = = = = = = = = = = = = API ENDPOINTS = = = = = = = = = = = = = = = =


// = = = = = AUTH ENDPOINTS = = = = = 
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  username: z.string().min(3, "Username must be at least 3 characters"),
});

app.post("/api/register", async (req: Request, res: Response) => {
  const parseResult = RegisterSchema.safeParse(req.body);
  if (!parseResult.success) return res.status(400).json({ message: "Invalid input" });

  const { email, password, username } = parseResult.data;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO USER_BASE (username, password, email, categories) VALUES ($1, $2, $3, $4::jsonb) RETURNING id, email",
      [username, hashedPassword, email, JSON.stringify([])]
    );

    const user = result.rows[0];
    const token = generateToken(user.id, user.email);

    res.status(201).json({ message: "User created", token });
  } catch (error) {
    console.error("❌ Error registering user:", error);
    res.status(500).json({ message: "Failed to register user" });
  }
});

app.post("/api/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password are required" });

  try {
    const result = await pool.query("SELECT id, email, password FROM USER_BASE WHERE email = $1", [email]);
    if (result.rowCount === 0) return res.status(401).json({ message: "Invalid email or password" });

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ message: "Invalid email or password" });

    const token = generateToken(user.id, user.email);
    res.status(200).json({ message: "Login successful", token });
  } catch (error) {
    console.error("❌ Error logging in:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
});



// = = = = = NEWS ENDPOINTS = = = = = 

const NewsSchema = z.object({
  categories: z.array(z.string()).min(1, "At least one category is required"),
});

const NewsResponse = z.object({
  categories: z.array(z.string()).min(1, "At least one category is required"),
})

import dayjs from "dayjs"; // Install with: npm install dayjs

app.post("/api/newsByCategory", authenticateToken, async (req: Request, res: Response) => {
  console.log("we were here");

  const { category } = req.body; // Get the categories array from the request body
  console.log("categories", category);

  if (!category || !Array.isArray(category) || category.length === 0) {
      return res.status(400).json({ message: "Categories array is required and must not be empty" });
  }

  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return res.status(500).json({ message: "News API key missing" });

  const fromDate = dayjs().subtract(7, "day").format("YYYY-MM-DD");

  try {
      const newsResponses = await Promise.all(
          category.map(async (cat) => {
              try {
                  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(cat)}&from=${fromDate}&sortBy=publishedAt&apiKey=${apiKey}`;
                  console.log(`Fetching news for: ${cat} (from: ${fromDate})`, url);

                  const response = await axios.get(url);
                  return response.data.articles || [];
              } catch (err) {
                  console.error(`❌ Error fetching news for query "${cat}":`, err.message);
                  return []; // Return an empty array on error
              }
          })
      );

      const news = newsResponses.flat(); // Flatten the array of news arrays
      res.json({ news, message: "success" });
  } catch (error) {
      console.error("❌ Unexpected error fetching news:", error);
      res.status(500).json({ message: "Failed to fetch news" });
  }
});
// = = = = = CATEGORIES ENDPOINTS = = = = =
const UpdateCategoriesSchema = z.object({
  newCategories: z.array(z.string()).min(1, "At least one category is required"),
});

app.post("/api/updateCategories", authenticateToken, async (req: Request, res: Response) => {
  const parseResult = UpdateCategoriesSchema.safeParse(req.body);
  if (!parseResult.success) return res.status(400).json({ message: "Invalid input" });

  const { newCategories } = parseResult.data;
  const email = req.user.email;

  try {
      const fetchResult = await pool.query("SELECT categories FROM USER_BASE WHERE email = $1", [email]);
      if (fetchResult.rowCount === 0) return res.status(404).json({ message: "User not found" });

      let currentCategories = fetchResult.rows[0]?.categories;

      if (currentCategories) {
          if (typeof currentCategories === 'string') {
              try {
                  currentCategories = JSON.parse(currentCategories);
              } catch (e) {
                  currentCategories = [];
              }
          }
          if (!Array.isArray(currentCategories)){
              currentCategories = [];
          }
      } else {
          currentCategories = [];
      }

      const updatedCategories = Array.from(new Set([...currentCategories, ...newCategories]));

      const result = await pool.query(
          "UPDATE USER_BASE SET categories = $1::jsonb WHERE email = $2 RETURNING categories",
          [JSON.stringify(updatedCategories), email]
      );

      res.status(200).json({ message: "Categories updated", categories: result.rows[0] });
  } catch (error) {
      console.error("❌ Error updating categories:", error);
      res.status(500).json({ message: "Something went wrong", error: error.message });
  }
});

app.get("/api/getCategories", authenticateToken, async (req: Request, res: Response) => {
  const email = req.user.email;

  try {
    const result = await pool.query("SELECT categories FROM USER_BASE WHERE email = $1", [email]);

    if (result.rowCount === 0) return res.status(404).json({ message: "User not found" });

    res.status(200).json({ categories: result.rows[0].categories });
  } catch (error) {
    console.error("❌ Error fetching categories:", error);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

app.post("/api/SingleNewsByCategory", async (req: Request, res: Response) => {
  const { category } = req.body;

  if (!category) {
    return res.status(400).json({ message: "Category is required" });
  }

  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ message: "News API key missing" });
  }

  // Get date 7 days ago dynamically
  const fromDate = dayjs().subtract(7, "day").format("YYYY-MM-DD");

  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(category)}&from=${fromDate}&sortBy=publishedAt&apiKey=${apiKey}`;
    console.log(`Fetching single category news: ${category} (from: ${fromDate})`, url);

    const response = await axios.get(url);

    res.json({ news: response.data.articles, message: "success" });
  } catch (error) {
    console.error("❌ Error fetching news:", error);
    res.status(500).json({ message: "Failed to fetch news" });
  }
});


app.listen(PORT, () => console.log(`🔥 Server running at http://localhost:${PORT}`));
